const core = require('@actions/core');
const github = require('@actions/github');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';
const COMMENT_MARKER = '<!-- openrouter-review -->';
const MAX_DIFF_CHARS = 120_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

const STRICTNESS_LEVELS = {
  lenient: {
    label: 'Lenient',
    prompt:
      'Only 🔴 CRITICAL findings (actual bugs, vulnerabilities, or correctness errors) are required fixes. Treat 🟡 MAJOR findings as strong suggestions. Treat 🟢 MINOR and ⚪ NITPICK findings as entirely optional. Be permissive: focus only on clear, high-confidence blockers.',
  },
  balanced: {
    label: 'Balanced',
    prompt:
      '🔴 CRITICAL and 🟡 MAJOR findings (bugs, vulnerabilities, significant design, performance, or test-coverage concerns) are required fixes. Treat 🟢 MINOR findings as nice-to-fix suggestions. Skip ⚪ NITPICK findings or mention them only briefly.',
  },
  strict: {
    label: 'Strict',
    prompt:
      '🔴 CRITICAL, 🟡 MAJOR, and 🟢 MINOR findings are all required fixes. Only ⚪ NITPICK is optional. Hold the PR to a high bar for correctness, safety, design, test coverage, and maintainability. Treat significant quality concerns as blockers.',
  },
};

const DEFAULT_STRICTNESS = 'balanced';

const DEFAULT_FOCUS_AREAS = [
  {
    name: 'security',
    label: 'Security',
    prompt: 'Check for: hardcoded secrets or credentials, injection vulnerabilities (SQL, command, XSS), insufficient authz checks, unsafe deserialization, overly permissive CORS or CSP, dependency vulnerabilities introduced by new imports, exposure of internal information in error messages or logs.',
  },
  {
    name: 'correctness',
    label: 'Correctness',
    prompt: 'Check for: logic bugs and off-by-one errors, silent data truncation or type coercion, concurrency races or inconsistent state, API contract violations (wrong status codes, missing fields, changed semantics), regression in existing behavior, incorrect assumptions about input shape or nullability.',
  },
  {
    name: 'error_handling',
    label: 'Error handling',
    prompt: 'Check for: unhandled edge cases (empty arrays, null values, network failures), swallowed or silent errors (empty catch blocks, ignored Promise rejections), missing input validation, inconsistent error responses, resource leaks (unreleased connections, file handles, subscriptions), lack of graceful degradation.',
  },
  {
    name: 'tests',
    label: 'Tests',
    prompt: 'Check for: missing tests for new or changed logic, tests that only cover happy paths without error cases, insufficient assertions (asserting mocks were called instead of asserting behavior), tests that are fragile or tightly coupled to implementation details, high-risk untested paths identified in other focus areas.',
  },
  {
    name: 'performance',
    label: 'Performance',
    prompt: 'Check for: N+1 queries or avoidable network round-trips, large data loaded unnecessarily into memory, inefficient algorithms (O(n²) where O(n log n) suffices), missing pagination or batching on new endpoints, tight loops making synchronous I/O calls, cache-inefficient data structures, resource leaks that degrade over time.',
  },
  {
    name: 'readability',
    label: 'Readability',
    prompt: 'Check for: unclear or misleading variable/function names, overly long functions or deeply nested conditionals, magic numbers or opaque constants, insufficient inline comments for non-obvious logic, large blocks of duplicated code that could be extracted, inconsistent formatting or conventions with surrounding code.',
  },
  {
    name: 'design',
    label: 'Design',
    prompt: 'Check for: inappropriate abstraction boundaries, tight coupling between unrelated modules, leaky abstractions that expose internal details, inconsistent patterns with existing codebase, over-engineering (unnecessary generics, factories, or indirection), under-engineering (logic sprawl in a single function), unclear ownership of data transformations.',
  },
  {
    name: 'maintainability',
    label: 'Maintainability',
    prompt: 'Check for: code duplication that will diverge over time, configuration baked into code instead of config files or env vars, missing deprecation handling on changed interfaces, tight coupling to external services without abstraction, insufficient logging or observability for new functionality, migration or rollout concerns for schema/database changes.',
  },
];

const FOCUS_AREA_ALIASES = {
  architecture: 'design',
  auth: 'security',
  bug: 'correctness',
  bugs: 'correctness',
  edge_case: 'error_handling',
  edge_cases: 'error_handling',
  error: 'error_handling',
  errors: 'error_handling',
  error_handling: 'error_handling',
  failure_modes: 'error_handling',
  maintainability: 'maintainability',
  performance: 'performance',
  readability: 'readability',
  security: 'security',
  test: 'tests',
  testing: 'tests',
  tests: 'tests',
};

function resolvePullNumber(eventName, payload, inputNumber) {
  if (eventName === 'pull_request' && payload.pull_request?.number) {
    return payload.pull_request.number;
  }

  const parsed = Number.parseInt(String(inputNumber || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(
      'Could not determine PR number. Run this action on pull_request events or set pull-request-number for workflow_dispatch.',
    );
  }

  return parsed;
}

function normalizeOptionName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function parseStrictness(input) {
  const strictness = normalizeOptionName(input) || DEFAULT_STRICTNESS;

  if (!STRICTNESS_LEVELS[strictness]) {
    throw new Error(
      `Invalid strictness "${input}". Expected one of: ${Object.keys(STRICTNESS_LEVELS).join(', ')}.`,
    );
  }

  return strictness;
}

function parseFocusInput(input) {
  const trimmed = String(input || '').trim();

  if (!trimmed) {
    return DEFAULT_FOCUS_AREAS.map(({ name }) => name);
  }

  if (trimmed.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid focus input. Expected a JSON array, comma-separated list, or newline list: ${message}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error('Invalid focus input. JSON focus value must be an array of strings.');
    }

    return parsed;
  }

  return trimmed.split(/[\n,]+/);
}

function parseFocusAreas(input) {
  const configuredAreas = new Map(DEFAULT_FOCUS_AREAS.map((area) => [area.name, area]));
  const rawAreas = parseFocusInput(input);
  const selectedAreas = [];
  const seenAreas = new Set();

  for (const rawArea of rawAreas) {
    const normalized = normalizeOptionName(rawArea);
    if (!normalized) {
      continue;
    }

    const areaName = FOCUS_AREA_ALIASES[normalized] || normalized;
    const area = configuredAreas.get(areaName);

    if (!area) {
      throw new Error(
        `Invalid focus area "${rawArea}". Expected one of: ${DEFAULT_FOCUS_AREAS.map(({ name }) => name).join(', ')}.`,
      );
    }

    if (!seenAreas.has(area.name)) {
      selectedAreas.push(area);
      seenAreas.add(area.name);
    }
  }

  if (selectedAreas.length === 0) {
    throw new Error('Invalid focus input. Select at least one focus area.');
  }

  return selectedAreas;
}

async function fetchPullRequestDiff(octokit, owner, repo, pullNumber) {
  const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner,
    repo,
    pull_number: pullNumber,
    headers: {
      accept: 'application/vnd.github.diff',
    },
  });

  return typeof response.data === 'string' ? response.data : String(response.data ?? '');
}

async function fetchPrSummary(octokit, owner, repo, pullNumber) {
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });

  const title = data.title || '';
  const body = data.body || '';
  const parts = [`Title: ${title}`];

  if (data.draft) {
    parts.push('Status: Draft (work in progress)');
  }

  const baseRef = data.base?.ref;
  const headRef = data.head?.ref;
  if (baseRef && headRef) {
    parts.push(`Branch: ${headRef} → ${baseRef}`);
  }

  const statBits = [];
  if (Number.isFinite(data.changed_files)) {
    statBits.push(`${data.changed_files} file(s) changed`);
  }
  if (Number.isFinite(data.additions) || Number.isFinite(data.deletions)) {
    statBits.push(`+${data.additions ?? 0} / -${data.deletions ?? 0} lines`);
  }
  if (Number.isFinite(data.commits)) {
    statBits.push(`${data.commits} commit(s)`);
  }
  if (statBits.length) {
    parts.push(`Change size: ${statBits.join(', ')}`);
  }

  if (body.trim()) {
    parts.push(`Description (author's stated intent):\n${body.trim()}`);
  } else {
    parts.push('Description: (none provided by the author)');
  }

  return parts.join('\n\n');
}

function buildSystemPrompt({ approver, focusAreas, strictness }) {
  const strictnessConfig = STRICTNESS_LEVELS[strictness];
  const focusList = focusAreas.map((area) => `- ${area.label}: ${area.prompt}`).join('\n');

  const reviewPrinciples = `Core principles (read these first — they override the urge to find something):
- Your goal is to catch real problems the author may have missed, not to produce a long list. A correct, well-written PR is a success. If the change is sound, say so plainly and approve it. Do not invent, inflate, or pad findings to look thorough — that actively harms the author by wasting their time and eroding trust in this review.
- A false positive is worse than a missed nitpick. When you are not confident a problem is real, do not report it. It is always acceptable to conclude that there are no issues.
- Every finding must be grounded in evidence that is actually visible in the diff. Point to the specific changed line(s) that are wrong. If you cannot identify the exact line and explain concretely why it is a problem, do not raise it.
- Never speculate about code you cannot see. You are reviewing a unified diff, not the whole repository. Function definitions, imports, type declarations, call sites, configuration, and tests outside the diff are invisible to you. Do NOT flag something as missing, undefined, unused, broken, or unhandled merely because its definition or usage is not shown — assume code outside the diff exists and works unless the diff itself proves otherwise.
- Review only what the PR changes. In the diff, lines beginning with \`+\` are added and lines beginning with \`-\` are removed; lines with no prefix are unchanged context shown for orientation. Raise issues about added/changed code (and removals that break something), not about unchanged context lines.
- Do not flag pre-existing issues, style preferences already consistent with the surrounding code, or hypothetical problems that depend on inputs the change does not actually introduce.`;

  const severityDefinitions = `Severity levels (use these consistently):
- 🔴 CRITICAL: A bug, vulnerability, or correctness error that will cause incorrect behavior, data loss, or production incidents. Requires a fix before merging.
- 🟡 MAJOR: A significant concern about design, performance, error handling, test coverage, or maintainability. Should be addressed before merging.
- 🟢 MINOR: Readability, naming, local code organization, or small style issue. Consider fixing but not a blocker.
- ⚪ NITPICK: Personal preference, very minor suggestion, or idea for future improvement. Entirely optional.`;

  const processInstructions = `Follow this review process before writing your output:
1. **Understand the change** — Read the PR title, description, change size, and diff to grasp what the PR does and why. Reviewing against the author's stated intent helps you tell deliberate decisions apart from mistakes.
2. **Analyze file by file** — Evaluate each changed file against the focus areas below. Use the diff's hunk headers (\`@@ -old +new @@\`) to locate added lines in the new file; cite new-file line numbers.
3. **Verify before flagging** — For each potential finding, re-read the relevant diff lines and confirm the problem is real and visible there. Discard anything that relies on assumptions about unseen code or that you are not confident about.
4. **Assign severity** — For each surviving finding, choose exactly one severity level from the definitions above. Calibrate honestly: do not promote a minor concern to CRITICAL.
5. **Be specific** — Include the exact file path and line numbers for every finding. For 🔴 CRITICAL and 🟡 MAJOR findings, provide a concrete fix suggestion with before/after code.
6. **If you find nothing wrong, say so** — Do not manufacture issues to fill the template. Reporting "No issues found" on a clean PR is the correct, expected outcome.
7. **If the diff is truncated**, note that your review may be incomplete rather than guessing about the omitted portions.`;

  const commonFormat = `${reviewPrinciples}

${severityDefinitions}

${processInstructions}

Focus on these areas (these are lenses to look through, not a checklist you must produce a finding for — only report a focus area when there is a genuine, evidence-backed problem):
${focusList}

Strictness: ${strictnessConfig.label}
${strictnessConfig.prompt}`;

  if (approver) {
    return `You are an expert code reviewer. Evaluate this pull request and return a structured approval decision.

${commonFormat}

Return valid JSON only. Do not wrap it in markdown fences or add any text outside the JSON.
The JSON object must have exactly these two keys:
- "decision": either "approve" or "request_changes"
  - Use "approve" when there are no required fixes — including when you found no issues at all, or when every finding is below the strictness threshold (e.g. all 🟢 MINOR or ⚪ NITPICK under the balanced level). Approving a clean PR with no manufactured concerns is the correct outcome.
  - Use "request_changes" only when the strictness level above identifies a genuine, evidence-backed required fix. Do not request changes over speculative or padded findings.
- "review": your full review in the format below (as a single string with \\n newlines)

Review format for the "review" field:

## Overview

<Brief summary of what the PR does and your overall impression in 2-3 sentences. Classify the change as a bugfix, feature, refactor, test-only, or docs change.>

## File-by-File Feedback

For each changed file, list findings using the severity levels above. Include line numbers and concrete fix suggestions for 🔴 and 🟡 findings. Use \`\`\`diff blocks for fix suggestions. If a file has no findings, write "No issues found."

## Overall Assessment

**Quality:** ⭐⭐⭐⭐⭐ (5/5) | ⭐⭐⭐⭐☆ (4/5) | ⭐⭐⭐☆☆ (3/5) | ⭐⭐☆☆☆ (2/5) | ⭐☆☆☆☆ (1/5)

**Strengths:**
- What the PR does well

**Key Concerns:**
- What needs attention

**Final Verdict:** Approve | Approve with minor changes | Changes requested`;
  }

  return `You are an expert code reviewer. Review the pull request diff below.

${commonFormat}

Output your review using this exact markdown format:

## Overview

<Brief summary of what the PR does and your overall impression in 2-3 sentences. Classify the change as a bugfix, feature, refactor, test-only, or docs change.>

## File-by-File Feedback

### \`path/to/file.js\`

**🔴 CRITICAL** — <Description of issue> (line XX-YY)
<Why this matters.>
\`\`\`diff
- // current code
+ // suggested fix
\`\`\`

**🟡 MAJOR** — <Description of issue> (line XX)
<Why this matters.>
\`\`\`diff
- // current code
+ // suggested fix
\`\`\`

**🟢 MINOR** — <Description of issue> (line XX)

**⚪ NITPICK** — <Description> (line XX)

### \`path/to/other.js\`

**🟡 MAJOR** — <Description> (line XX-YY)
...

## Overall Assessment

**Quality:** ⭐⭐⭐⭐⭐ (5/5 — Excellent) | ⭐⭐⭐⭐☆ (4/5 — Good) | ⭐⭐⭐☆☆ (3/5 — Needs minor improvements) | ⭐⭐☆☆☆ (2/5 — Significant concerns) | ⭐☆☆☆☆ (1/5 — Major issues)

**Strengths:**
- What the PR does well

**Key Concerns:**
- What needs attention

**Final Verdict:** Approve | Approve with minor changes | Changes requested

---
Format rules:
- Always use the section headers exactly as shown: ## Overview, ## File-by-File Feedback, ## Overall Assessment.
- Within ## File-by-File Feedback, group findings by file using ### \`path/to/file\` headers.
- Use severity emojis (🔴 🟡 🟢 ⚪) at the start of each finding line.
- Include line numbers in parentheses for every finding.
- Add \`\`\`diff blocks with fix suggestions for 🔴 CRITICAL and 🟡 MAJOR findings.
- If a file has no findings, write "No issues found." under its header.
- If there are no findings at all, write "No issues found in this PR." and skip the file-by-file section.`;
}

function buildMessages(diff, extraPrompt, options = {}) {
  const strictness = options.strictness || DEFAULT_STRICTNESS;
  const focusAreas = options.focusAreas || DEFAULT_FOCUS_AREAS;
  const approver = Boolean(options.approver);
  const prSummary = options.prSummary || '';

  let userContent = '';

  if (prSummary.trim()) {
    userContent += `Pull request summary:\n\n${prSummary.trim()}\n\n`;
  }

  userContent += `Pull request diff:\n\n\`\`\`diff\n${diff}\n\`\`\``;

  if (extraPrompt.trim()) {
    userContent += `\n\nAdditional review instructions:\n${extraPrompt.trim()}`;
  }

  return [
    { role: 'system', content: buildSystemPrompt({ approver, focusAreas, strictness }) },
    { role: 'user', content: userContent },
  ];
}

async function callOpenRouter(apiKey, model, messages) {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/jeremyunck/openrouter-review',
      'X-Title': 'openrouter-review',
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
    }),
  });

  const body = await response.text();
  let parsed;

  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`OpenRouter returned non-JSON response (${response.status}): ${body.slice(0, 500)}`);
  }

  if (!response.ok) {
    const message = parsed?.error?.message || parsed?.message || body;
    throw new Error(`OpenRouter request failed (${response.status}): ${message}`);
  }

  const content = parsed?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error('OpenRouter response did not include review content.');
  }

  return content.trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callWithRetry(apiKey, model, messages, retries) {
  const maxAttempts = retries + 1;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const content = await callOpenRouter(apiKey, model, messages);
      return content;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        core.warning(
          `Attempt ${attempt}/${maxAttempts} for model "${model}" failed: ${error instanceof Error ? error.message : String(error)}. Retrying in ${delay}ms.`,
        );
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

async function callOpenRouterWithFallback(apiKey, model, fallbackModel, messages, maxRetries = MAX_RETRIES) {
  try {
    const content = await callWithRetry(apiKey, model, messages, maxRetries);
    return { content, model };
  } catch (error) {
    if (!fallbackModel || fallbackModel === model) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Primary model "${model}" exhausted all retries: ${message}. Retrying with fallback model "${fallbackModel}".`);

    const content = await callWithRetry(apiKey, fallbackModel, messages, maxRetries);
    return { content, model: fallbackModel };
  }
}

function parseDecision(input) {
  const decision = normalizeOptionName(input);

  if (decision === 'approve' || decision === 'approved') {
    return 'approve';
  }

  if (decision === 'request_changes' || decision === 'changes_requested') {
    return 'request_changes';
  }

  throw new Error('Reviewer decision must be either "approve" or "request_changes".');
}

function parseJsonObjectResponse(content) {
  const trimmed = content.trim();
  const fencedJson = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fencedJson ? fencedJson[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error('Reviewer response must be a JSON object when approver is true.');
    }

    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
  }
}

function parseApproverResponse(content) {
  const parsed = parseJsonObjectResponse(content);

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Reviewer response must be a JSON object when approver is true.');
  }

  const decision = parseDecision(parsed.decision);
  const review = typeof parsed.review === 'string' ? parsed.review.trim() : '';

  if (!review) {
    throw new Error('Reviewer response must include a non-empty "review" string.');
  }

  return { decision, review };
}

function formatComment(review, model) {
  return [
    COMMENT_MARKER,
    '## AI code review (OpenRouter)',
    '',
    `Model: \`${model}\``,
    '',
    review,
  ].join('\n');
}

async function submitPullRequestReview(octokit, owner, repo, pullNumber, review, decision) {
  const event = decision === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES';

  await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    event,
    body: review,
  });

  core.info(`Submitted PR review with decision ${decision}.`);
}

async function postReviewComment(octokit, owner, repo, issueNumber, body) {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
  core.info('Posted new review comment.');
}

async function run() {
  const apiKey = core.getInput('open-router-api-key', { required: true });
  const model = core.getInput('model') || DEFAULT_MODEL;
  const fallbackModel = (core.getInput('fallback-model') || '').trim();
  const token = core.getInput('github-token', { required: true });
  const extraPrompt = core.getInput('prompt') || '';
  const inputPullNumber = core.getInput('pull-request-number');
  const approver = core.getBooleanInput('approver');
  const strictness = parseStrictness(core.getInput('strictness'));
  const focusAreas = parseFocusAreas(core.getInput('focus'));

  const octokit = github.getOctokit(token);
  const context = github.context;
  const { owner, repo } = context.repo;
  const pullNumber = resolvePullNumber(context.eventName, context.payload, inputPullNumber);

  core.info(`Reviewing PR #${pullNumber} in ${owner}/${repo} with model ${model}${fallbackModel ? ` (fallback: ${fallbackModel})` : ''}`);
  core.info(`Review settings: approver=${approver}, strictness=${strictness}, focus=${focusAreas.map(({ name }) => name).join(', ')}`);

  let diff = await fetchPullRequestDiff(octokit, owner, repo, pullNumber);

  if (!diff.trim()) {
    core.warning('PR diff is empty.');
    diff = '(no changes in diff)';
  }

  if (diff.length > MAX_DIFF_CHARS) {
    core.warning(`Diff truncated from ${diff.length} to ${MAX_DIFF_CHARS} characters.`);
    diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n\n... [diff truncated due to size]`;
  }

const prSummary = await fetchPrSummary(octokit, owner, repo, pullNumber);

  const messages = buildMessages(diff, extraPrompt, { approver, focusAreas, prSummary, strictness });
  const { content: response, model: modelUsed } = await callOpenRouterWithFallback(
    apiKey,
    model,
    fallbackModel,
    messages,
  );
  const { decision, review } = approver
    ? parseApproverResponse(response)
    : { decision: '', review: response };

  if (approver) {
    await submitPullRequestReview(octokit, owner, repo, pullNumber, review, decision);
  } else {
    const commentBody = formatComment(review, modelUsed);
    await postReviewComment(octokit, owner, repo, pullNumber, commentBody);
  }

  core.setOutput('review', review);
  core.setOutput('decision', decision);
}

if (require.main === module) {
  run().catch((error) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
  });
}

module.exports = {
  DEFAULT_FOCUS_AREAS,
  DEFAULT_STRICTNESS,
  STRICTNESS_LEVELS,
  buildMessages,
  buildSystemPrompt,
  callOpenRouterWithFallback,
  fetchPrSummary,
  parseApproverResponse,
  parseFocusAreas,
  parseStrictness,
};