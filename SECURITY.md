# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's security advisory feature for this repository. Do not open a public issue for a vulnerability involving arbitrary file access, approval bypass, cache integrity, credential exposure, or remote source substitution.

Include the affected commit, platform, DeepSeek Harness version, configuration, reproduction steps, and expected impact. Do not include live credentials.

## Supported versions

Until the first stable release, only the latest tagged dsh-skillflux version is supported. The current MVP targets DeepSeek Harness `0.1.1-rc.2`.

## Trust model

Remote skills are untrusted instructions. Commit pinning and cache integrity prevent source drift; they do not prove that a skill is safe. Use the default `always` approval policy and keep the Harness sandbox and tool permissions enabled.

The remote quality score is discovery triage, not a security score. Stars,
installs, recent activity, organization ownership, license metadata, and a
configured trusted-owner boost can all be manipulated or become stale. Review
the exact pinned commit before approval. `GITHUB_TOKEN` and `GH_TOKEN` are read
from the process environment for GitHub search and are never written to cache
manifests or usage telemetry.

The remote discovery result cache stores a SHA-256 fingerprint of the bounded
query and active ranking configuration plus validated candidate metadata. It
does not store query text, credentials, or Skill bodies. Freshness expiry does
not change candidate identity: cached and stale-fallback candidates remain
pinned to the immutable commit that was originally validated. Explicit caller
cancellation never triggers stale fallback.
