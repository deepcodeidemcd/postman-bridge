// Discover the agent-mode chat route + load its bundle, then extract the
// attachment->chat-payload mapping (the field the backend reads images from).
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
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ storageState: sp });
const page = await ctx.newPage();

const bundleUrls = new Set();
page.on('request', (r) => { const u = r.url(); if (/\.min\.js|_ar-assets|\/js\//.test(u)) bundleUrls.add(u); });

// whoami to get the user slug for building chat URLs
await page.goto(`${team}/home`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(4000);
const who = await page.evaluate(async () => {
  const g = globalThis; if (!g.__name) g.__name = (f) => f;
  try { const r = await fetch('https://api.getpostman.com/me', { headers: { apikey: localStorage.getItem('pmapikey') || '' }, credentials: 'include' }); return await r.text(); } catch { return null; }
}).catch(() => null);
console.log('me:', (who || '').slice(0, 300));

// enumerate all links + buttons text/href on home to find chat/agent entry
const nav = await page.evaluate(() => {
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) { const h = a.getAttribute('href'); if (/chat|agent|postbot|bot|ai/i.test(h)) out.push(['a', h, (a.textContent||'').trim().slice(0,30)]); }
  for (const b of document.querySelectorAll('button,[role="button"],[data-testid]')) { const t = (b.getAttribute('data-testid')||'')+'|'+(b.textContent||'').trim().slice(0,25); if (/chat|agent|postbot|ai|bot/i.test(t)) out.push(['btn', b.getAttribute('data-testid')||'', (b.textContent||'').trim().slice(0,30)]); }
  return out.slice(0, 40);
});
console.log('--- chat/agent-ish nav elements ---');
for (const n of nav) console.log(' ', n.join('  ::  '));

// try candidate routes; record which loads a bundle containing chatType
const routes = ['/_/chat', '/chat', '/agent', '/postbot', '/home/chat', '/app/chat'];
for (const rt of routes) {
  const before = bundleUrls.size;
  await page.goto(team + rt, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3500);
  const url = page.url();
  const hasComposer = await page.locator('[role="textbox"], textarea, input[type="file"]').count().catch(() => 0);
  console.log(`route ${rt} -> ${url.slice(0,70)} | newBundles=${bundleUrls.size-before} composerEls=${hasComposer}`);
  if (hasComposer > 0) { await page.screenshot({ path: 'route_'+rt.replace(/[^a-z]/gi,'_')+'.png' }).catch(()=>{}); }
}

// Now search all captured bundles for chat attachment mapping
const all = [...bundleUrls];
console.log('\ntotal bundles seen:', all.length);
let hits = 0;
for (const url of all) {
  const txt = await page.evaluate(async (u) => { try { const r = await fetch(u, { credentials: 'omit' }); return await r.text(); } catch { return ''; } }, url).catch(()=>'');
  if (!txt) continue;
  const i1 = txt.indexOf('/attachments/presign');
  const i2 = txt.indexOf('chatType');
  if (i1 >= 0 || (i2 >= 0 && /IMAGE|attachment|artifact/i.test(txt))) {
    hits++;
    console.log(`\n@@@ ${url.slice(-60)} len=${txt.length} presign=${i1>=0} chatType=${i2>=0}`);
    if (i1 >= 0) console.log('PRESIGN>>', txt.substring(Math.max(0,i1-900), i1+900).replace(/\s+/g,' '));
    // find where attachments become part of chat body
    const ci = txt.search(/attachments:\s*\[/);
    if (ci>=0) console.log('ATTACH>>', txt.substring(Math.max(0,ci-400), ci+600).replace(/\s+/g,' '));
  }
}
console.log('\nhits:', hits);
await browser.close();
