/**
 * Find file upload capability in the Agent composer (for vision).
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { config } from '../src/config/env.js';
import { tryFindComposer } from '../src/browser/dom-heuristics.js';

fs.mkdirSync('.runtime', { recursive: true });

const context = await chromium.launchPersistentContext(config.postman.profileDir, {
  headless: false,
  channel: 'chrome',
  viewport: { width: 1728, height: 960 },
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled'],
});

const page = context.pages()[0] ?? (await context.newPage());
page.setDefaultTimeout(20_000);

const overview = config.postman.workspaceUrl.replace(/([?&])sideView=agentMode(?=&|$)/, '$1').replace(/[?&]$/, '');
await page.goto(overview, { waitUntil: 'domcontentloaded', timeout: 60_000 });
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(2000);
  const body = (await page.locator('body').innerText().catch(() => '')) || '';
  if (/open the link in the desktop app|open in browser/i.test(body)) {
    const btn = page.getByText(/always open in browser/i).first();
    if (await btn.isVisible().catch(() => false)) { await btn.click(); await page.waitForTimeout(3000); continue; }
  }
  if (page.url().includes('postman.co')) break;
}
await page.waitForTimeout(10000);

// Open AI panel
const aiTab = page.locator('[data-testid="gcb-tab-POSTBOT_AI_CHAT"]').first();
if (await aiTab.isVisible().catch(() => false)) { await aiTab.click(); await page.waitForTimeout(4000); }

const composer = await tryFindComposer(page);
console.log('composer found:', !!composer);

// 1. Check for hidden file inputs
const fileInputs = await page.evaluate(() => {
  const inputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]');
  return Array.from(inputs).map((i) => ({
    accept: i.getAttribute('accept') || '',
    multiple: i.multiple,
    visible: i.offsetParent !== null,
    cls: (i.className || '').slice(0, 60),
    testid: i.getAttribute('data-testid') || '',
    ariaLabel: i.getAttribute('aria-label') || '',
  }));
});
console.log('\nfile inputs:', JSON.stringify(fileInputs, null, 2));

// 2. Check for attach buttons near composer
const attachBtns = await page.evaluate(() => {
  const btns = document.querySelectorAll<HTMLElement>('button, [role="button"]');
  return Array.from(btns)
    .filter((b) => b.offsetParent !== null)
    .map((b) => ({
      text: (b.textContent || '').trim().slice(0, 30),
      aria: b.getAttribute('aria-label') || '',
      title: b.getAttribute('title') || '',
      testid: b.getAttribute('data-testid') || '',
      cls: (b.className || '').slice(0, 70),
    }))
    .filter((b) => /attach|upload|image|photo|plus|add|file|paperclip|clipboard/i.test(`${b.text} ${b.aria} ${b.title} ${b.testid} ${b.cls}`));
});
console.log('\nattach-related buttons:', JSON.stringify(attachBtns, null, 2));

// 3. Check paste support info — dump composer attributes
if (composer) {
  const compInfo = await composer.evaluate((el) => ({
    tag: el.tagName,
    cls: (el.className || '').slice(0, 100),
    placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '',
    ariaLabel: el.getAttribute('aria-label') || '',
    pasteable: el.tagName === 'TEXTAREA' || el.getAttribute('contenteditable') === 'true',
  }));
  console.log('\ncomposer:', JSON.stringify(compInfo, null, 2));
}

await context.close();
console.log('done');