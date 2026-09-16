import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AgentDriver } from '../browser/agent-driver.js';
import { ClientGoneError, ServerBusyError } from '../browser/agent-driver.js';
import type { ChatCompletionRequest } from '../openai/types.js';
import { buildCompletion, cleanToolCalls } from '../openai/response.js';
import { hasImages, postmanAwsVisionChat } from '../openai/vision-router.js';
import { codeChat, nativeCodeChat, resetConversation } from '../openai/code-chat.js';
import { PUBLIC_MODELS, normalizePublicModel, parseModelEffort, sanitizeBranding, sanitizeError } from '../openai/branding.js';
import { buildResponsesResult, responsesToChatRequest, type ResponsesRequest } from '../openai/responses-api.js';
import { requireApiKey, userIdOf } from './auth.js';

const chatBodySchema = {
  type: 'object',
  required: ['model', 'messages'],
  additionalProperties: true,
  properties: {
    model: { type: 'string', minLength: 1 },
    messages: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['role'],
        additionalProperties: true,
        properties: {
          role: { type: 'string' },
          content: {},
        },
      },
    },
    stream: { type: 'boolean' },
    tools: { type: 'array' },
  },
} as const;

function writeSse(reply: FastifyReply, payload: unknown): void {
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function registerOpenAiRoutes(app: FastifyInstance, driver: AgentDriver): Promise<void> {
  app.get('/v1/models', { preHandler: requireApiKey }, async () => {
    const created = Math.floor(Date.now() / 1000);
    return {
      object: 'list',
      data: PUBLIC_MODELS.map((model) => ({
        id: model.id,
        object: 'model',
        created,
        owned_by: model.owned_by,
        display_name: model.display_name,
      })),
    };
  });

  app.post<{ Body: ChatCompletionRequest }>(
    '/v1/chat/completions',
    {
      preHandler: requireApiKey,
      schema: { body: chatBodySchema },
    },
    async (request, reply) => {
      const rawBody = request.body;
      // Track real client disconnects via the socket 'close' event — NOT via
      // request.raw.destroyed (unreliable: true at handler entry for some
      // HTTP clients even while they wait for the response).
      let clientGone = false;
      request.raw.on('close', () => { clientGone = true; });
      const isCancelled = () => clientGone;
      // Parse effort suffix from model name (e.g. "claude-sonnet-4-5-high").
      // Explicit reasoning_effort field wins over the suffix.
      const parsed = parseModelEffort(rawBody.model);
      if (parsed.effort && !rawBody.reasoning_effort) {
        rawBody.reasoning_effort = parsed.effort;
      }
      // "-thinking" suffix (e.g. "gpt-5.6-sol-thinking") enables extended
      // thinking explicitly. Wins over nothing — sets the thinking flag.
      const wantsThinking = /-thinking$/i.test(rawBody.model);
      if (wantsThinking && rawBody.thinking === undefined) {
        (rawBody as unknown as { thinking: boolean }).thinking = true;
      }
      // Normalize the model id to the public catalog before anything runs.
      rawBody.model = normalizePublicModel(parsed.model);
      const body = rawBody;
      const userId = userIdOf(request);
      try {
        const roles = (body.messages ?? []).map((m: { role?: string; tool_calls?: unknown[]; tool_call_id?: string }) =>
          m.role === 'assistant' && m.tool_calls?.length ? `assistant[tc${m.tool_calls.length}]`
          : m.role === 'tool' ? `tool:${String(m.tool_call_id ?? '').slice(0, 12)}`
          : String(m.role ?? '?')).join(',');
        const toolNames = (body.tools ?? []).map((t: { function?: { name?: string } }) => t.function?.name ?? '?').join(',');
        console.log(`[req] model=${body.model} stream=${Boolean(body.stream)} msgs=${(body.messages ?? []).length} roles=[${roles}] tools=[${toolNames}] tool_choice=${JSON.stringify((body as unknown as { tool_choice?: unknown }).tool_choice ?? 'auto').slice(0, 60)} effort=${String((body as unknown as { reasoning_effort?: unknown }).reasoning_effort ?? '-')}`);
      } catch { /* logging must never break requests */ }

      // --- Vision path: markdown-image pipeline, serialized on the shared page.
      if (hasImages(body)) {
        console.log(`[vision] vision path triggered model=${body.model}`);
        try {
          const answer = await driver.runVisionExclusive(
            (page) => postmanAwsVisionChat(page, body),
            { isCancelled },
          );
          console.log(`[vision] vision answer: ${answer.slice(0, 300)}`);
          return buildCompletion(body.model, { content: answer.trim(), rawText: answer });
        } catch (error) {
          if (error instanceof ServerBusyError || error instanceof ClientGoneError) throw error;
          const msg = error instanceof Error ? error.message : String(error);
          console.log(`[vision] failed: ${msg}`);
          return reply.code(502).send({
            error: { message: sanitizeError(`Image processing failed: ${msg}`), type: 'server_error', code: 'vision_error' },
          });
        }
      }

      // --- CODE-CHAT path (default for text requests) ---
      // Straight server call with all agent tools excluded and a coding
      // persona override; conversation memory is kept per user.
      const forceUiChat = body.tools && body.tools.length > 0
        ? (body as unknown as { bridge_ui_chat?: boolean }).bridge_ui_chat === true
        : false;
      // NATIVE AGENT MODE: opt-in (body.bridge_native_agent=true) or a dedicated
      // "agent" model alias. Keeps the backend's own tools (web search, code gen,
      // sub-agents) enabled + autoRun, so coding answers are grounded the same
      // way the Postman web chat does them — the thing the plain text-completion
      // path is weaker at.
      const nativeAgent =
        (body as unknown as { bridge_native_agent?: boolean }).bridge_native_agent === true;

      if (!forceUiChat) {
        try {
          const { content, toolCalls } = await driver.runVisionExclusive(
            async (page) => {
              if (nativeAgent) {
                const text = await nativeCodeChat(page, body, userId);
                return { content: text, toolCalls: undefined as undefined | ReturnType<typeof cleanToolCalls> };
              }
              return codeChat(page, body, userId);
            },
            // Checked AFTER queue wait inside runVisionExclusive: if the
            // client gave up while queued, the slot is released without
            // burning upstream quota.
            { isCancelled },
          );
          const completion = buildCompletion(body.model, { content, rawText: content ?? '', toolCalls });

          // Clients like Codex always request SSE. codeChat produces the full
          // result in one shot — wrap it in a single-chunk SSE stream so the
          // wire contract (text/event-stream) is honored either way.
          if (body.stream) {
            reply.hijack();
            reply.raw.statusCode = 200;
            reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
            reply.raw.setHeader('Connection', 'keep-alive');
            reply.raw.flushHeaders?.();

            writeSse(reply, {
              id: completion.id,
              object: 'chat.completion.chunk',
              created: completion.created,
              model: body.model,
              choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
            });
            if (content) {
              writeSse(reply, {
                id: completion.id,
                object: 'chat.completion.chunk',
                created: completion.created,
                model: body.model,
                choices: [{ index: 0, delta: { content }, finish_reason: null }],
              });
            }
            const sseToolCalls = cleanToolCalls(toolCalls);
            if (sseToolCalls.length) {
              writeSse(reply, {
                id: completion.id,
                object: 'chat.completion.chunk',
                created: completion.created,
                model: body.model,
                choices: [{
                  index: 0,
                  delta: { tool_calls: sseToolCalls.map((tc, i) => ({ index: i, ...tc })) },
                  finish_reason: 'tool_calls',
                }],
              });
            } else {
              writeSse(reply, {
                id: completion.id,
                object: 'chat.completion.chunk',
                created: completion.created,
                model: body.model,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              });
            }
            reply.raw.write('data: [DONE]\n\n');
            reply.raw.end();
            return;
          }
          return completion;
        } catch (error) {
          if (error instanceof ServerBusyError || error instanceof ClientGoneError) throw error;
          const msg = error instanceof Error ? error.message : String(error);
          console.log(`[code-chat] failed: ${msg}`);
          return reply.code(502).send({
            error: { message: sanitizeError(`Upstream request failed: ${msg}`), type: 'server_error', code: 'gateway_error' },
          });
        }
      }

      // --- Legacy UI-agent path (opt-in via bridge_ui_chat=true) ---
      // Standard OpenAI behavior: return any tool_calls to the client; the
      // client executes them and sends tool results back in the next request.
      if (!body.stream) {
        const result = await driver.complete(body, userId);
        return buildCompletion(body.model, result);
      }

      // --- Streaming path ---
      reply.hijack();
      reply.raw.statusCode = 200;
      reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.flushHeaders?.();

      const id = `chatcmpl-gw-${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2, 10)}`;
      const created = Math.floor(Date.now() / 1000);

      writeSse(reply, {
        id,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      });

      const onDelta = (delta: string) => {
        writeSse(reply, {
          id,
          object: 'chat.completion.chunk',
          created,
          model: body.model,
          choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
        });
      };

      let finishedWithTools = false;
      try {
        const result = await driver.complete(body, userId, onDelta);
        const streamToolCalls = cleanToolCalls(result.toolCalls);
        if (streamToolCalls.length) {
          // Streaming + tool calls: emit tool_calls as the final chunk.
          // OpenAI spec requires an `index` on each streamed tool_call.
          finishedWithTools = true;
          writeSse(reply, {
            id,
            object: 'chat.completion.chunk',
            created,
            model: body.model,
            choices: [{
              index: 0,
              delta: {
                tool_calls: streamToolCalls.map((tc, i) => ({ index: i, ...tc })),
              },
              finish_reason: 'tool_calls',
            }],
          });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        writeSse(reply, {
          id,
          object: 'chat.completion.chunk',
          created,
          model: body.model,
          choices: [{ index: 0, delta: { content: `\n\n[Error: ${sanitizeError(msg)}]` }, finish_reason: 'stop' }],
        });
      }

      if (!finishedWithTools) {
        writeSse(reply, {
          id,
          object: 'chat.completion.chunk',
          created,
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });
      }
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    },
  );

  app.post<{ Body: ResponsesRequest }>(
    '/v1/responses',
    { preHandler: requireApiKey },
    async (request, reply) => {
      if (request.body.stream) {
        return reply.code(501).send({
          error: {
            message: 'Streaming for /v1/responses is not implemented yet. Use /v1/chat/completions with stream=true.',
            type: 'not_implemented_error',
            code: 'responses_stream_not_implemented',
          },
        });
      }
      const chatRequest = responsesToChatRequest(request.body);
      chatRequest.model = normalizePublicModel(chatRequest.model);
      let respGone = false;
      request.raw.on('close', () => { respGone = true; });
      const { content, toolCalls } = await driver.runVisionExclusive(
        (page) => codeChat(page, chatRequest, userIdOf(request)),
        { isCancelled: () => respGone },
      );
      const text = content ?? '';
      return buildResponsesResult(request.body.model, { content: text, rawText: text, toolCalls: cleanToolCalls(toolCalls) });
    },
  );

  // Start a fresh conversation (drops the cached session id for this user).
  app.post('/v1/conversations/reset', { preHandler: requireApiKey }, async (request) => {
    resetConversation(userIdOf(request));
    return { ok: true };
  });

}
