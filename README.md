# openrouter-review

GitHub Action that sends a pull request diff to [OpenRouter](https://openrouter.ai/) for an AI code review and posts the result as a PR comment.

## Setup

1. Add an [OpenRouter API key](https://openrouter.ai/keys) as a repository secret named `OPEN_ROUTER_API_KEY`.
2. Copy the workflow below into `.github/workflows/openrouter-review.yml` in your repository (or use the workflow in this repo as a reference).

## Usage

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

- Fetches the full PR diff from the GitHub API.
- Sends the diff to OpenRouter's chat completions API with a code-review system prompt that reflects the selected strictness and focus areas.
- By default, posts (or updates) a single PR comment tagged with `<!-- openrouter-review -->` so reruns on new commits replace the previous review instead of spamming the thread.
- When `approver` is `true`, asks the model for a structured decision and submits either an approving or requesting-changes PR review with the model review as the body.
- Truncates very large diffs before sending them to the model.

## Development

```bash
npm install
npm run build
```

Commit `dist/index.js` after changing `src/index.js`.

