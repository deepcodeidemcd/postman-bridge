// Ground-truth capture: drive the real Postman Agent-Mode chat UI, attach a red
// PNG through the native file input, send, and record the exact /_gw/chat
// request body the browser sends. This tells us the real vision payload shape
// instead of guessing.
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
console.log('email:', EMAIL, 'team:', team);

// build a red png file on disk
const redPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC', 'base64');
const tmp = `.${'redcap'}.png`;
fs.writeFileSync(tmp, redPng);

const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ storageState: sp, acceptDownloads: true });
const page = await ctx.newPage();

const chatReqs = [];
page.on('request', (r) => {
  const u = r.url();
  if (/_gw\/chat|attachments|upload|postbot|conversation/i.test(u) && r.method() !== 'GET') {
    let post = null; try { post = r.postData(); } catch {}
    chatReqs.push({ method: r.method(), url: u.slice(0, 120), headers: Object.fromEntries(Object.entries(r.headers()).filter(([k]) => /pstmn|service|content-type|workspace/i.test(k))), body: post ? post.slice(0, 4000) : null });
  }
});

await page.goto(`${team}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(10000);

// find an <input type=file> anywhere (maybe hidden). Post it after we locate the chat composer.
// Try clicking a chat/agent entry first.
for (const sel of ['[data-testid*="chat"]', 'a[href*="/chat"]', '[role="textbox"]', 'textarea', 'button:has-text("Agent")', 'button:has-text("Chat")']) {
  const n = await page.locator(sel).count().catch(() => 0);
  console.log('probe', sel, '->', n);
}

// try file input presence
const fileInputs = await page.locator('input[type="file"]').count().catch(() => 0);
console.log('file inputs before opening composer:', fileInputs);

// screenshot current state
await page.screenshot({ path: 'cap_home.png' }).catch(() => {});

// Attempt: find a textbox, click, look for attach/paperclip button
const box = page.locator('[role="textbox"], textarea').first();
if (await box.count().catch(() => 0)) {
  await box.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const fi = await page.locator('input[type="file"]').count().catch(() => 0);
  console.log('file inputs after clicking composer:', fi);
  if (fi > 0) {
    await page.locator('input[type="file"]').first().setInputFiles(tmp).catch((e) => console.log('setInputFiles err', e.message));
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'cap_attached.png' }).catch(() => {});
    // type a message
    await box.click({ timeout: 3000 }).catch(() => {});
    await page.keyboard.type('What color is this image? Reply with just the color.').catch(() => {});
    await page.waitForTimeout(1500);
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(20000);
  }
}

await page.screenshot({ path: 'cap_after.png' }).catch(() => {});
console.log('=== captured non-GET requests (attachments/chat/upload) ===');
for (const r of chatReqs) {
  console.log(`\n-> ${r.method} ${r.url}`);
  console.log('   headers:', JSON.stringify(r.headers));
  if (r.body) console.log('   body:', r.body.slice(0, 3500));
}
await browser.close();
try { fs.unlinkSync(tmp); } catch {}
