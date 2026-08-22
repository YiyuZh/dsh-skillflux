# dsh-skillflux

Dynamic Skill Runtime Manager for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

SkillFlux keeps the full Skill pool outside the model-facing catalog. For each
task, it selects a small set of relevant Skills, mounts them for the current
turn, and releases the mounts when the turn ends.

> **Status:** MVP for DeepSeek Harness `0.1.1-rc.2`. Harness is still a
> developer preview, so this project follows the current RC API.

[中文文档](README.zh-CN.md)

## Why SkillFlux

A growing Skill library should not make every request carry a growing catalog.
Large catalogs consume context and make Skill selection less predictable.

SkillFlux acts as a runtime layer between the Agent and its Skill pool. The
automatic catalog contains no more than `maxActiveSkills` selected Skills
(three by default), while the official DSH Skill Registry remains the source
of truth. Explicit `/skill-name` invocations remain available separately.

## Quick start

You need Node.js `22.20.0` or later and a DeepSeek Harness profile on the
`0.1.1-rc.2` package line.

1. Install SkillFlux into the profile you use:

   ```bash
   dsh plugin --profile web add github:YiyuZh/dsh-skillflux
   ```

   Replace `web` with another profile name, such as `headless`, when needed.

2. Restart that Harness profile.

3. Verify the runtime from a DSH conversation:

   ```text
   /skillflux status
   ```

For a reproducible deployment, pin a commit:

```bash
dsh plugin --profile web add github:YiyuZh/dsh-skillflux#<commit-sha>
```

The repository includes built `lib/` artifacts, so GitHub installation doesn't
run a `prepare` script. The bundle patch disables the official `tool-skill`
consumer and mounts SkillFlux under the unique `skillflux` loader ID. It keeps
the official `skill` Registry and `skill-filesystem` provider active.

## How it works

```text
User task
  -> deterministic Skill router
  -> local Registry + persistent cache + skills.sh
  -> select and mount up to the configured limit (3 by default)
  -> Agent calls a mounted Skill
  -> unmount at turn/end
  -> keep downloaded files until explicit cleanup
```

A mount is scoped to the receiving Agent. Unmounting removes the runtime
registration from future catalogs; it doesn't delete cached files or text
already stored in session history.

## MVP capabilities

- Route by ordered rules, then deterministic English and Chinese lexical scores.
- Limit the model-facing catalog with `maxActiveSkills`.
- Discover candidates from the DSH Registry, the SkillFlux cache, and
  [skills.sh](https://skills.sh/).
- Resolve remote candidates to immutable GitHub commit SHAs.
- Register cached Skills through the current Agent's `ctx.skills` scope.
- Verify cached content with a SHA-256 manifest before every load.
- Support per-remote-mount, per-repository/session, and automatic approval
  policies.
- Expose model tools for loading, searching, and mounting Skills.
- Expose `/skillflux` commands for runtime status and cache cleanup.

## Routing behavior

SkillFlux routes a task in this order:

1. Preserve an explicit user invocation such as `/pdf-reader` and exclude that
   name from automatic routing.
2. Group model-invocable Registry and cached candidates by Skill name. Registry
   entries represent a name first, while same-name cache entries remain
   available as fallbacks.
3. Apply matching `routes` in configuration order.
4. Score the remaining name representatives with deterministic lexical
   matching and reject scores below `minRouteScore`.
5. Mount the selected names until `maxActiveSkills` is reached. If a candidate
   can't load, try its same-name fallbacks in candidate-pool order.

The MVP lexical score is:

| Match | Score |
| --- | ---: |
| Complete Skill name or its space-separated form | +100 |
| Each matching name token | +20 |
| Each matching `whenToUse` token | +8 |
| Each matching description token | +3 |

For equal scores, Registry candidates rank before cached candidates, and cached
candidates rank before remote candidates. Cache ties prefer higher install
counts and then a stable source/name order.

## Configuration

SkillFlux accepts these plugin options:

```yaml
maxActiveSkills: 3
minRouteScore: 8
approvalPolicy: always       # always | session | automatic
remoteDiscovery: automatic   # automatic | on-demand | off
remoteSearchLimit: 5
remoteSearchTimeoutMs: 8000
catalogDescriptionMaxLength: 160
maxSkillFiles: 1000
maxSkillBytes: 10485760
installTimeoutMs: 300000
routes: []
```

Add ordered rules when a known task must prefer specific Skills:

```yaml
routes:
  - matchAll: [pdf, analyze]
    skills: [pdf-reader, document-parser]
  - matchAny: [react, frontend]
    skills: [react-specialist]
```

A rule can contain `matchAll`, `matchAny`, or both. Rule results keep their
declared order, skip unavailable Skills, and still respect
`maxActiveSkills`.

### Approval policies

| Policy | Behavior |
| --- | --- |
| `always` | Request native DSH approval for every remote mount. This is the default. |
| `session` | Request approval for the first successful install from a repository, then trust that repository for the current session. |
| `automatic` | Download and mount the highest-ranked remote candidate without approval. Use only in a trusted environment. |

If approval is unavailable, rejected, or canceled, the remote mount fails
closed.

## Model tools and user commands

The model can use:

- `skill({ name })` to load instructions for a Skill already mounted this turn.
- `skillflux_search({ query, remote? })` to search installed, cached, and
  immutable remote candidates.
- `skillflux_mount({ candidateId })` to mount a candidate from the current
  SkillFlux discovery state.

You can use:

```text
/skillflux status
/skillflux cache list
/skillflux cache clean <cache-id>
/skillflux cache clean all
```

Cleanup skips cache entries that are still mounted. At `turn/end`, SkillFlux
unregisters runtime mounts but retains downloaded files for later reuse.

## Security and trust

- Remote discovery accepts only public GitHub `owner/repository` results from
  skills.sh.
- Each remote result is resolved to a 40-character commit SHA before SkillFlux
  creates its candidate ID.
- Installation downloads that immutable GitHub codeload archive through the
  pinned `skills@1.5.23` CLI.
- Transport extraction is capped at 5,000 files. The selected Skill is
  separately capped at 1,000 files and 10 MiB by default.
- SkillFlux checks paths, symlinks, frontmatter, file counts, byte counts, and a
  SHA-256 content manifest before mounting.
- SkillFlux caches scripts as resources but never executes them.
- Automatic discovery sends a bounded keyword query instead of the complete
  user message.
- `GITHUB_TOKEN` or `GH_TOKEN` is optional and used only for GitHub API rate
  limits; SkillFlux doesn't persist it.

Skills are external instructions and can be malicious. Approval is a trust
decision, not a sandbox. Keep DSH permissions, sandboxing, and tool approvals
enabled.

## Evaluation

Run the versioned routing corpus without an API key or network access:

```bash
corepack pnpm eval
```

The corpus contains 36 English, Chinese, normalization, rule, threshold,
capacity, ranking, and deduplication cases.

| Metric | Current baseline |
| --- | ---: |
| Exact ordered match | 100.0% |
| Top-1 accuracy on positive cases | 100.0% |
| Negative-task rejection | 100.0% |
| Selector-limit compliance | 100.0% |

These results verify the deterministic MVP routing contract against the
checked-in corpus. They don't measure third-party Skill quality or the final
answer from an online model. Read the
[evaluation corpus guide](evals/README.md) for the case format and limitations.

## Known MVP limits

- Selection uses rules and lexical scoring, not embeddings or an LLM router.
- Remote installation supports only public GitHub Skills discovered through
  skills.sh.
- Unmounting can't remove text already committed to session history.
- A new upstream commit creates a new immutable cache entry. Old entries remain
  until explicit cleanup.

## Development

```bash
corepack pnpm install
corepack pnpm check
corepack pnpm eval
corepack pnpm pack --dry-run
```

The test suite covers routing, DSH catalog virtualization, explicit invocation,
remote response validation, cache integrity, lifecycle cleanup, and the bundle
patch. Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change.

## License

[MIT](LICENSE)
