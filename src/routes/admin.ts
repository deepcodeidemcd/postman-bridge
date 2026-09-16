import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserManager } from '../browser/browser-manager.js';
import type { AgentDriver } from '../browser/agent-driver.js';
import { config } from '../config/env.js';
import { addKey, listKeys, removeKey } from '../config/key-store.js';
import { requireApiKey } from './auth.js';
import { renderAdminPage } from './admin-ui.js';
import { reloadAccounts, getPoolStatus } from '../browser/account-pool.js';

export async function registerAdminRoutes(
  app: FastifyInstance,
  driver: AgentDriver,
  browser: BrowserManager,
): Promise<void> {
  app.get('/health', async () => ({ ok: true, service: 'ai-gateway' }));

  app.get('/', async (_request, reply) => {
    reply.redirect('/admin');
  });

  app.get('/admin', async (_request, reply) => {
    reply.type('text/html; charset=utf-8').send(renderAdminPage());
  });

  app.get('/admin/status', { preHandler: requireApiKey }, async () => driver.status());

  // Debug: dump cookie NAMES+domains from the main persistent profile (never
  // values unless ?includeValues=1). Used to diagnose session/transplant
  // issues. Localhost + API-key gated like all admin endpoints.
  app.get<{ Querystring: { includeValues?: string } }>(
    '/admin/debug/cookies',
    { preHandler: requireApiKey },
    async (request) => {
      const cookies = await browser.exportCookies();
      const withValues = request.query.includeValues === '1';
      return cookies.map((c) => ({
        name: c.name,
        domain: c.domain,
        path: c.path,
        httpOnly: c.httpOnly,
        secure: c.secure,
        ...(withValues ? { value: c.value } : {}),
      }));
    },
  );

  // Reload the account pool from postman_accounts.jsonl (after batch registration).
  app.post('/admin/pool/reload', { preHandler: requireApiKey }, async () => {
    reloadAccounts();
    return getPoolStatus();
  });

  app.get('/admin/pool/status', { preHandler: requireApiKey }, async () => getPoolStatus());

  app.post('/admin/models/refresh', { preHandler: requireApiKey }, async () => ({
    data: await driver.listModels(true),
  }));

  app.post('/admin/screenshot', { preHandler: requireApiKey }, async () => ({
    path: await browser.screenshot(),
  }));

  // Debug endpoint: find ALL file inputs and dropzones in the DOM, including
  // hidden ones, plus check what the workspace dropzone accepts.
  app.get('/admin/debug/dropzones', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();
    return page.evaluate(() => {
      const inputs = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')].map(el => ({
        accept: el.accept,
        multiple: el.multiple,
        visible: el.offsetParent !== null,
        testId: el.dataset?.testid || '',
        id: el.id,
        parentClasses: el.parentElement?.className?.toString().substring(0, 150) || '',
      }));

      const dropzones = [...document.querySelectorAll<HTMLElement>('[class*="dropzone" i], [class*="drop-zone" i], [class*="drop-files" i]')].map(el => ({
        tag: el.tagName,
        classes: el.className?.toString().substring(0, 200) || '',
        testId: el.dataset?.testid || '',
        childInputs: el.querySelectorAll('input').length,
        childFileInputs: el.querySelectorAll('input[type="file"]').length,
        text: (el.textContent || '').substring(0, 100),
      }));

      return { inputs, dropzones };
    });
  });

  // Debug endpoint: simulate a REAL drag-drop of an image file onto the
  // composer via CDP Input.dispatchDragEvent (works in headful Chrome).
  app.post('/admin/debug/drop-image', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();
    const fs = await import('node:fs');
    const path = await import('node:path');

    // Write a small red PNG to temp.
    const filePath = path.join(config.projectRoot, '.runtime', 'drop-test.png');
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FAPwHBWLY9X5zAAAAAElFTkSuQmCC';
    fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));

    // Find the composer element and its center point.
    const composer = page.locator('[data-lexical-editor="true"]').first();
    await composer.scrollIntoViewIfNeeded();
    const box = await composer.boundingBox();
    if (!box) return { error: 'composer not visible' };
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    // Use Playwright's setInputFiles on a hidden file input if one exists,
    // otherwise dispatch real drag events with the file.
    try {
      // 1) Try a hidden input[type=file] in the dropzone container.
      const input = page.locator('input[type="file"]').first();
      if (await input.count().catch(() => 0) > 0) {
        await input.setInputFiles(filePath);
        await page.waitForTimeout(2500);
        const dom = await page.evaluate(() => ({
          hasImg: document.querySelector('[data-lexical-editor="true"]')?.querySelector('img') !== null,
          html: document.querySelector('[data-lexical-editor="true"]')?.innerHTML?.substring(0, 500) ?? '',
        }));
        return { method: 'setInputFiles', dom };
      }
    } catch { /* no file input */ }

    // 2) CDP Input.dispatchDragEvent with the file payload.
    const client = await (page.context() as any).newCDPSession(page);
    await client.send('Input.setInterceptDrags', { enabled: true }).catch(() => undefined);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.up();

    try {
      await client.send('Input.dispatchDragEvent', {
        type: 'dragEnter',
        x, y,
        data: {
          items: [{ mimeType: 'image/png', data: b64, title: 'drop-test.png' }],
          files: ['drop-test.png'],
          dragOperationsMask: 1,
        },
      });
      await client.send('Input.dispatchDragEvent', {
        type: 'drop',
        x, y,
        data: {
          items: [{ mimeType: 'image/png', data: b64, title: 'drop-test.png' }],
          files: ['drop-test.png'],
          dragOperationsMask: 1,
        },
      });
    } catch (e) {
      return { method: 'dispatchDragEvent', error: String(e) };
    }

    await page.waitForTimeout(2500);
    const dom2 = await page.evaluate(() => ({
      hasImg: document.querySelector('[data-lexical-editor="true"]')?.querySelector('img') !== null,
      html: document.querySelector('[data-lexical-editor="true"]')?.innerHTML?.substring(0, 500) ?? '',
    }));
    return { method: 'dispatchDragEvent', dom: dom2 };
  });

  // Debug endpoint: focus the composer, press Ctrl+V (system clipboard),
  // then dump the Lexical editor DOM. Used to verify whether Postman's
  // Agent Mode composer accepts pasted images at all.
  app.post('/admin/debug/paste-image', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();

    // Focus the Lexical composer with a real click.
    const composer = page.locator('[data-lexical-editor="true"]').first();
    await composer.click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(500);

    // Trusted Ctrl+V through CDP.
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(2500);

    // Dump the editor DOM afterwards.
    const dom = await page.evaluate(() => {
      const ed = document.querySelector('[data-lexical-editor="true"]');
      return {
        hasImg: ed?.querySelector('img') !== null,
        imgCount: ed?.querySelectorAll('img').length ?? 0,
        innerHTML: ed?.innerHTML?.substring(0, 800) ?? '',
        text: ed?.textContent?.substring(0, 200) ?? '',
      };
    });
    return dom;
  });

  // Debug endpoint: click the "Tools" status-bar menu and dump its contents.
  app.get('/admin/debug/tools-menu', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();
    // Click the Tools status bar button
    const toolsBtn = page.locator('button:has-text("Tools")').first();
    if (await toolsBtn.isVisible().catch(() => false)) {
      await toolsBtn.click();
      await page.waitForTimeout(1500);
    }
    // Dump any open menus / popovers
    const menus = await page.evaluate(() => {
      const all = [...document.querySelectorAll<HTMLElement>('[role="menu"], [role="listbox"], [class*="popover" i], [class*="dropdown" i], [class*="menu" i]')];
      return all.filter(m => m.getBoundingClientRect().height > 50).map(m => ({
        tag: m.tagName,
        testId: m.dataset?.testid || '',
        classes: m.className?.toString().substring(0, 150) || '',
        text: (m.textContent || '').substring(0, 800),
        rect: m.getBoundingClientRect(),
      }));
    });
    // Close menu
    await page.keyboard.press('Escape').catch(() => undefined);
    return { menus };
  });

  // Debug endpoint: click the Settings (gear) button in the composer and dump contents.
  app.get('/admin/debug/settings-menu', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();
    const settingsBtn = page.locator('[data-testid="ai-chat-input-settings-button"]').first();
    if (await settingsBtn.isVisible().catch(() => false)) {
      await settingsBtn.click();
      await page.waitForTimeout(1500);
    }
    const menus = await page.evaluate(() => {
      const all = [...document.querySelectorAll<HTMLElement>('[role="menu"], [role="listbox"], [class*="popover" i], [class*="dropdown" i], [class*="menu" i], [class*="dialog" i]')];
      return all.filter(m => m.getBoundingClientRect().height > 50).map(m => ({
        tag: m.tagName,
        testId: m.dataset?.testid || '',
        classes: m.className?.toString().substring(0, 150) || '',
        text: (m.textContent || '').substring(0, 800),
        rect: m.getBoundingClientRect(),
      }));
    });
    await page.keyboard.press('Escape').catch(() => undefined);
    return { menus };
  });

  // Debug endpoint: call Postman's internal /_gw/chat endpoint directly from the
  // browser context (inheriting session auth) with an experimental image field,
  // to test whether the Postman backend accepts image input server-side.
  app.post('/admin/debug/direct-chat-api', { preHandler: requireApiKey }, async (request) => {
    const page = await browser.getPage();
    const body = (request.body ?? {}) as {
      query?: string;
      imageFields?: string[];
      imageUrl?: string;
    };
    const query = body.query ?? 'Describe the attached image.';
    const imageUrl = body.imageUrl ?? '';

    // Base request template matching what the web app sends.
    const baseInput = {
      input: {
        chatType: 'USER_QUERY',
        query,
        toolResponse: '',
        useCase: null,
        conversationId: null,
        agent: null,
        product: 'workspace_v12',
        startedFrom: 'CHAT_INPUT',
      },
      platform: 'WEB',
      clientTools: {
        nativeToolsHash: 'clienttools-workspace_v12-browser-12.26.4-260903-0231-f55e14847067',
        excludedTools: ['generateSyntheticDataFile', 'storeGeneratedDataFile', 'appendDataToDatasource', 'generateFlowCiCdCommand', 'askUser'],
        thirdParty: {},
      },
      clientKBTerms: {
        nativeTermsHash: 'kbterms-workspace_v12-browser-12.26.4-260903-0231-0d3666ad2780',
        excludedKBTerms: [],
      },
      mandatoryContext: {
        workspaceId: '6395e8dd-6e6b-4ae4-8a07-cfd9f4eb9b20',
      },
      selectedContext: [],
      backgroundContext: [],
      availableSkills: [],
      devModeOptions: {
        selectedModel: null,
        isParallelToolCallingSupported: true,
        autoRun: false,
        supportsAskUser: false,
        supportsActionRecommendations: true,
        useThinkingModeIfAvailable: true,
        thinkingLevel: 'medium',
        isLoopApprovalEnabled: true,
        enableWebAccess: true,
      },
    };

    // Attach experimental image fields in multiple plausible shapes so we can
    // discover which (if any) the backend understands.
    const imageFields = body.imageFields ?? ['images', 'attachments', 'mediaFiles', 'files'];
    const testBodies: Array<{ field: string; payload: unknown }> = [];
    for (const field of imageFields) {
      const payload = JSON.parse(JSON.stringify(baseInput)) as Record<string, unknown>;
      // Try a markdown-ish reference plus a structured attachment entry.
      (payload as any).input.query = `${query}\n\n[image: ${imageUrl}]`;
      (payload as any)[field] = [
        {
          type: 'image_url',
          url: imageUrl,
          name: 'image.png',
          mimeType: 'image/png',
        },
      ];
      testBodies.push({ field, payload });
    }

    // Also try images embedded inside input (server may read input.attachments).
    const innerAttach = JSON.parse(JSON.stringify(baseInput)) as Record<string, unknown>;
    (innerAttach as any).input.attachments = [{ type: 'image', url: imageUrl }];
    testBodies.push({ field: 'input.attachments', payload: innerAttach });

    const results: Array<{ field: string; status: number | string; responsePreview: string }> = [];
    for (const tb of testBodies) {
      try {
        const resp = await page.evaluate(async ({ url, body }) => {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
              'x-pstmn-req-service': 'agent-mode-service',
            },
            body: JSON.stringify(body),
            credentials: 'include',
          });
          const text = await res.text();
          return { status: res.status, text: text.slice(0, 2000) };
        }, { url: 'https://pmkzqm7shd77-6336972.postman.co/_gw/chat', body: tb.payload });
        results.push({ field: tb.field, status: resp.status, responsePreview: resp.text });
      } catch (e) {
        results.push({ field: tb.field, status: 'error', responsePreview: String(e).slice(0, 300) });
      }
    }

    return { results };
  });

  // Debug endpoint: capture the FULL /_gw/chat request body the web app sends,
  // including all headers we need to replicate.
  app.post('/admin/debug/chat-api-full', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();
    let chatRequestBody: string | null = null;
    let chatRequestHeaders: Record<string, string> | null = null;
    const client = await (page.context() as any).newCDPSession(page);
    await client.send('Network.enable');

    client.on('Network.requestWillBeSent', (params: any) => {
      if (params.request.url.includes('/_gw/chat')) {
        chatRequestBody = params.request.postData ?? null;
        chatRequestHeaders = params.request.headers ?? null;
      }
    });

    const composer = page.locator('[data-lexical-editor="true"]').first();
    await composer.click({ timeout: 5000 }).catch(() => undefined);
    await page.keyboard.insertText('Say exactly: FULL_DUMP_TEST');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(10000);

    await client.send('Network.disable').catch(() => undefined);
    await client.detach().catch(() => undefined);

    return {
      requestBody: chatRequestBody ? JSON.parse(chatRequestBody as string) : null,
      headers: chatRequestHeaders,
    };
  });

  // Debug endpoint: search the loaded JS bundles for image-related fields in the
  // agent-mode chat payload (to discover how Postman sends images server-side).
  app.post('/admin/debug/find-image-schema', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();

    // Find all script URLs loaded by the app.
    const scriptUrls = await page.evaluate(() => {
      return [...document.querySelectorAll<HTMLScriptElement>('script[src]')]
        .map((s) => s.src)
        .filter((u) => u.includes('.js'))
        .slice(0, 50);
    });
    console.log(`[find-image-schema] Found ${scriptUrls.length} script URLs`);

    // Fetch the biggest ones and search for interesting keywords.
    const keywords = ['attachments', 'mediaFiles', 'image_url', 'imageUrl', 'uploadImage', 'images:', 'multimodal', 'pastedImage', 'fileToUpload', 'clientAttachments'];
    const results: Array<{ url: string; size: number; matches: string[] }> = [];
    const searchPool: string[] = [];
    const allMatches: Array<{ url: string; context: string }> = [];

    for (const url of scriptUrls) {
      try {
        const resp = await page.evaluate(async (u) => {
          const res = await fetch(u);
          if (!res.ok) return '';
          return await res.text();
        }, url);
        if (!resp || resp.length < 10000) continue;

        // Only keep large chunks to search for payload-building code.
        for (const kw of keywords) {
          const idx = resp.indexOf(kw);
          if (idx >= 0) {
            const start = Math.max(0, idx - 200);
            const ctx = resp.substring(start, idx + 300);
            allMatches.push({ url: url.split('/').pop() || url, context: ctx });
          }
        }
        searchPool.push(url);
      } catch {
        // skip
      }
    }

    // Also scan in-page for window state / redux store that might reveal schema.
    const storeInfo = await page.evaluate(() => {
      const keys = Object.keys(window).filter((k) => /redux|store|postbot|agent/i.test(k)).slice(0, 20);
      return keys;
    });

    return {
      scriptsScanned: searchPool.length,
      matches: allMatches.slice(0, 30).map((m) => ({
        url: m.url,
        context: m.context.replace(/\s+/g, ' ').substring(0, 400),
      })),
      storeKeys: storeInfo,
    };
  });

  // Debug endpoint: extract session cookies via CDP and use them server-side
  // (Node fetch) to probe gateway domains that CORS blocks from the page.
  app.post('/admin/debug/node-gateway-probe', { preHandler: requireApiKey }, async (request) => {
    const page = await browser.getPage();
    const reqBody = (request.body ?? {}) as {
      probes?: Array<{ url: string; method?: string; body?: unknown; headers?: Record<string, string> }>;
    };
    const probes = reqBody.probes ?? [];

    // Get cookies for the Postman workspace domain.
    const client = await (page.context() as any).newCDPSession(page);
    const { cookies } = await client.send('Network.getCookies', {
      urls: ['https://pmkzqm7shd77-6336972.postman.co'],
    });
    await client.detach().catch(() => undefined);
    const cookieHeader = (cookies ?? []).map((c: any) => `${c.name}=${c.value}`).join('; ');

    const results: Array<{ url: string; status: number; body: string }> = [];
    for (const p of probes) {
      try {
        const res = await fetch(p.url, {
          method: p.method ?? 'GET',
          headers: {
            Cookie: cookieHeader,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
            'x-pstmn-req-service': 'agent-mode-service',
            ...(p.headers ?? {}),
          },
          ...(p.body !== undefined ? { body: JSON.stringify(p.body) } : {}),
        });
        const text = await res.text();
        results.push({ url: p.url, status: res.status, body: text.slice(0, 300) });
      } catch (e) {
        results.push({ url: p.url, status: 0, body: String(e).slice(0, 150) });
      }
    }
    return { cookieCount: cookies?.length ?? 0, results };
  });

// Debug endpoint: get cookies for a domain via CDP and test gateway access.
  app.post('/admin/debug/get-cookies', { preHandler: requireApiKey }, async (request) => {
    const page = await browser.getPage();
    const reqBody = (request.body ?? {}) as { domain?: string };
    const domain = reqBody.domain ?? 'https://pmkzqm7shd77-6336972.postman.co';
    const client = await (page.context() as any).newCDPSession(page);
    const { cookies } = await client.send('Network.getCookies', { urls: [domain] });
    await client.detach().catch(() => undefined);
    return { cookieCount: cookies?.length ?? 0, cookieNames: (cookies ?? []).map((c: any) => c.name) };
  });

// Debug endpoint: probe gateway domains (orion, bifrost, ra) for AI/vision APIs.
  app.post('/admin/debug/probe-gateways', { preHandler: requireApiKey }, async (request) => {
    const page = await browser.getPage();
    const reqBody = (request.body ?? {}) as { probes?: Array<{ domain: string; path: string; method?: string; body?: unknown }> };
    const probes = reqBody.probes ?? [
      { domain: 'https://orion-http.gw.postman.co', path: '/health' },
      { domain: 'https://orion-http.gw.postman.co', path: '/v1/models' },
      { domain: 'https://orion-http.gw.postman.co', path: '/v1/chat/completions', method: 'POST', body: { model: 'x', messages: [] } },
      { domain: 'https://orion-http.gw.postman.co', path: '/' },
      { domain: 'https://bifrost-web-https-v4.gw.postman.co', path: '/' },
      { domain: 'https://bifrost-web-https-v4.gw.postman.co', path: '/v1/models' },
      { domain: 'https://ra.gw.postman.co', path: '/' },
      { domain: 'https://ra.gw.postman.co', path: '/v1/models' },
      { domain: 'https://skill.postman.co', path: '/' },
      { domain: 'https://skill.postman.co', path: '/v1/models' },
    ];

    const result = await page.evaluate(async (probes) => {
      const results: Array<{ domain: string; path: string; status: number; body: string }> = [];
      for (const p of probes) {
        try {
          const res = await fetch(p.domain + p.path, {
            method: p.method ?? 'GET',
            headers: { 'Content-Type': 'application/json', 'x-pstmn-req-service': 'agent-mode-service' },
            ...(p.body ? { body: JSON.stringify(p.body) } : {}),
            credentials: 'include',
          });
          const text = await res.text();
          results.push({ domain: p.domain, path: p.path, status: res.status, body: text.slice(0, 200) });
        } catch (e) {
          results.push({ domain: p.domain, path: p.path, status: 0, body: String(e).slice(0, 100) });
        }
      }
      return results;
    }, probes);

    return result;
  });

  // Debug endpoint: find the correct schema for POST /ai/request by trying
  // various payload shapes (model, messages, image references).
  app.post('/admin/debug/ai-request-schema', { preHandler: requireApiKey }, async (request) => {
    const page = await browser.getPage();
    const reqBody = (request.body ?? {}) as { payloads?: Array<Record<string, unknown>> };
    const payloads = reqBody.payloads ?? [];

    const result = await page.evaluate(async (payloads) => {
      const results: Array<{ label: string; status: number; body: string }> = [];
      for (const p of payloads) {
        try {
          const res = await fetch('/_api/ws/proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ service: 'ai', method: 'POST', path: '/ai/request', body: p }),
            credentials: 'include',
          });
          const text = await res.text();
          results.push({ label: (p as any).__label || 'unknown', status: res.status, body: text.slice(0, 300) });
        } catch (e) {
          results.push({ label: (p as any).__label || 'unknown', status: 0, body: String(e).slice(0, 100) });
        }
      }
      return results;
    }, payloads);

    return result;
  });

  // Debug endpoint: probe /ai/request with detailed error capture + try to read
  // the ai-service response/validation to find the correct schema.
  app.post('/admin/debug/ai-request-deep', { preHandler: requireApiKey }, async (request) => {
    const page = await browser.getPage();
    const reqBody = (request.body ?? {}) as { method?: string; path?: string; body?: Record<string, unknown> };
    const method = reqBody.method ?? 'POST';
    const path = reqBody.path ?? '/ai/request';
    const body = reqBody.body ?? {};

    const result = await page.evaluate(async ({ method, path, body }) => {
      const res = await fetch('/_api/ws/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: 'ai', method, path, body }),
        credentials: 'include',
      });
      const text = await res.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      return { status: res.status, body: text.slice(0, 2000), parsed };
    }, { method, path, body });

    return result;
  });

  // Debug endpoint: probe /ai/request and related paths on the ai service with
  // various methods and payloads to understand the API surface.
  app.post('/admin/debug/probe-ai-request', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();

    const result = await page.evaluate(async () => {
      const tests: Array<{ method: string; path: string; body?: Record<string, unknown>; label: string }> = [
        { method: 'GET', path: '/ai/request', label: 'GET /ai/request' },
        { method: 'POST', path: '/ai/request', body: {}, label: 'POST empty' },
        { method: 'POST', path: '/ai/request', body: { type: 'vision' }, label: 'POST type:vision' },
        { method: 'POST', path: '/ai/request', body: { messages: [{ role: 'user', content: 'test' }] }, label: 'POST messages' },
        { method: 'GET', path: '/ai/consent', label: 'GET /ai/consent' },
        { method: 'GET', path: '/ai/user-settings', label: 'GET /ai/user-settings' },
        { method: 'POST', path: '/ai/postbot/request/completions', body: { prompt: 'test' }, label: 'POST completions' },
        // image-service probes
        { method: 'GET', path: '/ai/image', label: 'GET /ai/image (ai svc)' },
        { method: 'POST', path: '/ai/image', body: { fileName: 'a.png' }, label: 'POST /ai/image' },
        { method: 'POST', path: '/ai/image/upload', body: { fileName: 'a.png' }, label: 'POST /ai/image/upload' },
        { method: 'POST', path: '/ai/attachments', body: { fileName: 'a.png' }, label: 'POST /ai/attachments' },
        { method: 'POST', path: '/ai/presign', body: { attachments: [{ fileName: 'a.png', mimeType: 'image/png', byteSize: 100 }] }, label: 'POST /ai/presign' },
        { method: 'POST', path: '/ai/vision', body: { imageUrl: 'x' }, label: 'POST /ai/vision' },
        { method: 'POST', path: '/ai/multimodal', body: { imageUrl: 'x' }, label: 'POST /ai/multimodal' },
      ];

      const results: Array<{ label: string; status: number; body: string }> = [];
      for (const t of tests) {
        try {
          const res = await fetch('/_api/ws/proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ service: 'ai', method: t.method, path: t.path, ...(t.body ? { body: t.body } : {}) }),
            credentials: 'include',
          });
          const text = await res.text();
          results.push({ label: t.label, status: res.status, body: text.slice(0, 250) });
        } catch (e) {
          results.push({ label: t.label, status: 0, body: String(e).slice(0, 80) });
        }
      }
      return results;
    });

    return result;
  });

  // Debug endpoint: extract ALL /ai/* paths from bundles to map the ai-service
  // API surface.
  app.post('/admin/debug/ai-paths', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();
    const resourceUrls = await page.evaluate(() =>
      performance.getEntriesByType('resource').map((e) => e.name).filter((u) => u.endsWith('.js')),
    );

    const allPaths = new Set<string>();
    const contexts: Array<{ url: string; path: string; snippet: string }> = [];

    for (const url of resourceUrls) {
      if (!url) continue;
      try {
        const body = await page.evaluate(async (u: string) => {
          const res = await fetch(u, { credentials: 'include' });
          return res.ok ? await res.text() : '';
        }, url);
        if (!body || body.length < 1000) continue;

        // Find all /ai/... path literals.
        const re = /['"`](\/ai\/[a-zA-Z0-9\-_\/{}$.]*)['"`]/g;
        let m;
        while ((m = re.exec(body)) !== null) {
          const p = m[1];
          if (p && !allPaths.has(p)) {
            allPaths.add(p);
            const start = Math.max(0, m.index - 120);
            contexts.push({
              url: (url.split('/').pop() || url).substring(0, 50),
              path: p,
              snippet: body.substring(start, m.index + 200).replace(/\s+/g, ' ').substring(0, 300),
            });
          }
        }
      } catch { /* skip */ }
    }

    return { paths: [...allPaths], contexts: contexts.slice(0, 40) };
  });

  // Debug endpoint: search JS bundles for ws/proxy calls using the `ai` and
  // `image-service` service names to discover real whitelisted paths.
  app.post('/admin/debug/bundle-proxy-search', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();
    const resourceUrls = await page.evaluate(() =>
      performance.getEntriesByType('resource').map((e) => e.name).filter((u) => u.endsWith('.js')),
    );

    const findings: Array<{ url: string; term: string; snippet: string }> = [];
    const terms = ['image-service', 'service:"ai"', 'service:"image', '"service":"ai"', 'ai/images', 'ai/vision', 'image-service/'];

    for (const url of resourceUrls) {
      try {
        const body = await page.evaluate(async (u) => {
          const res = await fetch(u, { credentials: 'include' });
          return res.ok ? await res.text() : '';
        }, url);
        if (!body || body.length < 1000) continue;
        for (const term of terms) {
          let idx = body.indexOf(term);
          let count = 0;
          while (idx >= 0 && count < 3) {
            const start = Math.max(0, idx - 200);
            findings.push({
              url: (url.split('/').pop() || url).substring(0, 60),
              term,
              snippet: body.substring(start, idx + 300).replace(/\s+/g, ' ').substring(0, 450),
            });
            idx = body.indexOf(term, idx + 1);
            count++;
          }
        }
      } catch { /* skip */ }
    }

    return { scanned: resourceUrls.length, findings: findings.slice(0, 40) };
  });

  // Debug endpoint: probe the valid `ai` and `image-service` services with many
  // plausible paths to find the vision/chat endpoints.
  app.post('/admin/debug/probe-ai-service', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();

    const result = await page.evaluate(async () => {
      const tests: Array<{ service: string; method: string; path: string; body?: Record<string, unknown> }> = [];

      const services = ['ai', 'image-service'];
      const paths = [
        '/', '/v1', '/v1/models', '/v1/chat', '/v1/chat/completions',
        '/v1/images', '/v1/images/upload', '/v1/images/analyze',
        '/v1/upload', '/v1/presign', '/v1/presigned-url',
        '/v1/vision', '/v1/multimodal', '/v1/completions',
        '/v1/analyze', '/v1/describe', '/v1/caption',
        '/v1/ocr', '/v1/detect', '/v1/recognize',
        '/v1/files', '/v1/attachments', '/v1/attachment',
        '/v1/agents', '/v1/agent', '/v1/conversations',
        '/v1/messages', '/v1/audio', '/v1/images/generations',
        '/v1/images/edits', '/v1/images/variations',
        '/v1/embeddings', '/v1/moderation',
      ];

      for (const service of services) {
        for (const path of paths) {
          tests.push({ service, method: 'get', path });
          tests.push({ service, method: 'post', path, body: { query: 'test', imageUrl: 'https://example.com/x.png' } });
        }
      }

      const results: Array<{ service: string; method: string; path: string; status: number; body: string }> = [];
      for (const t of tests) {
        try {
          const res = await fetch('/_api/ws/proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ service: t.service, method: t.method, path: t.path, body: t.body }),
            credentials: 'include',
          });
          const text = await res.text();
          results.push({ service: t.service, method: t.method, path: t.path, status: res.status, body: text.slice(0, 150) });
        } catch (e) {
          results.push({ service: t.service, method: t.method, path: t.path, status: 0, body: String(e).slice(0, 80) });
        }
      }
      return results;
    });

    return result;
  });

  // Debug endpoint: enumerate valid services via the ws/proxy gateway by
  // diffing invalidServiceError (bad service) vs invalidPathError (valid
  // service, bad path).
  app.post('/admin/debug/enumerate-services', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();

    const result = await page.evaluate(async () => {
      const candidates = [
        // Known from bundle observations
        'datasets', 'private-network', 'mcp-catalog',
        // AI related guesses
        'postbot-service', 'agent-mode', 'agent-mode-service', 'ai-assistant',
        'assistant', 'postbot', 'ai', 'generative-ai', 'genai', 'openai-proxy',
        // Image / media
        'image-service', 'image', 'media', 'media-service', 'attachment-service',
        'attachments', 'artifact', 'artifacts', 'file', 'files', 'filestore',
        'upload', 'uploads', 'blob', 'blobstore', 'storage', 's3-proxy',
        // Common postman services
        'collections', 'workspace', 'workspace-service', 'identity', 'billing',
        'usage', 'api-keys', 'governance', 'insights', 'monitor', 'mock',
        'flow', 'flows', 'security', 'scim', 'enterprise', 'team', 'teams',
        'user', 'users', 'notifications', 'search', 'history', 'webhooks',
      ];
      const results: Record<string, string> = {};
      for (const service of candidates) {
        try {
          const res = await fetch('/_api/ws/proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ service, method: 'get', path: '/__probe__' }),
            credentials: 'include',
          });
          const text = await res.text();
          if (text.includes('invalidServiceError')) {
            results[service] = 'INVALID';
          } else if (text.includes('invalidPathError')) {
            results[service] = 'VALID_SERVICE';
          } else {
            results[service] = `OTHER:${res.status}`;
          }
        } catch (e) {
          results[service] = 'ERROR';
        }
      }
      return results;
    });

    return result;
  });

  // Debug endpoint: probe image-service with POST + various paths/bodies.
  app.post('/admin/debug/probe-image-service-post', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();

    const result = await page.evaluate(async () => {
      const service = 'image-service';
      // Try various POST endpoints with plausible payloads.
      const tests: Array<{ path: string; body: Record<string, unknown> }> = [
        { path: '/v1/upload', body: { fileName: 'a.png', mimeType: 'image/png' } },
        { path: '/v1/images', body: { fileName: 'a.png', mimeType: 'image/png' } },
        { path: '/v1/images/upload', body: { fileName: 'a.png', mimeType: 'image/png' } },
        { path: '/v1/presign', body: { attachments: [{ fileName: 'a.png', mimeType: 'image/png', byteSize: 100 }] } },
        { path: '/v1/presigned-url', body: { attachments: [{ fileName: 'a.png', mimeType: 'image/png', byteSize: 100 }] } },
        { path: '/v1/analyze', body: { url: 'https://example.com/a.png' } },
        { path: '/v1/describe', body: { url: 'https://example.com/a.png' } },
        { path: '/v1/caption', body: { url: 'https://example.com/a.png' } },
        { path: '/api/upload', body: { fileName: 'a.png', mimeType: 'image/png' } },
        { path: '/api/presign', body: { attachments: [{ fileName: 'a.png', mimeType: 'image/png', byteSize: 100 }] } },
        { path: '/presign', body: { attachments: [{ fileName: 'a.png', mimeType: 'image/png', byteSize: 100 }] } },
        { path: '/upload', body: { fileName: 'a.png', mimeType: 'image/png' } },
        { path: '/v1/process', body: { imageUrl: 'https://example.com/a.png', operations: ['describe'] } },
        { path: '/v1/vision/describe', body: { imageUrl: 'https://example.com/a.png' } },
      ];
      const results: Array<{ path: string; status: number; body: string }> = [];
      for (const t of tests) {
        try {
          const res = await fetch('/_api/ws/proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ service, method: 'post', path: t.path, body: t.body }),
            credentials: 'include',
          });
          const text = await res.text();
          results.push({ path: t.path, status: res.status, body: text.slice(0, 200) });
        } catch (e) {
          results.push({ path: t.path, status: 0, body: String(e).slice(0, 100) });
        }
      }
      return results;
    });

    return result;
  });

  // Debug endpoint: probe image-service with common paths to discover its API.
  app.post('/admin/debug/probe-image-service', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();

    const result = await page.evaluate(async () => {
      const service = 'image-service';
      const paths = [
        '/', '/v1', '/v1/images', '/v1/images/generations',
        '/v1/images/uploads', '/v1/images/analyze',
        '/v1/upload', '/v1/analyze', '/v1/describe',
        '/v1/vision', '/v1/multimodal', '/v1/chat/completions',
        '/v1/models', '/v1/files', '/v1/images/edits',
        '/v1/images/variations', '/api', '/api/v1',
        '/api/images', '/api/upload', '/api/vision',
        '/v1/process', '/v1/recognize', '/v1/detect',
        '/v1/classify', '/v1/segment', '/v1/ocr',
        '/v1/generate', '/v1/transform', '/v1/convert',
        '/v1/optimize', '/v1/resize', '/v1/crop',
        '/v1/annotate', '/v1/label', '/v1/tag',
        '/v1/caption', '/v1/question', '/v1/answer',
        // Image CRUD
        '/v1/images/id', '/v1/images/upload',
        '/v1/presign', '/v1/presigned-url',
        '/v1/attachments', '/v1/attachments/upload',
        // Agent mode related
        '/v1/agent/images', '/v1/agent/vision',
        '/v1/chat/vision',
      ];
      const results: Array<{ path: string; status: number; body: string }> = [];
      for (const path of paths) {
        try {
          const res = await fetch('/_api/ws/proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ service, method: 'get', path }),
            credentials: 'include',
          });
          const body = await res.text();
          results.push({ path, status: res.status, body: body.slice(0, 150) });
        } catch (e) {
          results.push({ path, status: 0, body: String(e).slice(0, 100) });
        }
      }
      return results;
    });

    return result;
  });

  // Debug endpoint: probe Postman backend services for AI/vision APIs.
  // Uses the _api/ws/proxy gateway (service-based RPC) to enumerate services.
  app.post('/admin/debug/probe-services', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();

    const result = await page.evaluate(async () => {
      const services = [
        'agent-mode-service', 'postbot', 'postbot-service', 'ai-service',
        'vision', 'multimodal', 'image-service', 'media-service',
        'file-service', 'upload-service', 'artifacts', 'artifact-service',
        'postman-ai', 'ai-gateway', 'llm-gateway', 'inference',
      ];
      const results: Array<{ service: string; path: string; status: number; body: string }> = [];

      const paths = ['/v1/models', '/health', '/v1/chat'];
      for (const service of services) {
        for (const path of paths) {
          try {
            const res = await fetch('/_api/ws/proxy', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ service, method: 'get', path }),
              credentials: 'include',
            });
            const text = await res.text();
            // 404 from gateway means service not routed; other statuses are interesting.
            if (res.status !== 404) {
              results.push({ service, path, status: res.status, body: text.slice(0, 200) });
            }
          } catch (e) {
            // network error = interesting too
          }
        }
      }
      return results;
    });

    return result;
  });

  // Debug endpoint: run raw JS in the page via CDP Runtime.evaluate (no
  // TypeScript transpilation of the browser-side code, avoiding __name errors).
  app.post('/admin/debug/runtime-eval', { preHandler: requireApiKey }, async (request) => {
    const page = await browser.getPage();
    const body = (request.body ?? {}) as { expression?: string };
    const expression = body.expression ?? '1+1';
    const client = await (page.context() as any).newCDPSession(page);
    const result = await client.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 120000,
    });
    await client.detach().catch(() => undefined);
    if (result.exceptionDetails) {
      return { error: result.exceptionDetails.exception?.description || result.exceptionDetails.text };
    }
    return { result: result.result?.value };
  });

  // Debug endpoint: brute-force the chat payload schema for image references.
  // Uploads a red PNG to S3 once, then tries MANY field-name/placement
  // combinations in /_gw/chat to find the one the agent model can see.
  app.post('/admin/debug/brute-force-image-schema', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();

    const result = await page.evaluate(async () => {
      const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FAPwHBWLY9X5zAAAAAElFTkSuQmCC';
      const bytes = Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0));
      const byteSize = bytes.byteLength;

      // Presign + upload once.
      const presignRes = await fetch('/_gw/attachments/presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pstmn-req-service': 'agent-mode-service' },
        body: JSON.stringify({ attachments: [{ fileName: 'red.png', mimeType: 'image/png', byteSize }] }),
        credentials: 'include',
      });
      const presignBody = await presignRes.json().catch(() => null);
      const att = presignBody?.attachments?.[0];
      if (!att?.uploadUrl) return { error: 'presign failed: ' + JSON.stringify(presignBody).slice(0, 300) };
      const uploadRes = await fetch(att.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytes });
      if (uploadRes.status !== 200) return { error: 'S3 upload failed: ' + uploadRes.status };
      const attId = att.id;

      // Build payload with many different image reference shapes.
      const baseInput = {
        chatType: 'USER_QUERY',
        query: 'Look at the image I attached and tell me its exact color. Answer with only the color name.',
        toolResponse: '',
        useCase: null,
        conversationId: null,
        agent: null,
        product: 'workspace_v12',
        startedFrom: 'CHAT_INPUT',
      };
      const common = {
        platform: 'WEB',
        clientTools: {
          nativeToolsHash: 'clienttools-workspace_v12-browser-12.26.4-260903-0231-f55e14847067',
          excludedTools: ['generateSyntheticDataFile', 'storeGeneratedDataFile', 'appendDataToDatasource', 'generateFlowCiCdCommand', 'askUser'],
          thirdParty: {},
        },
        clientKBTerms: {
          nativeTermsHash: 'kbterms-workspace_v12-browser-12.26.4-260903-0231-0d3666ad2780',
          excludedKBTerms: [],
        },
        mandatoryContext: { workspaceId: '6395e8dd-6e6b-4ae4-8a07-cfd9f4eb9b20' },
        selectedContext: [],
        backgroundContext: [],
        availableSkills: [],
        devModeOptions: {
          selectedModel: null,
          isParallelToolCallingSupported: true,
          autoRun: false,
          supportsAskUser: false,
          supportsActionRecommendations: true,
          useThinkingModeIfAvailable: true,
          thinkingLevel: 'medium',
          isLoopApprovalEnabled: true,
          enableWebAccess: true,
        },
      };

      const makeAttachment = (url: string) => [{ id: attId, mimeType: 'image/png', byteSize, url }];
      const S3URL = `https://s3.amazonaws.com/us-prod-agent-mode-chat-artifacts/${attId}`;

      // Many candidate shapes.
      const shapes: Array<{ name: string; build: () => any }> = [
        { name: 'input.query+mdlink', build: () => ({ input: { ...baseInput, query: `Look at the image: [image](${S3URL}) and tell me its color.` }, ...common }) },
        { name: 'input.images', build: () => ({ input: { ...baseInput, images: makeAttachment(S3URL) }, ...common }) },
        { name: 'input.attachments', build: () => ({ input: { ...baseInput, attachments: makeAttachment(S3URL) }, ...common }) },
        { name: 'input.media', build: () => ({ input: { ...baseInput, media: makeAttachment(S3URL) }, ...common }) },
        { name: 'input.files', build: () => ({ input: { ...baseInput, files: makeAttachment(S3URL) }, ...common }) },
        { name: 'root.attachments', build: () => ({ input: baseInput, ...common, attachments: makeAttachment(S3URL) }) },
        { name: 'root.images', build: () => ({ input: baseInput, ...common, images: makeAttachment(S3URL) }) },
        { name: 'root.media', build: () => ({ input: baseInput, ...common, media: makeAttachment(S3URL) }) },
        { name: 'root.artifacts', build: () => ({ input: baseInput, ...common, artifacts: makeAttachment(S3URL) }) },
        { name: 'input.artifacts', build: () => ({ input: { ...baseInput, artifacts: makeAttachment(S3URL) }, ...common }) },
        { name: 'selectedContext IMAGE', build: () => ({ input: baseInput, ...common, selectedContext: [{ type: 'IMAGE', value: { id: attId } }] }) },
        { name: 'selectedContext IMAGE_ATTACHMENT', build: () => ({ input: baseInput, ...common, selectedContext: [{ type: 'IMAGE_ATTACHMENT', value: { id: attId, url: S3URL } }] }) },
        { name: 'backgroundContext IMAGE', build: () => ({ input: baseInput, ...common, backgroundContext: [{ type: 'IMAGE', value: { id: attId, url: S3URL } }] }) },
        { name: 'root.attachments full', build: () => ({ input: baseInput, ...common, attachments: [{ id: attId, type: 'image/png', mimeType: 'image/png', byteSize, url: S3URL, fileName: 'red.png', artifactId: attId }] }) },
        { name: 'input.message image', build: () => ({ input: { ...baseInput, message: { role: 'user', content: [{ type: 'text', text: 'Look at this image' }, { type: 'image_url', image_url: { url: S3URL } }] } }, ...common }) },
        { name: 'messages array', build: () => ({ input: baseInput, ...common, messages: [{ role: 'user', content: [{ type: 'text', text: 'color?' }, { type: 'image_url', image_url: { url: S3URL } }] }] }) },
      ];

      const results: Array<{ name: string; status: number; answer: string }> = [];
      for (const shape of shapes) {
        let payload;
        try { payload = shape.build(); } catch { continue; }
        try {
          const res = await fetch('/_gw/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'x-pstmn-req-service': 'agent-mode-service' },
            body: JSON.stringify(payload),
            credentials: 'include',
          });
          const reader = res.body?.getReader();
          if (!reader) { results.push({ name: shape.name, status: res.status, answer: 'no reader' }); continue; }
          const decoder = new TextDecoder();
          let acc = '';
          const texts: string[] = [];
          const deadline = Date.now() + 30000;
          while (Date.now() < deadline) {
            const { done, value } = await reader.read();
            if (done) break;
            acc += decoder.decode(value, { stream: true });
            const lines = acc.split('\n');
            acc = lines.pop() ?? '';
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              try {
                const parsed = JSON.parse(line.slice(6));
                if (parsed.eventType === 'textChunk' && parsed.data?.textContent) texts.push(parsed.data.textContent);
                if (parsed.eventType === 'failure') texts.push('FAIL:' + JSON.stringify(parsed.data).slice(0, 100));
              } catch { /* ignore */ }
            }
          }
          const answer = texts.join('').slice(0, 250);
          results.push({ name: shape.name, status: res.status, answer });
        } catch (e) {
          results.push({ name: shape.name, status: 0, answer: String(e).slice(0, 120) });
        }
      }

      return { attId, results };
    });

    return result;
  });

  // Debug endpoint: extract the image-upload code region from the platform bundle
  // (the IMAGE_*_ERROR constants reveal the full server-side image pipeline).
  app.post('/admin/debug/image-pipeline', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();
    const resourceUrls = await page.evaluate(() =>
      performance.getEntriesByType('resource').map((e) => e.name),
    );
    const platformUrl = resourceUrls.find((u) => u.includes('platform-') && u.endsWith('.js'));
    if (!platformUrl) return { error: 'platform bundle not found' };

    const bundle = await page.evaluate(async (u) => {
      const res = await fetch(u, { credentials: 'include' });
      return res.ok ? await res.text() : '';
    }, platformUrl);
    if (!bundle) return { error: 'fetch failed' };

    // Find the IMAGE_* constants region and dump a large window around it.
    const idx = bundle.indexOf('IMAGE_PRESIGNED_URL_ERROR');
    const regions: Record<string, string> = {};
    if (idx >= 0) {
      // Dump a wide window both directions.
      const start = Math.max(0, idx - 4000);
      regions.pipeline = bundle.substring(start, idx + 6000);
    }

    // Also search for how images get referenced in conversation (attachImage,
    // addImage, imageAttachment, etc.).
    const searchTerms = ['imageUpload', 'attachImage', 'addImage', 'imageAttachment', 'IMAGE_', 'imageUrl', 's3.amazonaws', 'artifacts/'];
    const extra: Array<{ term: string; snippet: string }> = [];
    for (const term of searchTerms) {
      let tidx = bundle.indexOf(term);
      let count = 0;
      while (tidx >= 0 && count < 3) {
        const start = Math.max(0, tidx - 150);
        extra.push({ term, snippet: bundle.substring(start, tidx + 250).replace(/\s+/g, ' ').substring(0, 400) });
        tidx = bundle.indexOf(term, tidx + 1);
        count++;
      }
    }

    return { size: bundle.length, regions, extra: extra.slice(0, 30) };
  });

  // Debug endpoint: search ALL loaded chunks for references to the artifacts
  // attachment id pattern and how the chat payload references them.
  app.post('/admin/debug/artifact-search', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();
    const resourceUrls = await page.evaluate(() =>
      performance.getEntriesByType('resource').map((e) => e.name).filter((u) => u.endsWith('.js')),
    );

    const terms = ['artifacts/', 'attachment', 'byteSize', 'uploadUrl', 'presign'];
    const findings: Array<{ url: string; term: string; snippet: string }> = [];
    let scanned = 0;

    for (const url of resourceUrls) {
      try {
        const body = await page.evaluate(async (u) => {
          try {
            const res = await fetch(u, { credentials: 'include' });
            return res.ok ? await res.text() : '';
          } catch { return ''; }
        }, url);
        if (!body || body.length < 1000) continue;
        scanned++;
        for (const term of terms) {
          let idx = body.indexOf(term);
          let count = 0;
          while (idx >= 0 && count < 2) {
            const start = Math.max(0, idx - 150);
            findings.push({
              url: (url.split('/').pop() || url).substring(0, 60),
              term,
              snippet: body.substring(start, idx + 300).replace(/\s+/g, ' ').substring(0, 400),
            });
            idx = body.indexOf(term, idx + 1);
            count++;
          }
        }
      } catch { /* skip */ }
    }

    return { totalResources: resourceUrls.length, scanned, findings: findings.slice(0, 50) };
  });

  // Debug endpoint: FULL image flow — presign → S3 PUT → chat with attachment ref.
  app.post('/admin/debug/s3-image-flow', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();

    // 1) Presign + upload + chat, all in-page (same-origin auth).
    const result = await page.evaluate(async () => {
      // 10x10 red PNG.
      const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FAPwHBWLY9X5zAAAAAElFTkSuQmCC';
      const bytes = Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0));
      const byteSize = bytes.byteLength;

      const out: Record<string, unknown> = {};

      // Step 1: presign.
      const presignRes = await fetch('/_gw/attachments/presign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-pstmn-req-service': 'agent-mode-service',
        },
        body: JSON.stringify({
          attachments: [{ fileName: 'red.png', mimeType: 'image/png', byteSize }],
        }),
        credentials: 'include',
      });
      const presignBody = await presignRes.json().catch(() => null);
      out.presignStatus = presignRes.status;
      const att = presignBody?.attachments?.[0];
      if (!att?.uploadUrl) {
        out.error = 'no uploadUrl: ' + JSON.stringify(presignBody).slice(0, 300);
        return out;
      }
      out.attId = att.id;

      // Step 2: PUT bytes to S3.
      const uploadRes = await fetch(att.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: bytes,
      });
      out.uploadStatus = uploadRes.status;
      if (uploadRes.status !== 200) {
        out.error = 'S3 upload failed: ' + (await uploadRes.text()).slice(0, 300);
        return out;
      }

      // Step 3: chat with attachment reference — try shapes.
      const basePayload = {
        input: {
          chatType: 'USER_QUERY',
          query: 'What color is the attached image? Answer with only the color name.',
          toolResponse: '',
          useCase: null,
          conversationId: null,
          agent: null,
          product: 'workspace_v12',
          startedFrom: 'CHAT_INPUT',
        },
        platform: 'WEB',
        clientTools: {
          nativeToolsHash: 'clienttools-workspace_v12-browser-12.26.4-260903-0231-f55e14847067',
          excludedTools: ['generateSyntheticDataFile', 'storeGeneratedDataFile', 'appendDataToDatasource', 'generateFlowCiCdCommand', 'askUser'],
          thirdParty: {},
        },
        clientKBTerms: {
          nativeTermsHash: 'kbterms-workspace_v12-browser-12.26.4-260903-0231-0d3666ad2780',
          excludedKBTerms: [],
        },
        mandatoryContext: { workspaceId: '6395e8dd-6e6b-4ae4-8a07-cfd9f4eb9b20' },
        selectedContext: [],
        backgroundContext: [],
        availableSkills: [],
        devModeOptions: {
          selectedModel: null,
          isParallelToolCallingSupported: true,
          autoRun: false,
          supportsAskUser: false,
          supportsActionRecommendations: true,
          useThinkingModeIfAvailable: true,
          thinkingLevel: 'medium',
          isLoopApprovalEnabled: true,
          enableWebAccess: true,
        },
      };

      const shapes: Array<{ name: string; patch: Record<string, unknown> }> = [
        { name: 'root_attachments', patch: { attachments: [{ id: att.id, mimeType: 'image/png', byteSize }] } },
        { name: 'input_attachments', patch: {} },
      ];
      const inputShape = shapes[1];
      if (inputShape) {
        (inputShape.patch as { input?: unknown }).input = { ...(basePayload.input as Record<string, unknown>), attachments: [{ id: att.id, mimeType: 'image/png', byteSize }] };
      }
      shapes.push({
        name: 'selected_context',
        patch: { selectedContext: [{ type: 'ATTACHMENT', value: { id: att.id, mimeType: 'image/png' } }] },
      });
      shapes.push({
        name: 'background_context',
        patch: { backgroundContext: [{ type: 'ATTACHMENT', value: { id: att.id, mimeType: 'image/png', url: `https://s3.amazonaws.com/us-prod-agent-mode-chat-artifacts/${att.id}` } }] },
      });

      const results: Array<{ name: string; status: number; answer: string }> = [];
      for (const shape of shapes) {
        const payload = { ...basePayload, ...shape.patch };
        const res = await fetch('/_gw/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            'x-pstmn-req-service': 'agent-mode-service',
          },
          body: JSON.stringify(payload),
          credentials: 'include',
        });
        const reader = res.body?.getReader();
        if (!reader) { results.push({ name: shape.name, status: res.status, answer: 'no reader' }); continue; }
        const decoder = new TextDecoder();
        let acc = '';
        const texts: string[] = [];
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          const lines = acc.split('\n');
          acc = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const parsed = JSON.parse(line.slice(6));
              if (parsed.eventType === 'textChunk' && parsed.data?.textContent) texts.push(parsed.data.textContent);
              if (parsed.eventType === 'failure') texts.push('FAILURE:' + JSON.stringify(parsed.data).slice(0, 150));
            } catch { /* ignore */ }
          }
        }
        results.push({ name: shape.name, status: res.status, answer: texts.join('').slice(0, 300) });
      }
      out.shapeResults = results;
      return out;
    });

    return result;
  });

  // Debug endpoint: get the Postman access token and call /attachments/presign
  // to obtain an S3 presigned upload URL, then test uploading an image.
  app.post('/admin/debug/presign-test', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();

    // 1. Find the access token in localStorage / IndexedDB / cookies.
    const tokenInfo = await page.evaluate(() => {
      const results: Record<string, unknown> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        if (/token|auth|access|session/i.test(key)) {
          const val = localStorage.getItem(key) || '';
          results[key] = val.length > 100 ? val.substring(0, 100) + '...' : val;
        }
      }
      return results;
    });

    // 2. Call the presign endpoint with the token.
    const presignResult = await page.evaluate(async () => {
      // Try to get token from common locations.
      const tokens: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        const val = localStorage.getItem(key) || '';
        if (/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/.test(val)) {
          const m = val.match(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/);
          if (m) tokens.push(m[0]);
        }
      }
      const token = tokens[0] || '';

      // The endpoint requires body.attachments with per-attachment byteSize.
      // Iterate schema candidates quickly to discover the full contract.
      const candidates = [
        {
          attachments: [{ fileName: 'test-image.png', mimeType: 'image/png', byteSize: 1024 }],
        },
        {
          attachments: [{ name: 'test-image.png', mimeType: 'image/png', byteSize: 1024, size: 1024 }],
        },
        {
          attachments: [{ fileName: 'test-image.png', type: 'image/png', byteSize: 1024 }],
        },
        {
          attachments: [{ fileName: 'test-image.png', mimeType: 'image/png', byteSize: 1024, purpose: 'image' }],
        },
        {
          attachments: [{ fileName: 'test-image.png', mimeType: 'image/png', byteSize: 1024, fileSize: 1024 }],
        },
      ];
      const results: Array<{ status: number; body: string }> = [];
      for (const candidate of candidates) {
        const res = await fetch('https://pmkzqm7shd77-6336972.postman.co/_gw/attachments/presign', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-pstmn-req-service': 'agent-mode-service',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify(candidate),
          credentials: 'include',
        });
        const text = await res.text();
        results.push({ status: res.status, body: text.substring(0, 1200) });
      }
      return { status: results[0]?.status, results, tokenFound: !!token };
    });

    return { tokenInfo, presignResult };
  });

  // Debug endpoint: dump EXACT code around the presign upload function u() and
  // the /conversation endpoint usage from the ai-chat bundle.
  app.post('/admin/debug/ai-chat-upload-flow', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();
    const resourceUrls = await page.evaluate(() =>
      performance.getEntriesByType('resource').map((e) => e.name),
    );
    const aiChatUrl = resourceUrls.find((u) => u.includes('ai-chat-') && u.endsWith('.js'));
    if (!aiChatUrl) return { error: 'bundle not found' };

    const bundle = await page.evaluate(async (u) => {
      const res = await fetch(u, { credentials: 'include' });
      return res.ok ? await res.text() : '';
    }, aiChatUrl);
    if (!bundle) return { error: 'fetch failed' };

    const regions: Record<string, string> = {};

    // Find "/attachments/presign" and dump 5000 chars AFTER (the upload fn u).
    const presignIdx = bundle.indexOf('"/attachments/presign"');
    if (presignIdx >= 0) {
      regions.presignAfter = bundle.substring(presignIdx, presignIdx + 5000);
    }

    // Find "/conversation" endpoint usage.
    const convIdx = bundle.indexOf('"/conversation"');
    if (convIdx >= 0) {
      regions.conversation = bundle.substring(convIdx - 500, convIdx + 3500);
    }

    // Find "/chat?stream=false" — the non-streaming endpoint.
    const chatIdx = bundle.indexOf('"/chat?stream=false"');
    if (chatIdx >= 0) {
      regions.chatStreamFalse = bundle.substring(chatIdx - 300, chatIdx + 2000);
    }

    // Find the presign function call: search for "presigned-url" and "presign"
    const psIdx = bundle.indexOf('/presigned-url');
    if (psIdx >= 0) {
      regions.presignedUrl = bundle.substring(psIdx - 1500, psIdx + 800);
    }

    return regions;
  });

  // Debug endpoint: dump exact regions of the ai-chat bundle around the USER_QUERY
  // payload construction (es variable) and the presign upload function u(...).
  app.post('/admin/debug/ai-chat-deep2', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();
    const resourceUrls = await page.evaluate(() =>
      performance.getEntriesByType('resource').map((e) => e.name),
    );
    const aiChatUrl = resourceUrls.find((u) => u.includes('ai-chat-') && u.endsWith('.js'));
    if (!aiChatUrl) return { error: 'bundle not found' };

    const bundle = await page.evaluate(async (u) => {
      const res = await fetch(u, { credentials: 'include' });
      return res.ok ? await res.text() : '';
    }, aiChatUrl);
    if (!bundle) return { error: 'fetch failed' };

    const regions: Record<string, string> = {};

    // The region right before the el payload: search for 'let el={input:{chatType'.
    const elIdx = bundle.indexOf('let el={input:{chatType');
    if (elIdx >= 0) {
      // Dump 3500 chars BEFORE to see how es (query) is composed.
      regions.beforeEl = bundle.substring(Math.max(0, elIdx - 3500), elIdx);
    }

    // Search for image handling near "message:" or editor state → look for
    // common image-to-payload helpers.
    for (const term of ['image/png', 'toDataURL', 'readAsDataURL', 'FileReader', 'paste', 'onPaste']) {
      const indices: number[] = [];
      let idx = bundle.indexOf(term);
      while (idx >= 0 && indices.length < 3) {
        indices.push(idx);
        idx = bundle.indexOf(term, idx + 1);
      }
      regions['hits_' + term.replace(/[^A-Za-z0-9]/g, '')] = JSON.stringify(
        indices.map((i) => bundle.substring(Math.max(0, i - 120), i + 250).replace(/\s+/g, ' ').substring(0, 350)),
      );
    }

    return regions;
  });

// Debug endpoint: test TOOL_RESPONSE chatType with attachments (image) — the
  // way Postman tools feed images back into the conversation.
  app.post('/admin/debug/tool-response-image', { preHandler: requireApiKey }, async (request) => {
    const page = await browser.getPage();
    const body = (request.body ?? {}) as { query?: string; imageUrl?: string; conversationId?: string };
    const query = body.query ?? 'Describe the image above.';
    const imageUrl = body.imageUrl ?? '';

    const payload: Record<string, unknown> = {
      input: {
        chatType: 'TOOL_RESPONSE',
        query,
        toolResponse: 'Tool call returned an image attachment for analysis.',
        useCase: null,
        conversationId: body.conversationId ?? null,
        product: 'workspace_v12',
      },
      platform: 'WEB',
      clientTools: {
        nativeToolsHash: 'clienttools-workspace_v12-browser-12.26.4-260903-0231-f55e14847067',
        excludedTools: ['generateSyntheticDataFile', 'storeGeneratedDataFile', 'appendDataToDatasource', 'generateFlowCiCdCommand', 'askUser'],
        thirdParty: {},
      },
      clientKBTerms: {
        nativeTermsHash: 'kbterms-workspace_v12-browser-12.26.4-260903-0231-0d3666ad2780',
        excludedKBTerms: [],
      },
      mandatoryContext: { workspaceId: '6395e8dd-6e6b-4ae4-8a07-cfd9f4eb9b20' },
      selectedContext: [],
      backgroundContext: [],
      availableSkills: [],
      devModeOptions: {
        selectedModel: null,
        isParallelToolCallingSupported: true,
        autoRun: false,
        supportsAskUser: false,
        supportsActionRecommendations: true,
        useThinkingModeIfAvailable: true,
        thinkingLevel: 'medium',
        isLoopApprovalEnabled: true,
        enableWebAccess: true,
      },
      toolCallGroupId: 'bridge-test-group-1',
      toolResponses: [
        {
          toolCallId: 'bridge-test-call-1',
          content: 'Image captured for analysis.',
          toolResponseSummary: 'Image captured',
          toolResponseStatus: 'SUCCESS',
          attachments: [
            {
              name: 'image.png',
              mimeType: 'image/png',
              url: imageUrl,
              type: 'image',
            },
          ],
        },
      ],
    };

    const result = await page.evaluate(async ({ url, body }) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'x-pstmn-req-service': 'agent-mode-service',
        },
        body: JSON.stringify(body),
        credentials: 'include',
      });
      const reader = res.body?.getReader();
      if (!reader) return { status: res.status, events: [] };
      const decoder = new TextDecoder();
      let acc = '';
      const events: Array<{ type: string; data: string }> = [];
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        const lines = acc.split('\n');
        acc = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const d = line.slice(6);
            let evType = 'raw';
            try {
              const parsed = JSON.parse(d);
              evType = parsed.eventType ?? 'raw';
            } catch { /* keep raw */ }
            events.push({ type: evType, data: d.substring(0, 500) });
          }
        }
      }
      return { status: res.status, events: events.slice(0, 60) };
    }, { url: 'https://pmkzqm7shd77-6336972.postman.co/_gw/chat', body: payload });

    return result;
  });

// Debug endpoint: extract EXACT code around payload building & upload from
  // the ai-chat bundle (targeted regexes for the interesting regions).
  app.post('/admin/debug/ai-chat-deep', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();
    const resourceUrls = await page.evaluate(() =>
      performance.getEntriesByType('resource').map((e) => e.name),
    );
    const aiChatUrl = resourceUrls.find((u) => u.includes('ai-chat-') && u.endsWith('.js'));
    if (!aiChatUrl) return { error: 'bundle not found' };

    const bundle = await page.evaluate(async (u) => {
      const res = await fetch(u, { credentials: 'include' });
      return res.ok ? await res.text() : '';
    }, aiChatUrl);
    if (!bundle) return { error: 'fetch failed' };

    // Find the function `u` that does the presign upload: locate the segment
    // after "attachments/presign" definition and dump ~3000 chars.
    const presignIdx = bundle.indexOf('/attachments/presign');
    const regions: Record<string, string> = {};

    if (presignIdx >= 0) {
      // The chunk defines endpoints then functions; dump a wide window around it.
      const start = Math.max(0, presignIdx - 2500);
      regions.presign = bundle.substring(start, presignIdx + 800);
    }

    // Find where USER_QUERY payload includes attachments/images.
    const userQueryIdx = bundle.indexOf('AIChatAPIInputTypes.USER_QUERY');
    if (userQueryIdx >= 0) {
      regions.userQuery = bundle.substring(userQueryIdx - 200, userQueryIdx + 2500);
    }

    // Find the presign call sites (u(...) usages with /attachments).
    const attachApiIdx = bundle.indexOf('"/attachments/presign"');
    if (attachApiIdx < 0) regions.altAttach = 'not found';

    // Find "attachments:" payload keys.
    let searchIdx = 0;
    const attachKeySnippets: string[] = [];
    while (searchIdx < bundle.length) {
      const idx = bundle.indexOf('attachments:', searchIdx);
      if (idx < 0) break;
      attachKeySnippets.push(bundle.substring(Math.max(0, idx - 250), idx + 350));
      searchIdx = idx + 1;
      if (attachKeySnippets.length >= 5) break;
    }
    regions.attachmentsKeys = JSON.stringify(attachKeySnippets);

    // Search for 'files' / 'image' / 'data:' near the payload builder.
    for (const term of ['query:', 'messages:', 'images:', 'files:', 'media:']) {
      const idx = bundle.indexOf(term);
      if (idx >= 0) {
        regions['near_' + term.replace(/[^a-z]/gi, '')] = bundle.substring(Math.max(0, idx - 150), idx + 400);
      }
    }

    // The upload function call flow: find calls to the presign URL var `a`.
    const callIdx = bundle.indexOf('await u(');
    if (callIdx >= 0) regions.uploadCall = bundle.substring(callIdx - 200, callIdx + 1500);

    return regions;
  });

  // Debug endpoint: dump the FULL ai-chat bundle and search it for how images/
  // attachments are added to the USER_QUERY payload, plus the presign upload
  // flow.
  app.post('/admin/debug/ai-chat-bundle', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();
    const resourceUrls = await page.evaluate(() => {
      return performance.getEntriesByType('resource').map((e) => e.name);
    });

    const aiChatUrl = resourceUrls.find((u) => u.includes('ai-chat-') && u.endsWith('.js'));
    if (!aiChatUrl) return { error: 'ai-chat bundle not found', resources: resourceUrls.slice(0, 30) };

    const bundle = await page.evaluate(async (u) => {
      const res = await fetch(u, { credentials: 'include' });
      return res.ok ? await res.text() : '';
    }, aiChatUrl);

    if (!bundle) return { error: 'could not fetch ai-chat bundle', url: aiChatUrl };

    const findings: Array<{ term: string; snippets: string[] }> = [];
    const terms = [
      'attachments/presign', 'presign', 'uploadImage', 'addImage', 'attachments:',
      'query:es', 'seedingMessages', 'attachments[', '.attachments',
      'imageContent', 'image_url', 'data:image', 'fileUpload', 'presignedUrl',
      'hasAttachments', 'imageAttachments', 'blobToDataUrl', 'pastedFiles',
    ];

    for (const term of terms) {
      const snippets: string[] = [];
      let idx = bundle.indexOf(term);
      let count = 0;
      while (idx >= 0 && count < 4) {
        const start = Math.max(0, idx - 180);
        snippets.push(bundle.substring(start, idx + 300).replace(/\s+/g, ' ').substring(0, 450));
        idx = bundle.indexOf(term, idx + 1);
        count++;
      }
      if (snippets.length) findings.push({ term, snippets });
    }

    return { url: aiChatUrl, size: bundle.length, findings };
  });

  // Debug endpoint: enumerate ALL JS chunks the app has loaded (Performance API)
  // and search each for how the agent chat payload builds image/attachment fields.
  app.post('/admin/debug/chunk-image-search', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();

    // Performance API reveals every fetched resource, including lazy chunks.
    const resourceUrls = await page.evaluate(() => {
      return performance.getEntriesByType('resource')
        .map((e) => e.name)
        .filter((u) => u.endsWith('.js') || u.includes('.js?'));
    });

    const searchTerms = [
      'chatType', 'USER_QUERY', 'startedFrom', 'nativeToolsHash',  // payload builders
      'pastedImage', 'imageData', 'attachments', 'mediaFiles', 'image_url',
      'addImage', 'uploadImage', 'screenshotToAgent', 'conversationAttachment',
    ];

    const findings: Array<{ url: string; term: string; snippet: string }> = [];
    let scanned = 0;
    const CHUNK_LIMIT = 40; // avoid scanning too many

    for (const url of resourceUrls.slice(-CHUNK_LIMIT)) {
      try {
        const body = await page.evaluate(async (u) => {
          try {
            const res = await fetch(u, { credentials: 'include' });
            return res.ok ? await res.text() : '';
          } catch { return ''; }
        }, url);
        if (!body || body.length < 1000) continue;
        scanned++;
        for (const term of searchTerms) {
          let idx = body.indexOf(term);
          let count = 0;
          while (idx >= 0 && count < 2) {
            const start = Math.max(0, idx - 150);
            findings.push({
              url: (url.split('/').pop() || url).substring(0, 80),
              term,
              snippet: body.substring(start, idx + 250).replace(/\s+/g, ' ').substring(0, 350),
            });
            idx = body.indexOf(term, idx + 1);
            count++;
          }
        }
      } catch { /* skip */ }
    }

    return { totalResources: resourceUrls.length, scanned, findings: findings.slice(0, 80) };
  });

  // Debug endpoint: capture the FULL SSE response from /_gw/chat for a given
  // query so we can see the final answer (not just the first chunks).
  app.post('/admin/debug/chat-full-response', { preHandler: requireApiKey }, async (request) => {
    const page = await browser.getPage();
    const body = (request.body ?? {}) as { query?: string; field?: string; imageUrl?: string };
    const query = body.query ?? 'Say exactly: FULL_RESPONSE_TEST';
    const imageUrl = body.imageUrl ?? '';

    // Build payload; if field provided, attach image under that field name.
    const payload: Record<string, unknown> = {
      input: {
        chatType: 'USER_QUERY',
        query,
        toolResponse: '',
        useCase: null,
        conversationId: null,
        agent: null,
        product: 'workspace_v12',
        startedFrom: 'CHAT_INPUT',
      },
      platform: 'WEB',
      clientTools: {
        nativeToolsHash: 'clienttools-workspace_v12-browser-12.26.4-260903-0231-f55e14847067',
        excludedTools: ['generateSyntheticDataFile', 'storeGeneratedDataFile', 'appendDataToDatasource', 'generateFlowCiCdCommand', 'askUser'],
        thirdParty: {},
      },
      clientKBTerms: {
        nativeTermsHash: 'kbterms-workspace_v12-browser-12.26.4-260903-0231-0d3666ad2780',
        excludedKBTerms: [],
      },
      mandatoryContext: { workspaceId: '6395e8dd-6e6b-4ae4-8a07-cfd9f4eb9b20' },
      selectedContext: [],
      backgroundContext: [],
      availableSkills: [],
      devModeOptions: {
        selectedModel: null,
        isParallelToolCallingSupported: true,
        autoRun: false,
        supportsAskUser: false,
        supportsActionRecommendations: true,
        useThinkingModeIfAvailable: true,
        thinkingLevel: 'medium',
        isLoopApprovalEnabled: true,
        enableWebAccess: true,
      },
    };

    if (body.field && imageUrl) {
      (payload as any)[body.field] = [{ type: 'image_url', url: imageUrl, name: 'image.png', mimeType: 'image/png' }];
    }

    // Read the full SSE stream from the page.
    const result = await page.evaluate(async ({ url, body }) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'x-pstmn-req-service': 'agent-mode-service',
        },
        body: JSON.stringify(body),
        credentials: 'include',
      });
      // Collect all SSE events.
      const reader = res.body?.getReader();
      if (!reader) return { status: res.status, events: [] };
      const decoder = new TextDecoder();
      let acc = '';
      let full = '';
      const events: Array<{ type: string; data: string }> = [];
      // Read up to 60s.
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        full += decoder.decode(value, { stream: true });
        // Parse complete SSE events from acc
        acc += decoder.decode(value, { stream: true });
        const lines = acc.split('\n');
        acc = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const d = line.slice(6);
            events.push({ type: 'event', data: d.substring(0, 600) });
          }
        }
      }
      return { status: res.status, events, totalBytes: full.length };
    }, { url: 'https://pmkzqm7shd77-6336972.postman.co/_gw/chat', body: payload });

    return result;
  });

  // Debug endpoint: use CDP Runtime to search loaded JS source for how the
  // agent-mode chat handles images / attachments (search the live bundle).
  app.post('/admin/debug/runtime-image-search', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();
    const client = await (page.context() as any).newCDPSession(page);

    // Find all script URLs (including dynamically loaded).
    const scripts = await page.evaluate(() => {
      return [...document.querySelectorAll<HTMLScriptElement>('script[src]')].map((s) => s.src).filter((u) => u.includes('postman'));
    });

    const searchTerms = [
      'attachments', 'mediaFiles', 'image_url', 'imageUrl', 'pastedImage',
      'fileAttachments', 'clientAttachments', 'screenshot', 'uploadMedia',
      'multimodalContent', 'vision', 'imageContent', 'addAttachment',
    ];

    const findings: Array<{ url: string; term: string; snippet: string }> = [];
    const totalScripts = scripts.length;

    // Use Runtime.getIsolateId + CDP to fetch bundle contents. Playwright
    // can't fetch these cross-origin, so use Runtime.evaluate with fetch on
    // the same origin (the page can fetch its own bundles).
    for (let i = 0; i < scripts.length; i++) {
      const url = scripts[i];
      if (!url) continue;
      const body = await page.evaluate(async (u: string) => {
        try {
          const res = await fetch(u, { credentials: 'include' });
          return res.ok ? await res.text() : '';
        } catch { return ''; }
      }, url);
      if (!body || body.length < 2000) continue;
      for (const term of searchTerms) {
        let idx = body.indexOf(term);
        let count = 0;
        while (idx >= 0 && count < 3) {
          const start = Math.max(0, idx - 120);
          findings.push({
            url: url.split('/').pop() || url,
            term,
            snippet: body.substring(start, idx + 200).replace(/\s+/g, ' ').substring(0, 300),
          });
          idx = body.indexOf(term, idx + 1);
          count++;
        }
      }
    }

    await client.detach().catch(() => undefined);
    return { totalScripts, scanned: scripts.length, findings: findings.slice(0, 60) };
  });

// Debug endpoint: capture network traffic while the agent processes a prompt.
  // This reveals what API endpoints the Postman web app calls when talking to
  // the AI backend — the key to finding a server-side image upload path.
  app.post('/admin/debug/sniff-network', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();
    const requests: Array<{
      url: string;
      method: string;
      body?: string;
      status?: number;
      contentType?: string;
    }> = [];

    const client = await (page.context() as any).newCDPSession(page);
    await client.send('Network.enable');

    client.on('Network.requestWillBeSent', (params: any) => {
      requests.push({
        url: params.request.url,
        method: params.request.method,
        body: params.request.postData,
      });
    });
    client.on('Network.responseReceived', (params: any) => {
      const req = requests.find((r) => r.url === params.response.url && r.status === undefined);
      if (req) {
        req.status = params.response.status;
        req.contentType = params.response.mimeType;
      }
    });

    // Type a simple prompt and submit it.
    const composer = page.locator('[data-lexical-editor="true"]').first();
    await composer.click({ timeout: 5000 }).catch(() => undefined);
    await page.keyboard.insertText('Say exactly: NETWORK_TEST_OK');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(15000);

    await client.send('Network.disable').catch(() => undefined);
    await client.detach().catch(() => undefined);

    // Filter interesting requests (exclude static assets).
    const interesting = requests.filter((r) =>
      /ai|agent|postbot|chat|completion|message|conversation|upload|image|media|graphql|api/i.test(r.url) &&
      !/\.(js|css|png|jpg|svg|woff|woff2|ico)(\?|$)/i.test(r.url),
    );

    return {
      total: requests.length,
      interesting: interesting.slice(0, 40).map((r) => ({
        url: r.url.substring(0, 200),
        method: r.method,
        status: r.status,
        contentType: r.contentType,
        bodyPreview: r.body ? r.body.substring(0, 500) : undefined,
      })),
    };
  });

  // Debug endpoint: click "More..." in the settings menu and dump everything.
  app.get('/admin/debug/settings-more', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();
    // Open settings menu
    const settingsBtn = page.locator('[data-testid="ai-chat-input-settings-button"]').first();
    await settingsBtn.click().catch(() => undefined);
    await page.waitForTimeout(1200);

    // Dump full menu text first
    const menuText = await page.evaluate(() => {
      const menus = [...document.querySelectorAll('[role="menu"], .szh-menu')];
      return menus.filter(m => m.getBoundingClientRect().height > 20).map(m => m.textContent?.trim().substring(0, 500));
    });

    // Click "More..." if present
    const moreBtn = page.getByText(/^More\.\.\.$/i).first();
    if (await moreBtn.isVisible().catch(() => false)) {
      await moreBtn.click();
      await page.waitForTimeout(1500);
    }

    const afterText = await page.evaluate(() => {
      const menus = [...document.querySelectorAll('[role="menu"], .szh-menu')];
      return menus.filter(m => m.getBoundingClientRect().height > 20).map(m => m.textContent?.trim().substring(0, 800));
    });

    await page.keyboard.press('Escape').catch(() => undefined);
    return { menuText, afterText };
  });

  // Debug endpoint: explore how to add a custom MCP server in Postman.
  app.get('/admin/debug/mcp-add', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();

    // Open the MCP dialog again via settings.
    const settingsBtn = page.locator('[data-testid="ai-chat-input-settings-button"]').first();
    await settingsBtn.click().catch(() => undefined);
    await page.waitForTimeout(1200);
    const mcpBtn = page.getByText(/Configure MCP servers/i).first();
    await mcpBtn.click().catch(() => undefined);
    await page.waitForTimeout(2500);

    // Look for "Add" / "Add custom" / "+" buttons and any input fields in the Your MCPs section.
    const addInfo = await page.evaluate(() => {
      const section = document.querySelector('[data-testid="your-mcps-section"]');
      const scope = section ?? document;
      const buttons = [...scope.querySelectorAll<HTMLButtonElement>('button')].map(b => ({
        text: (b.textContent || '').trim().substring(0, 50),
        testId: b.dataset?.testid || '',
        ariaLabel: b.getAttribute('aria-label') || '',
        visible: b.offsetParent !== null,
      })).filter(b => b.visible);

      const inputs = [...scope.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].map(i => ({
        type: (i as HTMLInputElement).type,
        placeholder: (i as HTMLInputElement).placeholder || '',
        testId: i.dataset?.testid || '',
      }));

      const links = [...scope.querySelectorAll<HTMLAnchorElement>('a')].map(a => ({
        text: (a.textContent || '').trim().substring(0, 60),
        href: a.href || '',
      }));

      return { buttons, inputs, links };
    });

    // Also search the whole dialog for "custom" keyword.
    const dialogText = await page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>('[data-testid="mcp-servers-card-view"]');
      return dialog?.innerText?.substring(0, 3000) || '';
    });

    await page.keyboard.press('Escape').catch(() => undefined);
    return { addInfo, dialogText };
  });

  // Debug endpoint: click "Configure MCP servers" and explore the dialog.
  app.get('/admin/debug/mcp-servers', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();
    // Open settings
    const settingsBtn = page.locator('[data-testid="ai-chat-input-settings-button"]').first();
    await settingsBtn.click().catch(() => undefined);
    await page.waitForTimeout(1500);

    // Click "Configure MCP servers"
    const mcpBtn = page.getByText(/Configure MCP servers/i).first();
    let mcpClicked = false;
    if (await mcpBtn.isVisible().catch(() => false)) {
      await mcpBtn.click();
      await page.waitForTimeout(3000);
      mcpClicked = true;
    }

    // If no visible MCP, try "More..."
    if (!mcpClicked) {
      const moreBtn = page.getByText(/More/i).first();
      if (await moreBtn.isVisible().catch(() => false)) {
        await moreBtn.click();
        await page.waitForTimeout(2000);
        // Now try MCP again
        const mcpBtn2 = page.getByText(/Configure MCP servers/i).first();
        if (await mcpBtn2.isVisible().catch(() => false)) {
          await mcpBtn2.click();
          await page.waitForTimeout(3000);
          mcpClicked = true;
        }
      }
    }

    // Also click "Auto-run" to see if there's relevant config
    const autoRunBtn = page.getByText(/Auto-run/i).first();
    if (await autoRunBtn.isVisible().catch(() => false)) {
      await autoRunBtn.click();
      await page.waitForTimeout(1500);
    }

    // Dump all visible dialogs, panels, modals
    const dialogs = await page.evaluate(() => {
      const all = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [class*="modal" i], [class*="dialog" i], [data-testid*="dialog" i], [data-testid*="modal" i], [class*="mcp" i], [data-testid*="mcp" i]')];
      return all.filter(m => m.getBoundingClientRect().height > 100).map(m => ({
        tag: m.tagName,
        testId: m.dataset?.testid || '',
        classes: m.className?.toString().substring(0, 200) || '',
        innerText: (m.textContent || '').substring(0, 1500),
        rect: m.getBoundingClientRect(),
      }));
    });

    // Also dump the full body text for keyword search
    const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';

    return { dialogs, bodyKeywords: ['upload', 'image', 'file', 'vision', 'screenshot', 'attachment', 'mcp', 'tool', 'function'].filter(k => bodyText.toLowerCase().includes(k)), mcpClicked };
  });

  // Debug endpoint: find any elements hinting at tools the agent can use
  // (upload, image, vision, sendRequest, read_file etc).
  app.get('/admin/debug/agent-tools', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();
    return page.evaluate(() => {
      const bodyText = document.body?.innerText || '';
      const keywords = ['upload', 'image', 'vision', 'attachment', 'file', 'screenshot', 'sendRequest', 'subagent', 'read_file', 'browser'];
      const matches = keywords.filter(k => bodyText.toLowerCase().includes(k));
      return { bodyKeywordMatches: matches };
    });
  });

  // Debug endpoint: inspect the AI chat panel message container structure.
  app.get('/admin/debug/panel', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();
    const info = await page.evaluate(() => {
      // Find the AI chat panel (right side, tall container)
      const candidates = [...document.querySelectorAll('div')].filter(el => {
        const r = el.getBoundingClientRect();
        return r.right > window.innerWidth * 0.55 && r.height > window.innerHeight * 0.5 && r.width > 250;
      });
      const panelInfo = candidates.slice(0, 8).map(el => ({
        classes: el.className?.toString().substring(0, 150) || '',
        testId: el.dataset?.testid || '',
        childCount: el.children.length,
        textLen: (el.textContent || '').length,
        rect: el.getBoundingClientRect(),
        scrollable: el.scrollHeight > el.clientHeight,
      }));

      // Find message elements (user + assistant bubbles)
      const messages = [...document.querySelectorAll<HTMLElement>('[data-testid*="message" i], [data-message-author-role], [role="article"], [class*="ai-chat-message" i]')]
        .slice(0, 15)
        .map(el => ({
          tag: el.tagName,
          classes: el.className?.toString().substring(0, 120) || '',
          testId: el.dataset?.testid || '',
          role: el.dataset?.messageAuthorRole || el.getAttribute('data-message-author-role') || '',
          text: (el.textContent || '').substring(0, 100),
          rect: el.getBoundingClientRect(),
        }));

      return { panelInfo, messages };
    });
    return info;
  });

  // Debug endpoint: simulate typing @ in editor and dump resulting menu.
  app.get('/admin/debug/at-menu', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();
    const composer = page.locator('[data-lexical-editor="true"]').first();
    await composer.click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(300);
    // Type @ to trigger context menu
    await page.keyboard.type('@', { delay: 100 });
    await page.waitForTimeout(1500);

    const menuInfo = await page.evaluate(() => {
      // Find any dropdown/popover/menu that appeared
      const menus = document.querySelectorAll('[role="menu"], [role="listbox"], [class*="dropdown"], [class*="popover"], [class*="menu"], [data-testid*="menu"]');
      return [...menus].map(m => ({
        tag: m.tagName,
        testId: (m as HTMLElement).dataset?.testid || '',
        classes: m.className?.toString().substring(0, 200) || '',
        text: (m.textContent || '').substring(0, 500),
        visible: m.getBoundingClientRect().height > 0,
        rect: m.getBoundingClientRect(),
        childCount: m.children.length,
      }));
    });

    // Also take screenshot
    const ssPath = await browser.screenshot('debug-at-menu.png');

    return { menus: menuInfo, screenshot: ssPath };
  });

  // Debug endpoint: dump composer DOM info for vision troubleshooting.
  app.get('/admin/debug/composer', { preHandler: requireApiKey }, async () => {
    const page = await browser.getPage();
    const info = await page.evaluate(() => {
      const editables = [...document.querySelectorAll<HTMLElement>('[contenteditable="true"]')];
      const fileInputs = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')];
      const allInputs = [...document.querySelectorAll<HTMLInputElement>('input')];
      const textareas = [...document.querySelectorAll<HTMLTextAreaElement>('textarea')];

      // Find the composer area (bottom-right panel with placeholder)
      const composerCandidates = editables.filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.right > window.innerWidth * 0.6 && rect.bottom > window.innerHeight * 0.7;
      });

      return {
        url: location.href,
        editables: editables.map(el => ({
          tag: el.tagName,
          classes: el.className.toString().substring(0, 300),
          testId: (el as HTMLElement).dataset?.testid || '',
          placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '',
          innerText: (el.textContent || '').substring(0, 100),
          rect: el.getBoundingClientRect(),
          childTags: [...el.children].map(c => c.tagName).join(','),
          hasImg: el.querySelector('img') !== null,
          hasSvg: el.querySelector('svg') !== null,
        })),
        composerCandidates: composerCandidates.map(el => ({
          tag: el.tagName,
          classes: el.className.toString().substring(0, 300),
          testId: (el as HTMLElement).dataset?.testid || '',
          placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '',
        })),
        fileInputs: fileInputs.map(el => ({
          accept: el.accept,
          multiple: el.multiple,
          testId: (el as HTMLElement).dataset?.testid || '',
          id: el.id,
          visible: el.offsetParent !== null,
          parentClasses: el.parentElement?.className?.toString().substring(0, 200) || '',
        })),
        textareaCount: textareas.length,
        inputCount: allInputs.length,
        // Check for any image upload / attach buttons
        attachButtons: [...document.querySelectorAll('button')].filter(btn => {
          const text = (btn.textContent || '').toLowerCase();
          const label = (btn.getAttribute('aria-label') || '').toLowerCase();
          const testId = (btn as HTMLElement).dataset?.testid || '';
          return text.includes('attach') || text.includes('upload') || text.includes('image') ||
                 label.includes('attach') || label.includes('upload') || label.includes('image') ||
                 testId.includes('attach') || testId.includes('upload') || testId.includes('image');
        }).map(btn => ({
          text: (btn.textContent || '').substring(0, 50),
          testId: (btn as HTMLElement).dataset?.testid || '',
          ariaLabel: btn.getAttribute('aria-label') || '',
        })),
        // Composer parent hierarchy
        composerParentHTML: (() => {
          const ed = composerCandidates[0] || editables[editables.length - 1];
          if (!ed) return '';
          let el: Element = ed;
          for (let i = 0; i < 5; i++) { el = el.parentElement || el; }
          return el.outerHTML.substring(0, 2000);
        })(),
        // All buttons in the bottom-right panel area
        panelButtons: [...document.querySelectorAll('button')].filter(btn => {
          const rect = btn.getBoundingClientRect();
          return rect.right > window.innerWidth * 0.6 && rect.bottom > window.innerHeight * 0.7;
        }).map(btn => ({
          text: (btn.textContent || '').trim().substring(0, 50),
          testId: (btn as HTMLElement).dataset?.testid || '',
          ariaLabel: btn.getAttribute('aria-label') || '',
          title: btn.getAttribute('title') || '',
          classes: btn.className?.toString().substring(0, 150) || '',
          rect: btn.getBoundingClientRect(),
        })),
        // Lexical editor internals
        lexicalInfo: (() => {
          const ed = document.querySelector('[data-lexical-editor="true"]');
          if (!ed) return { found: false };
          // Lexical stores internals on __lexicalEditor or in __zone_symbol...
          const keys = Object.keys(ed).filter(k => k.startsWith('__'));
          const reactFiber = Object.keys(ed).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
          return {
            found: true,
            internalKeys: keys.slice(0, 10),
            hasReactFiber: !!reactFiber,
            fiberKey: reactFiber || '',
            // Check for Lexical composer context
            hasLexical: typeof (window as any).__LEXICAL_VERSION !== 'undefined' || 
                        typeof (window as any).Lexical !== 'undefined',
          };
        })(),
        // Try to find image-related commands or plugins
        lexicalPlugins: (() => {
          const ed = document.querySelector('[data-lexical-editor="true"]');
          if (!ed) return [];
          // Check for custom elements or data attributes that might indicate image support
          const parent = ed.closest('[class*="lexical"], [class*="editor"], [data-testid*="editor"]');
          const allAttrs = parent ? [...parent.attributes].map(a => `${a.name}=${a.value}`) : [];
          return allAttrs.slice(0, 20);
        })(),
      };
    });
    return info;
  });

  // Serves the latest screenshot as an image so the admin UI can display it.
  app.get('/admin/screenshot/file', { preHandler: requireApiKey }, async (_request, reply) => {
    const file = path.join(config.projectRoot, '.runtime', 'postman-bridge-debug.png');
    if (!fs.existsSync(file)) {
      return reply.code(404).send({ error: 'no screenshot yet — POST /admin/screenshot first' });
    }
    reply.type('image/png').send(fs.createReadStream(file));
  });

  // API key management for connecting clients like Cursor.
  app.get('/admin/keys', { preHandler: requireApiKey }, async () => ({
    baseUrl: `http://${config.server.host}:${config.server.port}/v1`,
    keys: listKeys(),
  }));

  app.post('/admin/keys', { preHandler: requireApiKey }, async (request, reply) => {
    const body = (request.body ?? {}) as { user?: string };
    try {
      return addKey(String(body.user ?? ''));
    } catch (error) {
      return reply.code(400).send({
        error: { message: error instanceof Error ? error.message : 'Invalid user' },
      });
    }
  });

  app.delete('/admin/keys/:user', { preHandler: requireApiKey }, async (request, reply) => {
    const { user } = request.params as { user: string };
    try {
      removeKey(user);
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({
        error: { message: error instanceof Error ? error.message : 'Remove failed' },
      });
    }
  });
}

