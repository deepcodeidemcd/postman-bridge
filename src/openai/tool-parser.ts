import crypto from 'node:crypto';
import type { NormalizedResult, ToolCall } from './types.js';

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;

export function parseModelOutput(rawText: string): NormalizedResult {
  const toolCalls: ToolCall[] = [];
  let match: RegExpExecArray | null;

  while ((match = TOOL_CALL_RE.exec(rawText)) !== null) {
    try {
      const payload = JSON.parse(match[1] ?? '') as {
        name?: unknown;
        arguments?: unknown;
      };
      if (typeof payload.name !== 'string' || !payload.name.trim()) continue;
      const args =
        typeof payload.arguments === 'string'
          ? payload.arguments
          : JSON.stringify(payload.arguments ?? {});

      toolCalls.push({
        id: `call_${crypto.randomBytes(12).toString('hex')}`,
        type: 'function',
        function: {
          name: payload.name,
          arguments: args,
        },
      });
    } catch {
      // Ignore malformed tool blocks and fall back to normal text.
    }
  }

  if (toolCalls.length) {
    return { content: null, toolCalls, rawText };
  }

  return { content: rawText.trim(), rawText };
}
