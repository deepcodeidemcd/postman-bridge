import fs from 'node:fs';
import path from 'node:path';
import { BrowserManager } from '../src/browser/browser-manager.js';
import { findComposer, findModelButton } from '../src/browser/dom-heuristics.js';
import { discoverModels } from '../src/browser/model-discovery.js';
import { config } from '../src/config/env.js';

const browser = new BrowserManager();

try {
  console.log('Postman OpenAI Bridge Doctor');
  console.log(`Workspace: ${config.postman.workspaceUrl}`);
  console.log(`Profile:   ${config.postman.profileDir}`);
  console.log(`Browser:   ${config.browser.executablePath ?? config.browser.channel}`);

  const page = await browser.getPage();
  console.log(`Current:   ${page.url()}`);

  const composer = await findComposer(page);
  const composerBox = await composer.boundingBox();
  console.log('✓ Agent composer found', composerBox ?? '');

  const modelButton = await findModelButton(page, composer);
  console.log(`✓ Model button found: ${(await modelButton.innerText().catch(() => '')).trim()}`);

  const models = await discoverModels(page);
  console.log(`✓ Discovered ${models.length} models:`);
  for (const model of models) console.log(`  - ${model.id}  (${model.displayName})`);

  const runtimeDir = path.resolve('.runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const screenshot = path.join(runtimeDir, 'doctor-success.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(`✓ Screenshot: ${screenshot}`);
  console.log('\nDoctor completed successfully.');
} catch (error) {
  console.error('\nDoctor failed:');
  console.error(error);
  try {
    const screenshot = await browser.screenshot('doctor-failure.png');
    console.error(`Debug screenshot: ${screenshot}`);
  } catch {
    // Browser may not have launched.
  }
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => undefined);
}
