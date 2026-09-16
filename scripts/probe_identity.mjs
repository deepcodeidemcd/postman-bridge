// Quick probe: with a saved session, find the reliable in-app identity API.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const EMAIL = process.argv[2] || 'pm77yqii5lcj@uberip.com';
function safeName(email) {
  const base = email.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 40);
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0;
  return `${base}_${h.toString(16)}`;
}
const sp = `.sessions/${safeName(EMAIL)}.json`;
const state = JSON.parse(fs.readFileSync(sp, 'utf-8'));
const team = state.origins?.[0]?.origin || 'https://www.postman.com';

const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ storageState: sp });
const page = await ctx.newPage();
await page.goto(`${team}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(6000);
console.log('landed:', page.url().slice(0, 90));

const probes = await page.evaluate(async () => {
  const out = [];
  const tries = [
    { label: 'identity /users/me', body: { service: 'identity', method: 'get', path: '/users/me' } },
    { label: 'users /user', body: { service: 'users', method: 'get', path: '/user' } },
    { label: 'ui /user', body: { service: 'ui', method: 'get', path: '/user' } },
    { label: 'auth /user', body: { service: 'auth', method: 'get', path: '/user' } },
  ];
  for (const t of tries) {
    try {
      const res = await fetch('/_api/ws/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(t.body),
        credentials: 'include',
      });
      const text = await res.text();
      out.push({ label: t.label, status: res.status, body: text.slice(0, 300) });
    } catch (e) {
      out.push({ label: t.label, status: 0, body: String(e).slice(0, 100) });
    }
  }
  return out;
});
for (const p of probes) console.log(p.label, '->', p.status, p.body.replace(/\s+/g, ' ').slice(0, 220));
await browser.close();
