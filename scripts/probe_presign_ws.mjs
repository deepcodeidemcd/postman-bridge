// Probe: does /_gw/attachments/presign honor an explicit workspaceId (body/header)?
// We compare the returned artifact id S3-path for each variant. If the path
// embeds a workspace-internal id, the variant that matches our chosen
// workspace is the one to use in the vision flow.
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

// 1) our real workspace id
const wsId = await page.evaluate(async () => {
  const g = globalThis; if (!g.__name) g.__name = (f) => f;
  const r = await fetch('/_api/ws/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service: 'workspaces', method: 'get', path: '/workspaces' }), credentials: 'include' });
  const d = await r.json();
  return d.data?.[0]?.id ?? null;
});
console.log('workspaceId:', wsId);

// 2) presign variants
const out = await page.evaluate(async (ws) => {
  const g = globalThis; if (!g.__name) g.__name = (f) => f;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const binary = atob(png);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const meta = { fileName: `probe_${Math.random().toString(16).slice(2)}.png`, mimeType: 'image/png', byteSize: bytes.byteLength };

  const call = async (label, body, headers) => {
    try {
      const r = await fetch('/_gw/attachments/presign', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pstmn-req-service': 'agent-mode-service', ...headers }, body: JSON.stringify(body), credentials: 'include' });
      const t = await r.text();
      let id = null; try { id = JSON.parse(t)?.attachments?.[0]?.id; } catch {}
      return `${label}: ${r.status} id=${id}`;
    } catch (e) { return `${label}: ERR ${e.message}`; }
  };

  const results = [];
  results.push(await call('plain', { attachments: [meta] }, {}));
  results.push(await call('body.workspaceId', { workspaceId: ws, attachments: [meta] }, {}));
  results.push(await call('header x-pstmn-workspace-id', { attachments: [meta] }, { 'x-pstmn-workspace-id': ws }));
  results.push(await call('header x-workspace-id', { attachments: [meta] }, { 'x-workspace-id': ws }));
  results.push(await call('query ?workspaceId', { attachments: [meta] }, {}) );
  // query param variant
  try {
    const r = await fetch(`/_gw/attachments/presign?workspaceId=${ws}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pstmn-req-service': 'agent-mode-service' }, body: JSON.stringify({ attachments: [meta] }), credentials: 'include' });
    const t = await r.text(); let id = null; try { id = JSON.parse(t)?.attachments?.[0]?.id; } catch {}
    results.push(`query param: ${r.status} id=${id}`);
  } catch (e) { results.push('query param: ERR ' + e.message); }
  return results;
}, wsId);

console.log('--- presign variants (compare artifact id paths) ---');
for (const l of out) console.log(' ', l);

await browser.close();
