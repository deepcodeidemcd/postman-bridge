// HEADFUL live capture: drive the real /_/chat composer, attach a red PNG,
// send, and capture the EXACT POST body + whether the model sees the image.
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

// 30x30 red png on disk
const { createCanvas } = (() => { try { return require('canvas'); } catch { return {}; } })();
let pngPath = 'cap_red.png';
if (createCanvas) {
  const cv = createCanvas(60, 60); const c = cv.getContext('2d'); c.fillStyle = '#ff0000'; c.fillRect(0, 0, 60, 60);
  fs.writeFileSync(pngPath, cv.toBuffer('image/png'));
} else {
  fs.writeFileSync(pngPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC', 'base64'));
}

const browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--no-sandbox', '--start-maximized'] });
const ctx = await browser.newContext({ storageState: sp, viewport: null });
const page = await ctx.newPage();

const cap = [];
page.on('request', (r) => {
  const u = r.url();
  if (/_gw\/chat|\/chat\?|attachments|\/conversation/.test(u) && (r.method() === 'POST' || r.method() === 'PUT')) {
    let body = null; try { body = r.postData(); } catch {}
    cap.push({ url: u.replace(/^https:\/\/[^/]+/, ''), method: r.method(), body });
  }
});
page.on('response', async (res) => {
  const u = res.url();
  if (/_gw\/chat|\/chat\?/.test(u) && res.request().method() === 'POST') {
    try { const t = await res.text(); cap.push({ url: u.replace(/^https:\/\/[^/]+/, '') + ' ::RESPONSE', text: t.slice(0, 3000) }); } catch {}
  }
});

await page.goto(`${team}/_/chat`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(12000);

// dump visible inputs so we can find the real composer selectors
const info = await page.evaluate(() => {
  const list = [];
  for (const el of document.querySelectorAll('textarea, [contenteditable], input[type=file], [role=textbox], button')) {
    const t = (el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.className || el.textContent || '').toString().trim().slice(0, 40);
    list.push(`${el.tagName}[type=${el.getAttribute('type')||''}] ${t}`);
  }
  return list.slice(0, 60);
});
console.log('=== interactive elements ===');
for (const l of info) console.log(' ', l);

// Try to attach: many composers need the file input; find it (may be hidden)
let fileSet = false;
for (const fi of await page.locator('input[type="file"]').all().catch(() => [])) {
  try { await fi.setInputFiles(pngPath, { timeout: 5000 }); fileSet = true; break; } catch {}
}
console.log('file set via direct input:', fileSet);
await page.waitForTimeout(3000);

// type into the composer and send
const composer = page.locator('[role="textbox"], textarea').first();
if (await composer.count().catch(() => 0)) {
  await composer.click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.type('What color is this image? Reply with ONLY the color name.').catch(() => {});
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'cap_before_send.png' }).catch(() => {});
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(25000);
  await page.screenshot({ path: 'cap_after_send.png' }).catch(() => {});
}

console.log('\n=== CAPTURED chat/conversation/attachment requests ===');
for (const c of cap) {
  console.log(`\n>> ${c.method || ''} ${c.url}`);
  if (c.body) console.log('   BODY:', c.body.slice(0, 3500));
  if (c.text) console.log('   RESP:', c.text.slice(0, 1500));
}
await browser.close();
