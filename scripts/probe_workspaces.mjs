// Probe: from a logged-in team page, find the workspaces API + a real workspaceId.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const EMAIL = process.argv[2] || 'pmukfxig0tx3@uberip.com';
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

// capture what requests the app itself makes for workspaces
const seen = [];
page.on('request', (r) => {
  const u = r.url();
  if (/workspace|entities|folder/i.test(u) && !/\.js|\.css|\.png|\.svg/i.test(u)) seen.push(`${r.method()} ${u.slice(0, 110)}`);
});
await page.goto(`${team}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(12000);
console.log('--- app requests mentioning workspace ---');
for (const s of [...new Set(seen)].slice(0, 12)) console.log(' ', s);

const res = await page.evaluate(async () => {
  const out = {};
  const tries = [
    ['workspaces GET', '/_api/ws/proxy', { service: 'workspaces', method: 'get', path: '/workspaces' }],
    ['entities GET', '/_api/ws/proxy', { service: 'entities', method: 'get', path: '/workspaces' }],
    ['direct /workspaces', '/workspaces', null],
    ['api v1 workspaces', 'https://api.getpostman.com/workspaces', null],
  ];
  for (const [label, url, body] of tries) {
    try {
      const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'include' } : { credentials: 'include' });
      const t = await r.text();
      out[label] = `${r.status}: ${t.slice(0, 400)}`;
    } catch (e) { out[label] = 'ERR ' + e.message; }
  }
  return out;
});
for (const [k, v] of Object.entries(res)) console.log(`\n[${k}]\n${v}`);
await browser.close();
