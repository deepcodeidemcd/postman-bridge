import crypto from 'node:crypto';
import type { ChatCompletionRequest, ChatMessage, FunctionTool, NormalizedResult } from './types.js';

export interface ResponsesRequest {
  model: string;
  input: string | Array<Record<string, unknown>>;
  instructions?: string;
  tools?: FunctionTool[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  // Codex/Responses API reasoning control: { effort: "low"|"medium"|"high"|"xhigh" }
  reasoning?: { effort?: string; summary?: string };
}

function contentArrayToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return String(part ?? '');
      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string') return record.text;
      if (record.type === 'input_text' && typeof record.text === 'string') return record.text;
      if (record.type === 'output_text' && typeof record.text === 'string') return record.text;
      if (record.type === 'input_image') return `[image: ${String(record.image_url ?? '')}]`;
      return JSON.stringify(record);
    })
    .join('\n');
}

export function responsesToChatRequest(input: ResponsesRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = [];
  if (input.instructions) messages.push({ role: 'system', content: input.instructions });

  if (typeof input.input === 'string') {
    messages.push({ role: 'user', content: input.input });
  } else {
    for (const item of input.input) {
      const type = item.type;
      if (type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: typeof item.call_id === 'string' ? item.call_id : undefined,
          content: contentArrayToText(item.output),
        });
        continue;
      }
      // The client echoes the model's own tool request back in the history —
      // render it as a proper assistant tool_calls turn, not stringified text.
      if (type === 'function_call') {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: typeof item.call_id === 'string' ? item.call_id : 'fc',
            type: 'function',
            function: {
              name: String(item.name ?? ''),
              arguments: String(item.arguments ?? '{}'),
            },
          }],
        });
        continue;
      }

      const role = item.role;
      if (role === 'system' || role === 'developer' || role === 'user' || role === 'assistant' || role === 'tool') {
        messages.push({
          role,
          content: contentArrayToText(item.content),
          tool_call_id: typeof item.tool_call_id === 'string' ? item.tool_call_id : undefined,
        });
      } else {
        messages.push({ role: 'user', content: JSON.stringify(item) });
      }
    }
  }

  return {
    model: input.model,
    messages,
    tools: input.tools,
    stream: false,
    temperature: input.temperature,
    top_p: input.top_p,
    max_completion_tokens: input.max_output_tokens,
    // Forward Codex/Responses API reasoning effort → bridge thinking level.
    // Accepts: "minimal"|"low"|"medium"|"high"|"xhigh" (also "ultra" for 3-pass).
    reasoning_effort: typeof input.reasoning?.effort === 'string' ? input.reasoning.effort : undefined,
  };
}

export function buildResponsesResult(model: string, result: NormalizedResult) {
  const id = `resp_postman_${crypto.randomBytes(10).toString('hex')}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const output: Array<Record<string, unknown>> = [];

  if (result.toolCalls?.length) {
    for (const call of result.toolCalls) {
      output.push({
        type: 'function_call',
        id: `fc_${crypto.randomBytes(8).toString('hex')}`,
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
        status: 'completed',
      });
    }
  } else {
    output.push({
      type: 'message',
      id: `msg_${crypto.randomBytes(8).toString('hex')}`,
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: result.content ?? '',
          annotations: [],
        },
      ],
    });
  }

  return {
    id,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    error: null,
    incomplete_details: null,
    model,
    output,
    parallel_tool_calls: true,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  };
}
