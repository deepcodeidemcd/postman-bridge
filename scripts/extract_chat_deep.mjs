// Deep-extract the chat feature bundle: show every region around key needles so
// we can read how the app uploads an image and where it puts the reference in
// the /_gw/chat body.
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
page.on('request', (r) => { const u = r.url(); if (/\.min\.js/.test(u)) bundleUrls.add(u); });
await page.goto(`${team}/_/chat`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(6000);
await page.locator('[role="textbox"], textarea').first().click({ timeout: 4000 }).catch(() => {});
await page.waitForTimeout(4000);
// also hit /home and open the agent-mode widget to force-mount chat chunks
await page.goto(`${team}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(4000);
await page.locator('#agent-mode-widget, [data-testid="agent-mode-widget"]').first().click({ timeout: 4000 }).catch(() => {});
await page.locator('textarea, [data-testid="agent-mode-widget-prompt-textarea"]').first().click({ timeout: 3000 }).catch(() => {});
await page.waitForTimeout(5000);

const needleList = process.argv[3] ? process.argv[3].split(',') :
  ['USER_QUERY', 'attachments/presign', 'uploadUrl', 'readUrl', 'chatType', 'TOOL_RESPONSE', 'artifacts', 'byteSize'];

const urls = [...bundleUrls];
const out = await page.evaluate(async ({ urls, needles }) => {
  const results = {};
  for (const src of urls) {
    let txt = '';
    try { const r = await fetch(src, { credentials: 'omit' }); txt = await r.text(); } catch { continue; }
    if (!txt) continue;
    for (const n of needles) {
      let idx = txt.indexOf(n);
      while (idx >= 0) {
        (results[n] ||= []);
        if (results[n].length < 3) results[n].push(txt.substring(Math.max(0, idx - 500), idx + 900).replace(/\s+/g, ' '));
        idx = txt.indexOf(n, idx + 1);
        if (results[n].length >= 3) break;
      }
    }
  }
  return results;
}, { urls, needles: needleList });

for (const [n, arr] of Object.entries(out)) {
  console.log(`\n=================== "${n}" (${arr.length} regions) ===================`);
  arr.forEach((s, i) => console.log(`\n--- ${n} #${i} ---\n${s}`));
}
if (!Object.keys(out).length) console.log('no matching bundle found via document.scripts');
await browser.close();
