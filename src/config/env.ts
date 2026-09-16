import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';

dotenv.config();

function env(name: string, fallback?: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function intEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = env(name);
  if (!raw) return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${name} must be true/false`);
}

const workspaceUrl = env('POSTMAN_WORKSPACE_URL');
if (!workspaceUrl) {
  throw new Error('POSTMAN_WORKSPACE_URL is required. Copy .env.example to .env and set it.');
}

function apiKeysEnv(primaryKey: string): Record<string, string> {
  const raw = env('BRIDGE_API_KEYS');
  if (!raw) return { default: primaryKey };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys: Record<string, string> = {};
      for (const [userId, key] of Object.entries(parsed)) {
        if (typeof key === 'string' && key.trim()) keys[userId] = key.trim();
      }
      if (Object.keys(keys).length > 0) return keys;
    }
  } catch {
    // fall through to the error below
  }
  throw new Error('BRIDGE_API_KEYS must be a JSON object like {"alice":"sk-alice","bob":"sk-bob"}');
}

const apiKey = env('BRIDGE_API_KEY', 'sk-postman-local')!;

// Project root = folder containing this source tree's .env (two levels up
// from src/config). Used by key-store to persist BRIDGE_API_KEYS regardless
// of the process cwd.
const projectRoot = path.resolve(process.cwd());

export const config = {
  projectRoot,
  server: {
    host: env('BRIDGE_HOST', '127.0.0.1')!,
    port: intEnv('BRIDGE_PORT', 8787),
    apiKey,
    apiKeys: apiKeysEnv(apiKey),
    defaultUserId: env('BRIDGE_DEFAULT_USER_ID', 'default')!,
  },
  postman: {
    workspaceUrl,
    profileDir: path.resolve(env('POSTMAN_PROFILE_DIR', '.postman-profile')!),
    headless: boolEnv('POSTMAN_HEADLESS', false),
    navigationTimeoutMs: intEnv('POSTMAN_NAVIGATION_TIMEOUT_MS', 45_000),
    completionTimeoutMs: intEnv('POSTMAN_COMPLETION_TIMEOUT_MS', 180_000),
    responseStableMs: intEnv('POSTMAN_RESPONSE_STABLE_MS', 2_200),
    modelCacheTtlMs: intEnv('POSTMAN_MODEL_CACHE_TTL_MS', 300_000),
    // Max number of concurrent agent tabs; each tab hosts one user's conversation.
    maxTabs: intEnv('POSTMAN_MAX_TABS', 5),
    // Max requests waiting for a free pool slot. With a large account pool
    // (N accounts serve N concurrent requests) the queue cap should scale with
    // it, otherwise a big pool fails fast at 429 while slots sit idle. Beyond
    // this the bridge returns 429 + Retry-After instead of queueing forever.
    maxQueue: intEnv('POSTMAN_MAX_QUEUE', 64),
    // Keep user tabs alive longer so repeated requests reuse the same tab
    // instead of opening a new one (the sweep only closes long-idle tabs).
    tabIdleTtlMs: intEnv('POSTMAN_TAB_IDLE_TTL_MS', 3_600_000),
    selectors: {
      composer: env('POSTMAN_SELECTOR_COMPOSER'),
      modelButton: env('POSTMAN_SELECTOR_MODEL_BUTTON'),
      assistantMessage: env('POSTMAN_SELECTOR_ASSISTANT_MESSAGE'),
      newChat: env('POSTMAN_SELECTOR_NEW_CHAT'),
      generating: env('POSTMAN_SELECTOR_GENERATING'),
    },
  },
  browser: {
    channel: env('BROWSER_CHANNEL', 'chrome')!,
    executablePath: env('BROWSER_EXECUTABLE_PATH'),
    // When set (e.g. http://127.0.0.1:9222), the bridge attaches to a dedicated
    // Chrome window with a debug profile instead of launching its own profile.
    cdpUrl: env('BROWSER_CDP_URL'),
    // Hide the CDP Chrome window off-screen so the bridge runs fully in the
    // background (the page still renders normally; minimizing would throttle
    // its timers and break the automation).
    cdpHidden: boolEnv('BROWSER_CDP_HIDDEN', false),
    // Profile dir used by the CDP-attached Chrome window. The bridge relaunches
    // this window automatically when a request arrives and CDP is not listening.
    cdpProfileDir: path.resolve(env('POSTMAN_CDP_PROFILE_DIR', '.chrome-cdp-profile')!),
  },
} as const;
