# Remote fallback validation — 2026-08-31

> Historical pre-fix result. The pending online acceptance recorded here was
> resolved by the targeted Git tree/blob installer; see
> `remote-targeted-install-validation-2026-09-01.md`.

## Local checks

- Full suite: 22 files, 160 tests passed.
- Evaluation command: 8 files, 27 tests passed, including 8 checked-in remote
  fallback scenarios and the cancellation/deadline/unmount regressions.
- Typecheck, lint, build, package dry run, and generated-source verification passed.
- Independent review found a named-unmount race. It was fixed by retaining
  per-name mount epochs across the fallback sequence; re-review reported no fixes.

The deterministic runtime tests use real temporary cache files, SkillFlux and
DSH services, the `skill` tool, and turn cleanup. Remote discovery and downloaded
content are fixtures. These checks are not an online end-to-end success claim.

## Online observations

The development-only `scripts/runtime-smoke.mjs` was run with a GitHub token
supplied through the child process environment. It uses a temporary DSH home,
real discovery and installation, and does not call an LLM or run downloaded
Skill scripts. No token or real user documents are stored in this report.

| Task query | Controlled first failure | Elapsed | Result |
| --- | --- | --- | --- |
| analyze PDF documents with OCR and extract tables | Yes | 44.4 s | Three attempts failed; no mount. |
| extract PDF tables | Yes | 59.2 s | One controlled failure, one repository above the 512-SKILL scan limit, one connection timeout; no mount. |
| pdf | No | 49.6 s | One repository above the scan limit and two connection timeouts; no mount. |
| anthropics pdf | No | 124.3 s | Scan-limit rejection, connection reset, then the shared mount deadline expired; no mount. |

The last run selected `nexu-io/open-design` / `pdf`,
`anthropics/knowledge-work-plugins` / `view-pdf`, and
`K-Dense-AI/scientific-agent-skills` / `pdf`. Its final routing outcomes were
`mount-failed`, `mount-failed`, and `mount-timeout`. The query's owner keyword
does not act as a repository allowlist.

A separate discovery-only run succeeded against skills.sh, including a fresh
discovery-cache hit. Individual raw GitHub and API requests also returned HTTP
200 during diagnostics; connectivity failures were intermittent, not a proven
total outage.

## Acceptance status

**Online installation / instruction delivery / cleanup acceptance is still
pending.** No successful online mount, successful controlled online fallback,
or LLM task answer is claimed. Existing scan limits and verification rules were
not relaxed. Changes remain on the local feature branch pending a successful
online acceptance run; no PR has been submitted for this phase.

Retry from the repository after stabilizing GitHub/raw.githubusercontent.com/
codeload.github.com connectivity:

```powershell
$env:GH_TOKEN = gh auth token
$env:SKILLFLUX_REQUIRE_GITHUB = '1'
$env:SKILLFLUX_SMOKE_FAIL_FIRST = '1'
corepack pnpm test:runtime-live
```

An upstream candidate that exceeds the scan limit should remain rejected. A
successful retry must report a real mount, instruction delivery through the
`skill` tool, and zero mounted Skills after turn cleanup.
