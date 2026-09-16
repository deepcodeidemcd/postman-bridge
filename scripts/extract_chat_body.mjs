// Load the REAL /_/chat route, capture its lazy JS chunks, and extract the exact
// code that builds the chat body with an attached image (USER_QUERY + how the
// uploaded artifact id/url is referenced). Ground truth for the vision shape.
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
await page.waitForTimeout(12000);
// interact a bit to trigger lazy chunks
await page.locator('[role="textbox"], textarea').first().click({ timeout: 4000 }).catch(() => {});
await page.waitForTimeout(4000);
console.log('bundles on /_/chat:', bundleUrls.size);

const all = [...bundleUrls];
const report = [];
for (const url of all) {
  const txt = await page.evaluate(async (u) => { try { const r = await fetch(u, { credentials: 'omit' }); return await r.text(); } catch { return ''; } }, url).catch(()=>'');
  if (!txt) continue;
  const hasUserQuery = txt.includes('USER_QUERY');
  const hasChatType = txt.includes('chatType');
  const hasPresign = txt.includes('attachments/presign');
  if (hasUserQuery || (hasChatType && /IMAGE|attachment|artifact|mediaFile|url:/i.test(txt))) {
    report.push({ url: url.slice(-45), len: txt.length, hasUserQuery, hasChatType, hasPresign });
  }
  if (hasChatType) {
    // dump the region where the chat input object is built
    let idx = txt.indexOf('USER_QUERY');
    if (idx < 0) idx = txt.indexOf('chatType');
    console.log(`\n#### ${url.slice(-45)} len=${txt.length} USER_QUERY@${txt.indexOf('USER_QUERY')}`);
    console.log('SNIP>>', txt.substring(Math.max(0, idx-200), idx+1600).replace(/\s+/g,' '));
  }
}
console.log('\n=== bundles with chatType/USER_QUERY ===');
for (const r of report) console.log(' ', JSON.stringify(r));
await browser.close();
