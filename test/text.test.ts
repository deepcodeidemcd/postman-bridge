import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanUiNoise, longestCommonPrefix, slugifyModel } from '../src/utils/text.js';
import { parseModelOutput } from '../src/openai/tool-parser.js';
import { serializeRequest } from '../src/openai/prompt.js';

process.env.POSTMAN_WORKSPACE_URL ??= 'https://example.postman.co/workspace/test?sideView=agentMode';

test('slugifyModel produces stable OpenAI ids', () => {
  assert.equal(slugifyModel('Claude Opus 4.8'), 'claude-opus-4-8');
  assert.equal(slugifyModel('GPT-5.6 Sol'), 'gpt-5-6-sol');
});

test('longestCommonPrefix works', () => {
  assert.equal(longestCommonPrefix('abcdef', 'abcXYZ'), 3);
});

test('cleanUiNoise removes common UI-only lines', () => {
  assert.equal(cleanUiNoise('Hello\nGenerating...\nCopy'), 'Hello');
});

test('serializeRequest includes full role history and end marker', () => {
  const result = serializeRequest({
    model: 'postman-test',
    messages: [
      { role: 'system', content: 'system rule' },
      { role: 'user', content: 'hello' },
    ],
  });
  // Roles are rendered as plain labels: "SYSTEM: ...", "USER: ..."
  assert.match(result.text, /SYSTEM: system rule/);
  assert.match(result.text, /USER: hello/);
  assert.ok(result.text.endsWith(result.endMarker));
});

test('serializeRequest extracts image parts from the request', () => {
  const result = serializeRequest({
    model: 'postman-test',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ],
  });
  assert.equal(result.images.length, 1);
  assert.match(result.text, /\[image attached above\]/);
});

test('parseModelOutput converts bridge tool blocks', () => {
  const parsed = parseModelOutput('<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>');
  assert.equal(parsed.content, null);
  assert.equal(parsed.toolCalls?.[0]?.function.name, 'read_file');
  assert.equal(parsed.toolCalls?.[0]?.function.arguments, '{"path":"a.ts"}');
});
