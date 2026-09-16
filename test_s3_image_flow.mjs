/**
 * Full end-to-end image flow test:
 * 1. Presign via Postman /_gw/attachments/presign
 * 2. PUT the image bytes to the S3 presigned URL
 * 3. Send a USER_QUERY with the attachment reference
 */
import fs from 'node:fs';
import path from 'node:path';

const PAGE_URL = 'https://pmkzqm7shd77-6336972.postman.co';

async function main() {
  // Use the bridge's admin debug endpoint infrastructure indirectly: we
  // perform everything in-page via a custom debug call. For this script we
  // use Playwright directly with the existing profile.
  const { chromium } = await import('playwright-core');
  const profileDir = path.resolve('.postman-profile');
  const context = await chromium.connectOverCDP('http://127.0.0.1:9222').catch(() => null);

  let page;
  if (context) {
    page = context.contexts()[0]?.pages()?.find((p) => p.url().includes('postman'));
  }
  if (!page) {
    console.log('No CDP page; launch persistent profile instead');
    const ctx = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      channel: 'chrome',
      args: ['--disable-blink-features=AutomationControlled'],
    });
    page = ctx.pages().find((p) => p.url().includes('postman')) ?? ctx.pages()[0];
  }

  // Step 1: presign for a real 10x10 red PNG.
  const pngB64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FAPwHBWLY9X5zAAAAAElFTkSuQmCC';
  const pngBytes = Buffer.from(pngB64, 'base64');
  const byteSize = pngBytes.byteLength;

  const presign = await page.evaluate(async ({ byteSize }) => {
    const res = await fetch('/_gw/attachments/presign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-pstmn-req-service': 'agent-mode-service',
      },
      body: JSON.stringify({
        attachments: [{ fileName: 'red.png', mimeType: 'image/png', byteSize }],
      }),
      credentials: 'include',
    });
    return { status: res.status, body: await res.json() };
  }, { byteSize });
  console.log('presign status:', presign.status);
  const att = presign.body?.attachments?.[0];
  if (!att?.uploadUrl) {
    console.log('presign failed:', JSON.stringify(presign.body).slice(0, 500));
    return;
  }
  console.log('attachment id:', att.id);

  // Step 2: upload the PNG bytes to S3 via the presigned PUT URL.
  const upload = await page.evaluate(
    async ({ uploadUrl, bytes }) => {
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: new Uint8Array(bytes),
      });
      return { status: res.status, text: (await res.text()).slice(0, 300) };
    },
    { uploadUrl: att.uploadUrl, bytes: Array.from(pngBytes) },
  );
  console.log('S3 upload status:', upload.status);
  if (upload.status !== 200) {
    console.log('upload body:', upload.text);
    return;
  }

  // Step 3: send USER_QUERY referencing the uploaded artifact.
  // Try plausible attachment reference shapes.
  const conversation = await page.evaluate(async ({ attId, byteSize }) => {
    const buildPayload = (attachShape) => ({
      input: {
        chatType: 'USER_QUERY',
        query: 'What color is the attached image? Answer with only the color name.',
        toolResponse: '',
        useCase: null,
        conversationId: null,
        agent: null,
        product: 'workspace_v12',
        startedFrom: 'CHAT_INPUT',
      },
      platform: 'WEB',
      clientTools: {
        nativeToolsHash: 'clienttools-workspace_v12-browser-12.25.7-260828-0231-5c379ffbb1ff',
        excludedTools: ['generateSyntheticDataFile', 'storeGeneratedDataFile', 'appendDataToDatasource', 'generateFlowCiCdCommand', 'askUser'],
        thirdParty: {},
      },
      clientKBTerms: {
        nativeTermsHash: 'kbterms-workspace_v12-browser-12.25.7-260828-0231-802b20472456',
        excludedKBTerms: [],
      },
      mandatoryContext: { workspaceId: '6395e8dd-6e6b-4ae4-8a07-cfd9f4eb9b20' },
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
      ...attachShape,
    });

    const shapes = [
      { attachments: [{ id: attId, mimeType: 'image/png', byteSize }] },
      { input: { attachments: [{ id: attId, mimeType: 'image/png', byteSize }] } },
      { selectedContext: [{ type: 'ATTACHMENT', value: { id: attId, mimeType: 'image/png' } }] },
    ];

    const results = [];
    for (const shape of shapes) {
      const res = await fetch('/_gw/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'x-pstmn-req-service': 'agent-mode-service',
        },
        body: JSON.stringify(buildPayload(shape)),
        credentials: 'include',
      });
      const reader = res.body?.getReader();
      if (!reader) { results.push({ status: res.status, text: 'no body' }); continue; }
      const decoder = new TextDecoder();
      let acc = '';
      const texts = [];
      const deadline = Date.now() + 45000;
      let saw = 0;
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        const lines = acc.split('\n');
        acc = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          saw++;
          const d = line.slice(6);
          try {
            const parsed = JSON.parse(d);
            if (parsed.eventType === 'textChunk' && parsed.data?.textContent) {
              texts.push(parsed.data.textContent);
            }
            if (parsed.eventType === 'failure') {
              texts.push('FAILURE: ' + JSON.stringify(parsed.data).slice(0, 200));
            }
          } catch { /* ignore */ }
        }
        if (saw > 400) break;
      }
      results.push({ status: res.status, answer: texts.join('') });
    }
    return results;
  }, { attId: att.id, byteSize });

  conversation.forEach((r, i) => {
    console.log(`\n=== Shape ${i}: status ${r.status} ===`);
    console.log('Answer:', (r.answer || '(none)').slice(0, 400));
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
