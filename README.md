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

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: jeremyunck/openrouter-review@v1
        with:
          openrouter-api-key: ${{ secrets.OPEN_ROUTER_API_KEY }}
          model: ${{ github.event_name == 'workflow_dispatch' && inputs.model || 'deepseek/deepseek-v4-flash' }}
          pull-request-number: ${{ github.event_name == 'workflow_dispatch' && inputs.pull_request_number || '' }}
```

### Inputs

| Input | Required | Description |
| --- | --- | --- |
| `openrouter-api-key` | Yes | OpenRouter API key |
| `model` | Yes | OpenRouter model id (default in this repo: `deepseek/deepseek-v4-flash`) |
| `github-token` | No | Defaults to `github.token` |
| `prompt` | No | Extra instructions appended to the review request |
| `pull-request-number` | No* | PR number; required for `workflow_dispatch` when not triggered by `pull_request` |

### Outputs

| Output | Description |
| --- | --- |
| `review` | Raw markdown review text from the model |

## Behavior

- Fetches the full PR diff from the GitHub API.
- Sends the diff to OpenRouter's chat completions API with a code-review system prompt.
- Posts (or updates) a single PR comment tagged with `<!-- openrouter-review -->` so reruns on new commits replace the previous review instead of spamming the thread.
- Truncates very large diffs before sending them to the model.

## Development

```bash
npm install
npm run build
```

Commit `dist/index.js` after changing `src/index.js`.

