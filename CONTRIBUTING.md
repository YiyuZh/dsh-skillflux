# Contributing

Thanks for helping improve dsh-skillflux.

## Development setup

- Node.js `>=22.20.0`
- Corepack with pnpm `11.7.0`
- DeepSeek Harness packages on the `0.1.1-rc.2` line

```bash
corepack enable
corepack pnpm install
corepack pnpm check
corepack pnpm eval
corepack pnpm pack --dry-run
```

## Design constraints

- Keep the official `ctx.skills` service as the source of truth.
- Keep mounts scoped to the receiving Agent and dispose them exactly.
- Do not accept arbitrary model-supplied URLs for remote installation.
- Resolve remote candidates to immutable commits before presenting candidate IDs.
- Keep remote relevance ahead of popularity, and treat stars, installs,
  freshness, owner type, and license as evidence rather than verification.
- A remote provider failure may reduce discovery coverage, but must not weaken
  the immutable-commit or approval boundaries of candidates that remain.
- Never execute scripts as part of discovery or installation.
- Fail open for routing/search availability, but fail closed for installation and approval.
- Preserve explicit `/skill-name` behavior and the durable `skill-catalog` source contract.

## Pull requests

Keep changes focused and add tests for behavior or security boundaries. Router
changes should add or update a case in
[`evals/routing-cases.json`](evals/routing-cases.json). Remote quality changes
should update [`evals/remote-quality-cases.json`](evals/remote-quality-cases.json).
PRs should pass typecheck,
lint, tests, the routing evaluation, build, and package-content validation. Do
not commit credentials, local DSH profiles, cache entries, or `.qartez` indexes.

DeepSeek Harness is currently a developer preview. If an upstream RC changes public APIs, describe the compatibility impact and update peer/dev dependency ranges deliberately.
