// Fetch the real agent-mode JS bundles from a logged-in page and extract the
// code that (a) presigns/uploads attachments and (b) builds the /_gw/chat body,
// so we learn the exact field the backend reads an image from for vision.
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

const scriptUrls = new Set();
page.on('request', (r) => { const u = r.url(); if (/\.js(\?|$)/.test(u) && /agent|chat|postbot|workspace|main|chunk|app|vendor/i.test(u)) scriptUrls.add(u); });

// Navigate to the agent-mode chat app route (try a few known ones)
for (const route of [`${team}/home`]) {
  await page.goto(route, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(4000);
}
console.log('captured script urls:', scriptUrls.size);

// Also enumerate all script tags on the page
const pageScripts = await page.evaluate(() => Array.from(document.scripts).map((s) => s.src).filter(Boolean));
for (const s of pageScripts) scriptUrls.add(s);
console.log('total candidate bundles:', scriptUrls.size);

// fetch each bundle inside the page (same-origin cookies) and search
const bundles = [...scriptUrls].slice(0, 40);
const findings = [];
for (const url of bundles) {
  const txt = await page.evaluate(async (u) => {
    try { const r = await fetch(u, { credentials: 'include' }); return await r.text(); } catch { return ''; }
  }, url);
  if (!txt) continue;
  const markers = ['attachments/presign', 'chatType', 'selectedModel', 'mandatoryContext'];
  if (!markers.some((m) => txt.includes(m))) continue;
  findings.push({ url, len: txt.length });
  // Extract around presign
  for (const needle of ['/attachments/presign', 'uploadUrl', 'presign']) {
    let idx = txt.indexOf(needle);
    if (idx >= 0) {
      console.log(`\n##### ${url.slice(-40)} :: around "${needle}"`);
      console.log(txt.substring(Math.max(0, idx - 1200), idx + 1200).replace(/\s+/g, ' '));
      break;
    }
  }
}
console.log('\n=== bundles with chat markers ===');
for (const f of findings) console.log(' ', f.len, f.url.slice(-70));
await browser.close();
