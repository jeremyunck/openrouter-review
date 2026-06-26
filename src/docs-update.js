const fs = require('node:fs');
const path = require('node:path');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';
const MAX_DIFF_CHARS = 120_000;
const MAX_DOC_CHARS = 120_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

function log(message) {
  console.log(message);
}

function warn(message) {
  // GitHub Actions workflow command so it surfaces in the run annotations.
  console.log(`::warning::${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parse the documentation file list. Accepts a JSON array, a comma-separated
// list, or a newline-separated list (the same shapes the review action's
// `focus` input accepts), so it is forgiving about how the workflow input is
// written.
function parseDocFiles(input) {
  const trimmed = String(input || '').trim();

  if (!trimmed) {
    throw new Error('No documentation files provided. Set the doc-files input to at least one path.');
  }

  let rawEntries;
  if (trimmed.startsWith('{')) {
    throw new Error('Invalid doc-files input. JSON doc-files value must be an array of strings.');
  } else if (trimmed.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid doc-files input. Expected a JSON array, comma-separated list, or newline list: ${message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error('Invalid doc-files input. JSON doc-files value must be an array of strings.');
    }
    rawEntries = parsed;
  } else {
    rawEntries = trimmed.split(/[\n,]+/);
  }

  const files = [];
  const seen = new Set();
  for (const entry of rawEntries) {
    const file = String(entry || '').trim();
    if (!file || seen.has(file)) {
      continue;
    }
    seen.add(file);
    files.push(file);
  }

  if (files.length === 0) {
    throw new Error('No documentation files provided. Set the doc-files input to at least one path.');
  }

  return files;
}

function buildDocsSystemPrompt() {
  return `You are an expert technical writer maintaining the documentation for a software project. A pull request has just been merged, and you must update one documentation file so it accurately reflects the merged code change.

Core principles:
- Update only what the diff actually changes. Reflect new, removed, or modified behavior, options, APIs, commands, configuration, and examples that the diff introduces.
- Preserve the existing document's structure, tone, heading levels, formatting conventions, and voice. Make the smallest set of edits needed for accuracy — do not rewrite, reorganize, or reformat sections that are unaffected by the change.
- Ground every edit in evidence visible in the diff. Do not invent features, flags, parameters, or behavior that the diff does not show. Do not document code you cannot see.
- If the merged change does not affect this particular document, return the document's current contents completely unchanged.
- Keep links, anchors, code fences, and tables valid. Keep examples runnable and consistent with the new behavior.
- Do not add meta-commentary, changelogs, "updated by AI" notes, or references to the pull request unless the document already maintains such a section.

Output rules (critical):
- Return ONLY the full, complete, updated contents of the documentation file.
- Do not wrap the output in markdown code fences.
- Do not add any preamble, explanation, or trailing commentary before or after the file contents.
- The output must be ready to write directly back to disk as the new version of the file.`;
}

function buildDocsMessages({ docPath, docContent, diff, prSummary = '', extraPrompt = '' }) {
  let userContent = '';

  if (prSummary && prSummary.trim()) {
    userContent += `Merged pull request summary:\n\n${prSummary.trim()}\n\n`;
  }

  userContent += `Merged pull request diff:\n\n\`\`\`diff\n${diff}\n\`\`\`\n\n`;
  userContent += `Documentation file to update: \`${docPath}\`\n\n`;
  userContent += `Current contents of \`${docPath}\`:\n\n<<<DOC_START>>>\n${docContent}\n<<<DOC_END>>>`;

  if (extraPrompt && extraPrompt.trim()) {
    userContent += `\n\nAdditional documentation instructions:\n${extraPrompt.trim()}`;
  }

  userContent += `\n\nReturn the complete updated contents of \`${docPath}\` only, with no code fences or commentary. If the merged change does not affect this file, return its current contents unchanged.`;

  return [
    { role: 'system', content: buildDocsSystemPrompt() },
    { role: 'user', content: userContent },
  ];
}

// Models sometimes wrap the whole file in a single fenced code block despite
// instructions. If the entire response is one fence, unwrap it; otherwise
// leave the content untouched so inner fences in the doc survive.
function extractUpdatedContent(content) {
  const text = String(content == null ? '' : content);
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fenced) {
    return fenced[1];
  }
  return text;
}

async function callOpenRouter(apiKey, model, messages) {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/jeremyunck/openrouter-review',
      'X-Title': 'openrouter-review docs update',
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
    throw new Error('OpenRouter response did not include updated documentation content.');
  }

  return content;
}

async function callWithRetry(apiKey, model, messages, retries) {
  const maxAttempts = retries + 1;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await callOpenRouter(apiKey, model, messages);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        warn(
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
    warn(`Primary model "${model}" exhausted all retries: ${message}. Retrying with fallback model "${fallbackModel}".`);

    const content = await callWithRetry(apiKey, fallbackModel, messages, maxRetries);
    return { content, model: fallbackModel };
  }
}

function githubApiBase() {
  return (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
}

async function githubRequest(token, pathname, { accept = 'application/vnd.github+json' } = {}) {
  const response = await fetch(`${githubApiBase()}${pathname}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'openrouter-review-docs-update',
    },
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`GitHub API request to ${pathname} failed (${response.status}): ${body.slice(0, 500)}`);
  }

  return { body, response };
}

async function fetchPullRequestDiff(token, owner, repo, pullNumber) {
  const { body } = await githubRequest(token, `/repos/${owner}/${repo}/pulls/${pullNumber}`, {
    accept: 'application/vnd.github.diff',
  });
  return body;
}

async function fetchPrSummary(token, owner, repo, pullNumber) {
  const { body } = await githubRequest(token, `/repos/${owner}/${repo}/pulls/${pullNumber}`);
  const data = JSON.parse(body);

  const parts = [`Title: ${data.title || ''}`];

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
  if (statBits.length) {
    parts.push(`Change size: ${statBits.join(', ')}`);
  }

  const body_text = (data.body || '').trim();
  if (body_text) {
    parts.push(`Description (author's stated intent):\n${body_text}`);
  } else {
    parts.push('Description: (none provided by the author)');
  }

  return parts.join('\n\n');
}

function resolvePullNumber(eventName, payload, inputNumber) {
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    const number = payload?.pull_request?.number;
    if (number) {
      return number;
    }
  }

  const parsed = Number.parseInt(String(inputNumber || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(
      'Could not determine PR number. Run this on a merged pull_request event or set pull-request-number for workflow_dispatch.',
    );
  }

  return parsed;
}

function truncate(text, max, label) {
  if (text.length <= max) {
    return text;
  }
  warn(`${label} truncated from ${text.length} to ${max} characters.`);
  return `${text.slice(0, max)}\n\n... [${label} truncated due to size]`;
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) {
    return;
  }
  const delimiter = `ghadelimiter_${Math.random().toString(36).slice(2)}`;
  fs.appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

async function run() {
  const apiKey = process.env.OPEN_ROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OPEN_ROUTER_API_KEY. Provide the OpenRouter API key as an environment variable.');
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('Missing GITHUB_TOKEN. The workflow must pass a token with repo read access.');
  }

  const model = (process.env.MODEL || '').trim() || DEFAULT_MODEL;
  const fallbackModel = (process.env.FALLBACK_MODEL || '').trim();
  const extraPrompt = process.env.PROMPT || '';
  const docFiles = parseDocFiles(process.env.DOC_FILES);

  const repository = process.env.GITHUB_REPOSITORY || '';
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) {
    throw new Error(`Could not parse owner/repo from GITHUB_REPOSITORY="${repository}".`);
  }

  let payload = {};
  if (process.env.GITHUB_EVENT_PATH && fs.existsSync(process.env.GITHUB_EVENT_PATH)) {
    try {
      payload = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    } catch {
      payload = {};
    }
  }

  const pullNumber = resolvePullNumber(process.env.GITHUB_EVENT_NAME, payload, process.env.PR_NUMBER);

  log(`Updating docs for PR #${pullNumber} in ${owner}/${repo} with model ${model}${fallbackModel ? ` (fallback: ${fallbackModel})` : ''}`);
  log(`Documentation files: ${docFiles.join(', ')}`);

  let diff = await fetchPullRequestDiff(token, owner, repo, pullNumber);
  if (!diff.trim()) {
    warn('PR diff is empty; nothing to base documentation updates on.');
    setOutput('changed', 'false');
    setOutput('updated-files', '');
    return;
  }
  diff = truncate(diff, MAX_DIFF_CHARS, 'diff');

  const prSummary = await fetchPrSummary(token, owner, repo, pullNumber);

  const updatedFiles = [];

  for (const docFile of docFiles) {
    const absolutePath = path.resolve(process.cwd(), docFile);

    if (!fs.existsSync(absolutePath)) {
      warn(`Documentation file "${docFile}" does not exist; skipping.`);
      continue;
    }

    const original = fs.readFileSync(absolutePath, 'utf8');
    const docContent = truncate(original, MAX_DOC_CHARS, `documentation file "${docFile}"`);

    const messages = buildDocsMessages({ docPath: docFile, docContent, diff, prSummary, extraPrompt });

    log(`Requesting documentation update for ${docFile}...`);
    const { content, model: modelUsed } = await callOpenRouterWithFallback(apiKey, model, fallbackModel, messages);
    const updated = extractUpdatedContent(content);

    if (!updated.trim()) {
      warn(`Model returned empty content for "${docFile}"; leaving the file unchanged.`);
      continue;
    }

    if (updated === original) {
      log(`No documentation changes needed for ${docFile} (model: ${modelUsed}).`);
      continue;
    }

    fs.writeFileSync(absolutePath, updated);
    log(`Updated ${docFile} (model: ${modelUsed}).`);
    updatedFiles.push(docFile);
  }

  if (updatedFiles.length === 0) {
    log('No documentation files required changes.');
    setOutput('changed', 'false');
    setOutput('updated-files', '');
    return;
  }

  log(`Documentation updated for: ${updatedFiles.join(', ')}`);
  setOutput('changed', 'true');
  setOutput('updated-files', updatedFiles.join('\n'));
}

if (require.main === module) {
  run().catch((error) => {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_MODEL,
  buildDocsMessages,
  buildDocsSystemPrompt,
  callOpenRouterWithFallback,
  extractUpdatedContent,
  parseDocFiles,
  resolvePullNumber,
};
