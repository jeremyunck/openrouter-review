const core = require('@actions/core');
const github = require('@actions/github');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';
const COMMENT_MARKER = '<!-- openrouter-review -->';
const MAX_DIFF_CHARS = 120_000;

const DEFAULT_SYSTEM_PROMPT = `You are an expert code reviewer. Review the pull request diff below.

Focus on:
- Bugs, security issues, and correctness
- Edge cases and error handling
- Performance and maintainability concerns
- Missing tests when behavior changes

Be concise and actionable. Use markdown with clear sections. Call out specific files and lines when relevant.
If the diff is truncated, note that your review may be incomplete.`;

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

function buildMessages(diff, extraPrompt) {
  let userContent = `Pull request diff:\n\n\`\`\`diff\n${diff}\n\`\`\``;

  if (extraPrompt.trim()) {
    userContent += `\n\nAdditional review instructions:\n${extraPrompt.trim()}`;
  }

  return [
    { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
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

async function findExistingReviewComment(octokit, owner, repo, issueNumber) {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });

  return comments.find((comment) => comment.body?.includes(COMMENT_MARKER)) ?? null;
}

async function upsertReviewComment(octokit, owner, repo, issueNumber, body) {
  const existing = await findExistingReviewComment(octokit, owner, repo, issueNumber);

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
    core.info(`Updated existing review comment (#${existing.id}).`);
    return;
  }

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
  const token = core.getInput('github-token', { required: true });
  const extraPrompt = core.getInput('prompt') || '';
  const inputPullNumber = core.getInput('pull-request-number');

  const octokit = github.getOctokit(token);
  const context = github.context;
  const { owner, repo } = context.repo;
  const pullNumber = resolvePullNumber(context.eventName, context.payload, inputPullNumber);

  core.info(`Reviewing PR #${pullNumber} in ${owner}/${repo} with model ${model}`);

  let diff = await fetchPullRequestDiff(octokit, owner, repo, pullNumber);

  if (!diff.trim()) {
    core.warning('PR diff is empty.');
    diff = '(no changes in diff)';
  }

  if (diff.length > MAX_DIFF_CHARS) {
    core.warning(`Diff truncated from ${diff.length} to ${MAX_DIFF_CHARS} characters.`);
    diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n\n... [diff truncated due to size]`;
  }

  const messages = buildMessages(diff, extraPrompt);
  const review = await callOpenRouter(apiKey, model, messages);
  const commentBody = formatComment(review, model);

  await upsertReviewComment(octokit, owner, repo, pullNumber, commentBody);
  core.setOutput('review', review);
}

run().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
