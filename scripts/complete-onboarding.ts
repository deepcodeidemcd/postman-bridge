/**
 * Complete Postman onboarding in the bridge profile.
 * Handles: name input, 2 custom dropdowns (I'd like to / as a), team size, workspace button.
 * Usage: node scripts/complete-onboarding.ts
 */
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { config } from '../src/config/env.js';

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

console.log('opening onboarding...');
await page.goto('https://pmkzqm7shd77-6336972.postman.co/onboarding/user', {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
}).catch((e) => console.error('goto err:', e.message));

// Wait for the wizard
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(2000);
  const body = (await page.locator('body').innerText().catch(() => '')) || '';
  if (body.includes('Welcome to Postman')) break;
}
console.log('wizard loaded');

// 1. Fill name input
const nameInput = page.locator('input:not([type=hidden]):not([type=checkbox]):visible').first();
const nameCount = await nameInput.count().catch(() => 0);
if (nameCount > 0) {
  await nameInput.fill('Auto User', { timeout: 5000 }).catch(() => {});
  console.log('name filled');
}

// 2. Handle dropdowns (aether-dropdown)
const dropdowns = page.locator('[class*="aether-dropdown__placeholder"], div:text-is("Select option"), div:text-is("Select role")');
const ddCount = await dropdowns.count().catch(() => 0);
console.log(`dropdowns found: ${ddCount}`);

for (let d = 0; d < 4; d++) {
  // Find a visible placeholder
  const ph = page.locator('div:text-is("Select option"), div:text-is("Select role")').first();
  if (!((await ph.count().catch(() => 0)) > 0)) break;
  if (!(await ph.isVisible().catch(() => false))) break;

  console.log(`dropdown ${d + 1}: clicking placeholder`);
  await ph.click({ timeout: 5000 }).catch((e) => console.error('ph click err', e.message));
  await page.waitForTimeout(1500);

  // Find menu options - react-select/aether style
  const options = page.locator('[class*="aether-dropdown__option"], [class*="dropdown__option"], [role="option"]');
  const optCount = await options.count().catch(() => 0);
  console.log(`  options visible: ${optCount}`);
  if (optCount > 0) {
    await options.first().click({ timeout: 5000 }).catch((e) => console.error('opt click err', e.message));
    console.log(`  picked option 1`);
    await page.waitForTimeout(1000);
  } else {
    // Dump menu contents
    const menuText = await page
      .locator('[class*="menu"], [class*="popover"], [role="listbox"]')
      .allInnerTexts()
      .catch(() => []);
    console.log(`  menu contents: ${JSON.stringify(menuText).slice(0, 300)}`);
    // try generic clickable items in overlay
    const item = page.locator('[class*="menu"] >> visible >> text=/[A-Za-z]/').first();
    if ((await item.count().catch(() => 0)) > 0) {
      await item.click({ timeout: 3000 }).catch(() => {});
      console.log('  picked generic item');
    }
    await page.waitForTimeout(1000);
  }
}

// 3. Team size: click "1 member"
const teamBtn = page.getByRole('button', { name: /1 member/i }).first();
if (await teamBtn.isVisible().catch(() => false)) {
  await teamBtn.click();
  console.log('team size: 1 member');
}

// 4. Take me to my Workspace
const wsBtn = page.getByRole('button', { name: /take me to my workspace/i }).first();
if (await wsBtn.isVisible().catch(() => false)) {
  await wsBtn.click();
  console.log('clicked workspace button');
}

await page.waitForTimeout(8000);
const url = page.url();
console.log(`after onboarding: ${url.slice(0, 100)}`);

// Check where we are
const body = (await page.locator('body').innerText().catch(() => '')) || '';
if (body.includes('Welcome to Postman')) {
  console.log('STILL ON ONBOARDING - dumping state');
  await page.screenshot({ path: '.runtime/onboarding-stuck.png' }).catch(() => {});
} else {
  console.log('ONBOARDING COMPLETE');
  await page.screenshot({ path: '.runtime/onboarding-done.png' }).catch(() => {});
}

await page.waitForTimeout(5000);
await context.close();
console.log('done');
