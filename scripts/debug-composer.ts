/**
 * Debug: Take screenshot + DOM dump of the Postman composer.
 * Run with: npx tsx scripts/debug-composer.ts
 */
import { chromium, type Page } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  // Find running Chrome via CDP or launch from profile
  let page: Page | undefined;

  // Try CDP first
  try {
    const resp = await fetch('http://localhost:9222/json');
    const pages = await resp.json() as any[];
    const postman = pages.find((p: any) => p.url.includes('postman'));
    if (postman) {
      const browser = await chromium.connectOverCDP(postman.webSocketDebuggerUrl);
      const ctx = browser.contexts()[0];
      page = ctx?.pages()?.find((p: any) => p.url.includes('postman')) ?? ctx?.pages()[0];
      console.log('Connected via CDP');
    } else throw new Error('no postman tab');
  } catch {
    // Launch from profile
    const browser = await chromium.launchPersistentContext('.postman-profile', {
      headless: false,
      viewport: { width: 1728, height: 960 },
      channel: 'chrome',
      args: ['--disable-blink-features=AutomationControlled'],
    });
    page = browser.pages().find(p => p.url().includes('postman')) ?? browser.pages()[0];
    console.log('Launched from profile');
  }

  if (!page) {
    console.log('No page found');
    process.exit(1);
  }

  console.log('URL:', page.url());

  // Screenshot
  const ssDir = path.resolve('.runtime');
  fs.mkdirSync(ssDir, { recursive: true });
  await page.screenshot({ path: path.join(ssDir, 'debug-composer.png'), fullPage: false });
  console.log('Screenshot saved to .runtime/debug-composer.png');

  // DOM dump: contenteditable elements
  const domInfo = await page.evaluate(() => {
    const editables = [...document.querySelectorAll<HTMLElement>('[contenteditable="true"]')];
    const fileInputs = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')];
    const dropzones = [...document.querySelectorAll<HTMLElement>('[data-testid*="drop"], [class*="dropzone"], [class*="upload"]')];

    return {
      editables: editables.map(el => ({
        tag: el.tagName,
        classes: el.className.toString().substring(0, 200),
        testId: el.dataset?.testid || '',
        innerText: (el.textContent || '').substring(0, 200),
        childCount: el.children.length,
        hasImg: el.querySelector('img') !== null,
        rect: el.getBoundingClientRect(),
      })),
      fileInputs: fileInputs.map(el => ({
        accept: el.accept,
        multiple: el.multiple,
        testId: el.dataset?.testid || '',
        id: el.id,
        name: el.name,
        visible: el.offsetParent !== null,
      })),
      dropzones: dropzones.map(el => ({
        tag: el.tagName,
        classes: el.className.toString().substring(0, 200),
        testId: el.dataset?.testid || '',
      })),
    };
  });

  console.log('\n=== ContentEditable elements ===');
  console.log(JSON.stringify(domInfo.editables, null, 2));
  console.log('\n=== File Inputs ===');
  console.log(JSON.stringify(domInfo.fileInputs, null, 2));
  console.log('\n=== Dropzones ===');
  console.log(JSON.stringify(domInfo.dropzones, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
