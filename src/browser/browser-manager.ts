import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { config } from '../config/env.js';

function findChromeExecutable(): string | undefined {
  if (config.browser.executablePath) return config.browser.executablePath;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe')
      : '',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export class BrowserManager {
  private context?: BrowserContext;
  private page?: Page;
  private cdpBrowser?: Browser;
  // Shared headless browser for the account pool: many isolated contexts
  // (one login session per account) inside a single Chrome process.
  private poolBrowser?: Browser;

  // Ensures a browser context is attached (CDP attach or persistent launch).
  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) {
      if (config.browser.cdpUrl) {
        // CDP mode: drop the cached context when the websocket died or Chrome
        // is gone, so the next call re-attaches (and auto-relaunches Chrome).
        if (this.cdpBrowser && this.cdpBrowser.isConnected()) return this.context;
        try {
          const alive = this.context.pages().some((page) => !page.isClosed());
          if (alive) return this.context;
        } catch {
          // context unusable, fall through to re-attach
        }
      } else {
        // Persistent mode: the browser process may have been closed behind our
        // back (user closed the window / process killed). Probe the browser
        // through the page's CDP binding — if Chrome is gone this throws.
        try {
          const probe = this.context.pages().find((p) => !p.isClosed());
          if (probe) {
            // page.context() roundtrip + a trivial evaluate is the cheapest
            // liveness check; when the browser process is dead this rejects.
            await probe.evaluate(() => 1, undefined as never).catch(async () => {
              // Fallback liveness: browser version (process-level check).
              await this.context!.browser()?.version();
            });
            return this.context;
          }
          // No open pages at all: force a new one to prove liveness.
          const p = await this.context.newPage();
          await p.close();
          return this.context;
        } catch {
          this.context = undefined;
          this.page = undefined;
        }
      }
      this.context = undefined;
      this.cdpBrowser = undefined;
      this.page = undefined;
    }

    // CDP attach mode: drive a dedicated Chrome window with a debug profile
    // (keeps login/Cloudflare state). Chrome 136+ requires a non-default
    // --user-data-dir for the remote debugging port.
    if (config.browser.cdpUrl) {
      let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
      try {
        browser = await chromium.connectOverCDP(config.browser.cdpUrl);
      } catch (error) {
        // CDP not listening: relaunch the debug Chrome window, then retry once.
        await this.relaunchCdpChrome();
        browser = await chromium.connectOverCDP(config.browser.cdpUrl).catch((retryError: unknown) => {
          throw retryError instanceof Error ? retryError : (error ?? new Error('CDP attach failed'));
        });
      }
      const context = browser.contexts()[0] ?? (await browser.newContext());
      this.cdpBrowser = browser;
      this.context = context;
      context.setDefaultTimeout(10_000);
      context.setDefaultNavigationTimeout(config.postman.navigationTimeoutMs);
      // Grant clipboard permissions for vision image paste support.
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://pmkzqm7shd77-6336972.postman.co' }).catch(() => undefined);
      return context;
    }

    fs.mkdirSync(config.postman.profileDir, { recursive: true });

    // The bridge routinely kills/restarts Chrome (and Windows may do it too).
    // Chrome remembers unclean shutdowns in Preferences (profile.exit_type =
    // "Crashed") and shows a "Restore pages?" bubble on next launch — the
    // popup the user keeps seeing. Reset the flag before every launch so a
    // fresh start is always clean. Also delete stale Singleton locks.
    try {
      for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
        try { fs.unlinkSync(path.join(config.postman.profileDir, f)); } catch { /* absent */ }
      }
      const prefsPath = path.join(config.postman.profileDir, 'Preferences');
      if (fs.existsSync(prefsPath)) {
        const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
        if (prefs?.profile) {
          prefs.profile.exit_type = 'Normal';
          prefs.profile.exited_cleanly = true;
          fs.writeFileSync(prefsPath, JSON.stringify(prefs));
        }
      }
    } catch { /* never block launch on profile cleanup */ }

    const launchOptions = {
      headless: config.postman.headless,
      viewport: { width: 1728, height: 960 },
      // Hide automation signals so Cloudflare is less likely to flag the Postman window as a bot.
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-blink-features=AutomationControlled',
        // Never show the "Restore pages?" bubble after an unclean shutdown.
        '--disable-session-crashed-bubble',
        '--disable-infobars',
        // Don't offer to be the default browser / translate bar noise.
        '--no-default-browser-check',
        '--disable-component-update',
      ],
      ...(config.browser.executablePath
        ? { executablePath: config.browser.executablePath }
        : { channel: config.browser.channel }),
    };

    const context = await chromium.launchPersistentContext(config.postman.profileDir, launchOptions);
    context.setDefaultTimeout(10_000);
    context.setDefaultNavigationTimeout(config.postman.navigationTimeoutMs);
    // Grant clipboard permissions for vision image paste support.
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://pmkzqm7shd77-6336972.postman.co' }).catch(() => undefined);
    this.context = context;
    return context;
  }

  async getPage(): Promise<Page> {
    const context = await this.ensureContext();
    if (this.page && !this.page.isClosed()) return this.page;

    const pages = context.pages();
    const postmanTab = pages.find((page) => page.url().includes('postman'));
    // Prefer a tab already showing Postman; otherwise reuse the front-most
    // tab; only create a new tab if the browser has none at all.
    this.page = postmanTab ?? pages[0] ?? (await context.newPage());
    await this.ensureWorkspace(this.page);
    return this.page;
  }

  /**
   * Export ONLY Cloudflare clearance cookies (cf_clearance, __cf_bm, _cfuvid)
   * from the trusted persistent profile. Fresh headless contexts get hard
   * challenged by Turnstile ("Just a moment..." forever); seeding THESE
   * cookies (same machine/IP/Chrome build) lets them skip the challenge.
   *
   * Deliberately EXCLUDES all Postman session/auth cookies: a slot must only
   * ever operate as its own account (verified post-login). Transplanting
   * sessions would silently burn the wrong account's quota.
   * Read-only — never disturbs the main session.
   */
  async exportTrustCookies(): Promise<Array<{
    name: string; value: string; domain?: string; path?: string;
    expires?: number; httpOnly?: boolean; secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  }>> {
    const all = await this.exportCookies();
    return all.filter((c) => /^cf_|^__cf|cloudflare/i.test(c.name));
  }

  /** All cookies from the persistent profile (for diagnostics / transplant). */
  async exportCookies(): Promise<Array<{
    name: string; value: string; domain?: string; path?: string;
    expires?: number; httpOnly?: boolean; secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  }>> {
    try {
      const context = await this.ensureContext();
      const all = await context.cookies();
      return all.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      }));
    } catch {
      return [];
    }
  }

  // Creates a dedicated tab (one per user conversation) that already sits on
  // the Postman workspace with the Agent panel open. If the cached context is
  // dead ("Target ... has been closed"), relaunch once and retry.
  async newTab(): Promise<Page> {
    let context = await this.ensureContext();
    let page: Page;
    try {
      page = await context.newPage();
    } catch (e) {
      // Stale context — force a relaunch and try once more.
      this.context = undefined;
      this.page = undefined;
      context = await this.ensureContext();
      try {
        page = await context.newPage();
      } catch (e2) {
        throw new Error(`Could not open a browser tab: ${e2 instanceof Error ? e2.message : String(e2)}`);
      }
    }
    try {
      await this.ensureWorkspace(page);
      await page
        .evaluate(() => {
          document.documentElement.dataset.postmanBridgeOwned = '1';
        })
        .catch(() => undefined);
    } catch {
      await page.close().catch(() => undefined);
      throw new Error(
        'Could not prepare a new tab (Agent Mode panel not available). ' +
          'Check that the workspace is valid and the bridge browser is signed in.',
      );
    }
    return page;
  }

  // Reuses a tab created by this bridge (marked on creation) that is still
  // open after a server restart, instead of spawning yet another tab.
  async adoptOwnedTab(): Promise<Page | undefined> {
    const context = await this.ensureContext();
    for (const page of context.pages()) {
      if (page === this.page || page.isClosed()) continue;
      const owned = await page
        .evaluate(() => document.documentElement.dataset.postmanBridgeOwned === '1')
        .catch(() => false);
      if (!owned) continue;
      return page;
    }
    return undefined;
  }

  async ensureWorkspace(page: Page = this.page!): Promise<void> {
    if (!page || page.isClosed()) return;
    const current = page.url();
    // Navigate when the tab is not on the Postman workspace at all. Postman
    // redirects ?sideView=agentMode back to the plain /overview URL, so go
    // straight there and open the Agent panel via the "AI" button ourselves.
    // The configured workspace belongs to one specific team; when the signed-in
    // account is not a member of it, Postman bounces to the identity account
    // chooser. In that case fall back to the current pool account's own team
    // origin so new accounts still get a usable workspace.
    const { getCurrentAccount } = await import('./account-pool.js');
    const acc = getCurrentAccount();
    let workspaceUrl = config.postman.workspaceUrl;
    if (acc?.url && acc.url.includes('postman.co')) {
      const configuredTeam = /([a-z0-9-]+)\.postman\.co/i.exec(config.postman.workspaceUrl)?.[1];
      const accountTeam = /([a-z0-9-]+)\.postman\.co/i.exec(acc.url)?.[1];
      if (!configuredTeam || !accountTeam || configuredTeam !== accountTeam) {
        workspaceUrl = acc.url;
      }
    }
    const overview =
      workspaceUrl.replace(/([?&])sideView=agentMode(?=&|$)/, '$1').replace(/[?&]$/, '') ??
      workspaceUrl;
    const needsNav =
      !current ||
      current === 'about:blank' ||
      !current.includes('postman') ||
      current.includes('identity.getpostman.com') ||
      // Tab sits on a different team's subdomain than the signed-in account.
      (() => {
        const curTeam = /([a-z0-9-]+)\.postman\.co/i.exec(current)?.[1];
        const wantTeam = /([a-z0-9-]+)\.postman\.co/i.exec(overview)?.[1];
        return curTeam && wantTeam && curTeam !== wantTeam;
      })();
    if (needsNav) {
      await page.goto(overview, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
    }
    if (!page.url().includes('postman')) return;

    // Postman shows an "Open in Browser" interstitial when it detects a
    // browser-only context. Dismiss it so the web app can load.
    await this.dismissBrowserInterstitial(page);

    // Postman strips ?sideView=agentMode from the URL after load and only
    // auto-opens the Agent panel once per browser profile. The reliable opener
    // is an SPA-router navigation: once the app has booted (~12s), pushing
    // "?sideView=agentMode" into history and dispatching popstate makes the
    // React router mount the Agent panel on ANY tab.
    const { tryFindComposer } = await import('./dom-heuristics.js');
    const startedAt = Date.now();
    const deadline = startedAt + 120_000;
    let routerTried = false;
    let reloaded = false;
    let consentHandled = false;
    let aiEnabled = false;

    while (Date.now() < deadline) {
      if (await tryFindComposer(page).catch(() => null)) return;
      await this.clickAgentEntry(page);
      await page.waitForTimeout(1500);

      // Bounced to the identity account chooser mid-flow: click the current
      // account entry (or "Continue using Postman") so the app proceeds.
      if (page.url().includes('identity.getpostman.com')) {
        const email = getCurrentAccount()?.email ?? '';
        await page.evaluate((mail: string) => {
          const els = document.querySelectorAll('a, button, div[role="button"]');
          for (const el of els) {
            const t = (el.textContent || '').trim();
            if ((mail && t.includes(mail)) || /continue using postman/i.test(t)) {
              (el as HTMLElement).click();
              return;
            }
          }
        }, email).catch(() => undefined);
        await page.waitForTimeout(6000);
        if (!page.url().includes('identity.getpostman.com')) {
          await this.dismissBrowserInterstitial(page);
        }
        continue;
      }

      // First-time enterprise consent: clicking "Enable Postman Agent"
      // navigates to the org AI settings page.
      if (!consentHandled) {
        const consentBtn = page.locator('[data-testid="postbot-enterprise-consent-button"]').first();
        if (await consentBtn.isVisible().catch(() => false)) {
          consentHandled = true;
          await consentBtn.click().catch(() => undefined);
          await page.waitForTimeout(4000);
          // Enable Postman AI for the org (one-time setup).
          aiEnabled = await this.enableOrgAiAccess(page);
          // Navigate back to the workspace and reopen the AI panel.
          await page.goto(overview, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
          await page.waitForTimeout(6000);
          await this.dismissBrowserInterstitial(page);
          continue;
        }
      }

      // Give the SPA time to boot before the router trick (it is a no-op
      // while the app JS is still loading).
      if (!routerTried && Date.now() - startedAt > 12_000) {
        routerTried = true;
        await this.openAgentPanelViaRouter(page);
        await page.waitForTimeout(1_500);
      }
      // Last resort: a fresh navigation sometimes triggers Postman's own
      // one-time auto-open.
      if (!reloaded && Date.now() - startedAt > 45_000) {
        reloaded = true;
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
        await page.waitForTimeout(2_500);
      }
    }
    throw new Error(
      'Could not open the Agent Mode panel automatically. ' +
        'Open the workspace in the bridge Chrome window and click "AI" once, then retry.',
    );
  }

  // Postman sometimes shows an interstitial ("We are opening the link in the
  // desktop app…"). Clicking "Open in Browser" / "Always open in browser"
  // dismisses it and lets the web workspace load.
  private async dismissBrowserInterstitial(page: Page): Promise<void> {
    for (let i = 0; i < 5; i++) {
      const body = (await page.locator('body').innerText().catch(() => '')) || '';
      if (!/open the link in the desktop app|open in browser/i.test(body)) return;
      const candidates = [
        page.getByText(/always open in browser/i).first(),
        page.getByText(/open in browser/i).first(),
      ];
      for (const candidate of candidates) {
        if (await candidate.isVisible().catch(() => false)) {
          await candidate.click().catch(() => undefined);
          await page.waitForTimeout(2500);
          break;
        }
      }
    }
  }

  // Org-level AI enablement: the consent click lands on the team AI settings
  // page; the "Enable" button there turns Postman AI on for the org.
  private async enableOrgAiAccess(page: Page): Promise<boolean> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const enableBtn = page.locator('[data-testid="ai-access-enable-button"]').first();
      if (await enableBtn.isVisible().catch(() => false)) {
        await enableBtn.click().catch(() => undefined);
        await page.waitForTimeout(3000);
        // A confirmation dialog may appear; confirm it.
        const confirmBtn = page.getByRole('button', { name: /^enable$/i }).first();
        if (await confirmBtn.isVisible().catch(() => false)) {
          await confirmBtn.click().catch(() => undefined);
          await page.waitForTimeout(2000);
        }
        return true;
      }
      await page.waitForTimeout(1500);
    }
    return false;
  }

  // Opens the Agent Mode panel by rewriting the URL through the History API
  // and firing popstate so Postman's router reacts. This works on any tab
  // after the app has booted, unlike direct goto() which gets stripped.
  private async openAgentPanelViaRouter(page: Page): Promise<void> {
    await page
      .evaluate(() => {
        const url = new URL(location.href);
        url.searchParams.set('sideView', 'agentMode');
        history.pushState({}, '', url.toString());
        window.dispatchEvent(new PopStateEvent('popstate'));
      })
      .catch(() => undefined);
  }

  // Postman opens the Agent panel from the header "AI" tab (next to Variables,
  // data-testid gcb-tab-POSTBOT_AI_CHAT). Do NOT touch the bottom-left sidebar
  // agent-selection item ("Cloud Agent"/"Desktop Agent") — that is only a mode
  // picker popover and is not the panel opener.
  private async clickAgentEntry(page: Page): Promise<void> {
    const candidates = [
      page.locator('[data-testid="gcb-tab-POSTBOT_AI_CHAT"]').first(),
      page.locator('[role="tab"][aria-label="AI"], button[aria-label="AI"]').first(),
      page.locator('button:text-is("AI")').first(),
    ];
    for (const candidate of candidates) {
      if (!(await candidate.isVisible().catch(() => false))) continue;
      await candidate.click().catch(() => undefined);
      return;
    }
  }

  // Headless browser shared by the account pool. Unlike the persistent
  // profile above (one login), this browser hosts MANY isolated contexts —
  // one authenticated Postman session per pool account — inside a single
  // Chrome process. Always headless: pool pages only run fetch() calls.
  async getPoolBrowser(): Promise<Browser> {
    if (this.poolBrowser?.isConnected()) return this.poolBrowser;
    try { await this.poolBrowser?.close().catch(() => undefined); } catch { /* noop */ }
    this.poolBrowser = undefined;
    const launchOptions = {
      // One-time session warming may need headful Chrome (Cloudflare
      // challenges cold headless logins). POSTMAN_POOL_HEADFUL=1 opens
      // login windows; normal operation stays headless via saved sessions.
      headless: process.env.POSTMAN_POOL_HEADFUL !== '1',
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
      ],
      ...(config.browser.executablePath
        ? { executablePath: config.browser.executablePath }
        : { channel: config.browser.channel }),
    };
    this.poolBrowser = await chromium.launch(launchOptions);
    return this.poolBrowser;
  }

  async close(): Promise<void> {
    await this.poolBrowser?.close().catch(() => undefined);
    this.poolBrowser = undefined;
    if (config.browser.cdpUrl) {
      // CDP mode: this is a dedicated debug-window Chrome, still not ours to
      // kill on shutdown (it owns the login session). Disconnect the websocket
      // only; Chrome itself stays open.
      await this.cdpBrowser?.close().catch(() => undefined);
      this.cdpBrowser = undefined;
      this.context = undefined;
      this.page = undefined;
      return;
    }
    await this.context?.close();
    this.context = undefined;
    this.page = undefined;
  }

  // Chrome 136+ ignores --remote-debugging-port on the default profile, so the
  // CDP window must use its own --user-data-dir. If the window was closed, this
  // relaunches it so the bridge heals without manual steps.
  private async relaunchCdpChrome(): Promise<void> {
    const exe = findChromeExecutable();
    if (!exe) {
      throw new Error(
        `CDP attach failed and no Chrome executable was found to relaunch. ` +
          `Set BROWSER_EXECUTABLE_PATH in .env.`,
      );
    }
    let port = '9222';
    try {
      port = String(new URL(config.browser.cdpUrl!).port || 9222);
    } catch {
      // keep default
    }
    fs.mkdirSync(config.browser.cdpProfileDir, { recursive: true });
    // Hidden mode runs true headless (no window, no taskbar icon to close by
    // accident). A fixed window size keeps Postman's layout wide enough for
    // the Agent panel to render; headless defaults to 800x600 which collapses
    // it.
    const hiddenArgs = config.browser.cdpHidden
      ? ['--headless=new', '--window-size=1400,900']
      : [];
    const child = spawn(
      exe,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${config.browser.cdpProfileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        ...hiddenArgs,
      ],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();

    // Wait for the debugging endpoint to come up (Chrome can take several seconds).
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      try {
        const probe = await chromium.connectOverCDP(config.browser.cdpUrl!);
        await probe.close().catch(() => undefined);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
    throw new Error(`Relaunched Chrome for CDP but port ${port} never became ready.`);
  }

  async screenshot(name = 'postman-bridge-debug.png'): Promise<string> {
    const page = await this.getPage();
    const runtimeDir = path.join(config.projectRoot, '.runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const file = path.join(runtimeDir, name);
    // fullPage can stall while the SPA animates; fall back to viewport shot.
    await page
      .screenshot({ path: file, fullPage: true, timeout: 15_000 })
      .catch(() => page.screenshot({ path: file, fullPage: false, timeout: 15_000 }));
    return file;
  }
}