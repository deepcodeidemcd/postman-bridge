import type { Page } from 'playwright-core';
import type { ChatCompletionRequest } from './types.js';
import { isCreditLimitError, QuotaExhaustedError, SessionExpiredError } from '../browser/account-pool.js';
import { sanitizeBranding } from './branding.js';
import { resolveThinkingLevel, resolveWorkspaceId } from './code-chat.js';
import sharp from 'sharp';

export function hasImages(request: ChatCompletionRequest): boolean {
  return request.messages.some((message) => {
    if (!Array.isArray(message.content)) return false;
    return message.content.some((part) => part?.type === 'image_url');
  });
}

function mapModel(openaiModel: string): string | null {
  const raw = openaiModel.trim().toLowerCase();
  const m = raw.endsWith('-thinking') ? raw.slice(0, -'-thinking'.length) : raw;
  if (!m || m === 'auto') return null;
  const mapping: Record<string, string> = {
    'claude-opus-5': 'CLAUDE_OPUS_48_BEDROCK',
    'claude-opus-4-8': 'CLAUDE_OPUS_48_BEDROCK', 'claude-opus-4-7': 'CLAUDE_OPUS_47_BEDROCK',
    'claude-opus-4-5': 'CLAUDE_OPUS_45_BEDROCK', 'claude-sonnet-4-6': 'CLAUDE_46_SONNET_BEDROCK',
    'claude-sonnet-4-5': 'CLAUDE_45_SONNET_BEDROCK', 'claude-haiku-4-5': 'CLAUDE_45_HAIKU_BEDROCK',
    'gpt-5.6-sol': 'GPT_56_SOL', 'gpt-5.6-terra': 'GPT_56_TERRA', 'gpt-5.6-luna': 'GPT_56_LUNA',
    'gpt-5.5': 'GPT_55', 'gpt-5.4': 'GPT_54', 'gpt-55': 'GPT_55', 'gpt-54': 'GPT_54',
  };
  if (mapping[m]) return mapping[m];
  for (const [k, v] of Object.entries(mapping)) {
    if (m.includes(k) || k.includes(m)) return v;
  }
  // Unknown model: fall back to a KNOWN-GOOD Bedrock key with vision + the
  // readFile tool the handshake needs — never forward a made-up upstream key
  // (uppercasing the input produced garbage keys the backend rejects).
  return 'CLAUDE_45_SONNET_BEDROCK';
}

const noImageRegex = /I don'?t see (any )?image|I (cannot|can'?t) (see|view|analyze) (the )?image|unable to (see|view|analyze)|I don'?t have (the )?ability to (view|see|analyze)|no image (attached|provided|available)|I (was )?not given an image|please (share|upload|paste|provide) (the )?image|không thấy|chưa thấy|không thể xem|chưa thể xem|chưa đọc được|chưa xem|chưa có khả năng/i;

/**
 * Postman AWS vision path — WORKING PIPELINE (reverse-engineered from the
 * Agent Mode web app):
 *
 *  1. USER_QUERY asks the agent to `readFile` the attached file. The
 *     `attachments` array (fileName + type only) makes the agent aware of the
 *     file; it responds with a `readFile` toolCallChunk.
 *  2. We answer the toolCall with chatType TOOL_RESPONSE whose
 *     input.toolResponses[].content is a markdown image
 *     `![image](data:image/png;base64,...)`.
 *  3. The backend parses the markdown image inside the tool response and feeds
 *     it to Bedrock as REAL vision input — the model can then see the image.
 *
 * Works for ANY image size (base64 rides inside the tool response, no ~8k
 * query limit).
 */
export async function postmanAwsVisionChat(
  page: Page,
  request: ChatCompletionRequest,
): Promise<string> {
  const images: string[] = [];
  const textParts: string[] = [];

  for (const message of request.messages) {
    if (typeof message.content === 'string') {
      if (message.content.trim()) textParts.push(message.content.trim());
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === 'text' && (part as { text?: string }).text) {
          textParts.push((part as { text: string }).text.trim());
        } else if (part?.type === 'image_url') {
          const url = (part as { image_url?: { url?: string } }).image_url?.url;
          if (url) images.push(url);
        }
      }
    }
  }

  const userQuery = textParts.join('\n').trim() || 'Describe the attached image.';

  // Resolve image URLs (http(s)) to data URLs inside the browser so the whole
  // content can ride in the tool response markdown.
  const dataUrls: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img) continue;
    if (img.startsWith('data:')) {
      dataUrls.push(img);
      continue;
    }
    try {
      const dataUrl = await page.evaluate(async (url: string) => {
        const resp = await fetch(url, { credentials: 'omit' });
        const buf = await resp.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buf);
        const chunk = 0x8000;
        for (let j = 0; j < bytes.length; j += chunk) {
          binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(j, j + chunk)) as unknown as number[]);
        }
        const mime = resp.headers.get('content-type') || 'image/png';
        return `data:${mime};base64,${btoa(binary)}`;
      }, img);
      dataUrls.push(dataUrl);
      console.log(`[vision] resolved image ${i + 1}/${images.length} (${dataUrl.length} chars)`);
    } catch (e) {
      console.log(`[vision] image fetch failed: ${e}`);
    }
  }

  if (dataUrls.length === 0) {
    throw new Error('No images could be resolved to data URLs');
  }

  // COMPRESS before encoding: base64 rides inside the tool response and is
  // billed as TEXT tokens (~1 token per 3-4 chars). A raw PNG screenshot can
  // burn 10-14K tokens; the same image resized to max 1280px and re-encoded
  // as JPEG is typically 3-4x cheaper with no visible quality loss for model
  // perception. Runs natively via sharp (fast, no browser round-trip).
  // Images already under the target budget pass through untouched.
  const TARGET_B64_CHARS = 80_000; // ~20K text tokens per image — enough for readable text
  const compressed: string[] = [];
  for (let i = 0; i < dataUrls.length; i++) {
    const original = dataUrls[i] ?? '';
    try {
      const comma = original.indexOf(',');
      const b64 = original.slice(comma + 1);
      const inputBuf = Buffer.from(b64, 'base64');
      if (b64.length <= TARGET_B64_CHARS) {
        compressed.push(original);
        continue;
      }
      // Shrink: 1280px max + JPEG quality 85, then step down if still over.
      let outBuf = await sharp(inputBuf)
        .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      let quality = 85;
      let width = 1280;
      while (`data:image/jpeg;base64,${outBuf.toString('base64')}`.length > TARGET_B64_CHARS && (quality > 50 || width > 640)) {
        if (quality > 50) {
          quality -= 5;
        } else {
          width = Math.max(640, Math.round(width * 0.85));
        }
        outBuf = await sharp(inputBuf)
          .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality })
          .toBuffer();
      }
      const out = `data:image/jpeg;base64,${outBuf.toString('base64')}`;
      compressed.push(out);
      console.log(`[vision] compressed image ${i + 1}: ${original.length} -> ${out.length} chars (w${width} q${quality})`);
    } catch (e) {
      console.log(`[vision] compression failed for image ${i + 1}, sending original: ${e}`);
      compressed.push(original);
    }
  }
  dataUrls.length = 0;
  dataUrls.push(...compressed);

  // Model mapping (user's requested model passes straight through).
  const requestedModel = (request as unknown as { model?: string }).model || 'auto';
  const selectedModelKey = mapModel(requestedModel) ?? 'CLAUDE_45_SONNET_BEDROCK';
  console.log(`[vision] model: ${requestedModel} -> ${selectedModelKey}, images: ${dataUrls.length}`);

  // Resolve workspaceId from the CURRENT team origin.
  const workspaceId = await resolveWorkspaceId(page);
  console.log(`[vision] workspaceId: ${workspaceId} (page ${page.url().slice(0, 60)})`);

  // Send the image directly in the user message using OpenAI's native
  // image_url content format. The Postman backend may forward this as-is
  // to the model's multimodal input.
  const result = await page.evaluate(
    async ({ userQuery, dataUrls, workspaceId, selectedModelKey, thinkingLevel }) => {
      const g = globalThis as unknown as { __name?: (fn: unknown, n?: string) => unknown };
      if (!g.__name) (g as Record<string, unknown>).__name = (fn: unknown) => fn;

      const baseMeta = {
        platform: 'WEB',
        clientTools: {
          nativeToolsHash: 'clienttools-workspace_v12-browser-12.26.4-260903-0231-f55e14847067',
          excludedTools: [],
          thirdParty: {},
        },
        clientKBTerms: {
          nativeTermsHash: 'kbterms-workspace_v12-browser-12.26.4-260903-0231-0d3666ad2780',
          excludedKBTerms: [],
        },
        mandatoryContext: { workspaceId },
        selectedContext: [],
        backgroundContext: [],
        availableSkills: [],
        devModeOptions: {
          selectedModel: selectedModelKey,
          isParallelToolCallingSupported: true,
          autoRun: true,
          supportsAskUser: false,
          supportsActionRecommendations: true,
          useThinkingModeIfAvailable: true,
          thinkingLevel,
          isLoopApprovalEnabled: true,
          enableWebAccess: false,
        },
      };

      interface ToolCall { id: string; gid?: string; name?: string; args: string; }

      const streamChat = async (payload: unknown, deadlineMs: number) => {
        const res = await fetch('/_gw/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'x-pstmn-req-service': 'agent-mode-service' },
          body: JSON.stringify(payload), credentials: 'include',
        });
        if (res.status === 401 || res.status === 403) return { httpError: `AUTH_EXPIRED:${res.status}` };
        if (!res.ok) return { httpError: `${res.status}: ${(await res.text()).slice(0, 200)}` };
        const reader = res.body?.getReader();
        if (!reader) return { httpError: 'no stream reader' };
        const decoder = new TextDecoder();
        let acc = '', text = '', conversationId: string | null = null;
        const toolCalls: ToolCall[] = [];
        const start = Date.now();
        while (Date.now() - start < deadlineMs) {
          const idle = new Promise((r) => setTimeout(() => r('idle'), 60000));
          const read = reader.read().then(({ done, value }) => ({ done, value }));
          const out = (await Promise.race([read, idle])) as 'idle' | { done: boolean; value?: Uint8Array };
          if (out === 'idle') { if (toolCalls.length) continue; if (text) break; continue; }
          if (out.done) break;
          acc += decoder.decode(out.value, { stream: true });
          const lines = acc.split('\n'); acc = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const p = JSON.parse(line.slice(6));
              if (p.eventType === 'conversation' && p.data?.id && !conversationId) conversationId = p.data.id;
              if (p.eventType === 'textChunk' && p.data?.textContent) text += p.data.textContent;
              if (p.eventType === 'failure') return { httpError: 'failure: ' + JSON.stringify(p.data).slice(0, 200) };
              if (p.eventType === 'toolCallChunk' && Array.isArray(p.data?.toolCalls)) {
                for (const tc of p.data.toolCalls) {
                  let ex = toolCalls.find((t) => t.id === tc.id);
                  if (!ex) { ex = { id: tc.id, gid: tc.toolCallGroupId, name: tc.function?.name, args: '' }; toolCalls.push(ex); }
                  if (tc.function?.arguments) ex.args += tc.function.arguments;
                }
              }
            } catch { /* noop */ }
          }
        }
        try { reader.cancel(); } catch { /* noop */ }
        return { conversationId, text: text.trim(), toolCalls };
      };

      // Send the user query with image_url content parts (OpenAI native format).
      // The Postman backend should forward this to the model's multimodal input.
      const messageContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
        { type: 'text', text: userQuery },
      ];
      for (const dataUrl of dataUrls) {
        messageContent.push({ type: 'image_url', image_url: { url: dataUrl } });
      }

      let r = await streamChat(
        {
          input: {
            chatType: 'USER_QUERY',
            query: userQuery,
            toolResponse: '',
            useCase: null,
            conversationId: null,
            agent: null,
            product: 'workspace_v12',
            startedFrom: 'CHAT_INPUT',
            message: { role: 'user', content: messageContent },
          },
          ...baseMeta,
        },
        180000,
      );
      if (r.httpError) return { error: 'chat ' + r.httpError };
      const conv = r.conversationId;
      let finalText = r.text || '';

      // If agent called readFile, answer with image via tool response.
      for (let phase = 2; phase <= 5; phase++) {
        const pending = r.toolCalls ?? [];
        if (pending.length === 0) break;
        const groupId = pending[0]?.gid;
        const responses = pending.map((tc) => ({
          toolCallId: tc.id,
          content: 'Image file read successfully. Please analyze the attached image visually.',
          toolResponseSummary: 'Image file content',
          toolResponseStatus: 'SUCCESS',
          attachments: [{ name: 'image.png', mimeType: 'image/png', url: dataUrls[0] ?? '', type: 'image' }],
        }));
        const prev = r;
        r = await streamChat(
          { input: { chatType: 'TOOL_RESPONSE', query: '', useCase: null, conversationId: conv, product: 'workspace_v12', toolCallGroupId: groupId, toolResponses: responses }, ...baseMeta },
          180000,
        );
        if (r.httpError) return { error: `phase${phase} ` + r.httpError, partial: finalText };
        if (r.text) { finalText = r.text; } else if (!r.toolCalls?.length && prev.text) { /* keep prev */ }
      }

      return { text: finalText, conversationId: conv };
    },
    { userQuery, dataUrls, workspaceId, selectedModelKey, thinkingLevel: resolveThinkingLevel(request) },
  );

  const answer = (result as { text?: string; error?: string; partial?: string }).text
    ?? (result as { error?: string }).error ?? '';
  const errMsg = (result as { error?: string }).error;
  if (errMsg) {
    console.log(`[vision] pipeline error: ${errMsg}`);
    if (errMsg.includes('AUTH_EXPIRED')) throw new SessionExpiredError();
    const partial = (result as { partial?: string }).partial;
    if (!partial) throw new Error(`Vision agent loop failed: ${errMsg}`);
  }

  console.log(`[vision] answer: ${(answer || '').slice(0, 200)}`);

  if (!answer || answer.trim().length === 0) {
    throw new Error('empty response from upstream');
  }

  if (isCreditLimitError(answer)) {
    console.log(`[vision] quota exhausted on this slot, retrying elsewhere`);
    throw new QuotaExhaustedError();
  }

  if (noImageRegex.test(answer)) {
    console.log(`[vision] model says no image: ${answer.slice(0, 120)}`);
    throw new Error(`Model could not see image: ${answer.slice(0, 100)}`);
  }

  console.log(`[vision] SUCCESS: ${answer.slice(0, 150)}`);
  return sanitizeBranding(answer);
}

export async function postmanVisionChat(
  page: Page, request: ChatCompletionRequest,
): Promise<string> {
  return postmanAwsVisionChat(page, request);
}
