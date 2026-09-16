import type { Page } from 'playwright-core';
import type { ChatCompletionRequest } from './types.js';
import { isCreditLimitError, QuotaExhaustedError, SessionExpiredError } from '../browser/account-pool.js';
import { sanitizeBranding } from './branding.js';
import { resolveThinkingLevel, resolveWorkspaceId } from './code-chat.js';
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';

const TESSERACT_PATH = process.env.TESSERACT_PATH || 'C:\\Program Files\\Tesseract-OCR\\tesseract.exe';

function ocrImage(imagePath: string): string {
  try {
    const result = execSync(`"${TESSERACT_PATH}" "${imagePath}" stdout --oem 3 --psm 6`, {
      timeout: 15000, encoding: 'utf-8', windowsHide: true,
    });
    return result.trim();
  } catch { return ''; }
}

async function downloadImage(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmpPath = join(tmpdir(), `ocr_${crypto.randomBytes(6).toString('hex')}.png`);
  writeFileSync(tmpPath, buf);
  return tmpPath;
}

export function hasImages(request: ChatCompletionRequest): boolean {
  return request.messages.some((message) => {
    if (!Array.isArray(message.content)) return false;
    return message.content.some((part) => part?.type === 'image_url');
  });
}

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
  console.log(`[vision] OCR mode: ${images.length} image(s), query: ${userQuery.slice(0, 80)}`);

  // OCR each image
  const ocrTexts: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img) continue;
    try {
      const tmpPath = join(tmpdir(), `ocr_${crypto.randomBytes(6).toString('hex')}.png`);
      if (img.startsWith('data:')) {
        const b64 = img.slice(img.indexOf(',') + 1);
        writeFileSync(tmpPath, Buffer.from(b64, 'base64'));
      } else {
        const downloaded = await downloadImage(img);
        writeFileSync(tmpPath, readFileSync(downloaded));
        unlinkSync(downloaded);
      }
      const text = ocrImage(tmpPath);
      if (text) { ocrTexts.push(text); console.log(`[vision] OCR image ${i + 1}: ${text.length} chars`); }
      try { unlinkSync(tmpPath); } catch {}
    } catch (e) { console.log(`[vision] OCR failed for image ${i + 1}: ${e}`); }
  }

  let fullQuery = userQuery;
  if (ocrTexts.length > 0) {
    fullQuery = `The OCR from the image(s) extracted this text:\n\n${ocrTexts.join('\n---\n')}\n\nOriginal question: ${userQuery}`;
  }

  const modelKey = resolveThinkingLevel(request) === 'high' ? 'CLAUDE_45_SONNET_BEDROCK' : 'CLAUDE_45_SONNET_BEDROCK';
  const thinkingLevel = resolveThinkingLevel(request);
  const useThinking = thinkingLevel === 'high' || request.thinking === true;
  const workspaceId = await resolveWorkspaceId(page);
  console.log(`[vision] workspaceId: ${workspaceId} (page ${page.url().slice(0, 60)})`);

  const result = await page.evaluate(
    async ({ query, modelKey, workspaceId, thinkingLevel, useThinking }) => {
      const g = globalThis as unknown as { __name?: (fn: unknown, n?: string) => unknown };
      if (!g.__name) (g as Record<string, unknown>).__name = (fn: unknown) => fn;

      const payload = {
        input: { chatType: 'USER_QUERY', query, toolResponse: '', useCase: null, conversationId: null, agent: null, product: 'workspace_v12', startedFrom: 'CHAT_INPUT' },
        platform: 'WEB',
        clientTools: { nativeToolsHash: 'clienttools-workspace_v12-browser-12.26.4-260903-0231-f55e14847067', excludedTools: [], thirdParty: {} },
        clientKBTerms: { nativeTermsHash: 'kbterms-workspace_v12-browser-12.26.4-260903-0231-0d3666ad2780', excludedKBTerms: [] },
        mandatoryContext: { workspaceId }, selectedContext: [], backgroundContext: [], availableSkills: [],
        devModeOptions: { selectedModel: modelKey, isParallelToolCallingSupported: true, autoRun: true, supportsAskUser: false, supportsActionRecommendations: true, useThinkingModeIfAvailable: useThinking, thinkingLevel, isLoopApprovalEnabled: false, enableWebAccess: true },
      };

      const res = await fetch('/_gw/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'x-pstmn-req-service': 'agent-mode-service' },
        body: JSON.stringify(payload), credentials: 'include',
      });
      if (res.status === 401 || res.status === 403) return { error: `AUTH_EXPIRED:${res.status}` };
      if (!res.ok) return { error: `${res.status}: ${(await res.text()).slice(0, 200)}` };
      const reader = res.body?.getReader();
      if (!reader) return { error: 'no stream reader' };

      const decoder = new TextDecoder();
      let acc = '', text = '';
      let lastActivity = Date.now();
      const start = Date.now();
      while (Date.now() - start < 180000) {
        const remaining = 90000 - (Date.now() - lastActivity);
        const idle = new Promise((r) => setTimeout(() => r('idle'), Math.max(500, remaining)));
        const read = reader.read().then(({ done, value }) => ({ done, value }));
        const out = (await Promise.race([read, idle])) as 'idle' | { done: boolean; value?: Uint8Array };
        if (out === 'idle') { if (text) break; continue; }
        lastActivity = Date.now();
        if (out.done) break;
        acc += decoder.decode(out.value, { stream: true });
        const lines = acc.split('\n'); acc = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const p = JSON.parse(line.slice(6));
            if (p.eventType === 'textChunk' && p.data?.textContent) text += p.data.textContent;
            if (p.eventType === 'failure') return { error: 'failure: ' + JSON.stringify(p.data).slice(0, 200) };
          } catch {}
        }
      }
      try { reader.cancel(); } catch {}
      return { text: text.trim() };
    },
    { query: fullQuery, modelKey, workspaceId, thinkingLevel, useThinking },
  );

  const answer = (result as { text?: string; error?: string }).text ?? (result as { error?: string }).error ?? '';
  const errMsg = (result as { error?: string }).error;
  if (errMsg) {
    console.log(`[vision] pipeline error: ${errMsg}`);
    if (errMsg.includes('AUTH_EXPIRED')) throw new SessionExpiredError();
    throw new Error(`Vision agent loop failed: ${errMsg}`);
  }
  console.log(`[vision] answer: ${(answer || '').slice(0, 200)}`);
  if (!answer || answer.trim().length === 0) throw new SessionExpiredError();
  if (isCreditLimitError(answer)) throw new QuotaExhaustedError();
  console.log(`[vision] SUCCESS: ${answer.slice(0, 150)}`);
  return sanitizeBranding(answer);
}

export async function postmanVisionChat(
  page: Page, request: ChatCompletionRequest,
): Promise<string> {
  return postmanAwsVisionChat(page, request);
}
