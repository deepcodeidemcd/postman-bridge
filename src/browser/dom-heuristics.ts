import type { Locator, Page } from 'playwright-core';
import { config } from '../config/env.js';
import { MODEL_PATTERN } from '../utils/text.js';

async function firstVisible(locators: Locator[]): Promise<Locator | null> {
  for (const locator of locators) {
    const count = Math.min(await locator.count(), 10);
    for (let i = 0; i < count; i += 1) {
      const item = locator.nth(i);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return null;
}

// When attached via CDP, page.viewportSize() is null; fall back to the real
// window inner size so position-based heuristics still work.
async function viewportOf(page: Page): Promise<{ width: number; height: number }> {
  const size = page.viewportSize();
  if (size) return size;
  const fallback = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  return fallback ?? { width: 1920, height: 1080 };
}

export async function tryFindComposer(page: Page): Promise<Locator | null> {
  if (config.postman.selectors.composer) {
    const explicit = page.locator(config.postman.selectors.composer).first();
    if (await explicit.isVisible().catch(() => false)) return explicit;
  }

  const direct = await firstVisible([
    page.getByPlaceholder(/Describe what you need/i),
    page.locator('textarea[placeholder*="Describe what you need" i]'),
    page.locator('textarea[placeholder*="Ask" i]'),
    page.locator('[contenteditable="true"][data-placeholder*="Describe" i]'),
    page.locator('[contenteditable="true"][aria-label*="message" i]'),
  ]);
  if (direct) return direct;

  const candidates = page.locator('textarea, [contenteditable="true"]');
  const viewport = await viewportOf(page);
  let best: { score: number; locator: Locator } | undefined;

  for (let i = 0; i < Math.min(await candidates.count(), 30); i += 1) {
    const item = candidates.nth(i);
    if (!(await item.isVisible().catch(() => false))) continue;
    const box = await item.boundingBox();
    if (!box) continue;

    let score = 0;
    if (box.x > viewport.width * 0.6) score += 6;
    if (box.y > viewport.height * 0.55) score += 4;
    if (box.width > 180) score += 2;
    const placeholder = (await item.getAttribute('placeholder')) ?? '';
    const aria = (await item.getAttribute('aria-label')) ?? '';
    if (/describe|ask|message|prompt/i.test(`${placeholder} ${aria}`)) score += 8;

    if (!best || score > best.score) best = { score, locator: item };
  }

  if (!best || best.score < 4) return null;
  return best.locator;
}

// The Postman SPA renders the Agent panel asynchronously; retry for a few
// seconds (also covers the case where the bridge just relaunched Chrome).
export async function findComposer(page: Page): Promise<Locator> {
  const deadline = Date.now() + 12_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const composer = await tryFindComposer(page);
      if (composer) return composer;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  if (lastError) throw lastError instanceof Error ? lastError : new Error(String(lastError));
  throw new Error('Could not locate the agent composer. Set POSTMAN_SELECTOR_COMPOSER in .env.');
}

export async function findModelButton(page: Page, composer: Locator): Promise<Locator> {
  if (config.postman.selectors.modelButton) {
    const explicit = page.locator(config.postman.selectors.modelButton).first();
    if (await explicit.isVisible().catch(() => false)) return explicit;
  }

  const candidates = page.locator('button, [role="button"]');
  const viewport = await viewportOf(page);
  const composerBox = await composer.boundingBox();
  let best: { score: number; locator: Locator; text: string } | undefined;

  for (let i = 0; i < Math.min(await candidates.count(), 250); i += 1) {
    const item = candidates.nth(i);
    if (!(await item.isVisible().catch(() => false))) continue;
    const box = await item.boundingBox();
    if (!box) continue;

    const text = ((await item.innerText().catch(() => '')) || '').trim();
    const aria = (await item.getAttribute('aria-label')) ?? '';
    const title = (await item.getAttribute('title')) ?? '';
    const searchable = `${text} ${aria} ${title}`;

    let score = 0;
    if (MODEL_PATTERN.test(searchable)) score += 12;
    if (/model/i.test(searchable)) score += 6;
    if (box.x > viewport.width * 0.6) score += 4;
    if (composerBox && Math.abs(box.y - composerBox.y) < 180) score += 5;
    if (box.width >= 80 && box.width <= 260) score += 1;

    if (!best || score > best.score) best = { score, locator: item, text };
  }

  if (!best || best.score < 8) {
    throw new Error('Could not locate the model selector. Set POSTMAN_SELECTOR_MODEL_BUTTON in .env.');
  }
  return best.locator;
}

export async function findAgentPanel(page: Page, composer: Locator): Promise<Locator> {
  const viewport = await viewportOf(page);
  const handle = await composer.elementHandle();
  if (!handle) return page.locator('body');

  const selectorPath = await handle.evaluate((node, viewportWidth) => {
    let current: HTMLElement | null = node as HTMLElement;
    let depth = 0;
    while (current && depth < 12) {
      const rect = current.getBoundingClientRect();
      if (
        rect.width >= 250 &&
        rect.height >= window.innerHeight * 0.55 &&
        rect.left >= viewportWidth * 0.55
      ) {
        if (!current.dataset.postmanBridgePanel) {
          current.dataset.postmanBridgePanel = `panel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        }
        return `[data-postman-bridge-panel="${current.dataset.postmanBridgePanel}"]`;
      }
      current = current.parentElement;
      depth += 1;
    }
    return 'body';
  }, viewport.width);

  return page.locator(selectorPath).first();
}
