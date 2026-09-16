import type { Locator, Page } from 'playwright-core';
import { config } from '../config/env.js';
import type { ChatCompletionRequest, NormalizedResult } from '../openai/types.js';
import { serializeRequest } from '../openai/prompt.js';
import { parseModelOutput } from '../openai/tool-parser.js';
import { AsyncMutex } from '../utils/async-mutex.js';
import { cleanUiNoise, longestCommonPrefix, normalizeWhitespace } from '../utils/text.js';
import { BrowserManager } from './browser-manager.js';
import { findAgentPanel, findComposer } from './dom-heuristics.js';
import { discoverModels, selectModel, setAutoMode, setThinking, type DiscoveredModel } from './model-discovery.js';
import { AgentTabPool } from './tab-pool.js';

// Pseudo-model that turns on the "Auto" switch ("Optimized for most tasks")
// so the backend picks the underlying model itself.
export const AUTO_MODEL_ID = 'auto';
const AUTO_MODEL_ENTRY: DiscoveredModel = {
  id: AUTO_MODEL_ID,
  displayName: 'Auto',
  ownedBy: 'openai',
};

// true/false = force the Thinking switch; undefined = leave it untouched.
function resolveThinking(request: ChatCompletionRequest): boolean | undefined {
  if (typeof request.thinking === 'boolean') return request.thinking;
  if (typeof request.reasoning_effort === 'string') {
    const value = request.reasoning_effort.trim().toLowerCase();
    if (value) return !['none', 'off', 'false', '0'].includes(value);
  }
  return undefined;
}

interface ModelCache {
  fetchedAt: number;
  models: DiscoveredModel[];
}

/** Shared-pipeline errors live in account-pool (single source of truth);
 * re-exported here so existing imports keep working. */
export { ServerBusyError, ClientGoneError } from './account-pool.js';
import {
  acquireSlot,
  markExhausted,
  markSessionDead,
  finishSlot,
  QuotaExhaustedError,
  SessionExpiredError,
  ServerBusyError,
  ClientGoneError,
  getSlotCount,
  type Slot,
} from './account-pool.js';

export interface DriverStatus {
  workspaceUrl: string;
  currentUrl: string;
  signedInLikely: boolean;
  composerFound: boolean;
  modelButtonFound: boolean;
  cachedModels: number;
  userTabs: number;
  maxTabs: number;
  perUser: Record<string, { busy: boolean; idleMs: number }>;
}

export class AgentDriver {
  private modelCache?: ModelCache;
  private readonly sharedMutex = new AsyncMutex();

  constructor(
    private readonly browser: BrowserManager,
    private readonly tabPool: AgentTabPool,
  ) {}

  async listModels(force = false): Promise<DiscoveredModel[]> {
    const now = Date.now();
    if (
      !force &&
      this.modelCache &&
      now - this.modelCache.fetchedAt < config.postman.modelCacheTtlMs
    ) {
      return [AUTO_MODEL_ENTRY, ...this.modelCache.models];
    }

    // Model discovery is read-only and account-wide, so it can share the
    // first tab instead of consuming a per-user slot.
    return this.sharedMutex.runExclusive(async () => {
      const page = await this.browser.getPage();
      await this.ensureReady(page);
      const models = await discoverModels(page);
      this.modelCache = { fetchedAt: Date.now(), models };
      return [AUTO_MODEL_ENTRY, ...models];
    });
  }

  // Direct server API access (vision path). Returns the shared workspace page
  // whose session cookies authenticate /_gw/* backend calls. Vision calls run
  // through the driver's shared mutex (runVisionExclusive) so account switches
  // (credit-limit handling) can never interleave with an in-flight stream.
  async getWorkspacePage() {
    const page = await this.browser.getPage();
    await this.ensureReady(page);
    return page;
  }

  // Parallel pool dispatch. Each request runs on its OWN account slot (own
  // login session) — N concurrent requests use N accounts at once. When a
  // slot reports quota exhaustion or a dead session, the request transparently
  // retries on a different slot. Slots are released back even on failure.
  async runVisionExclusive<T>(fn: (page: Page) => Promise<T>, opts?: { isCancelled?: () => boolean }): Promise<T> {
    if (opts?.isCancelled?.() ?? false) {
      console.log('[route] client already gone, dropping request before queue');
      throw new ClientGoneError();
    }
    const tried = new Set<string>();
    // Retry on a DIFFERENT slot when a slot reports quota/session death, but
    // cap the fan-out: with a large pool (100+ slots) an uncapped budget could
    // chain 100+ slow logins on a single request. 8 healthy-slot attempts is
    // plenty to ride out exhausted/dead slots without pathological latency.
    const maxAttempts = Math.min(Math.max(3, getSlotCount() + 2), 8);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const slot: Slot = await acquireSlot(tried, opts);
      try {
        const page = slot.page;
        if (!page || page.isClosed()) {
          slot.inFlight = false;
          tried.add(slot.account.email);
          continue;
        }
        const out = await fn(page);
        finishSlot(slot);
        return out;
      } catch (e) {
        if (e instanceof QuotaExhaustedError) {
          markExhausted(slot);
          tried.add(slot.account.email);
          lastError = e;
          continue;
        }
        if (e instanceof SessionExpiredError) {
          await markSessionDead(slot);
          tried.add(slot.account.email);
          lastError = e;
          continue;
        }
        slot.inFlight = false;
        throw e;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('no healthy pool accounts available');
  }

  // Each request runs on the tab owned by `userId`. Two requests carrying the
  // same key are serialized; different keys run on their own tabs.
  //
  // When `onDelta` is provided, it is called with each text increment as the
  // response streams in from the UI. The final return value is still the
  // complete NormalizedResult.
  async complete(
    request: ChatCompletionRequest,
    userId: string,
    onDelta?: (delta: string) => void,
  ): Promise<NormalizedResult> {
    return this.tabPool.runExclusive(userId, async (page) => {
      await this.ensureReady(page);

      const wantsAuto = request.model.trim().toLowerCase() === AUTO_MODEL_ID;
      if (wantsAuto) {
        await setAutoMode(page, true);
      } else {
        const model = await this.resolveModel(page, request.model);
        await selectModel(page, model.displayName);
      }

      const thinking = resolveThinking(request);
      if (thinking !== undefined) {
        await setThinking(page, thinking);
      }

      await this.startFreshConversation(page);

      const composer = await findComposer(page);
      const panel = await findAgentPanel(page, composer);
      const beforeText = await this.readPanelText(panel);
      console.log(`[complete] beforeText length: ${beforeText.length}`);
      console.log(`[complete] beforeText preview: ${beforeText.substring(0, 200)}`);

      const serialized = serializeRequest(request);
      console.log(`[complete] prompt length: ${serialized.text.length}`);
      console.log(`[complete] prompt preview: ${serialized.text.substring(0, 300)}`);

      // NOTE: requests carrying images are routed to the vision pipeline
      // (vision-router) before ever reaching complete(), so serialized.images
      // is always empty here. No composer clipboard paste is attempted — the
      // Agent Mode Lexical composer does not accept image pastes.

      // Log what's in the composer before typing
      const composerBefore = await this.readComposerValue(composer);
      console.log(`[complete] composer before typing: "${composerBefore.substring(0, 100)}"`);

      await this.enterAndSubmit(page, composer, serialized.text);

      // Log what's in the composer after typing
      const composerAfter = await this.readComposerValue(composer);
      console.log(`[complete] composer after typing: "${composerAfter.substring(0, 100)}"`);

      const answer = await this.waitForAnswer(page, panel, beforeText, serialized.endMarker, onDelta);
      console.log(`[complete] answer length: ${answer.length}`);
      console.log(`[complete] answer preview: ${answer.substring(0, 300)}`);
      return parseModelOutput(answer);
    });
  }

  // (Removed) attachImages: clipboard-paste of images into the Agent Mode
  // composer never worked — Lexical strips non-text clipboard payloads and
  // the composer has no attach button. Images now flow exclusively through
  // the direct /_gw/chat vision pipeline in vision-router.ts.

  async status(): Promise<DriverStatus> {
    const page = await this.browser.getPage();
    let composerFound = false;
    let modelButtonFound = false;
    try {
      const composer = await findComposer(page);
      composerFound = true;
      const { findModelButton } = await import('./dom-heuristics.js');
      await findModelButton(page, composer);
      modelButtonFound = true;
    } catch {
      // Status endpoint should report, not throw.
    }

    const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';
    return {
      workspaceUrl: config.postman.workspaceUrl,
      currentUrl: page.url(),
      signedInLikely: !/sign in|log in|continue with google/i.test(bodyText.slice(0, 5000)),
      composerFound,
      modelButtonFound,
      cachedModels: this.modelCache?.models.length ?? 0,
      ...this.tabPool.stats(),
    };
  }

  private async ensureReady(page: Page): Promise<void> {
    await this.browser.ensureWorkspace();
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);

    try {
      await findComposer(page);
    } catch (error) {
      const body = ((await page.locator('body').innerText().catch(() => '')) || '').slice(0, 4000);
      if (/sign in|log in|continue with google/i.test(body)) {
        throw new Error(
          'Not logged in the bridge browser profile. Use the opened browser window to sign in, then retry.',
        );
      }
      throw error;
    }
  }

  private async resolveModel(page: Page, idOrName: string): Promise<DiscoveredModel> {
    let models = this.modelCache?.models ?? [];
    let found = models.find(
      (model) =>
        model.id.toLowerCase() === idOrName.toLowerCase() ||
        model.displayName.toLowerCase() === idOrName.toLowerCase(),
    );

    if (!found) {
      models = await discoverModels(page);
      this.modelCache = { fetchedAt: Date.now(), models };
      found = models.find(
        (model) =>
          model.id.toLowerCase() === idOrName.toLowerCase() ||
          model.displayName.toLowerCase() === idOrName.toLowerCase(),
      );
    }

    if (!found) {
      const names = models.map((model) => model.id).join(', ');
      const error = new Error(`Unknown model '${idOrName}'. Available models: ${names}`);
      (error as Error & { statusCode?: number }).statusCode = 400;
      throw error;
    }
    return found;
  }

  private async startFreshConversation(page: Page): Promise<void> {
    const explicit = config.postman.selectors.newChat;
    if (explicit) {
      const button = page.locator(explicit).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click();
        await page.waitForTimeout(250);
        return;
      }
    }

    const composer = await findComposer(page);
    const panel = await findAgentPanel(page, composer);

    // Try clicking "New Chat" button
    const labels = [/new chat/i, /new conversation/i, /start over/i, /start new/i];
    for (const pattern of labels) {
      const locator = panel.getByRole('button', { name: pattern });
      const count = Math.min(await locator.count(), 8);
      for (let i = 0; i < count; i += 1) {
        const item = locator.nth(i);
        if (await item.isVisible().catch(() => false)) {
          await item.click().catch(() => undefined);
          await page.waitForTimeout(800);
          // Verify panel was cleared
          const afterClick = await this.readPanelText(panel);
          if (afterClick.length < 120) return;
        }
      }
    }

    // Fallback: try title/aria-label buttons
    const metadataButtons = panel.locator(
      'button[title*="new" i], button[aria-label*="new" i], button[data-testid*="new" i]',
    );
    for (let i = 0; i < Math.min(await metadataButtons.count(), 8); i += 1) {
      const item = metadataButtons.nth(i);
      if (await item.isVisible().catch(() => false)) {
        await item.click().catch(() => undefined);
        await page.waitForTimeout(800);
        const afterClick = await this.readPanelText(panel);
        if (afterClick.length < 120) return;
      }
    }

    // If panel still dirty, try JS-based clear: find the agent chat container
    // and clear all its children via DOM manipulation.
    const panelLen = (await this.readPanelText(panel)).length;
    if (panelLen > 120) {
      console.log(`[startFreshConversation] panel dirty (${panelLen} chars), trying JS clear...`);
      const cleared = await page.evaluate(() => {
        // Find the AI chat panel message container (scrollable area above composer)
        const composer = document.querySelector('[data-lexical-editor="true"]');
        if (!composer) return false;
        // Walk up from composer to find the parent panel container
        let current = composer.parentElement;
        while (current) {
          // Look for the chat messages container (scrollable, before composer)
          const prev = current.previousElementSibling;
          if (prev) {
            // Clear all child messages but keep the container
            const children = Array.from(prev.children);
            for (const child of children) {
              if (child.tagName === 'DIV' && !child.classList.contains('ai-chat-footer')) {
                child.remove();
              }
            }
            return true;
          }
          current = current.parentElement;
        }
        return false;
      });
      if (cleared) {
        await page.waitForTimeout(500);
        const newLen = (await this.readPanelText(panel)).length;
        console.log(`[startFreshConversation] after JS clear: ${newLen} chars`);
      }
    }
  }

  private async enterAndSubmit(page: Page, composer: Locator, text: string): Promise<void> {
    await composer.scrollIntoViewIfNeeded();
    try {
      await composer.click({ timeout: 5_000 });
    } catch {
      await composer.evaluate((el) => {
        if (el instanceof HTMLElement) el.focus();
      });
    }

    const tagName = await composer.evaluate((el) => el.tagName.toLowerCase());
    if (tagName === 'textarea' || tagName === 'input') {
      await composer.fill(text);
    } else {
      await composer.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => undefined);
      await composer.press('Backspace').catch(() => undefined);
      await composer.evaluate((el) => {
        if (el instanceof HTMLElement) el.focus();
      });
      await page.keyboard.insertText(text);
    }

    // Verify text was inserted
    const inserted = await this.readComposerValue(composer);
    console.log(`[enterAndSubmit] text length: ${text.length}, inserted length: ${inserted.length}`);
    console.log(`[enterAndSubmit] inserted preview: ${inserted.substring(0, 150)}`);

    await composer.press('Enter');
    await page.waitForTimeout(500);

    const valueAfter = await this.readComposerValue(composer);
    console.log(`[enterAndSubmit] value after Enter: "${valueAfter.substring(0, 100)}"`);
    
    if (valueAfter.includes(text.slice(0, Math.min(80, text.length)))) {
      const send = page.getByRole('button', { name: /send|submit/i }).first();
      if (await send.isVisible().catch(() => false)) {
        console.log(`[enterAndSubmit] clicking Send button`);
        await send.click();
      } else {
        console.log(`[enterAndSubmit] trying Ctrl+Enter`);
        await composer.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
      }
    } else {
      console.log(`[enterAndSubmit] text was submitted via Enter`);
    }
  }

  private async readComposerValue(composer: Locator): Promise<string> {
    return composer.evaluate((el) => {
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value;
      return (el.textContent ?? '').trim();
    });
  }

  private async readPanelText(panel: Locator): Promise<string> {
    return normalizeWhitespace((await panel.innerText().catch(() => '')) || '');
  }

  private async isGenerating(page: Page): Promise<boolean> {
    const explicit = config.postman.selectors.generating;
    if (explicit) {
      const locator = page.locator(explicit).first();
      return locator.isVisible().catch(() => false);
    }

    // Postman renders many transient status strings while the agent is busy
    // (thinking, web search, browsing). All of them mean: not done yet.
    const statuses = [
      'Generating...',
      'Generating…',
      'Stop generating',
      'Searching the web...',
      'Searching the web…',
      'Searching...',
      'Searching…',
      'Searching the web for',
      'Browsing...',
      'Browsing…',
      'Reading...',
      'Reading…',
      'Fetching...',
      'Fetching…',
      'Running tool',
      'Running function',
    ];
    for (const text of statuses) {
      const locator = page.getByText(text, { exact: false }).first();
      if (await locator.isVisible().catch(() => false)) return true;
    }
    return false;
  }

  private async latestAssistantMessage(page: Page): Promise<string | null> {
    const explicit = config.postman.selectors.assistantMessage;
    const selectors = explicit
      ? [explicit]
      : [
          '[data-testid*="assistant" i]',
          '[data-testid*="message" i]',
          '[data-message-author-role="assistant"]',
          '[role="article"]',
        ];

    for (const selector of selectors) {
      const items = page.locator(selector);
      for (let i = (await items.count()) - 1; i >= 0 && i >= (await items.count()) - 10; i -= 1) {
        const item = items.nth(i);
        if (!(await item.isVisible().catch(() => false))) continue;
        const text = cleanUiNoise((await item.innerText().catch(() => '')) || '');
        if (text.length >= 2 && !/^POSTMAN_OPENAI_BRIDGE_REQUEST/.test(text)) return text;
      }
    }
    return null;
  }

  private async waitForAnswer(
    page: Page,
    panel: Locator,
    beforeText: string,
    endMarker: string,
    onDelta?: (delta: string) => void,
  ): Promise<string> {
    const startedAt = Date.now();
    let sawChange = false;
    let lastText = '';
    let stableSince = Date.now();
    let sawGenerating = false;
    let emittedLength = 0;

    console.log(`[waitForAnswer] beforeText length: ${beforeText.length}`);
    console.log(`[waitForAnswer] timeout: ${config.postman.completionTimeoutMs}ms`);

    while (Date.now() - startedAt < config.postman.completionTimeoutMs) {
      await page.waitForTimeout(350);
      const generating = await this.isGenerating(page);
      if (generating) sawGenerating = true;

      const panelText = await this.readPanelText(panel);
      if (panelText !== beforeText) {
        if (!sawChange) {
          console.log(`[waitForAnswer] first change detected at ${Date.now() - startedAt}ms`);
          console.log(`[waitForAnswer] new text preview: ${panelText.substring(0, 200)}`);
        }
        sawChange = true;
      }

      if (panelText !== lastText) {
        lastText = panelText;
        stableSince = Date.now();
      }

      if (onDelta && sawChange) {
        const delta = this.extractDelta(beforeText, panelText, endMarker);
        if (delta && delta.length > emittedLength) {
          const newPart = delta.slice(emittedLength);
          emittedLength = delta.length;
          if (newPart) onDelta(newPart);
        }
      }

      const stableFor = Date.now() - stableSince;
      if (sawChange && !generating && stableFor >= config.postman.responseStableMs) {
        console.log(`[waitForAnswer] stable for ${stableFor}ms, extracting answer`);
        const specific = await this.latestAssistantMessage(page);
        if (specific && !specific.includes(endMarker)) {
          console.log(`[waitForAnswer] latestAssistantMessage: ${specific.substring(0, 200)}`);
          if (onDelta && specific.length > emittedLength) {
            onDelta(specific.slice(emittedLength));
          }
          return specific;
        }

        const extracted = this.extractDelta(beforeText, panelText, endMarker);
        if (extracted) {
          console.log(`[waitForAnswer] extracted delta: ${extracted.substring(0, 200)}`);
          if (onDelta && extracted.length > emittedLength) {
            onDelta(extracted.slice(emittedLength));
          }
          return extracted;
        }
      }

      if (!sawGenerating && sawChange && stableFor >= config.postman.responseStableMs * 2) {
        const extracted = this.extractDelta(beforeText, panelText, endMarker);
        if (extracted) {
          if (onDelta && extracted.length > emittedLength) {
            onDelta(extracted.slice(emittedLength));
          }
          return extracted;
        }
      }
    }

    throw new Error(`Timed out waiting for agent response after ${config.postman.completionTimeoutMs} ms.`);
  }

  private extractDelta(beforeText: string, afterText: string, endMarker: string): string {
    let delta = '';
    const markerIndex = afterText.lastIndexOf(endMarker);
    if (markerIndex >= 0) {
      delta = afterText.slice(markerIndex + endMarker.length);
    } else if (afterText.startsWith(beforeText)) {
      delta = afterText.slice(beforeText.length);
    } else {
      const prefix = longestCommonPrefix(beforeText, afterText);
      delta = afterText.slice(prefix);
    }

    delta = cleanUiNoise(delta);
    delta = delta.replace(/^\s*(?:you|user)\s*[:\n]/i, '').trim();
    return delta;
  }
}
