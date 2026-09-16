import type { Page } from 'playwright-core';
import { config } from '../config/env.js';
import { AsyncMutex } from '../utils/async-mutex.js';
import { BrowserManager } from './browser-manager.js';

export class PoolExhaustedError extends Error {
  constructor() {
    super(
      `Too many concurrent user tabs (max ${config.postman.maxTabs}). ` +
        `Raise POSTMAN_MAX_TABS or retry when a tab frees up.`,
    );
    this.name = 'PoolExhaustedError';
  }
}

interface TabEntry {
  userId: string;
  page: Page;
  mutex: AsyncMutex;
  busy: boolean;
  lastUsedAt: number;
}

// One tab per user = one isolated Postman conversation per user. Requests of
// the same user serialize on their own tab; different users run in parallel on
// separate tabs, so contexts can never mix.
export class AgentTabPool {
  private readonly tabs = new Map<string, TabEntry>();
  private sweepTimer?: NodeJS.Timeout;

  constructor(private readonly browser: BrowserManager) {
    const timer = setInterval(() => void this.sweepIdleTabs(), 30_000);
    timer.unref?.();
    this.sweepTimer = timer;
  }

  async runExclusive<T>(userId: string, fn: (page: Page) => Promise<T>): Promise<T> {
    const tab = await this.acquire(userId);
    try {
      return await tab.mutex.runExclusive(async () => {
        tab.busy = true;
        tab.lastUsedAt = Date.now();
        try {
          return await fn(tab.page);
        } finally {
          tab.busy = false;
        }
      });
    } finally {
      if (tab.page.isClosed()) this.tabs.delete(userId);
    }
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await Promise.all([...this.tabs.values()].map((tab) => tab.page.close().catch(() => undefined)));
    this.tabs.clear();
  }

  stats(): { userTabs: number; maxTabs: number; perUser: Record<string, { busy: boolean; idleMs: number }> } {
    const perUser: Record<string, { busy: boolean; idleMs: number }> = {};
    for (const { userId, busy, lastUsedAt } of this.tabs.values()) {
      perUser[userId] = { busy, idleMs: Date.now() - lastUsedAt };
    }
    return { userTabs: this.tabs.size, maxTabs: config.postman.maxTabs, perUser };
  }

  private async acquire(userId: string): Promise<TabEntry> {
    // Drop closed tabs first so the open-tab count below is accurate.
    for (const [id, entry] of [...this.tabs]) {
      if (entry.page.isClosed()) this.tabs.delete(id);
    }

    const existing = this.tabs.get(userId);
    if (existing) return existing;

    if (this.tabs.size >= config.postman.maxTabs) {
      throw new PoolExhaustedError();
    }

    // Reuse a bridge-owned tab left open from a previous run instead of
    // spawning a new one (avoids a fresh tab per request after restart).
    const adopted = await this.browser.adoptOwnedTab();
    if (adopted) {
      const tab: TabEntry = { userId, page: adopted, mutex: new AsyncMutex(), busy: false, lastUsedAt: Date.now() };
      this.tabs.set(userId, tab);
      return tab;
    }

    const page = await this.browser.newTab();
    const tab: TabEntry = { userId, page, mutex: new AsyncMutex(), busy: false, lastUsedAt: Date.now() };
    this.tabs.set(userId, tab);
    return tab;
  }

  private async sweepIdleTabs(): Promise<void> {
    const ttl = config.postman.tabIdleTtlMs;
    for (const [userId, tab] of [...this.tabs]) {
      if (tab.page.isClosed()) {
        this.tabs.delete(userId);
        continue;
      }
      const idleMs = Date.now() - tab.lastUsedAt;
      if (!tab.busy && tab.mutex.queueLength === 0 && idleMs > ttl) {
        await tab.page.close().catch(() => undefined);
        this.tabs.delete(userId);
      }
    }
  }
}