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

## Contributor workflow

Open an issue before a large architectural change so the scope and compatibility
target can be agreed before implementation. Small fixes can go directly to a
focused pull request.

1. Fork `YiyuZh/dsh-skillflux`, clone your fork, and keep the original repository
   as `upstream`:

   ```bash
   git clone https://github.com/<your-account>/dsh-skillflux.git
   cd dsh-skillflux
   git remote add upstream https://github.com/YiyuZh/dsh-skillflux.git
   git fetch upstream
   git switch -c feat/<short-name> upstream/main
   ```

   Collaborators with write access may clone the original repository and push a
   topic branch there instead. Changes should still go through a pull request.

2. Install the pinned toolchain and make the change in `src/`. Add focused unit
   tests in `tests/` and update the applicable checked-in corpus under `evals/`.
   Do not hand-edit `lib/`; `pnpm build` regenerates it from `src/`.

3. Run the local quality gate:

   ```bash
   corepack enable
   corepack pnpm install --frozen-lockfile
   corepack pnpm check
   corepack pnpm eval
   corepack pnpm test:cache-governance-live
   corepack pnpm pack --dry-run
   ```

4. For remote-discovery changes, also run a real online smoke test. GitHub Code
   Search is enabled by default but requires `GITHUB_TOKEN` or `GH_TOKEN` in the
   test process. For example, in PowerShell:

   ```powershell
   $env:GH_TOKEN = gh auth token
   $env:SKILLFLUX_REQUIRE_GITHUB = '1'
   corepack pnpm test:discovery-live
   corepack pnpm test:runtime-live
   ```

   Never paste a token into source, configuration, fixtures, logs, or the pull
   request. A remote provider outage should be reported separately from an
   offline unit-test failure.

   `test:runtime-live` uses a temporary DSH home and the real online discovery,
   installer, scoped runtime, `skill` tool, and turn cleanup. It does not call an
   LLM or execute downloaded Skill scripts. Set `SKILLFLUX_SMOKE_FAIL_FIRST=1`
   for a controlled first-candidate installation failure during the online run.

5. Commit the source, tests, documentation, evaluation fixtures, and regenerated
   `lib/` output, then push the topic branch and open a pull request against
   `main`. The pull request should explain the behavior change, compatibility
   impact, tests run, and any remaining limitations.

6. Address review findings on the same branch. The repository CI reruns
   typecheck, lint, tests, evaluations, build, and package-content validation.
   A maintainer merges after the review is resolved and CI passes.

## Design constraints

- Keep the official `ctx.skills` service as the source of truth.
- Keep mounts scoped to the receiving Agent and dispose them exactly.
- Do not accept arbitrary model-supplied URLs for remote installation.
- Resolve remote candidates to immutable commits before presenting candidate IDs.
- Keep remote relevance ahead of popularity, and treat stars, installs,
  freshness, owner type, and license as evidence rather than verification.
- A remote provider failure may reduce discovery coverage, but must not weaken
  the immutable-commit or approval boundaries of candidates that remain.
- The built-in installer must remain target-directory scoped: bind every file
  to the pinned GitHub tree/blob SHA, reject symbolic links and path traversal,
  and enforce file/byte limits before network download and again after writing.
- Never persist raw discovery queries. Cache keys must remain one-way
  fingerprints, and explicit cancellation must never trigger stale fallback.
- Installed-cache pruning must be deterministic, protect active and in-flight
  mounts across processes, and remain inside the dedicated SkillFlux cache root.
- Never execute scripts as part of discovery or installation.
- Fail open for routing/search availability, but fail closed for installation and approval.
- Preserve explicit `/skill-name` behavior and the durable `skill-catalog` source contract.

## Pull requests

Keep changes focused and add tests for behavior or security boundaries. Router
changes should add or update a case in
[`evals/routing-cases.json`](evals/routing-cases.json). Remote quality changes
should update [`evals/remote-quality-cases.json`](evals/remote-quality-cases.json).
Evidence-level, owner-policy, or content-deduplication changes should update
[`evals/remote-governance-cases.json`](evals/remote-governance-cases.json).
Discovery cache policy changes should update
[`evals/remote-cache-cases.json`](evals/remote-cache-cases.json).
Installed cache governance changes should update
[`evals/cache-governance-cases.json`](evals/cache-governance-cases.json).
Automatic remote mount changes should update
[`evals/remote-fallback-cases.json`](evals/remote-fallback-cases.json).
PRs should pass typecheck,
lint, tests, the routing evaluation, build, and package-content validation. Do
not commit credentials, local DSH profiles, cache entries, or `.qartez` indexes.

DeepSeek Harness is currently a developer preview. If an upstream RC changes public APIs, describe the compatibility impact and update peer/dev dependency ranges deliberately.
