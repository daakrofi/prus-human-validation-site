# PRUS Validation GitHub Writer

This Cloudflare Worker receives validated session payloads from the GitHub Pages site and writes the latest record for each participant to the private `daakrofi/prus-human-validation-responses` repository.

The participant email is SHA-256 hashed for the GitHub filename. Main-site responses are stored under `responses/post-validation-v1/`; alternative cue-and-scope-codebook responses are stored under `responses/post-validation-synthetic-rubric-hybrid-v1/`. The complete participant record remains inside the private JSON file. Repeated checkpoints update the same file, while Git history preserves prior versions.

The Worker accepts the main `2026-07-17-post-level-v1` sample schema and the alternative `2026-07-18-synthetic-rubric-hybrid-v1` schema, routing each to its own response namespace. Each completed PRUS-positive post must contain at least one valid product topic domain, while Not PRUS posts cannot contain domain selections. GitHub Contents API writes share a branch and can conflict when checkpoints overlap. The Worker therefore re-reads and retries transient `409`, `422`, `429`, and server-error responses with bounded exponential backoff. It also compares checkpoint progress and timestamps so a delayed request cannot overwrite a more advanced saved record. The browser complements this by allowing only one active remote save and coalescing any pending checkpoints.

## Required secret

Create a fine-grained GitHub personal access token with **Contents: Read and write** access limited to the private response repository, then set it without committing it:

```bash
npx wrangler secret put GITHUB_TOKEN
```

## Deploy

```bash
npm install
npm test
npx wrangler deploy
```

After deployment, set `backendUrl` in the site's `config.js` to the Worker `/collect` URL.

The deployed endpoint is:

```text
https://prus-validation-github-writer.daakrofi-research.workers.dev/collect
```

Health can be checked at:

```text
https://prus-validation-github-writer.daakrofi-research.workers.dev/health
```
