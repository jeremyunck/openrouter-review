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
      'Prioritize clear blockers and high-confidence issues. Avoid nitpicks and mark optional improvements as non-blocking.',
  },
  balanced: {
    label: 'Balanced',
    prompt:
      'Call out material bugs, risks, and maintainability concerns. Distinguish required fixes from helpful suggestions.',
  },
  strict: {
    label: 'Strict',
    prompt:
      'Hold the PR to a high bar for correctness, safety, design, and test coverage. Treat significant quality issues as required fixes.',
  },
};

const DEFAULT_STRICTNESS = 'balanced';

const DEFAULT_FOCUS_AREAS = [
  {
    name: 'security',
    label: 'Security',
    prompt: 'vulnerabilities, secret handling, authentication and authorization, injection risks, and unsafe dependencies',
  },
  {
    name: 'correctness',
    label: 'Correctness',
    prompt: 'logic bugs, regressions, API behavior changes, data integrity, and concurrency issues',
  },
  {
    name: 'error_handling',
    label: 'Error handling',
    prompt: 'edge cases, failure modes, validation, resilience, and clear error behavior',
  },
  {
    name: 'tests',
    label: 'Tests',
    prompt: 'missing or weak tests for changed behavior, risky paths, and bug fixes',
  },
  {
    name: 'performance',
    label: 'Performance',
    prompt: 'avoidable latency, memory use, inefficient algorithms, scalability limits, and resource leaks',
  },
  {
    name: 'readability',
    label: 'Readability',
    prompt: 'clarity, naming, local complexity, comments, and ease of review',
  },
  {
    name: 'design',
    label: 'Design',
    prompt: 'architecture, abstractions, cohesion, coupling, public interfaces, and fit with existing patterns',
  },
  {
    name: 'maintainability',
    label: 'Maintainability',
    prompt: 'long-term change cost, duplication, migration concerns, and operational supportability',
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
  let summary = `Title: ${title}`;

  if (body.trim()) {
    summary += `\n\nDescription:\n${body.trim()}`;
  }

  return summary;
}

function buildSystemPrompt({ approver, focusAreas, strictness }) {
  const strictnessConfig = STRICTNESS_LEVELS[strictness];
  const focusList = focusAreas.map((area) => `- ${area.label}: ${area.prompt}`).join('\n');
  const responseInstructions = approver
    ? `Approval decision:
- Return JSON only. Do not wrap it in markdown fences.
- The JSON object must include "decision" and "review".
- "decision" must be either "approve" or "request_changes".
- Use "approve" when the PR is acceptable to merge as-is or only has optional suggestions.
- Use "request_changes" when the selected strictness level and focus areas reveal required fixes.
- "review" must be concise, actionable markdown with clear sections.`
    : `Return your review in the following markdown format:

---

## Overview

<Brief summary of the PR and overall impression.>

## Findings

### Critical
<Blocking issues that must be fixed before merging. Include file paths and line numbers.>

### Issues
<Non-blocking but significant concerns. Include file paths and line numbers.>

### Suggestions
<Optional improvements, style nits, or ideas for future work.>

## Summary

<Key takeaways and final recommendation.>

Use bullet points within each section. Include specific file paths and line numbers where relevant.
If a section has no items, write "None." instead of leaving it blank.`;

  return `You are an expert code reviewer. Review the pull request diff below.

Strictness: ${strictnessConfig.label}
${strictnessConfig.prompt}

Focus on:
${focusList}

Call out specific files and lines when relevant. If the diff is truncated, note that your review may be incomplete.

${responseInstructions}`;
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
