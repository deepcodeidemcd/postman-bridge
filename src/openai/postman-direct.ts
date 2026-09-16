import type { Page } from 'playwright-core';
import crypto from 'node:crypto';

/**
 * Direct Postman server API client.
 *
 * Postman Agent Mode chat accepts server-side image attachments that live in
 * AWS S3. The flow (discovered by reverse-engineering the web app):
 *   1. POST /_gw/attachments/presign  ->  S3 presigned upload URL + artifact id
 *   2. PUT image bytes to the S3 presigned URL
 *   3. POST /_gw/chat with `attachments: [{ id, mimeType, byteSize, url }]`
 *      and the model can actually see the image (verified: returns "Red" for a
 *      red PNG).
 *
 * All calls run inside the browser page context so the Postman session cookies
 * are sent automatically (`credentials: 'include'`).
 */

export interface PostmanAttachment {
  id: string;
  mimeType: string;
  byteSize: number;
  url: string;
}

export interface ChatEvent {
  eventType: string;
  data: unknown;
}

interface WorkspaceContext {
  workspaceId: string;
  nativeToolsHash: string;
  kbTermsHash: string;
  product: string;
}

function defaultContext(): WorkspaceContext {
  return {
    workspaceId: '6395e8dd-6e6b-4ae4-8a07-cfd9f4eb9b20',
    nativeToolsHash: 'clienttools-workspace_v12-browser-12.26.4-260903-0231-f55e14847067',
    kbTermsHash: 'kbterms-workspace_v12-browser-12.26.4-260903-0231-0d3666ad2780',
    product: 'workspace_v12',
  };
}

function buildBasePayload(ctx: WorkspaceContext): Record<string, unknown> {
  return {
    platform: 'WEB',
    clientTools: {
      nativeToolsHash: ctx.nativeToolsHash,
      excludedTools: [
        'generateSyntheticDataFile',
        'storeGeneratedDataFile',
        'appendDataToDatasource',
        'generateFlowCiCdCommand',
        'askUser',
      ],
      thirdParty: {},
    },
    clientKBTerms: {
      nativeTermsHash: ctx.kbTermsHash,
      excludedKBTerms: [],
    },
    mandatoryContext: { workspaceId: ctx.workspaceId },
    selectedContext: [],
    backgroundContext: [],
    availableSkills: [],
    devModeOptions: {
      selectedModel: null,
      isParallelToolCallingSupported: true,
      autoRun: false,
      supportsAskUser: false,
      supportsActionRecommendations: true,
      useThinkingModeIfAvailable: true,
      thinkingLevel: 'medium',
      isLoopApprovalEnabled: true,
      enableWebAccess: true,
    },
  };
}

/**
 * Uploads an image (data URL or http URL) to Postman's S3 artifact store and
 * returns the attachment reference that the chat API understands.
 */
export async function uploadImageToPostman(
  page: Page,
  image: string,
  workspaceId?: string,
): Promise<PostmanAttachment> {
  // Resolve the image to raw bytes inside the browser (fetch for http URLs,
  // decode for data URLs).
  const resolved = await page.evaluate(async (img) => {
    if (img.startsWith('data:')) {
      const comma = img.indexOf(',');
      const b64 = img.slice(comma + 1);
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const mime = /data:([^;]+)/.exec(img)?.[1] ?? 'image/png';
      return { bytes: Array.from(bytes), mimeType: mime, byteSize: bytes.byteLength };
    }
    const resp = await fetch(img, { credentials: 'omit' });
    const buf = new Uint8Array(await resp.arrayBuffer());
    const mime = resp.headers.get('content-type') || 'image/png';
    return { bytes: Array.from(buf), mimeType: mime, byteSize: buf.byteLength };
  }, image);

  const ctx = defaultContext();
  const fileName = `image_${crypto.randomBytes(6).toString('hex')}.png`;

  // 1) Presign.
  const presign = await page.evaluate(
    async ({ fileName, mimeType, byteSize, ctx }) => {
      const res = await fetch('/_gw/attachments/presign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-pstmn-req-service': 'agent-mode-service',
        },
        body: JSON.stringify({
          attachments: [{ fileName, mimeType, byteSize }],
        }),
        credentials: 'include',
      });
      if (!res.ok) {
        throw new Error(`presign failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      return res.json();
    },
    { fileName, mimeType: resolved.mimeType, byteSize: resolved.byteSize, ctx },
  );

  const att = presign?.attachments?.[0];
  if (!att?.uploadUrl || !att?.id) {
    throw new Error('presign response missing uploadUrl/id: ' + JSON.stringify(presign).slice(0, 300));
  }
  console.log(`[presign] att keys: ${Object.keys(att).join(', ')} readUrl=${(att.readUrl || '').slice(0, 120)}`);

  // 2) PUT bytes to S3.
  const uploadStatus = await page.evaluate(
    async ({ uploadUrl, mimeType, bytes }) => {
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': mimeType },
        body: new Uint8Array(bytes),
      });
      return res.status;
    },
    { uploadUrl: att.uploadUrl, mimeType: resolved.mimeType, bytes: resolved.bytes },
  );
  if (uploadStatus !== 200) {
    throw new Error(`S3 upload failed with status ${uploadStatus}`);
  }

  // Use readUrl if provided (keep it FULLY SIGNED — the backend fetches this
  // URL server-side to read the artifact; stripping the querystring makes the
  // object private/unfetchable and the model reports "no image").
  const readUrl = att.readUrl as string | undefined;
  const fallbackUrl = `https://us-prod-agent-mode-chat-artifacts.s3.us-east-1.amazonaws.com/${att.id}`;
  return {
    id: att.id,
    mimeType: resolved.mimeType,
    byteSize: resolved.byteSize,
    url: readUrl || fallbackUrl,
  };
}

export interface DirectChatOptions {
  query: string;
  attachments?: PostmanAttachment[];
  conversationId?: string | null;
  thinkingLevel?: 'low' | 'medium' | 'high';
  selectedModel?: string | null;
  timeoutMs?: number;
  onEvent?: (event: ChatEvent) => void;
}

/**
 * Sends a chat query directly to the Postman backend and collects text chunks.
 * Returns the accumulated assistant answer.
 */
export async function directChat(
  page: Page,
  options: DirectChatOptions,
): Promise<string> {
  const ctx = defaultContext();
  const payload: Record<string, unknown> = {
    input: {
      chatType: 'USER_QUERY',
      query: options.query,
      toolResponse: '',
      useCase: null,
      conversationId: options.conversationId ?? null,
      agent: null,
      product: ctx.product,
      startedFrom: 'CHAT_INPUT',
    },
    ...buildBasePayload(ctx),
  };
  (payload as { devModeOptions: Record<string, unknown> }).devModeOptions = {
    ...(payload as { devModeOptions: Record<string, unknown> }).devModeOptions,
    thinkingLevel: options.thinkingLevel ?? 'medium',
    selectedModel: options.selectedModel ?? null,
  };

  if (options.attachments?.length) {
    payload.attachments = options.attachments.map((a) => ({
      id: a.id,
      mimeType: a.mimeType,
      byteSize: a.byteSize,
      url: a.url,
    }));
  }

  const timeoutMs = options.timeoutMs ?? 120_000;
  const result = await page.evaluate(
    async ({ payload, timeoutMs }) => {
      const res = await fetch('/_gw/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'x-pstmn-req-service': 'agent-mode-service',
        },
        body: JSON.stringify(payload),
        credentials: 'include',
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`chat failed ${res.status}: ${text.slice(0, 300)}`);
      }
      const reader = res.body?.getReader();
      if (!reader) return { text: '', events: [] };

      const decoder = new TextDecoder();
      let acc = '';
      let full = '';
      const events: Array<{ eventType: string; data: string }> = [];
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        const lines = acc.split('\n');
        acc = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed.eventType === 'textChunk' && parsed.data?.textContent) {
              full += parsed.data.textContent;
            }
            if (parsed.eventType === 'failure') {
              throw new Error('chat failure: ' + JSON.stringify(parsed.data).slice(0, 200));
            }
            events.push({ eventType: parsed.eventType ?? 'raw', data: JSON.stringify(parsed.data).slice(0, 500) });
          } catch (e) {
            if (e instanceof Error && e.message.startsWith('chat failure')) throw e;
            // ignore non-JSON keepalive lines
          }
        }
      }
      return { text: full, events };
    },
    { payload, timeoutMs },
  );

  return result.text;
}
