import Fastify, { type FastifyError } from 'fastify';
import { config } from './config/env.js';
import { BrowserManager } from './browser/browser-manager.js';
import { AgentDriver, ClientGoneError, ServerBusyError } from './browser/agent-driver.js';
import { AgentTabPool, PoolExhaustedError } from './browser/tab-pool.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerOpenAiRoutes } from './routes/openai.js';
import { sanitizeError } from './openai/branding.js';
import { initPool } from './browser/account-pool.js';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
  bodyLimit: 5 * 1024 * 1024,
});

// Tolerate POSTs that declare JSON content-type but carry no body (the admin
// UI and some API clients do this); treat them as an empty object.
app.addContentTypeParser(
  'application/json',
  { parseAs: 'string' },
  (_request, body: string, done) => {
    if (!body || !body.trim()) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch (error) {
      done(error as Error);
    }
  },
);

// Same tolerance for any other declared content type on bodyless posts.
app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, _body, done) => {
  done(null, {});
});

const browser = new BrowserManager();
const tabPool = new AgentTabPool(browser);
const driver = new AgentDriver(browser, tabPool);
// Parallel account pool (N accounts serve N concurrent requests). Slots log
// in lazily on first use; no browser work happens here.
initPool(browser);

app.setErrorHandler((error: FastifyError, request, reply) => {
  request.log.error({ err: error }, 'request failed');
  if (reply.sent) return;
  // Client already gone — nothing to send, just stop.
  if (error instanceof ClientGoneError) return;
  if (error instanceof PoolExhaustedError || error instanceof ServerBusyError) {
    reply.header('Retry-After', '10').code(429).send({
      error: {
        message: error.message,
        type: 'rate_limit_error',
        code: 'too_many_concurrent_requests',
      },
    });
    return;
  }
  const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
  reply.code(status).send({
    error: {
      message: sanitizeError(error.message),
      type: status >= 500 ? 'server_error' : 'invalid_request_error',
      code: status === 500 ? 'gateway_error' : undefined,
    },
  });
});

await registerAdminRoutes(app, driver, browser);
await registerOpenAiRoutes(app, driver);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close().catch(() => undefined);
  await tabPool.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  // Open the upstream workspace immediately so the session can be established
  // before the first API call.
  if (config.browser.cdpUrl) {
    // CDP mode: the user's Chrome may not be up yet. Do not crash the server;
    // retry the attach on the first request instead.
    await browser.getPage().catch((error: unknown) => {
      app.log.warn(
        { err: error },
        'Could not attach to Chrome over CDP yet; will retry on first request. ' +
          'Chrome 136+ ignores --remote-debugging-port on the default profile; start a ' +
          'dedicated debug profile instead: chrome.exe --remote-debugging-port=9222 ' +
          '--user-data-dir=C:\\path\\to\\chrome-cdp-profile',
      );
    });
  } else {
    // Warm up the browser but don't block server startup for more than 30s.
    await Promise.race([
      browser.getPage(),
      new Promise((resolve) => setTimeout(resolve, 30_000)),
    ]).catch((error: unknown) => {
      app.log.warn(
        { err: error },
        'Upstream workspace not ready yet; will retry on first request.',
      );
    });
  }
  await app.listen({ host: config.server.host, port: config.server.port });
  app.log.info(`OpenAI base URL: http://${config.server.host}:${config.server.port}/v1`);
  // Build marker: bump when deploying so logs prove which code is live.
  app.log.info('bridge build=20260911-evidence-retry');
} catch (error) {
  app.log.error(error);
  await browser.close().catch(() => undefined);
  process.exit(1);
}
