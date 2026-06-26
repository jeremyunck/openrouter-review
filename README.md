# openrouter-review

GitHub Action that sends a pull request diff to [OpenRouter](https://openrouter.ai/) for an AI code review and posts the result as a PR comment.

## Setup

1. Add an [OpenRouter API key](https://openrouter.ai/keys) as a repository secret named `OPEN_ROUTER_API_KEY`.
2. Copy the workflow below into `.github/workflows/openrouter-review.yml` in your repository (or use the workflow in this repo as a reference).

## Usage

Copy the minimal workflow below into `.github/workflows/openrouter-review.yml` to get started:

```yaml
name: OpenRouter PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: jeremyunck/openrouter-review@v1
        with:
          open-router-api-key: ${{ secrets.OPEN_ROUTER_API_KEY }}
```

For manual triggering and advanced options, use the full workflow below:

```yaml
name: OpenRouter PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]
  workflow_dispatch:
    inputs:
      model:
        description: OpenRouter model id
        required: false
        default: deepseek/deepseek-v4-flash
        type: string
      pull_request_number:
        description: PR number to review
        required: true
        type: number
      approver:
        description: Submit an approve/request-changes PR review
        required: false
        default: false
        type: boolean
      strictness:
        description: Review strictness
        required: false
        default: balanced
        type: choice
        options:
          - lenient
          - balanced
          - strict
      focus:
        description: JSON array, comma-separated list, or newline list of focus areas
        required: false
        type: string

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: jeremyunck/openrouter-review@v1
        with:
          open-router-api-key: ${{ secrets.OPEN_ROUTER_API_KEY }}
          pull-request-number: ${{ github.event_name == 'workflow_dispatch' && inputs.pull_request_number || '' }}
          approver: ${{ github.event_name == 'workflow_dispatch' && inputs.approver || false }}
          strictness: ${{ github.event_name == 'workflow_dispatch' && inputs.strictness || 'balanced' }}
          focus: ${{ github.event_name == 'workflow_dispatch' && inputs.focus || '' }}
```

### Inputs

| Input | Required | Description |
| --- | --- | --- |
| `open-router-api-key` | Yes | OpenRouter API key |
| `model` | No | OpenRouter model id (default: `deepseek/deepseek-v4-flash`) |
| `fallback-model` | No | OpenRouter model id to use if the primary `model` returns a non-success response |
| `github-token` | No | Defaults to `github.token` |
| `prompt` | No | Extra instructions appended to the review request |
| `approver` | No | When `true`, prompts the model for a decision and submits a PR review with `APPROVE` or `REQUEST_CHANGES` instead of posting the marker comment (default: `false`) |
| `strictness` | No | Review strictness: `lenient`, `balanced`, or `strict` (default: `balanced`) |
| `focus` | No | Focus areas as a JSON array, comma-separated list, or newline list. Defaults to all built-in areas. |
| `pull-request-number` | No* | PR number; required for `workflow_dispatch` when not triggered by `pull_request` |

Built-in focus areas are `security`, `correctness`, `error_handling`, `tests`, `performance`, `readability`, `design`, and `maintainability`.

### Outputs

| Output | Description |
| --- | --- |
| `review` | Raw markdown review text from the model |
| `decision` | Model decision when `approver` is `true`: `approve`, `request_changes`, or empty |

## Behavior

- Fetches the full PR diff from the GitHub API, plus context about the change (title, description, draft status, source/target branch, and change size).
- Sends the diff and context to OpenRouter's chat completions API with a code-review system prompt that reflects the selected strictness and focus areas.
- The prompt is tuned to minimize hallucinated findings: the model is instructed to ground every finding in evidence visible in the diff, never speculate about code it cannot see (definitions, imports, call sites, and tests outside the diff), and treat false positives as worse than silence. Reporting that a clean PR has no issues — and approving it — is an expected, correct outcome.
- By default, posts (or updates) a single PR comment tagged with `<!-- openrouter-review -->` so reruns on new commits replace the previous review instead of spamming the thread.
- When `approver` is `true`, asks the model for a structured decision and submits either an approving or requesting-changes PR review with the model review as the body.
- Truncates very large diffs before sending them to the model.

## Review Template

Reviews use a structured, severity-classified format:

- **🔴 CRITICAL** — Bugs, vulnerabilities, or correctness errors that must be fixed before merging.
- **🟡 MAJOR** — Significant design, performance, error handling, or test coverage concerns.
- **🟢 MINOR** — Readability, naming, or small style issues.
- **⚪ NITPICK** — Personal preference or ideas for future improvement.

The model is prompted to:
1. Understand the PR first by reading the title, description, and diff.
2. Analyze each changed file individually.
3. Assign exactly one severity level per finding.
4. Include exact file paths and line numbers.
5. Provide concrete before/after code suggestions (`diff` blocks) for 🔴 and 🟡 findings.
6. Only flag genuine, evidence-backed problems it is confident about — and to say so plainly when the PR is clean, rather than inventing issues to fill the template.

The review ends with an overall quality rating (⭐ out of 5), strengths, key concerns, and a final verdict.

## Documentation Updater

A companion workflow, [`.github/workflows/docs-update.yml`](.github/workflows/docs-update.yml), keeps your docs in sync with the code. After a pull request is **merged**, it sends the PR diff plus the current contents of the configured documentation files to OpenRouter, asks for updated versions of those files, and opens a follow-up pull request with the proposed changes for you to review.

It runs the standalone Node script [`src/docs-update.js`](src/docs-update.js) (no build step required) and reuses the same model + fallback + retry behavior as the review action.

### Setup

1. Add an [OpenRouter API key](https://openrouter.ai/keys) as a repository secret named `OPEN_ROUTER_API_KEY` (same secret the review action uses).
2. Configure which documentation files to update on merge via a repository variable named `OPENROUTER_DOC_FILES` (a JSON array, comma-separated, or newline list of paths), for example `README.md, docs/usage.md`. Optionally set `OPENROUTER_MODEL`, `OPENROUTER_FALLBACK_MODEL`, and `OPENROUTER_DOCS_PROMPT` variables.
3. Under **Settings → Actions → General**, enable **Allow GitHub Actions to create and approve pull requests** so the workflow can open the docs PR.

The workflow can also be run manually via **workflow_dispatch**, where you supply the documentation files, model, prompt customizations, and merged PR number as inputs.

### Inputs

When triggered manually (`workflow_dispatch`), the workflow accepts:

| Input | Required | Description |
| --- | --- | --- |
| `doc_files` | Yes | Documentation files to update (JSON array, comma-separated, or newline list). On merge, this comes from the `OPENROUTER_DOC_FILES` repository variable. |
| `model` | No | OpenRouter model id (default: `deepseek/deepseek-v4-flash`) |
| `fallback_model` | No | OpenRouter model id to use if the primary model fails |
| `prompt` | No | Extra documentation instructions / prompt customizations |
| `pull_request_number` | Yes | Merged PR number whose diff drives the documentation update |

The OpenRouter API key is read from the `OPEN_ROUTER_API_KEY` secret rather than a plaintext input.

### Behavior

- Fetches the merged PR diff and a short summary (title, branch, change size, description) for context.
- For each documentation file, sends the diff and the file's current contents to OpenRouter with a technical-writer system prompt, then writes back the model's updated version. Files that the change doesn't affect are returned unchanged and left alone.
- Grounds edits in evidence visible in the diff and makes the smallest set of changes needed for accuracy, preserving the document's existing structure and tone.
- Truncates very large diffs and documentation files before sending them to the model.
- Opens a single pull request (branch `docs/openrouter-update-pr-<number>`) with all updated files; it does nothing if no documentation needed changes.

## Development

```bash
npm install
npm run build
```

Commit `dist/index.js` after changing `src/index.js`. The documentation updater in `src/docs-update.js` runs directly with Node and is not bundled, so it needs no rebuild.

Run the test suite with:

```bash
npm test
```

