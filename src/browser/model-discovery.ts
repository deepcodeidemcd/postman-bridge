import type { Page } from 'playwright-core';
import { MODEL_PATTERN, normalizeWhitespace, slugifyModel } from '../utils/text.js';
import { findComposer, findModelButton } from './dom-heuristics.js';

export interface DiscoveredModel {
  id: string;
  displayName: string;
  ownedBy: 'openai';
}

const IGNORE = new Set(['more models', 'thinking', 'auto', 'optimized for most tasks', 'enable extended thinking']);

function sanitizeModelLabel(text: string): string {
  return normalizeWhitespace(text)
    .replace(/\s+/g, ' ')
    .replace(/[✓✔›>]+\s*$/g, '')
    .trim();
}

function isUsefulModelLabel(text: string): boolean {
  const value = sanitizeModelLabel(text);
  if (!value || value.length > 80) return false;
  if (IGNORE.has(value.toLowerCase())) return false;
  return MODEL_PATTERN.test(value) && !/optimized|extended thinking/i.test(value);
}

async function collectVisibleModelLabels(page: Page): Promise<string[]> {
  const selectors = [
    '[role="menuitem"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="listbox"] button',
    '[role="menu"] button',
  ];

  const labels = new Set<string>();
  for (const selector of selectors) {
    const items = page.locator(selector);
    for (let i = 0; i < Math.min(await items.count(), 100); i += 1) {
      const item = items.nth(i);
      if (!(await item.isVisible().catch(() => false))) continue;
      const text = sanitizeModelLabel((await item.innerText().catch(() => '')) || '');
      if (isUsefulModelLabel(text)) labels.add(text);
    }
  }

  // Fallback: inspect visible buttons in the right side. Useful when menu roles are missing.
  if (labels.size === 0) {
    const viewport = page.viewportSize();
    const buttons = page.locator('button, [role="button"]');
    for (let i = 0; i < Math.min(await buttons.count(), 250); i += 1) {
      const item = buttons.nth(i);
      if (!(await item.isVisible().catch(() => false))) continue;
      const box = await item.boundingBox();
      if (!box || !viewport || box.x < viewport.width * 0.55) continue;
      const text = sanitizeModelLabel((await item.innerText().catch(() => '')) || '');
      if (isUsefulModelLabel(text)) labels.add(text);
    }
  }

  return [...labels];
}

async function openMoreModels(page: Page): Promise<void> {
  const candidates = page.getByText(/^More models$/i);
  for (let i = 0; i < Math.min(await candidates.count(), 5); i += 1) {
    const more = candidates.nth(i);
    if (!(await more.isVisible().catch(() => false))) continue;
    await more.hover().catch(() => undefined);
    await page.waitForTimeout(350);
    // Some builds use hover submenus; others require a click.
    const afterHover = await collectVisibleModelLabels(page);
    if (afterHover.length <= 3) {
      await more.click().catch(() => undefined);
      await page.waitForTimeout(350);
    }
    return;
  }
}

async function clickVisibleModelByName(page: Page, displayName: string): Promise<boolean> {
  const candidates = page.getByText(displayName, { exact: false });
  for (let i = 0; i < Math.min(await candidates.count(), 20); i += 1) {
    const item = candidates.nth(i);
    if (!(await item.isVisible().catch(() => false))) continue;
    const text = sanitizeModelLabel((await item.innerText().catch(() => '')) || '');
    if (text.toLowerCase() !== displayName.toLowerCase()) continue;
    await item.click();
    return true;
  }
  return false;
}

export async function discoverModels(page: Page): Promise<DiscoveredModel[]> {
  const composer = await findComposer(page);
  const button = await findModelButton(page, composer);

  await button.click();
  await page.waitForTimeout(350);

  const names = new Set(await collectVisibleModelLabels(page));
  await openMoreModels(page);
  for (const name of await collectVisibleModelLabels(page)) names.add(name);

  // Dismiss menu without changing selection.
  await page.keyboard.press('Escape').catch(() => undefined);

  const models = [...names]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((displayName) => ({
      id: slugifyModel(displayName),
      displayName,
      ownedBy: 'openai' as const,
    }));

  if (models.length === 0) {
    throw new Error('Model menu opened, but no model labels were discovered. Use `npm run doctor` and selector overrides.');
  }
  return models;
}

export async function selectModel(page: Page, displayName: string): Promise<void> {
  const composer = await findComposer(page);
  const button = await findModelButton(page, composer);
  const current = sanitizeModelLabel((await button.innerText().catch(() => '')) || '');
  if (current.toLowerCase().includes(displayName.toLowerCase())) return;

  await button.click();
  await page.waitForTimeout(250);

  if (await clickVisibleModelByName(page, displayName)) return;

  await openMoreModels(page);
  if (await clickVisibleModelByName(page, displayName)) return;

  await page.keyboard.press('Escape').catch(() => undefined);
  throw new Error(`Model '${displayName}' is not available in the visible model menu.`);
}

// The model menu also hosts two switches ("Auto" and "Thinking"). Each row is
// a button wrapping a hidden checkbox input; clicking the row toggles it and
// the menu stays open.
const AUTO_ROW_SELECTOR = 'button[class*="ai-chat-model-selector-auto-row"]';
const THINKING_ROW_SELECTOR = 'button[class*="ai-chat-input-settings-auto-run"]:not([class*="auto-row"])';

async function setMenuSwitch(page: Page, rowSelector: string, desired: boolean, label: string): Promise<void> {
  const composer = await findComposer(page);
  const button = await findModelButton(page, composer);

  await button.click();
  await page.waitForTimeout(350);

  try {
    const row = page.locator(rowSelector).first();
    if (!(await row.isVisible().catch(() => false))) {
      throw new Error(`'${label}' switch is not visible in the model menu.`);
    }
    const checked = await row.evaluate((el) => !!el.querySelector('input')?.checked);
    if (checked !== desired) {
      await row.click();
      await page.waitForTimeout(400);
    }
  } finally {
    // Dismiss the menu without changing the model selection.
    await page.keyboard.press('Escape').catch(() => undefined);
  }
}

export async function setAutoMode(page: Page, on: boolean): Promise<void> {
  await setMenuSwitch(page, AUTO_ROW_SELECTOR, on, 'Auto');
}

export async function setThinking(page: Page, on: boolean): Promise<void> {
  await setMenuSwitch(page, THINKING_ROW_SELECTOR, on, 'Thinking');
}
