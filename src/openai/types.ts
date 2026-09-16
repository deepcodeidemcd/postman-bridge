export type ChatRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImageUrlPart {
  type: 'image_url';
  image_url: { url: string; detail?: string };
}

export type MessageContent = string | null | Array<TextPart | ImageUrlPart | Record<string, unknown>>;

export interface ChatMessage {
  role: ChatRole;
  content?: MessageContent;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface FunctionTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: FunctionTool[];
  tool_choice?: unknown;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  response_format?: unknown;
  user?: string;
  // OpenAI-style reasoning control. Any value other than 'none'/'off' enables
  // Postman's "Thinking" (extended thinking) switch before the request.
  reasoning_effort?: string | null;
  // Bridge-specific explicit override; wins over reasoning_effort.
  thinking?: boolean;
}

export interface NormalizedResult {
  content: string | null;
  toolCalls?: ToolCall[];
  rawText: string;
}
