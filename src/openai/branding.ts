/**
 * BRANDING / WHITELABEL LAYER
 *
 * Everything that leaves the bridge towards API clients passes through here,
 * so end users can never tell what backs the gateway. Internal names, error
 * strings, model keys and assistant text are all neutralized.
 */

/** Public, OpenAI-style model ids exposed to clients. Mirrors the upstream
 * /_gw/config catalog (11 models, fetched live 2026-09).
 * Thinking-capable models come in two variants: plain (fast) and `-thinking`
 * (extended thinking, slower but smarter). Only models whose upstream
 * supportsThinkingMode=true get a -thinking variant. */
export const PUBLIC_MODELS: Array<{ id: string; display_name: string; owned_by: string }> = [
  { id: 'auto', display_name: 'Auto', owned_by: 'gateway' },
  { id: 'claude-opus-5', display_name: 'Claude Opus 5', owned_by: 'gateway' },
  { id: 'claude-opus-5-thinking', display_name: 'Claude Opus 5 (Thinking)', owned_by: 'gateway' },
  { id: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', owned_by: 'gateway' },
  { id: 'gpt-5.6-sol-thinking', display_name: 'GPT-5.6 Sol (Thinking)', owned_by: 'gateway' },
  { id: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra', owned_by: 'gateway' },
  { id: 'gpt-5.6-terra-thinking', display_name: 'GPT-5.6 Terra (Thinking)', owned_by: 'gateway' },
  { id: 'gpt-5.6-luna', display_name: 'GPT-5.6 Luna', owned_by: 'gateway' },
  { id: 'gpt-5.6-luna-thinking', display_name: 'GPT-5.6 Luna (Thinking)', owned_by: 'gateway' },
  { id: 'gpt-5.5', display_name: 'GPT-5.5', owned_by: 'gateway' },
  { id: 'gpt-5.5-thinking', display_name: 'GPT-5.5 (Thinking)', owned_by: 'gateway' },
  { id: 'gpt-5.4', display_name: 'GPT-5.4', owned_by: 'gateway' },
  { id: 'gpt-5.4-thinking', display_name: 'GPT-5.4 (Thinking)', owned_by: 'gateway' },
  { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', owned_by: 'gateway' },
  { id: 'claude-opus-4-8-thinking', display_name: 'Claude Opus 4.8 (Thinking)', owned_by: 'gateway' },
  { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7', owned_by: 'gateway' },
  { id: 'claude-opus-4-7-thinking', display_name: 'Claude Opus 4.7 (Thinking)', owned_by: 'gateway' },
  { id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5', owned_by: 'gateway' },
  { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', owned_by: 'gateway' },
  { id: 'claude-sonnet-4-6-thinking', display_name: 'Claude Sonnet 4.6 (Thinking)', owned_by: 'gateway' },
  { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', owned_by: 'gateway' },
  { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', owned_by: 'gateway' },
];

/** Map any client-supplied model name to the public catalog id (or auto). */
export function normalizePublicModel(model: string): string {
  const m = model.trim().toLowerCase();
  if (!m) return 'auto';
  if (PUBLIC_MODELS.some((p) => p.id === m)) return m;
  // explicit variant aliases
  if (m.includes('sol')) return 'gpt-5.6-sol';
  if (m.includes('terra')) return 'gpt-5.6-terra';
  if (m.includes('luna')) return 'gpt-5.6-luna';
  // common aliases
  if (/claude-opus-5|opus-?5/.test(m)) return 'claude-opus-5';
  if (/claude-opus-4-8|opus-?4\.?8/.test(m)) return 'claude-opus-4-8';
  if (/claude-opus-4-7|opus-?4\.?7/.test(m)) return 'claude-opus-4-7';
  if (/^(claude|anthropic)/.test(m)) return 'claude-sonnet-4-5';
  if (/^(gpt|o\d|openai|codex)/.test(m)) return 'gpt-5.5';
  if (/gemini/.test(m)) return 'claude-sonnet-4-5';
  return 'auto';
}

/**
 * Extract reasoning effort from model name suffixes (9router/Codex style).
 * Supports: "model-high", "model-low", "model-medium", "model-ultra",
 *           "model-xhigh", "sonnet5-high", etc.
 * Returns { model, effort } where effort is undefined if no suffix found.
 */
export function parseModelEffort(model: string): { model: string; effort?: string } {
  const m = model.trim();
  const lower = m.toLowerCase();
  // Longest-first so '-ultracode' is matched before '-ultra'. These tiers map
  // (see code-chat resolveEffortLadder) to progressively deeper pipelines:
  //   low < medium < high < xhigh < ultra  (ultra == ultracode, code-review flavour)
  const suffixes = ['ultracode', 'ultra', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none', 'off'];
  for (const suffix of suffixes) {
    if (lower.endsWith('-' + suffix)) {
      const base = m.slice(0, -(suffix.length + 1));
      if (base) return { model: base, effort: suffix };
    }
  }
  // Also handle compact forms like "sonnet5-high", "opus48-ultra"
  const compact = lower.match(/^(.+?)-(ultracode|ultra|xhigh|high|medium|low)$/);
  if (compact && compact[1] && compact[2]) {
    return { model: compact[1], effort: compact[2] };
  }
  return { model: m };
}

const BRAND_PATTERNS: Array<[RegExp, string]> = [
  // Product / company names
  [/postman(?:'s)?/gi, 'the platform'],
  [/postbot/gi, 'assistant'],
  [/agent mode/gi, 'assistant mode'],
  [/agent-mode/gi, 'assistant-mode'],
  [/bedrock/gi, 'cloud'],
  [/\baws\b/gi, 'cloud'],
  [/amazon/gi, 'cloud'],
  [/enterprise trial/gi, 'pro plan'],
  [/\btrial\b/gi, 'plan'],
  [/credit limit/gi, 'rate limit'],
  [/credits/gi, 'quota'],
  // Domains and infra references
  [/[a-z0-9-]+\.postman\.co/gi, 'gateway.local'],
  [/identity\.getpostman\.com/gi, 'gateway.local'],
  [/postman\.co/gi, 'gateway.local'],
  [/postman\.com/gi, 'gateway.local'],
  [/getpostman/gi, 'gateway'],
  [/us-prod-agent-mode-chat-artifacts[^\\s"')]*\/?/gi, 'artifacts'],
  [/\bs3\b/gi, 'storage'],
  [/\bworkspace\b/gi, 'session'],
  [/\bworkspaces\b/gi, 'sessions'],
];

/** Scrub brand references out of assistant-visible/client-visible text. */
export function sanitizeBranding(text: string): string {
  let out = text;
  for (const [re, replacement] of BRAND_PATTERNS) {
    out = out.replace(re, replacement);
  }
  // Collapse duplicate spaces created by replacements, keep newlines intact.
  out = out.replace(/[ \t]{2,}/g, ' ');
  return out;
}

/** Sanitize an error message before it reaches a client. */
export function sanitizeError(message: string): string {
  return sanitizeBranding(message);
}
