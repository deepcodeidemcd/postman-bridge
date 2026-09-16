export const MODEL_PATTERN = /\b(?:auto|gpt[\s.-]?\d|claude|opus|sonnet|haiku|gemini|o\d(?:\b|-)|codex)\b/i;

export function normalizeWhitespace(input: string): string {
  return input.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function slugifyModel(displayName: string): string {
  return displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function longestCommonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

export function cleanUiNoise(input: string): string {
  const noisyLines = new Set([
    'Generating...',
    'Generating…',
    'Searching the web...',
    'Searching the web…',
    'Searching...',
    'Searching…',
    'Browsing...',
    'Browsing…',
    'Fetching...',
    'Fetching…',
    'Reading...',
    'Reading…',
    'Copy',
    'Regenerate',
    'Retry',
    'Apply',
    'Insert',
    'Stop generating',
  ]);

  let text = input
    .split('\n')
    .filter((line) => !noisyLines.has(line.trim()))
    .join('\n');

  // Postbot thinking/analysis intro lines leak into the answer. Drop them.
  // These are the model's private reasoning rendered by Postman's UI before
  // the actual answer ("Thought for X seconds", "Clarifying...", "I need to
  // consider...", etc.).
  text = text.replace(
    /^[\s\n]*(?:Thought for a moment|Thought for \d+ seconds?|Analyzing|Analyze|Thinking|Clarifying|Considering|Exploring|Reflecting|Planning|Let me (?:think|analyze|check|look|consider|explore|plan)|I'll (?:think|analyze|check|consider|explore)|I need to (?:think|consider|analyze|check|look|explore|plan|clarify|verify|confirm|decide|determine)).*?\n/gi,
    '',
  );
  // Drop the "Thinking..." label Postman renders above the answer.
  text = text.replace(/^[\s\n]*Thinking[.:…]?[\s\n]*/gi, '');

  // The panel text ends with the (empty) composer placeholder and the model
  // dropdown label below the answer; cut everything from the placeholder on.
  const placeholderIndex = text.indexOf('Describe what you need');
  if (placeholderIndex >= 0) text = text.slice(0, placeholderIndex);

  // Drop a trailing model selector row like "Claude Haiku 4.5" / "GPT-5.5".
  text = text.replace(
    /\n?\s*(?:Claude\s[\w.]+\s\d[\d.]*|GPT[\s.-]?\d[\d.-]*|Gemini[\s.-]?\d[\d.]*)[^\n]*$/i,
    '',
  );

  return normalizeWhitespace(text);
}
