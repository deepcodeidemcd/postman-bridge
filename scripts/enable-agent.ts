/**
 * Full Agent Mode enablement flow:
 * 1. Open workspace + click AI tab
 * 2. Click "Enable Postman Agent" consent (navigates to org settings)
 * 3. Enable Postman AI on the settings page
 * 4. Navigate back to workspace, open AI tab, wait for composer
 * 5. Discover models
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { config } from '../src/config/env.js';
import { discoverModels } from '../src/browser/model-discovery.js';
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

async function gotoWorkspace() {
  await page.goto(overview, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(2000);
    const body = (await page.locator('body').innerText().catch(() => '')) || '';
    if (/open the link in the desktop app|open in browser/i.test(body)) {
      const btn = page.getByText(/always open in browser/i).first();
      if (await btn.isVisible().catch(() => false)) { await btn.click(); await page.waitForTimeout(3000); continue; }
    }
    if (page.url().includes('postman.co') && body.length > 500) break;
  }
  await page.waitForTimeout(8000);
}

async function clickAiTab() {
  const aiTab = page.locator('[data-testid="gcb-tab-POSTBOT_AI_CHAT"]').first();
  if (await aiTab.isVisible().catch(() => false)) {
    await aiTab.click().catch(() => {});
    await page.waitForTimeout(3000);
    return true;
  }
  return false;
}

await gotoWorkspace();
console.log('workspace loaded:', page.url().slice(0, 100));

// Open AI panel
await clickAiTab();
console.log('AI tab clicked');

// Check for consent
const consentBtn = page.locator('[data-testid="postbot-enterprise-consent-button"]').first();
if (await consentBtn.isVisible().catch(() => false)) {
  console.log('consent visible - clicking (will navigate to settings)...');
  await consentBtn.click();
  await page.waitForTimeout(5000);
  console.log('after consent URL:', page.url().slice(0, 120));

  // We should now be on the org settings page. Find the Postman AI section.
  const body = (await page.locator('body').innerText().catch(() => '')) || '';
  if (/Postman AI/i.test(body)) {
    console.log('on settings page with Postman AI section');

    // Click the "Enable" button to enable Postman AI for the org
    const enableBtn = page.locator('[data-testid="ai-access-enable-button"]').first();
    if (await enableBtn.isVisible().catch(() => false)) {
      console.log('clicking ai-access-enable-button...');
      await enableBtn.click();
      await page.waitForTimeout(4000);

      // There may be a confirmation dialog
      const confirmBtn = page.getByRole('button', { name: /^enable$/i }).first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click().catch(() => {});
        await page.waitForTimeout(3000);
      }
      const body2 = (await page.locator('body').innerText().catch(() => '')) || '';
      console.log('after enable, body snippet:', body2.slice(0, 200).replace(/\n/g, ' | '));
      await page.screenshot({ path: '.runtime/after-enable.png' }).catch(() => {});
    } else {
      console.log('enable button not visible');
    }
  }
  await page.screenshot({ path: '.runtime/settings-page.png' }).catch(() => {});
  console.log('saved .runtime/settings-page.png');
} else {
  console.log('no consent screen this time');
}

// Go back to workspace and check composer
await gotoWorkspace();
await clickAiTab();
console.log('back at workspace, checking composer...');

let composerReady = false;
for (let i = 0; i < 20; i++) {
  const composer = await tryFindComposer(page).catch(() => null);
  if (composer) {
    composerReady = true;
    console.log(`composer found after ${(i + 1) * 2}s!`);
    break;
  }
  // re-click AI tab in case panel closed
  if (i % 5 === 4) await clickAiTab();
  await page.waitForTimeout(2000);
}

if (!composerReady) {
  console.log('composer still not found. Dumping panel text:');
  const body = (await page.locator('body').innerText().catch(() => '')) || '';
  console.log(body.slice(0, 1500));
  await page.screenshot({ path: '.runtime/no-composer2.png' }).catch(() => {});
  await context.close();
  process.exit(1);
}

// Discover models!
console.log('\n=== DISCOVERING MODELS ===');
try {
  const models = await discoverModels(page);
  console.log(`FOUND ${models.length} models:`);
  for (const m of models) console.log(`  - ${m.id} (${m.displayName})`);
  fs.writeFileSync('.runtime/models.json', JSON.stringify(models, null, 2));
  console.log('saved .runtime/models.json');
} catch (e) {
  console.error('discovery failed:', e instanceof Error ? e.message : String(e));
  await page.screenshot({ path: '.runtime/discovery-fail.png' }).catch(() => {});
}

await context.close();
console.log('done');
