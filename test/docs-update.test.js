const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildDocsMessages,
  buildDocsSystemPrompt,
  callOpenRouterWithFallback,
  extractUpdatedContent,
  parseDocFiles,
  resolvePullNumber,
} = require('../src/docs-update');

test('parseDocFiles accepts comma and newline separated lists and dedupes', () => {
  assert.deepEqual(parseDocFiles('README.md, docs/usage.md\nREADME.md'), [
    'README.md',
    'docs/usage.md',
  ]);
});

test('parseDocFiles accepts JSON arrays', () => {
  assert.deepEqual(parseDocFiles('["README.md", "docs/config.md"]'), [
    'README.md',
    'docs/config.md',
  ]);
});

test('parseDocFiles rejects empty input', () => {
  assert.throws(() => parseDocFiles(''), /No documentation files provided/);
  assert.throws(() => parseDocFiles('  ,  \n '), /No documentation files provided/);
});

test('parseDocFiles rejects non-array JSON', () => {
  assert.throws(() => parseDocFiles('{"file": "README.md"}'), /must be an array of strings/);
});

test('buildDocsSystemPrompt instructs returning the full file with no fences', () => {
  const prompt = buildDocsSystemPrompt();
  assert.match(prompt, /Return ONLY the full, complete, updated contents/);
  assert.match(prompt, /Do not wrap the output in markdown code fences/);
  assert.match(prompt, /return the document's current contents completely unchanged/i);
});

test('buildDocsMessages includes the diff, summary, doc path, and current contents in order', () => {
  const [systemMessage, userMessage] = buildDocsMessages({
    docPath: 'README.md',
    docContent: '# Title\n\nSome docs.',
    diff: 'diff --git a/src/app.js b/src/app.js',
    prSummary: 'Title: Add retry flag',
    extraPrompt: 'Keep the tone concise.',
  });

  assert.equal(systemMessage.role, 'system');
  assert.match(systemMessage.content, /expert technical writer/);

  assert.ok(userMessage.content.includes('Merged pull request summary:'));
  assert.ok(userMessage.content.includes('Title: Add retry flag'));
  assert.ok(userMessage.content.includes('Merged pull request diff:'));
  assert.ok(userMessage.content.includes('diff --git a/src/app.js b/src/app.js'));
  assert.ok(userMessage.content.includes('`README.md`'));
  assert.ok(userMessage.content.includes('# Title\n\nSome docs.'));
  assert.ok(userMessage.content.includes('Keep the tone concise.'));

  const summaryIdx = userMessage.content.indexOf('Merged pull request summary:');
  const diffIdx = userMessage.content.indexOf('Merged pull request diff:');
  const docIdx = userMessage.content.indexOf('Current contents of');
  assert.ok(summaryIdx < diffIdx && diffIdx < docIdx, 'summary, then diff, then current contents');
});

test('buildDocsMessages omits the summary section when none is provided', () => {
  const [, userMessage] = buildDocsMessages({
    docPath: 'README.md',
    docContent: 'docs',
    diff: 'diff',
  });

  assert.doesNotMatch(userMessage.content, /Merged pull request summary:/);
  assert.ok(userMessage.content.includes('Merged pull request diff:'));
});

test('extractUpdatedContent unwraps a whole-file fenced block', () => {
  assert.equal(extractUpdatedContent('```markdown\n# Title\n\nBody.\n```'), '# Title\n\nBody.');
  assert.equal(extractUpdatedContent('```\nplain\n```'), 'plain');
});

test('extractUpdatedContent leaves content with inner fences untouched', () => {
  const doc = '# Title\n\n```js\nconst a = 1;\n```\n\nMore.';
  assert.equal(extractUpdatedContent(doc), doc);
});

test('extractUpdatedContent tolerates empty and nullish input', () => {
  assert.equal(extractUpdatedContent(''), '');
  assert.equal(extractUpdatedContent(null), '');
  assert.equal(extractUpdatedContent(undefined), '');
});

test('resolvePullNumber reads the number from a pull_request event', () => {
  assert.equal(resolvePullNumber('pull_request', { pull_request: { number: 42 } }, ''), 42);
});

test('resolvePullNumber falls back to the provided input number', () => {
  assert.equal(resolvePullNumber('workflow_dispatch', {}, '17'), 17);
});

test('resolvePullNumber throws when no number can be determined', () => {
  assert.throws(() => resolvePullNumber('workflow_dispatch', {}, ''), /Could not determine PR number/);
  assert.throws(() => resolvePullNumber('schedule', {}, 'abc'), /Could not determine PR number/);
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

test('callOpenRouterWithFallback returns updated content from the primary model', async () => {
  const successBody = JSON.stringify({ choices: [{ message: { content: '# Updated docs' } }] });
  const { stub, calls } = makeFetchStub([{ status: 200, body: successBody }]);
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    const result = await callOpenRouterWithFallback('k', 'primary/model', 'fallback/model', [], 0);
    assert.deepEqual(result, { content: '# Updated docs', model: 'primary/model' });
    assert.equal(calls.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('callOpenRouterWithFallback falls back to the secondary model on failure', async () => {
  const errorBody = JSON.stringify({ error: { message: 'rate limited' } });
  const successBody = JSON.stringify({ choices: [{ message: { content: 'fallback docs' } }] });
  const { stub, calls } = makeFetchStub([
    { status: 429, body: errorBody },
    { status: 200, body: successBody },
  ]);
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    const result = await callOpenRouterWithFallback('k', 'primary/model', 'fallback/model', [], 0);
    assert.deepEqual(result, { content: 'fallback docs', model: 'fallback/model' });
    assert.deepEqual(calls.map((c) => c.model), ['primary/model', 'fallback/model']);
  } finally {
    global.fetch = originalFetch;
  }
});
