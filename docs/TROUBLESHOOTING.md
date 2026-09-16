# Troubleshooting

## `Could not locate the Postman Agent Mode composer`

1. Make sure the browser opened the intended workspace.
2. Make sure Agent Mode is visible on the right.
3. Sign in if needed.
4. Run `npm run doctor`.
5. Inspect `.runtime/doctor-failure.png`.
6. Set `POSTMAN_SELECTOR_COMPOSER` to a stable selector from DevTools.

Prefer accessibility attributes (`aria-label`, `placeholder`, `role`) over generated class names.

## Model list is incomplete

Open the Postman model dropdown manually and check whether `More models` opens on hover or click. Then run:

```bash
npm run doctor
```

The discovery code tries both hover and click. If your build uses a different control, set `POSTMAN_SELECTOR_MODEL_BUTTON`.

## Wrong text returned as the answer

Set `POSTMAN_SELECTOR_ASSISTANT_MESSAGE` to a selector that matches assistant message containers only. The default fallback uses panel text and a unique end marker, which is less precise than a message-level selector.

## Enter adds a newline instead of sending

The bridge tries Enter, then a visible Send/Submit button, then Ctrl+Enter (Cmd+Enter on macOS). If your Postman setting behaves differently, adjust `enterAndSubmit()` in `src/browser/agent-driver.ts`.

## Chrome is not found

Set:

```env
BROWSER_EXECUTABLE_PATH=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe
```

or the equivalent Chromium path on your system.

## Cursor says model does not exist

First query:

```text
GET /v1/models
```

Use the exact bridge ID returned there. Model names are derived from what your Postman account currently shows.

## Long request times out

Increase:

```env
POSTMAN_COMPLETION_TIMEOUT_MS=300000
```

This only changes how long the local bridge waits for the browser UI. It does not change Postman-side limits.

## Agent tools are unreliable

Tool calling is emulated at the prompt/protocol layer. Start by verifying plain chat. Then test one simple tool at a time. Models may occasionally produce malformed tool blocks; malformed blocks are treated as normal text rather than executed.
