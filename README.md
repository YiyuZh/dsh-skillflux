# dsh-skillflux

Dynamic Skill Runtime Manager for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

`dsh-skillflux` keeps the full Skill pool outside the model-facing catalog, selects only the skills relevant to the current turn, mounts cached or remote skills when needed, and unmounts them when the turn ends.

> Status: MVP for DeepSeek Harness `0.1.1-rc.2`. Harness is still a developer preview, so compatibility is pinned to the current RC line.

[中文文档](README.zh-CN.md)

## Why

Installing more skills should not make every later request carry a larger catalog. SkillFlux treats skills like dynamically loaded modules:

```text
User task
  -> deterministic router
  -> local registry + persistent cache + skills.sh
  -> mount at most 1-3 skills
  -> agent executes
  -> unmount at turn/end
  -> keep downloaded files until the user cleans them
```

SkillFlux reuses the official `ctx.skills` registry. It replaces only the default model-facing `tool-skill` consumer so the original filesystem providers, precedence rules, scoped registrations, and explicit `/skill-name` invocation continue to work.

## Features

- Rule-first routing plus deterministic lexical scoring for English and Chinese tasks.
- A model catalog capped by `maxActiveSkills` instead of the size of the installed pool.
- Local registry, persistent cache, and [skills.sh](https://skills.sh/) discovery.
- Immutable remote candidates resolved to a GitHub commit SHA.
- Turn-scoped `ctx.skills.register()` mounts with exact disposers.
- Persistent, content-hashed cache under `$DSH_HOME/cache/skillflux`.
- Three remote approval policies: every install, once per repository/session, or automatic.
- Native tools: `skill`, `skillflux_search`, and `skillflux_mount`.
- Native command: `/skillflux` for status and cache management.

## Install

Built artifacts are committed, so GitHub installation does not need a `prepare` script:

```bash
dsh plugin --profile web add github:YiyuZh/dsh-skillflux
```

For reproducible deployment, pin the plugin commit:

```bash
dsh plugin --profile web add github:YiyuZh/dsh-skillflux#<commit-sha>
```

The bundle patch disables the profile row with `id: tool-skill` and mounts SkillFlux under its own `skillflux` loader id. It does not replace the official `skill` registry or `skill-filesystem` provider. Restart the Harness profile after installation.

## Configuration

Defaults:

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

Example ordered routing rule:

```yaml
routes:
  - matchAll: [pdf, analyze]
    skills: [pdf-reader, document-parser]
  - matchAny: [react, frontend]
    skills: [react-skill]
```

Rules run before lexical scoring. A rule can use `matchAll`, `matchAny`, or both. Results are deduplicated and capped by `maxActiveSkills`.

### Approval policies

| Policy | Behavior |
| --- | --- |
| `always` | Every remote mount goes through the native DSH one-shot approval flow. This is the default. |
| `session` | The first successful install from a repository requires approval; that repository is trusted only for the current session. |
| `automatic` | The highest-ranked remote candidate may be downloaded and mounted without approval. Use only in a trusted environment. |

If the approval service is unavailable or rejects the request, the install fails closed.

## Tools and commands

The model can use:

- `skill({ name })` — load a skill already mounted for this turn.
- `skillflux_search({ query, remote? })` — search installed, cached, and immutable remote candidates.
- `skillflux_mount({ candidateId })` — mount only a candidate produced by the current SkillFlux discovery state.

Users can run:

```text
/skillflux status
/skillflux cache list
/skillflux cache clean <cache-id>
/skillflux cache clean all
```

Active cache entries are skipped during cleanup. At `turn/end`, SkillFlux unregisters runtime skills but keeps downloaded files for later reuse.

## Security model

- Remote discovery accepts only public GitHub `owner/repository` results from skills.sh.
- Each result is resolved through GitHub to a 40-character commit SHA before a candidate ID is minted.
- Installation downloads the immutable GitHub codeload archive for that SHA through the pinned `skills@1.5.23` CLI.
- Transport extraction is capped at 5,000 files; the selected skill is separately capped at 1,000 files and 10 MiB by default.
- Paths, symlinks, frontmatter, file counts, byte counts, and a SHA-256 content manifest are checked before mounting.
- Skill scripts are cached as resources but are never executed by SkillFlux.
- Automatic discovery sends a bounded token query, not the full user message. Secret-like tokens are removed.
- `GITHUB_TOKEN` or `GH_TOKEN` is optional and is read only for GitHub API rate limits; it is never persisted.

Skills are instructions supplied to an agent and can still be malicious. Approval is a trust decision, not a sandbox. Keep DSH permissions and tool approvals enabled.

## Known MVP limits

- No embedding or LLM router; selection is rule and lexical based.
- Only public GitHub skills discovered through skills.sh are remotely installable.
- Unmounting cannot remove text already committed to session history; it prevents stale skills from remaining in later catalogs.
- New upstream commits create new immutable cache entries. Old entries remain until explicitly cleaned.

## Development

```bash
corepack pnpm install
corepack pnpm check
corepack pnpm pack --dry-run
```

The test suite covers routing, DSH catalog virtualization, explicit invocation compatibility, remote response validation, cache integrity, and cleanup behavior. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance.

## License

[MIT](LICENSE)
