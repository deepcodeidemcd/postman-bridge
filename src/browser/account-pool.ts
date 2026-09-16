/**
 * Account POOL — parallel distribution across N accounts (not failover).
 *
 * Architecture: ONE headless Chrome process (see BrowserManager.getPoolBrowser)
 * hosts N isolated BrowserContexts — each context holds ONE account's login
 * session, persisted to disk via storageState JSON. Requests are round-robined
 * across healthy slots, so N concurrent requests run on N accounts at once.
 *
 *  - slot exhausted (quota)  -> parked, auto-recovers after the weekly cycle
 *  - slot session dead (401) -> closed, re-logins automatically next acquire
 *  - all slots exhausted     -> single-flight auto-register, then continue
 *  - queue too long          -> ServerBusyError (HTTP 429, fail fast)
 *  - client gone             -> ClientGoneError (drop silently, burn no quota)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { BrowserContext, Page } from 'playwright-core';
import type { BrowserManager } from './browser-manager.js';
import { config } from '../config/env.js';

const PROJECT_DIR = path.resolve(process.cwd());
const ACCOUNTS_FILE = path.join(PROJECT_DIR, 'postman_accounts.jsonl');
const REG_SCRIPT = path.join(PROJECT_DIR, 'postman_enterprise_register.py');
const SESSIONS_DIR = path.join(PROJECT_DIR, '.sessions');

const EXHAUSTED_RECOVER_MS = 7 * 24 * 3600 * 1000; // weekly credit cycle
const ERROR_COOLDOWN_MS = 2 * 60 * 1000;
const ACQUIRE_DEADLINE_MS = 10 * 60 * 1000;
const REGISTER_TIMEOUT_MS = 8 * 60 * 1000;
// Memory guard: a logged-in Postman workspace context is HEAVY (~1-1.5GB
// renderer). On a 16GB box keeping a dozen hot blows past available RAM. Cap
// the live set small; extra requests wait for a free slot or rehydrate a
// closed one from its storageState file (disk load, not a real re-login).
const MAX_LIVE_CONTEXTS = 5;
const CONTEXT_IDLE_TTL_MS = 5 * 60 * 1000;

export interface Account {
  email: string;
  username: string;
  password: string;
  status: string;
  url?: string;
}

/** Shared direct-API pipeline is saturated — maps to HTTP 429 + Retry-After. */
export class ServerBusyError extends Error {
  readonly queued: number;
  constructor(queued: number) {
    super(
      `Server busy: ${queued} requests already queued (max ${config.postman.maxQueue}). ` +
        `Retry in a few seconds.`,
    );
    this.name = 'ServerBusyError';
    this.queued = queued;
  }
}

/** The HTTP client disconnected before its turn — drop silently, burn no quota. */
export class ClientGoneError extends Error {
  constructor() {
    super('client disconnected before processing');
    this.name = 'ClientGoneError';
  }
}

/** Upstream answered with a quota/credit-limit message for this slot. */
export class QuotaExhaustedError extends Error {
  constructor() {
    super('account quota exhausted');
    this.name = 'QuotaExhaustedError';
  }
}

/** Upstream rejected auth (HTTP 401/403) — this slot's session is dead. */
export class SessionExpiredError extends Error {
  constructor(msg = 'account session expired') {
    super(msg);
    this.name = 'SessionExpiredError';
  }
}

export type SlotState = 'new' | 'ready' | 'exhausted' | 'cooldown';

export interface Slot {
  account: Account;
  context?: BrowserContext;
  page?: Page;
  inFlight: boolean;
  state: SlotState;
  failures: number;
  cooldownUntil: number;
  exhaustedUntil: number;
  lastUsedAt: number;
}

let managerRef: BrowserManager | null = null;
let slots: Slot[] = [];
let rrCursor = -1;
let waiting = 0;
let loaded = false;
let registering: Promise<boolean> | null = null;
// Identity server rate-limits parallel credential logins — only ONE
// interactive login at a time. Prepared-but-not-logged-in work (context
// creation + saved-session probe) runs in PARALLEL, bounded by a semaphore.
let loginTail: Promise<void> = Promise.resolve();
// Minimum gap between interactive logins (rate-limit courtesy).
let lastLoginAt = 0;
const LOGIN_GAP_MS = 15000;
// Max slots preparing their browser context at once (128 slots x ~300MB
// contexts would melt the box; 4 is plenty for the request burst shape).
const PREP_CONCURRENCY = 4;
let prepActive = 0;
const prepQueue: Array<() => void> = [];

async function acquirePrepSlot(): Promise<void> {
  if (prepActive < PREP_CONCURRENCY) {
    prepActive++;
    return;
  }
  await new Promise<void>((r) => prepQueue.push(r));
  prepActive++;
}

function releasePrepSlot(): void {
  prepActive--;
  const next = prepQueue.shift();
  if (next) next();
}

/** Called once at server startup so the pool can open browser contexts. */
export function initPool(manager: BrowserManager): void {
  managerRef = manager;
  // Idle-context sweeper: evictIdleContexts otherwise only runs during
  // acquire(). Without it a quiet pool could sit on dozens of live contexts
  // (GBs) between bursts.
  setInterval(() => {
    try { evictIdleContexts(Date.now()); } catch { /* sweeper must never crash */ }
  }, 60_000).unref();
}

// Registration statuses that mean the account never reached a usable
// workspace — putting them in the pool just wastes a slow interactive login
// on every request that happens to pick one.
const BAD_STATUSES = new Set(['on_onboarding', 'login_failed', 'unknown']);

function loadAccountsFile(): Account[] {
  if (!fs.existsSync(ACCOUNTS_FILE)) return [];
  const out: Account[] = [];
  for (const line of fs.readFileSync(ACCOUNTS_FILE, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const a = JSON.parse(t) as Partial<Account>;
      if (a.email && a.password && !BAD_STATUSES.has(String(a.status ?? ''))) {
        out.push({
          email: a.email,
          username: a.username ?? '',
          password: a.password,
          status: a.status ?? '',
          url: a.url,
        });
      }
    } catch { /* skip malformed lines */ }
  }
  return out;
}

/** Add Slot objects for accounts that don't have one yet. Never drops slots
 * (healthy sessions survive file reloads). */
function syncSlotsWithFile(): void {
  const have = new Set(slots.map((s) => s.account.email));
  for (const acc of loadAccountsFile()) {
    if (have.has(acc.email)) continue;
    slots.push({
      account: acc,
      inFlight: false,
      state: 'new',
      failures: 0,
      cooldownUntil: 0,
      exhaustedUntil: 0,
      lastUsedAt: 0,
    });
    console.log(`[pool] added slot for ${acc.email} (total ${slots.length})`);
  }
  if (!loaded) {
    loaded = true;
    console.log(`[pool] loaded ${slots.length} account slots`);
  }
}

function safeFileName(email: string): string {
  const base = email.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 40);
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0;
  return `${base}_${h.toString(16)}`;
}

function sessionPath(email: string): string {
  return path.join(SESSIONS_DIR, `${safeFileName(email)}.json`);
}

/** Team workspace origin (https://<team>-<id>.postman.co) recorded in a
 * slot's saved session. Used when acc.url is a generic www/landing URL. */
function teamOriginFromSessionFile(email: string): string | null {
  try {
    const sp = sessionPath(email);
    if (!fs.existsSync(sp)) return null;
    const d = JSON.parse(fs.readFileSync(sp, 'utf-8')) as { origins?: Array<{ origin: string }> };
    for (const o of d.origins ?? []) {
      if (/^https:\/\/(?!www\.|m\.)[a-z0-9-]+\.postman\.co$/i.test(o.origin)) return o.origin;
    }
  } catch { /* malformed session file — ignore */ }
  return null;
}

function saveAccountUrl(email: string, url: string): void {
  try {
    const lines = fs.readFileSync(ACCOUNTS_FILE, 'utf-8').split('\n');
    const updated = lines.map((l) => {
      try {
        const a = JSON.parse(l);
        if (a.email === email) { a.url = url; return JSON.stringify(a); }
      } catch { /* keep line */ }
      return l;
    });
    fs.writeFileSync(ACCOUNTS_FILE, updated.join('\n'));
  } catch { /* non-fatal */ }
}

export function isCreditLimitError(answer: string): boolean {
  return /credit limit|AI Credit|regain access/i.test(answer);
}

/** Legacy/UI fallback: first usable account (the persistent-profile browser
 * signs in as one account only). */
export function getCurrentAccount(): Account | null {
  syncSlotsWithFile();
  const withUrl = slots.find((s) => s.state !== 'exhausted' && s.account.url);
  if (withUrl) return withUrl.account;
  const any = slots.find((s) => s.state !== 'exhausted');
  if (any) return any.account;
  return slots.length > 0 && slots[0] ? slots[0].account : null;
}

export function getSlotCount(): number {
  return slots.length;
}

export function getPoolStatus(): {
  total: number;
  ready: number;
  busy: number;
  exhausted: number;
  waiting: number;
  accounts: Array<{ email: string; state: SlotState; inFlight: boolean }>;
} {
  syncSlotsWithFile();
  return {
    total: slots.length,
    ready: slots.filter((s) => s.state === 'ready' && !s.inFlight).length,
    busy: slots.filter((s) => s.inFlight).length,
    exhausted: slots.filter((s) => s.state === 'exhausted').length,
    waiting,
    accounts: slots.map((s) => ({ email: s.account.email, state: s.state, inFlight: s.inFlight })),
  };
}

/** Re-read the accounts file (picks up newly registered accounts). Existing
 * healthy sessions are kept. */
export function reloadAccounts(): void {
  syncSlotsWithFile();
  console.log('[pool] reloaded from file');
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isLoggedInUrl(url: string): boolean {
  return (
    (url.includes('postman.co') || url.includes('postman.com')) &&
    !/login|sign-?in|verify|identity/i.test(url)
  );
}

async function dismissCloudflare(page: Page): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const body = ((await page.locator('body').innerText().catch(() => '')) || '').toLowerCase();
    if (!body.includes('verifying') && !body.includes('cloudflare') && !body.includes('just a moment')) return;
    await page.waitForTimeout(5000);
  }
}

/** Wait until the login form renders OR the page leaves the challenge,
 * up to ~3 minutes. Turnstile on a cold IP can take a while; polling beats
 * fixed sleeps. Returns true when username+password fields are visible. */
async function waitForLoginForm(page: Page): Promise<boolean> {
  for (let i = 0; i < 36; i++) {
    const userCount = await page.locator('#username').count().catch(() => 0);
    const passCount = await page.locator('#password').count().catch(() => 0);
    if (userCount > 0 && passCount > 0) {
      const visible = await page.locator('#username').first().isVisible().catch(() => false);
      if (visible) return true;
    }
    await page.waitForTimeout(5000);
  }
  return false;
}

/** Interactive username/password login inside this slot's own context.
 * Uses Playwright TRUSTED input (locator.fill / locator.click = real CDP
 * events). The old JS-evaluate fill/click silently fails on React forms and
 * was the reason headless logins never completed. */
async function doInteractiveLogin(page: Page, acc: Account): Promise<void> {
  await page.goto('https://identity.getpostman.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);
  await page.waitForTimeout(5000);
  await dismissCloudflare(page);

  // Account chooser (profile holds other sessions): click through with a
  // trusted click so React/router actually navigates.
  const chooserLink = page.getByText(/different account|use another account|sign in with a different/i).first();
  if (await chooserLink.isVisible().catch(() => false)) {
    console.log(`[pool] account chooser shown for ${acc.email}, clicking through`);
    await chooserLink.click({ timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(4000);
    await dismissCloudflare(page);
  }

  // The form may appear late (Turnstile first) — poll instead of assuming.
  if (!(await waitForLoginForm(page))) {
    const title = await page.title().catch(() => '');
    throw new Error(`login form never rendered (title="${title}") at ${page.url().slice(0, 80)}`);
  }
  await page.locator('#username').first().fill(acc.email, { timeout: 15000 });
  await page.locator('#password').first().fill(acc.password, { timeout: 15000 });
  // Verify the values actually stuck (React controlled inputs can revert).
  const check = await page.evaluate(() => {
    const gh = globalThis as unknown as Record<string, unknown>;
    if (!gh.__name) gh.__name = (f: unknown) => f;
    const u = document.querySelector('#username') as HTMLInputElement | null;
    const pw = document.querySelector('#password') as HTMLInputElement | null;
    return { u: u?.value ?? '', pFilled: !!(pw && pw.value) };
  }).catch(() => ({ u: '', pFilled: false }));
  if (check.u !== acc.email || !check.pFilled) {
    throw new Error(`credential fill did not stick (user ok=${check.u === acc.email})`);
  }

  // Submit with a trusted click, then wait for the URL to actually leave
  // the login page instead of sleeping a fixed amount.
  await page.locator('button[type=submit]').first().click({ timeout: 15000 }).catch(() => undefined);
  try {
    await page.waitForURL((url) => !url.href.includes('/login'), { timeout: 30000 });
  } catch {
    await page.waitForTimeout(5000);
  }

  let url = page.url();
  // After submit the app may bounce through the account chooser again —
  // if so, click the just-used account entry to continue.
  if (url.includes('identity.getpostman.com')) {
    const entry = page.getByText(acc.email).first();
    if (await entry.isVisible().catch(() => false)) {
      await entry.click({ timeout: 10000 }).catch(() => undefined);
    } else {
      const cont = page.getByText(/continue using postman/i).first();
      if (await cont.isVisible().catch(() => false)) {
        await cont.click({ timeout: 10000 }).catch(() => undefined);
      }
    }
    await page.waitForTimeout(8000);
    url = page.url();
  }

  if (!isLoggedInUrl(url)) {
    throw new Error(`login failed, landed on ${url.slice(0, 80)}`);
  }
}

/** Bring a slot to ready. Preparation (context + saved-session probe + team
 * landing) runs in parallel (bounded by PREP_CONCURRENCY). ONLY the
 * interactive credential login is serialized through the loginTail chain —
 * the identity server rejects concurrent logins; good saved sessions never
 * touch the chain, so a warm pool serves requests immediately. */
async function loginSlot(s: Slot): Promise<void> {
  await acquirePrepSlot();
  try {
    await loginSlotPrepare(s);
  } finally {
    releasePrepSlot();
  }
}

/** Run `fn` after every previously-queued interactive login finished. */
function queueInteractiveLogin<T>(fn: () => Promise<T>): Promise<T> {
  const run = loginTail.then(fn, fn);
  // Keep the chain alive even if this login fails (callers still see it).
  loginTail = run.then(() => undefined, () => undefined);
  return run;
}

async function loginSlotPrepare(s: Slot): Promise<void> {
  const manager = managerRef;
  if (!manager) throw new Error('account pool not initialized');
  const acc = s.account;
  console.log(`[pool] preparing slot for ${acc.email}`);

  try { await s.context?.close().catch(() => undefined); } catch { /* noop */ }
  s.context = undefined;
  s.page = undefined;

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const browser = await manager.getPoolBrowser();
  const sp = sessionPath(acc.email);
  s.context = await browser.newContext(fs.existsSync(sp) ? { storageState: sp } : {});
  s.context.setDefaultTimeout(15000);
  // Seed Cloudflare/session trust cookies from the main persistent profile
  // (same machine/IP/Chrome). Without these, fresh headless contexts get a
  // permanent Turnstile challenge on identity pages.
  try {
    const trustCookies = await manager.exportTrustCookies();
    if (trustCookies.length > 0 && s.context) {
      await s.context.addCookies(trustCookies as Parameters<BrowserContext['addCookies']>[0]);
      console.log(`[pool] seeded ${trustCookies.length} trust cookies for ${acc.email}`);
    }
  } catch (e) {
    console.log(`[pool] trust-cookie seed failed for ${acc.email}: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
  }
  const page = await s.context.newPage();
  s.page = page;

  // 1) Try the saved session first (fast path — no credentials needed).
  // acc.url can be generic (www.postman.com) for older rows; fall back to the
  // team origin recorded in the session file itself.
  let probeUrl = acc.url && acc.url.includes('postman.') && !/www\.postman\.(com|co)/.test(acc.url)
    ? acc.url
    : (teamOriginFromSessionFile(acc.email) ?? 'https://www.postman.com/');
  await page.goto(probeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => undefined);
  await page.waitForTimeout(4000);
  await dismissCloudflare(page);

  if (!isLoggedInUrl(page.url())) {
    // 2) Saved-session probe failed (CF challenge on this cold context, or the
    // session really did expire). On the LIVE serving path we have 125+ fresh
    // sessions in the pool, so a slow serialized interactive login (15s gap +
    // up to 3-min form poll) would block this request well past its client
    // timeout for no reason. Instead THROW so the caller cools down this slot
    // and immediately claims the next one. Interactive login only runs while
    // explicitly warming sessions (POSTMAN_POOL_HEADFUL=1).
    if (process.env.POSTMAN_POOL_HEADFUL !== '1') {
      throw new SessionExpiredError(`saved-session probe landed on ${page.url().slice(0, 80)}`);
    }
    console.log(`[pool] saved session invalid for ${acc.email}, queueing interactive login...`);
    await queueInteractiveLogin(async () => {
      const gap = LOGIN_GAP_MS - (Date.now() - lastLoginAt);
      if (gap > 0) {
        console.log(`[pool] spacing logins (${Math.round(gap / 1000)}s gap)...`);
        await sleep(gap);
      }
      await doInteractiveLogin(page, acc);
      lastLoginAt = Date.now();
    });
  }

  // 3) Land on a real workspace (so workspaceId can be derived per request).
  // Strategy: go to the team home first (it lists workspaces), then follow
  // the first visible workspace link. Fall back to whatever workspace link
  // exists on the current page.
  const originMatch = /^(https:\/\/[a-z0-9-]+\.postman\.co)/i.exec(page.url());
  const teamOrigin = originMatch?.[1];
  if (teamOrigin) {
    await page.goto(`${teamOrigin}/home`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => undefined);
    await page.waitForTimeout(5000);
    await dismissCloudflare(page);
  }
  const wsUrl = await page.evaluate(() => {
    const gh = globalThis as unknown as Record<string, unknown>;
    if (!gh.__name) gh.__name = (f: unknown) => f;
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/workspace/"]'));
    for (const a of links) {
      const href = a.href || '';
      // Need a full workspace URL carrying the UUID (…/workspace/Name~uuid).
      if (/workspace\/[^/]*~[0-9a-f-]{8}/i.test(href) && a.offsetParent !== null) return href;
    }
    return null;
  }).catch(() => null);
  // Track the full workspace URL (carries the UUID that deriveWorkspaceId /
  // the vision path need). Saving only "<origin>/home" would strip the UUID
  // and force every request onto a hardcoded fallback workspace that belongs
  // to a DIFFERENT account — the backend then serves empty/blocked streams.
  let workspaceUrl: string | undefined;
  if (wsUrl) {
    const clean = wsUrl.split('?')[0] ?? wsUrl;
    workspaceUrl = clean;
    await page.goto(clean, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => undefined);
    await page.waitForTimeout(4000);
  }

  // 4) Fresh accounts must grant AI consent, otherwise the backend serves
  // empty streams. Trusted clicks (React-safe).
  for (let i = 0; i < 6; i++) {
    let clicked: string | null = null;
    const consentBtn = page.locator('[data-testid="postbot-enterprise-consent-button"]').first();
    const enableBtn = page.locator('[data-testid="ai-access-enable-button"]').first();
    if (await consentBtn.isVisible().catch(() => false)) {
      await consentBtn.click({ timeout: 8000 }).catch(() => undefined);
      clicked = 'consent';
    } else if (await enableBtn.isVisible().catch(() => false)) {
      await enableBtn.click({ timeout: 8000 }).catch(() => undefined);
      clicked = 'enable';
    } else {
      const confirmBtn = page.getByRole('button', { name: /^enable$/i }).first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click({ timeout: 8000 }).catch(() => undefined);
        clicked = 'confirm';
      }
    }
    if (!clicked) break;
    console.log(`[pool] consent step (${acc.email}): ${clicked}`);
    await page.waitForTimeout(4000);
  }

  const finalUrl = page.url();
  if (!isLoggedInUrl(finalUrl)) {
    throw new Error(`slot not logged in after login flow: ${finalUrl.slice(0, 80)}`);
  }

  // 5) IDENTITY CHECK. Our exported sessions are per-account and the team
  // subdomain we landed on (step 3) is private to THIS account — landing
  // there already proves the jar is this account's session. The old check
  // opened identity.getpostman.com/accounts and demanded the email appear on
  // the switcher, but single-member teams render an EMPTY switcher ("saw:
  // none"), so it failed 100% of good sessions. Only reject when the
  // switcher is populated and clearly shows a DIFFERENT email.
  await page.goto('https://identity.getpostman.com/accounts', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => undefined);
  await page.waitForTimeout(6000);
  const emailsShown = await page.evaluate(() => {
    const gh = globalThis as unknown as Record<string, unknown>;
    if (!gh.__name) gh.__name = (f: unknown) => f;
    const found = new Set<string>();
    const re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
    for (const el of document.querySelectorAll('a, button, div, span, p')) {
      const t = (el.textContent || '').trim();
      if (!t || t.length > 80) continue;
      const m = t.match(re);
      if (m) for (const e of m) found.add(e.toLowerCase());
      if (found.size >= 8) break;
    }
    return [...found];
  }).catch(() => [] as string[]);
  const want = acc.email.toLowerCase();
  const foreign = emailsShown.filter((e) => e !== want);
  if (emailsShown.includes(want)) {
    console.log(`[pool] identity verified: ${acc.email}`);
  } else if (foreign.length >= 1 && !teamOrigin) {
    // populated switcher without our email AND no private team landed
    // earlier -> genuinely wrong session, refuse.
    throw new Error(`identity mismatch: ${acc.email} not on switcher (saw: ${foreign.slice(0, 4).join(', ')})`);
  } else {
    // Empty switcher (single-member team) or landed on this account's
    // private team in step 3 (teamOrigin set): trust the team landing.
    console.log(`[pool] identity check: switcher empty/foreign (${foreign.length} shown), trusting team landing for ${acc.email}`);
  }
  // Re-assert the team session (the accounts page may have shifted focus).
  const reassert = teamOrigin ?? probeUrl;
  await page.goto(reassert, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => undefined);
  await page.waitForTimeout(3000);

  try {
    await s.context.storageState({ path: sp });
  } catch { /* non-fatal */ }
  // Persist the BEST URL for this slot, preferring one that carries a
  // workspace UUID so deriveWorkspaceId (code-chat + vision) resolves THIS
  // account's workspace instead of the hardcoded fallback. Priority:
  //   1) the full workspace URL discovered in step 3 (…/workspace/Name~uuid)
  //   2) finalUrl if it happens to already carry a workspace UUID
  //   3) "<origin>/home" as a last resort (no UUID — fallback path)
  const uuidRe = /workspace\/[^~/]*~[0-9a-f-]{8}|workspace\/[0-9a-f-]{8}/i;
  const m = /^(https:\/\/[a-z0-9-]+\.postman\.co)/i.exec(finalUrl);
  if (workspaceUrl && uuidRe.test(workspaceUrl)) {
    acc.url = workspaceUrl;
  } else if (uuidRe.test(finalUrl)) {
    acc.url = finalUrl.split('?')[0] ?? finalUrl;
  } else {
    acc.url = m?.[1] ? `${m[1]}/home` : finalUrl;
  }
  saveAccountUrl(acc.email, acc.url);
  // Leave the page on a usable workspace (not the accounts page).
  await page.goto(acc.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => undefined);
  await page.waitForTimeout(3000);
  s.state = 'ready';
  s.failures = 0;
  console.log(`[pool] slot ready: ${acc.email}`);
}

// ---------------------------------------------------------------------------
// Acquire / release
// ---------------------------------------------------------------------------

function recoverExpired(): void {
  const now = Date.now();
  for (const s of slots) {
    if (s.state === 'exhausted' && now >= s.exhaustedUntil) {
      s.state = 'new';
      s.failures = 0;
      console.log(`[pool] quota cycle may have reset, re-arming ${s.account.email}`);
    } else if (s.state === 'cooldown' && now >= s.cooldownUntil) {
      s.state = 'new';
    }
  }
  evictIdleContexts(now);
}

/** Close the least-recently-used live contexts once we are over
 * MAX_LIVE_CONTEXTS or past the idle TTL. This is what keeps a 126-account
 * pool from eating all system RAM: only ~a dozen browser sessions stay hot,
 * the rest are rehydrated from their storageState file on next use. */
function evictIdleContexts(now: number): void {
  const live = slots.filter((s) => s.context && !s.inFlight);
  if (live.length <= MAX_LIVE_CONTEXTS) return;
  const byAge = [...live].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  let doomed = byAge.filter((s) => now - s.lastUsedAt > CONTEXT_IDLE_TTL_MS);
  if (doomed.length === 0) doomed = byAge.slice(0, live.length - MAX_LIVE_CONTEXTS);
  // Never close more than needed: keep at least MAX_LIVE_CONTEXTS warm so a
  // traffic dip does not force a re-login storm on the next burst.
  const maxClose = Math.max(0, live.length - MAX_LIVE_CONTEXTS);
  if (doomed.length > maxClose) doomed = doomed.slice(0, maxClose);
  for (const s of doomed) {
    const ctx = s.context;
    s.context = undefined;
    s.page = undefined;
    s.state = 'new';
    void ctx?.close().catch(() => undefined);
    console.log(`[pool] evicted idle context ${s.account.email} (live ${live.length} -> cap ${MAX_LIVE_CONTEXTS})`);
  }
}

/** Live contexts = RAM consumers (in-flight AND parked-ready slots). */
function liveContextCount(): number {
  let n = 0;
  for (const s of slots) if (s.context) n++;
  return n;
}

/** Cold claims in flight (context will exist shortly — count them NOW or
 * a burst of synchronous acquirers all see "under cap" and overshoot). */
let preparingCount = 0;

/** Atomically claim a free slot (round-robin). Synchronous — no awaits, so
 * concurrent acquirers can never double-claim. Caller must ensure readiness
 * (login) and release via finishSlot / markExhausted / markSessionDead.
 * Memory rule: prefer slots that ALREADY have a warm context; only open a
 * fresh context while under MAX_LIVE_CONTEXTS, otherwise let the request
 * wait in the acquire loop for one to free up. */
function claimFreeSlot(exclude: Set<string>): Slot | null {
  const n = slots.length;
  // Pass 1: a ready slot with a live context costs no extra RAM — take it.
  for (let i = 0; i < n; i++) {
    rrCursor = (rrCursor + 1) % Math.max(n, 1);
    const s = slots[rrCursor];
    if (!s || exclude.has(s.account.email)) continue;
    if (s.inFlight) continue;
    if (s.state === 'exhausted' || s.state === 'cooldown') continue;
    if (s.context && s.state === 'ready') {
      s.inFlight = true;
      return s;
    }
  }
  // Pass 2: cold slot — only while the live-context budget allows.
  if (liveContextCount() + preparingCount < MAX_LIVE_CONTEXTS) {
    for (let i = 0; i < n; i++) {
      rrCursor = (rrCursor + 1) % Math.max(n, 1);
      const s = slots[rrCursor];
      if (!s || exclude.has(s.account.email)) continue;
      if (s.inFlight) continue;
      if (s.state === 'exhausted' || s.state === 'cooldown') continue;
      if (s.context) continue; // has a context but not ready — let pass-1 rules decide
      s.inFlight = true;
      return s;
    }
  }
  return null;
}

function releaseSlot(s: Slot): void {
  s.inFlight = false;
}

/** Mark a slot free after use and record recency for LRU eviction. */
export function finishSlot(s: Slot): void {
  s.inFlight = false;
  s.lastUsedAt = Date.now();
}

function cooldownSlot(s: Slot): void {
  s.failures += 1;
  s.state = 'cooldown';
  s.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
  s.inFlight = false;
}

/** Park a quota-exhausted slot until the weekly cycle resets. */
export function markExhausted(s: Slot): void {
  s.state = 'exhausted';
  s.exhaustedUntil = Date.now() + EXHAUSTED_RECOVER_MS;
  s.inFlight = false;
  console.log(`[pool] parked exhausted slot ${s.account.email}`);
}

/** Drop a dead session; the slot re-logins on next acquire. */
export async function markSessionDead(s: Slot): Promise<void> {
  s.state = 'new';
  s.inFlight = false;
  try { await s.context?.close().catch(() => undefined); } catch { /* noop */ }
  s.context = undefined;
  s.page = undefined;
  console.log(`[pool] session dead, will re-login ${s.account.email}`);
}

async function ensureSlotReady(s: Slot): Promise<void> {
  if (s.state === 'ready' && s.page && !s.page.isClosed()) {
    s.lastUsedAt = Date.now();
    return;
  }
  if (s.state === 'ready') {
    // Page gone but session may survive — rebuild page in same context.
    try {
      if (s.context) {
        s.page = await s.context.newPage();
        s.lastUsedAt = Date.now();
        return;
      }
    } catch { /* fall through to full login */ }
  }
  if (!s.context) {
    // Cold prepare: reserve a budget slot synchronously (we are still in the
    // claim's continuation — no await has run yet) so a burst of parallel
    // acquirers cannot all pass the cap check before contexts materialize.
    preparingCount++;
    try {
      await loginSlot(s);
    } finally {
      preparingCount = Math.max(0, preparingCount - 1);
    }
  } else {
    await loginSlot(s);
  }
  s.lastUsedAt = Date.now();
}

function singleFlightRegister(): Promise<boolean> {
  if (registering) return registering;
  registering = new Promise<boolean>((resolve) => {
    console.log('[pool] all slots exhausted, registering 1 new account...');
    const before = new Set(loadAccountsFile().map((a) => a.email));
    const child = spawn('python', ['-X', 'utf8', '-u', REG_SCRIPT, '1'], {
      cwd: PROJECT_DIR,
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      console.log('[pool] register timed out after 8 min');
      child.kill();
      registering = null;
      resolve(false);
    }, REGISTER_TIMEOUT_MS);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      registering = null;
      if (ok) {
        syncSlotsWithFile();
        const after = new Set(loadAccountsFile().map((a) => a.email));
        resolve([...after].some((e) => !before.has(e)));
      } else {
        resolve(false);
      }
    };
    child.once('exit', (code) => {
      console.log(`[pool] register exited with code ${code}`);
      done(code === 0);
    });
    child.once('error', (e) => {
      console.log(`[pool] register spawn error: ${(e as Error).message}`);
      done(false);
    });
  });
  return registering;
}

/**
 * Acquire a ready slot (round-robin). Logs in lazily on first use.
 * Throws ServerBusyError when the queue is full, ClientGoneError when the
 * caller went away, or Error when no account can serve.
 */
export async function acquireSlot(
  exclude: Set<string> = new Set(),
  opts: { isCancelled?: () => boolean } = {},
): Promise<Slot> {
  if (!managerRef) throw new Error('account pool not initialized');
  syncSlotsWithFile();
  if (slots.length === 0) {
    throw new Error('account pool is empty — no accounts in postman_accounts.jsonl');
  }
  waiting++;
  try {
    const deadline = Date.now() + ACQUIRE_DEADLINE_MS;
    let registerTried = false;
    for (;;) {
      if (opts.isCancelled?.()) throw new ClientGoneError();
      recoverExpired();
      const slot = claimFreeSlot(exclude);
      if (slot) {
        try {
          await ensureSlotReady(slot);
          return slot;
        } catch (e) {
          console.log(`[pool] slot ${slot.account.email} failed: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
          try { await slot.context?.close().catch(() => undefined); } catch { /* noop */ }
          slot.context = undefined;
          slot.page = undefined;
          cooldownSlot(slot);
          continue;
        }
      }
      // No free slot right now.
      const anyBusy = slots.some((s) => s.inFlight);
      if (!anyBusy) {
        const anyPending = slots.some((s) => s.state === 'new' || s.state === 'ready');
        if (!anyPending && !registerTried) {
          registerTried = true;
          const added = await singleFlightRegister();
          if (added) continue;
        }
        throw new Error('all pool accounts exhausted and registration produced no new account');
      }
      if (waiting - 1 >= config.postman.maxQueue) {
        throw new ServerBusyError(waiting - 1);
      }
      if (Date.now() > deadline) {
        throw new ServerBusyError(waiting - 1);
      }
      await sleep(300);
    }
  } finally {
    waiting--;
  }
}
