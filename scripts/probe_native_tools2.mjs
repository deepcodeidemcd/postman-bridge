// Probe v2: force a NATIVE Agent-Mode tool and dump every raw eventType + a
// toolCallChunk sample so evidence unambiguously shows the server-side loop.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const EMAIL = process.argv[2] || 'pmvw0jemgwv5@uberip.com';
function safeName(email) {
  const base = email.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 40);
  let h = 0; for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0;
  return `${base}_${h.toString(16)}`;
}
const sp = `.sessions/${safeName(EMAIL)}.json`;
const state = JSON.parse(fs.readFileSync(sp, 'utf-8'));
const team = state.origins?.[0]?.origin || 'https://www.postman.com';
console.log('team:', team);

const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ storageState: sp });
const page = await ctx.newPage();
await page.goto(team + '/home', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(8000);

const res = await page.evaluate(async () => {
  const g = globalThis; if (!g.__name) g.__name = (f) => f;
  const wsr = await fetch('/_api/ws/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service: 'workspaces', method: 'get', path: '/workspaces' }), credentials: 'include' });
  const wsj = await wsr.json();
  const wsId = wsj.data?.[0]?.id ?? null;

  const Q = 'Use your webSearch tool right now to look up the EXACT current price of Bitcoin in USD. You MUST call the webSearch tool first — do not answer from memory or training data. After the tool result, reply with only the number.';

  const payload = {
    input: { chatType: 'USER_QUERY', query: Q, toolResponse: '', useCase: null, conversationId: null, agent: null, product: 'workspace_v12', startedFrom: 'CHAT_INPUT' },
    platform: 'WEB',
    clientTools: { nativeToolsHash: 'clienttools-workspace_v12-browser-12.26.4-260903-0231-f55e14847067', excludedTools: [], thirdParty: {} },
    clientKBTerms: { nativeTermsHash: 'kbterms-workspace_v12-browser-12.26.4-260903-0231-0d3666ad2780', excludedKBTerms: [] },
    mandatoryContext: { workspaceId: wsId },
    selectedContext: [], backgroundContext: [], availableSkills: [],
    devModeOptions: { selectedModel: 'CLAUDE_45_SONNET_BEDROCK', isParallelToolCallingSupported: true, autoRun: true, supportsAskUser: false, supportsActionRecommendations: true, useThinkingModeIfAvailable: false, thinkingLevel: 'low', isLoopApprovalEnabled: false, enableWebAccess: true },
  };

  const r0 = await fetch('/_gw/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'x-pstmn-req-service': 'agent-mode-service' }, body: JSON.stringify(payload), credentials: 'include' });
  if (!r0.ok) return { http: r0.status + ' ' + (await r0.text()).slice(0, 300) };
  const rd = r0.body.getReader(); const dec = new TextDecoder();
  let acc = '', text = '', conv = null;
  const eventCounts = {};
  const rawLines = [];
  const toolCallChunks = [];
  const start = Date.now();
  let lastActivity = Date.now();
  while (Date.now() - start < 240000) {
    const remaining = 90000 - (Date.now() - lastActivity);
    const idle = new Promise((r) => setTimeout(() => r('idle'), Math.max(500, remaining)));
    const read = rd.read().then((x) => ({ done: x.done, value: x.value }));
    const out = await Promise.race([read, idle]);
    if (out === 'idle') { if (text) break; continue; }
    lastActivity = Date.now();
    if (out.done) break;
    acc += dec.decode(out.value, { stream: true });
    const lines = acc.split('\n'); acc = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      if (rawLines.length < 60) rawLines.push(line.slice(6, 500));
      let p; try { p = JSON.parse(line.slice(6)); } catch { continue; }
      const et = p.eventType || 'raw';
      eventCounts[et] = (eventCounts[et] || 0) + 1;
      if (et === 'conversation' && p.data && p.data.id && !conv) conv = p.data.id;
      if (et === 'textChunk' && p.data && p.data.textContent) text += p.data.textContent;
      if (/tool/i.test(et)) {
        const calls = (p.data && (p.data.toolCalls || p.data.calls)) || [];
        toolCallChunks.push({ et, names: calls.map((c) => c.function && c.function.name || c.name).filter(Boolean), sample: JSON.stringify(p.data).slice(0, 200) });
      }
      if (et === 'failure') return { failure: JSON.stringify(p.data).slice(0, 300), eventCounts, toolCallChunks, rawLines, conv };
    }
  }
  try { rd.cancel(); } catch {}
  return { wsId, conv, eventCounts, toolEventCount: toolCallChunks.length, toolEvents: toolCallChunks.slice(0, 8), rawEventLines: rawLines, finalText: text.trim().slice(0, 300) };
});

console.log(JSON.stringify(res, null, 2));
await browser.close();
