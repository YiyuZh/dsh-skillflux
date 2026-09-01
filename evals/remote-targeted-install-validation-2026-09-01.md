# Targeted remote installation validation — 2026-09-01

## Change under test

The built-in installer now obtains the pinned recursive GitHub tree, proves that
the requested Skill name has one usable `SKILL.md`, selects only regular files
inside that Skill directory, and downloads each file through the Git Blob API.
Every response is checked against its declared size and a locally recomputed Git
blob SHA before it is written. The whole repository archive is not downloaded.

The previous online failure was reproducible: `skills@1.5.23` has a fixed
30-second transport timeout, while a direct download of one selected repository
archive completed in about 35.3 seconds. The targeted installer removes that
archive-level dependency without relaxing the pinned-commit, uniqueness, path,
symlink, file-count, byte-count, parser, or installed-content checks.

## Deterministic checks

- Full suite: 22 files, 169 tests passed.
- Evaluation corpus: 8 files, 27 tests passed.
- Typecheck, lint, build, and package dry run passed.
- New tests cover nested target files, sibling exclusion, symbolic links, path
  traversal, preflight file/byte limits, malformed Base64, recomputed Git blob
  SHA enforcement, UTF-8 BOM hash preservation, legacy custom-verifier
  compatibility, and the default cache installation path.

## Live online runtime result

The development-only runtime smoke used a temporary DSH home, real skills.sh and
GitHub discovery, GitHub tree/blob verification, the real built-in installer,
the scoped DSH `skill` tool, and turn cleanup. It did not call an LLM or execute
downloaded scripts.

| Run | Task query | Controlled first failure | Elapsed | Result |
| --- | --- | --- | --- | --- |
| Initial acceptance | extract PDF tables | Yes | 33.3 s | Third ranked candidate mounted; instructions were delivered; turn cleanup unmounted it. |
| Post-review regression | extract PDF tables | Yes | 41.9 s | Same bounded fallback, mount, instruction delivery, and cleanup assertions passed. |

Observed fallback sequence:

1. `davila7/claude-code-templates` / `pdf-processing`: controlled failure.
2. `xberg-io/xberg` / `extracting-tables`: correctly rejected because the
   pinned repository contained five usable Skills with the same name.
3. `CraftOS-dev/CraftBot` / `pdf`: mounted successfully through targeted Git
   blob download.

The final assertions confirmed one mounted Skill, instruction delivery through
the DSH `skill` tool, and zero mounted or registered scoped Skills after the
turn ended.

## Acceptance status

**Passed.** The live run demonstrates bounded fallback from two rejected
candidates to a real online install, instruction delivery, and automatic
cleanup while retaining the existing verification boundaries.
