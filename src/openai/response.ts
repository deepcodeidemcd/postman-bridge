import crypto from 'node:crypto';
import type { NormalizedResult, ToolCall } from './types.js';
import { sanitizeBranding } from './branding.js';

/** Client SDKs hard-validate tool_calls (zod: "expected function.name to be a
 * string"). Never let a malformed call reach the wire — drop entries whose
 * name/arguments are not clean strings. */
export function cleanToolCalls(calls: ToolCall[] | undefined): ToolCall[] {
  const out: ToolCall[] = [];
  for (const c of calls ?? []) {
    const name = c?.function?.name;
    if (typeof name !== 'string' || !name.trim()) continue;
    let args = c.function.arguments as unknown;
    if (typeof args !== 'string') {
      try { args = JSON.stringify(args ?? {}); } catch { args = '{}'; }
    }
    out.push({
      id: typeof c.id === 'string' && c.id ? c.id : `call_${crypto.randomBytes(12).toString('hex')}`,
      type: 'function',
      function: { name, arguments: args as string },
    });
  }
  return out;
}

export function buildCompletion(model: string, result: NormalizedResult) {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-gw-${created}-${Math.random().toString(36).slice(2, 10)}`;
  const toolCalls = cleanToolCalls(result.toolCalls);
  const hasTools = toolCalls.length > 0;
  const content = result.content == null ? null : sanitizeBranding(result.content);

  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: hasTools ? null : content,
          ...(hasTools ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: hasTools ? 'tool_calls' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

export function chunkText(text: string, maxChunkChars = 96): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let buffer = '';
  for (const token of text.split(/(\s+)/)) {
    if (buffer.length + token.length > maxChunkChars && buffer) {
      chunks.push(buffer);
      buffer = '';
    }
    buffer += token;
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}
