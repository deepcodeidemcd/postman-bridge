import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage, FunctionTool, ToolCall } from './types.js';

export interface ToolResult {
  toolCallId: string;
  output: string;
  isError?: boolean;
}

const MAX_OUTPUT = 8000;
const BASH_TIMEOUT_MS = 30_000;

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n... (truncated)' : s;
}

export async function executeTool(call: ToolCall): Promise<ToolResult> {
  const { name, arguments: rawArgs } = call.function;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs || '{}');
  } catch {
    return { toolCallId: call.id, output: `Invalid JSON arguments: ${rawArgs}`, isError: true };
  }

  try {
    let output: string;
    switch (name) {
      case 'web_search': {
        const query = String(args.query || '');
        if (!query) return { toolCallId: call.id, output: 'Missing "query" parameter.', isError: true };
        output = await webSearch(query);
        break;
      }
      case 'web_fetch': {
        const url = String(args.url || '');
        if (!url) return { toolCallId: call.id, output: 'Missing "url" parameter.', isError: true };
        output = await webFetch(url);
        break;
      }
      case 'bash': {
        const command = String(args.command || args.cmd || '');
        if (!command) return { toolCallId: call.id, output: 'Missing "command" parameter.', isError: true };
        output = runBash(command);
        break;
      }
      case 'read_file': {
        const filePath = String(args.path || args.file_path || '');
        if (!filePath) return { toolCallId: call.id, output: 'Missing "path" parameter.', isError: true };
        output = readFile(filePath);
        break;
      }
      default:
        return { toolCallId: call.id, output: `Unknown tool: "${name}".`, isError: true };
    }
    return { toolCallId: call.id, output: truncate(output) };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { toolCallId: call.id, output: truncate(`Tool "${name}" error: ${msg}`), isError: true };
  }
}

async function webSearch(query: string): Promise<string> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(BASH_TIMEOUT_MS),
  });
  const html = await res.text();
  // Extract result snippets from DuckDuckGo HTML.
  const results: string[] = [];
  const regex = /<a[^>]*class="result__a"[^>]*>([^<]+)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null && results.length < 5) {
    const title = (match[1] ?? '').trim();
    const snippet = (match[2] ?? '').replace(/<[^>]+>/g, '').trim();
    results.push(`${title}\n${snippet}`);
  }
  return results.length ? results.join('\n\n') : 'No results found.';
}

async function webFetch(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(BASH_TIMEOUT_MS),
  });
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = await res.json();
    return JSON.stringify(json, null, 2).slice(0, MAX_OUTPUT);
  }
  const text = await res.text();
  // Strip HTML tags for readability.
  const clean = text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return truncate(clean);
}

function runBash(command: string): string {
  try {
    const output = execSync(command, {
      timeout: BASH_TIMEOUT_MS,
      maxBuffer: 1024 * 512,
      encoding: 'utf-8',
      windowsHide: true,
    });
    return output || '(no output)';
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    const parts: string[] = [];
    if (e.stdout) parts.push(`STDOUT:\n${e.stdout}`);
    if (e.stderr) parts.push(`STDERR:\n${e.stderr}`);
    if (e.message) parts.push(`ERROR: ${e.message}`);
    return parts.join('\n') || 'Command failed with unknown error.';
  }
}

function readFile(filePath: string): string {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return `File not found: ${filePath}`;
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    return entries.map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`).join('\n');
  }
  if (stat.size > 200_000) return `File too large (${Math.round(stat.size / 1024)}KB).`;
  return fs.readFileSync(resolved, 'utf-8');
}

export function hasToolCalls(result: { toolCalls?: ToolCall[] }): boolean {
  return Boolean(result.toolCalls?.length);
}

export function buildToolMessages(toolCalls: ToolCall[], results: ToolResult[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const call of toolCalls) {
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [call],
    });
    const result = results.find((r) => r.toolCallId === call.id);
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: result?.output ?? 'No result.',
    });
  }
  return messages;
}

// Built-in tool definitions the bridge injects when the client sends tools.
export const BUILTIN_TOOLS: FunctionTool[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for information using DuckDuckGo.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch content from a URL. Returns text or JSON.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a shell command and return stdout/stderr.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the local filesystem.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read' },
        },
        required: ['path'],
      },
    },
  },
];
