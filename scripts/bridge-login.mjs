/**
 * Login Postman into the bridge's Playwright profile (.postman-profile).
 * Uses the same engine (playwright-core + same profile) as the bridge itself.
 * Usage: node scripts/bridge-login.mjs <email> <password>
 */
import path from 'node:path';
import { chromium } from 'playwright-core';

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('usage: node scripts/bridge-login.mjs <email> <password>');
  process.exit(1);
}

const profileDir = path.resolve('.postman-profile');
console.log(`profile: ${profileDir}`);

function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const c of candidates) {
    try { if (require('node:fs').existsSync(c)) return c; } catch {}
  }
  return undefined;
}

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  channel: 'chrome',
  viewport: { width: 1280, height: 900 },
  args: ['--disable-blink-features=AutomationControlled', '--disable-gpu'],
});

const page = context.pages()[0] ?? (await context.newPage());
page.setDefaultTimeout(45_000);

// 1. Open login page
console.log('navigating to login...');
await page.goto('https://identity.getpostman.com/login', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});

// 2. Wait for CF to clear
for (let i = 0; i < 30; i++) {
  const body = (await page.locator('body').innerText().catch(() => '')) || '';
  if (!/performing security verification|verify you are human|just a moment/i.test(body)) {
    console.log('CF clear');
    break;
  }
  await page.waitForTimeout(3000);
}

// If already logged in, this will redirect to workspace
await page.waitForTimeout(3000);
let url = page.url();
console.log(`url now: ${url.slice(0, 90)}`);

if (/identity\.getpostman\.com\/login/.test(url)) {
  // 3. Fill the form
  console.log('filling login form...');
  await page.waitForSelector('#username', { timeout: 30_000 });
  await page.fill('#username', email);
  await page.fill('#password', password);

  // 4. Wait for turnstile to be ready
  for (let i = 0; i < 25; i++) {
    const ready = await page.evaluate(() => {
      const el = document.querySelector("input[name='cf-turnstile-response']");
      return !!(el && el.value && el.value.length > 10);
    });
    if (ready) { console.log('turnstile ready'); break; }
    await page.waitForTimeout(2000);
  }

  // 5. Submit
  await page.click('button[type=submit]');
  console.log('submitted');
}

// 6. Wait for postman.co redirect
let loggedIn = false;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(3000);
  url = page.url();
  if (url.includes('postman.co') && !url.includes('identity.getpostman.com')) {
    loggedIn = true;
    console.log(`LOGGED IN: ${url.slice(0, 100)}`);
    break;
  }
  const body = (await page.locator('body').innerText().catch(() => '')) || '';
  if (/incorrect|invalid credentials/i.test(body.slice(0, 3000))) {
    console.error('LOGIN ERROR: wrong credentials');
    await context.close();
    process.exit(1);
  }
}

if (!loggedIn) {
  console.error('login redirect timeout');
  await page.screenshot({ path: '.runtime/login-timeout.png' }).catch(() => {});
  await context.close();
  process.exit(1);
}

// 7. Wait for the app to fully initialize + persist cookies
await page.waitForTimeout(10_000);

// Keep browser open briefly to let Chromium flush profile to disk
await context.close();
console.log('done - session saved to profile');
