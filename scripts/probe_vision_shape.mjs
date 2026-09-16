// Probe which chat payload shape makes the Postman backend feed an uploaded S3
// image as REAL vision input. Uses a red 1x1 PNG and asks "what color".
// Each shape runs as its own conversation and reports text or failure.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const EMAIL = process.argv[2] || 'pmvw0jemgwv5@uberip.com';
function safeName(email) {
  const base = email.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 40);
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0;
  return `${base}_${h.toString(16)}`;
}
const sp = `.sessions/${safeName(EMAIL)}.json`;
const state = JSON.parse(fs.readFileSync(sp, 'utf-8'));
const team = state.origins?.[0]?.origin || 'https://www.postman.com';
console.log('email:', EMAIL, 'team:', team);

const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ storageState: sp });
const page = await ctx.newPage();
await page.goto(`${team}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(8000);

const res = await page.evaluate(async () => {
  const g = globalThis; if (!g.__name) g.__name = (f) => f;

  const wsId = await (async () => {
    const r = await fetch('/_api/ws/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service: 'workspaces', method: 'get', path: '/workspaces' }), credentials: 'include' });
    return (await r.json()).data?.[0]?.id ?? null;
  })();

  // red 20x20 png
  function makeRedPngDataUrl() {
    // Build a small red PNG via canvas.
    const c = document.createElement('canvas'); c.width = 40; c.height = 40;
    const x = c.getContext('2d'); x.fillStyle = 'rgb(255,0,0)'; x.fillRect(0, 0, 40, 40);
    return c.toDataURL('image/png');
  }
  const dataUrl = makeRedPngDataUrl();
  const comma = dataUrl.indexOf(',');
  const b64 = dataUrl.slice(comma + 1);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const byteSize = bytes.byteLength;

  // presign + upload
  const fname = `red_${Math.random().toString(16).slice(2)}.png`;
  const pr = await fetch('/_gw/attachments/presign', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pstmn-req-service': 'agent-mode-service' }, body: JSON.stringify({ attachments: [{ fileName: fname, mimeType: 'image/png', byteSize }] }), credentials: 'include' });
  const pj = await pr.json();
  const att = pj.attachments?.[0];
  if (!att?.uploadUrl) return { error: 'no presign', wsId };
  await fetch(att.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytes });
  const attRef = { id: att.id, mimeType: 'image/png', byteSize, url: att.readUrl || `https://us-prod-agent-mode-chat-artifacts.s3.us-east-1.amazonaws.com/${att.id}` };
  console.log('att', att.id);

  const baseMeta = () => ({
    platform: 'WEB',
    clientTools: { nativeToolsHash: 'clienttools-workspace_v12-browser-12.26.4-260903-0231-f55e14847067', excludedTools: [], thirdParty: {} },
    clientKBTerms: { nativeTermsHash: 'kbterms-workspace_v12-browser-12.26.4-260903-0231-0d3666ad2780', excludedKBTerms: [] },
    mandatoryContext: { workspaceId: wsId },
    selectedContext: [], backgroundContext: [], availableSkills: [],
    devModeOptions: { selectedModel: 'CLAUDE_45_SONNET_BEDROCK', isParallelToolCallingSupported: true, autoRun: true, supportsAskUser: false, supportsActionRecommendations: true, useThinkingModeIfAvailable: false, thinkingLevel: 'low', isLoopApprovalEnabled: true, enableWebAccess: false },
  });

  const streamChat = async (payload, deadlineMs = 120000) => {
    const r0 = await fetch('/_gw/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'x-pstmn-req-service': 'agent-mode-service' }, body: JSON.stringify(payload), credentials: 'include' });
    if (!r0.ok) return { http: `${r0.status} ${(await r0.text()).slice(0,160)}` };
    const rd = r0.body.getReader(); const dec = new TextDecoder();
    let acc = '', text = '', conv = null, failure = null; const tools = [];
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
      const { done, value } = await rd.read(); if (done) break;
      acc += dec.decode(value, { stream: true });
      const lines = acc.split('\n'); acc = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try { const p = JSON.parse(line.slice(6));
          if (p.eventType === 'conversation' && p.data?.id && !conv) conv = p.data.id;
          if (p.eventType === 'textChunk' && p.data?.textContent) text += p.data.textContent;
          if (p.eventType === 'failure') failure = JSON.stringify(p.data).slice(0, 200);
          if (p.eventType === 'toolCallChunk' && Array.isArray(p.data?.toolCalls)) for (const tc of p.data.toolCalls) tools.push(tc.function?.name);
        } catch {}
      }
    }
    try { rd.cancel(); } catch {}
    return { text: text.trim(), conv, failure, tools };
  };

  const Q = 'What is the single dominant color of this image? Answer with just the color name.';
  const results = { wsId, att: attRef.id };

  // Shape 1: USER_QUERY with top-level attachments[]
  results.s1 = await streamChat({ input: { chatType: 'USER_QUERY', query: Q, toolResponse: '', useCase: null, conversationId: null, agent: null, product: 'workspace_v12', startedFrom: 'CHAT_INPUT' }, ...baseMeta(), attachments: [attRef] });

  // Shape 2: USER_QUERY attachments + backgroundContext IMAGE
  results.s2 = await streamChat({ input: { chatType: 'USER_QUERY', query: Q, toolResponse: '', useCase: null, conversationId: null, agent: null, product: 'workspace_v12', startedFrom: 'CHAT_INPUT' }, ...baseMeta(), attachments: [attRef], backgroundContext: [{ type: 'IMAGE', value: { id: attRef.id, url: attRef.url } }] });

  // Shape 3: input.attachments (inside input)
  results.s3 = await streamChat({ input: { chatType: 'USER_QUERY', query: Q, toolResponse: '', useCase: null, conversationId: null, agent: null, product: 'workspace_v12', startedFrom: 'CHAT_INPUT', attachments: [attRef] }, ...baseMeta() });

  // Shape 4: selectedContext IMAGE
  results.s4 = await streamChat({ input: { chatType: 'USER_QUERY', query: Q, toolResponse: '', useCase: null, conversationId: null, agent: null, product: 'workspace_v12', startedFrom: 'CHAT_INPUT' }, ...baseMeta(), selectedContext: [{ type: 'IMAGE', value: { id: attRef.id, url: attRef.url } }] });

  // Shape 5: two-step — ask readFile, then TOOL_RESPONSE with attachments
  {
    const first = await streamChat({ input: { chatType: 'USER_QUERY', query: `Use the readFile tool to open ${fname} and tell me its dominant color.`, toolResponse: '', useCase: null, conversationId: null, agent: null, product: 'workspace_v12', startedFrom: 'CHAT_INPUT' }, ...baseMeta(), attachments: [attRef] });
    let second = null;
    if (first.conv && first.tools?.length) {
      second = await streamChat({ input: { chatType: 'TOOL_RESPONSE', query: '', useCase: null, conversationId: first.conv, product: 'workspace_v12', toolCallGroupId: null, toolResponses: [{ toolCallId: 'call_1', content: `The file ${fname} is a red square.`, toolResponseSummary: 'red', toolResponseStatus: 'SUCCESS', attachments: [{ name: fname, mimeType: 'image/png', url: attRef.url, type: 'image' }] }] }, ...baseMeta() });
    }
    results.s5 = { firstTools: first.tools, firstText: (first.text||'').slice(0,120), second };
  }

  return results;
});

console.log(JSON.stringify(res, null, 2));
await browser.close();
