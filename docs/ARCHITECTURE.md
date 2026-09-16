# Architecture

## Trust boundary

The browser profile is the authentication boundary. The bridge does not export Postman cookies or tokens into its API layer. The API layer only knows how to ask the Playwright driver to operate the already-authenticated page.

```text
OpenAI client -> localhost HTTP -> normalized request -> serialized browser job
                                                      |
                                                      v
                                             authenticated Postman UI
```

## Components

### BrowserManager

Owns one Playwright persistent context and one primary page. The persistent user-data directory allows normal Postman login to survive process restarts.

### DOM heuristics

Controls are found in this order:

1. explicit CSS override from `.env`;
2. accessible placeholder/name/role;
3. location-based heuristics in the right side of the window.

The bridge intentionally avoids hard-coded generated CSS class names because SPA class names are commonly unstable.

### Model discovery

The driver clicks the same model dropdown a user clicks, collects visible model labels, opens the `More models` submenu if present, normalizes labels, and maps them to OpenAI-safe IDs such as:

```text
Claude Opus 4.8 -> claude-opus-4-8
GPT-5.6 Sol     -> gpt-5-6-sol
```

Results are cached for a configurable TTL.

### Request serialization

A complete OpenAI conversation is rendered into one bounded prompt with explicit message roles. A random end marker is appended. That marker lets the response extractor separate the user bubble from the subsequent assistant output when only a panel-level text snapshot is available.

### Completion detection

The driver waits for three signals:

- panel text changed;
- Postman's generating indicator is no longer visible, when detectable;
- the panel remains text-stable for `POSTMAN_RESPONSE_STABLE_MS`.

It prefers an assistant-message DOM element. If Postman does not expose one with stable semantics, it falls back to extracting text after the unique request end marker.

### Concurrency

One browser chat is mutable shared state. An `AsyncMutex` serializes all browser jobs. This is required even if Fastify accepts many HTTP connections concurrently.

### OpenAI compatibility

`/v1/chat/completions` is the primary endpoint. The bridge also includes a non-streaming `/v1/responses` compatibility endpoint.

`stream: true` on chat completions is buffered SSE, not upstream token streaming.

## Scaling later

Do not remove the mutex to increase concurrency. Instead build a worker pool:

```text
request queue
  |-- profile A / page A
  |-- profile B / page B
  `-- profile C / page C
```

Each worker must have isolated browser/chat state. Depending on Postman policy, separate profiles may also imply separate sessions or users, so validate account/organization rules before scaling.
