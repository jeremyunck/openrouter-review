const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_FOCUS_AREAS,
  buildMessages,
  callOpenRouterWithFallback,
  parseApproverResponse,
  parseFocusAreas,
  parseStrictness,
} = require('../src/index');

test('parseStrictness defaults to balanced and accepts supported levels', () => {
  assert.equal(parseStrictness(''), 'balanced');
  assert.equal(parseStrictness('strict'), 'strict');
  assert.equal(parseStrictness('Lenient'), 'lenient');
  assert.throws(() => parseStrictness('severe'), /Invalid strictness/);
});

test('parseFocusAreas defaults to all configured areas', () => {
  assert.deepEqual(
    parseFocusAreas('').map(({ name }) => name),
    DEFAULT_FOCUS_AREAS.map(({ name }) => name),
  );
});

test('parseFocusAreas accepts JSON arrays and aliases', () => {
  assert.deepEqual(
    parseFocusAreas('["security", "readability", "architecture", "edge-cases"]').map(({ name }) => name),
    ['security', 'readability', 'design', 'error_handling'],
  );
});

test('parseFocusAreas accepts comma and newline separated lists', () => {
  assert.deepEqual(
    parseFocusAreas('bugs, tests\nperformance').map(({ name }) => name),
    ['correctness', 'tests', 'performance'],
  );
});

test('parseFocusAreas rejects unknown focus areas', () => {
  assert.throws(() => parseFocusAreas('security, vibes'), /Invalid focus area/);
});

test('buildMessages includes selected strictness, focus areas, and approver instructions', () => {
  const [systemMessage] = buildMessages('diff --git a/file.js b/file.js', '', {
    approver: true,
    strictness: 'strict',
    focusAreas: parseFocusAreas('security'),
  });

  assert.match(systemMessage.content, /Strictness: Strict/);
  assert.match(systemMessage.content, /Security:/);
  assert.doesNotMatch(systemMessage.content, /Performance:/);
  assert.match(systemMessage.content, /"decision" must be either "approve" or "request_changes"/);
});

test('buildMessages includes structured markdown format for non-approver reviews', () => {
  const [systemMessage] = buildMessages('diff --git a/file.js b/file.js', '', {
    approver: false,
    strictness: 'balanced',
    focusAreas: parseFocusAreas('security, correctness'),
  });

  assert.match(systemMessage.content, /## Overview/);
  assert.match(systemMessage.content, /## Findings/);
  assert.match(systemMessage.content, /### Critical/);
  assert.match(systemMessage.content, /### Issues/);
  assert.match(systemMessage.content, /### Suggestions/);
  assert.match(systemMessage.content, /## Summary/);
  assert.doesNotMatch(systemMessage.content, /Return concise, actionable markdown with clear sections/);
});

function makeFetchStub(responses) {
  const calls = [];
  const queue = [...responses];
  const stub = async (url, init) => {
    const payload = JSON.parse(init.body);
    calls.push({ url, model: payload.model });
    const next = queue.shift();
    if (!next) {
      throw new Error('fetch stub called more times than expected');
    }
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => next.body,
    };
  };
  return { stub, calls };
}

test('callOpenRouterWithFallback returns primary model content on success (0 retries)', async () => {
  const successBody = JSON.stringify({ choices: [{ message: { content: 'all good' } }] });
  const { stub, calls } = makeFetchStub([{ status: 200, body: successBody }]);
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    const result = await callOpenRouterWithFallback('k', 'primary/model', 'fallback/model', [], 0);
    assert.deepEqual(result, { content: 'all good', model: 'primary/model' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'primary/model');
  } finally {
    global.fetch = originalFetch;
  }
});

test('callOpenRouterWithFallback retries with fallback model when primary fails (0 retries)', async () => {
  const errorBody = JSON.stringify({ error: { message: 'rate limited' } });
  const successBody = JSON.stringify({ choices: [{ message: { content: 'fallback content' } }] });
  const { stub, calls } = makeFetchStub([
    { status: 429, body: errorBody },
    { status: 200, body: successBody },
  ]);
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    const result = await callOpenRouterWithFallback('k', 'primary/model', 'fallback/model', [], 0);
    assert.deepEqual(result, { content: 'fallback content', model: 'fallback/model' });
    assert.deepEqual(
      calls.map((c) => c.model),
      ['primary/model', 'fallback/model'],
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('callOpenRouterWithFallback rethrows when no fallback is configured (0 retries)', async () => {
  const errorBody = JSON.stringify({ error: { message: 'rate limited' } });
  const { stub } = makeFetchStub([{ status: 429, body: errorBody }]);
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    await assert.rejects(
      callOpenRouterWithFallback('k', 'primary/model', '', [], 0),
      /OpenRouter request failed \(429\)/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('callOpenRouterWithFallback retries primary model multiple times before fallback', async () => {
  const errorBody = JSON.stringify({ error: { message: 'overloaded' } });
  const successBody = JSON.stringify({ choices: [{ message: { content: 'ok after retry' } }] });
  // 2 retries → 3 primary attempts, all fail, then fallback succeeds
  const { stub, calls } = makeFetchStub([
    { status: 429, body: errorBody },
    { status: 429, body: errorBody },
    { status: 429, body: errorBody },
    { status: 200, body: successBody },
  ]);
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    const result = await callOpenRouterWithFallback('k', 'primary/model', 'fallback/model', [], 2);
    assert.deepEqual(result, { content: 'ok after retry', model: 'fallback/model' });
    assert.deepEqual(
      calls.map((c) => c.model),
      ['primary/model', 'primary/model', 'primary/model', 'fallback/model'],
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('callOpenRouterWithFallback throws after exhausting all primary retries without fallback', async () => {
  const errorBody = JSON.stringify({ error: { message: 'always fails' } });
  const { stub } = makeFetchStub([
    { status: 429, body: errorBody },
    { status: 429, body: errorBody },
  ]);
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    await assert.rejects(
      callOpenRouterWithFallback('k', 'primary/model', '', [], 1),
      /always fails/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('buildMessages includes PR summary in user content before the diff', () => {
  const [, userMessage] = buildMessages('diff --git a/file.js b/file.js', '', {
    strictness: 'balanced',
    focusAreas: parseFocusAreas('security'),
    prSummary: 'Title: Fix login bug\n\nDescription:\nFixes a null pointer in the auth flow.',
  });

  assert.ok(userMessage.content.includes('Pull request summary:'));
  assert.ok(userMessage.content.includes('Title: Fix login bug'));
  assert.ok(userMessage.content.includes('Fixes a null pointer in the auth flow.'));
  assert.ok(userMessage.content.includes('Pull request diff:'));
  assert.ok(userMessage.content.includes('diff --git a/file.js b/file.js'));

  const summaryIdx = userMessage.content.indexOf('Pull request summary:');
  const diffIdx = userMessage.content.indexOf('Pull request diff:');
  assert.ok(summaryIdx < diffIdx, 'summary must appear before diff');
});

test('buildMessages omits summary section when no summary is provided', () => {
  const [, userMessage] = buildMessages('diff --git a/file.js b/file.js', '', {
    strictness: 'balanced',
    focusAreas: parseFocusAreas('security'),
  });

  assert.doesNotMatch(userMessage.content, /Pull request summary:/);
  assert.ok(userMessage.content.includes('Pull request diff:'));
});

test('parseApproverResponse extracts decisions and markdown review text', () => {
  assert.deepEqual(
    parseApproverResponse('```json\n{"decision":"changes_requested","review":"Please fix the failing test."}\n```'),
    {
      decision: 'request_changes',
      review: 'Please fix the failing test.',
    },
  );

  assert.deepEqual(parseApproverResponse('{"decision":"approved","review":"Looks good."}'), {
    decision: 'approve',
    review: 'Looks good.',
  });
});