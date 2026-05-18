const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_FOCUS_AREAS,
  buildMessages,
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
