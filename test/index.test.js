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

test('callOpenRouterWithFallback returns primary model content on success', async () => {
  const successBody = JSON.stringify({ choices: [{ message: { content: 'all good' } }] });
  const { stub, calls } = makeFetchStub([{ status: 200, body: successBody }]);
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    const result = await callOpenRouterWithFallback('k', 'primary/model', 'fallback/model', []);
    assert.deepEqual(result, { content: 'all good', model: 'primary/model' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'primary/model');
  } finally {
    global.fetch = originalFetch;
  }
});

test('callOpenRouterWithFallback retries with fallback model when primary returns non-success', async () => {
  const errorBody = JSON.stringify({ error: { message: 'rate limited' } });
  const successBody = JSON.stringify({ choices: [{ message: { content: 'fallback content' } }] });
  const { stub, calls } = makeFetchStub([
    { status: 429, body: errorBody },
    { status: 200, body: successBody },
  ]);
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    const result = await callOpenRouterWithFallback('k', 'primary/model', 'fallback/model', []);
    assert.deepEqual(result, { content: 'fallback content', model: 'fallback/model' });
    assert.deepEqual(
      calls.map((c) => c.model),
      ['primary/model', 'fallback/model'],
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('callOpenRouterWithFallback rethrows when no fallback is configured', async () => {
  const errorBody = JSON.stringify({ error: { message: 'rate limited' } });
  const { stub } = makeFetchStub([{ status: 429, body: errorBody }]);
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    await assert.rejects(
      callOpenRouterWithFallback('k', 'primary/model', '', []),
      /OpenRouter request failed \(429\)/,
    );
  } finally {
    global.fetch = originalFetch;
  }
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
