import type {
  RegistryTier,
  RemoteCandidate,
  RemoteQualityBreakdown,
  RemoteQualitySignal,
  RemoteQualityWarning,
  RemoteTrustLevel,
  RemoteTrustPolicy,
} from './types.js'

export interface RemoteEvidenceInput {
  readonly relevanceScore: number
  readonly installs: number
  readonly stars: number
  readonly forks: number
  readonly pushedAt?: string
  readonly recentActivityDays: number
  readonly trustedSource: boolean
  readonly organizationOwned: boolean
  readonly hasLicense: boolean
  readonly discoverySourceCount?: number
  readonly contentPinned?: boolean
  /** Advisory ecosystem tier; evidence, never a trust grant. */
  readonly registryTier?: RegistryTier
  readonly now: number
}

export interface RemoteQualityEvidence {
  readonly trustLevel: RemoteTrustLevel
  readonly breakdown: RemoteQualityBreakdown
  readonly signals: readonly RemoteQualitySignal[]
  readonly warnings: readonly RemoteQualityWarning[]
}

const TRUST_RANK: Readonly<Record<RemoteTrustLevel, number>> = {
  unverified: 0,
  community: 1,
  corroborated: 2,
  trusted: 3,
}

function logarithmicPoints(value: number, multiplier: number, maximum: number): number {
  return Math.min(maximum, Math.round(Math.log10(value + 1) * multiplier))
}

function activityAgeDays(pushedAt: string | undefined, now: number): number | undefined {
  if (pushedAt === undefined) return undefined
  const pushed = Date.parse(pushedAt)
  if (!Number.isFinite(pushed)) return undefined
  return Math.max(0, (now - pushed) / 86_400_000)
}

export function remoteQualityEvidence(input: RemoteEvidenceInput): RemoteQualityEvidence {
  const relevance = input.relevanceScore >= 100
    ? 55
    : Math.min(50, Math.max(0, input.relevanceScore * 2))
  const adoption = logarithmicPoints(input.installs, 4, 15)
  const repository = logarithmicPoints(input.stars, 4, 15) + logarithmicPoints(input.forks, 2, 5)
  const age = activityAgeDays(input.pushedAt, input.now)
  const freshness = age === undefined
    ? 0
    : age <= input.recentActivityDays
      ? 10
      : age <= input.recentActivityDays * 3
        ? 6
        : age <= 365
          ? 3
          : 0
  const tierTrust = input.registryTier === 'official'
    ? 3
    : input.registryTier === 'verified'
      ? 2
      : input.registryTier === 'community'
        ? 1
        : 0
  const trust = (input.trustedSource ? 10 : 0)
    + (input.organizationOwned ? 3 : 0)
    + (input.hasLicense ? 2 : 0)
    + tierTrust
  const crossSource = (input.discoverySourceCount ?? 1) > 1
  const contentPinned = input.contentPinned === true
  const provenance = (crossSource ? 4 : 0) + (contentPinned ? 4 : 0)
  const total = Math.min(100, relevance + adoption + repository + freshness + trust + provenance)

  const signals: RemoteQualitySignal[] = []
  if (input.trustedSource) signals.push('trusted-owner')
  if (crossSource) signals.push('cross-source')
  if (contentPinned) signals.push('content-pinned')
  if (age !== undefined && age <= input.recentActivityDays) signals.push('recent-activity')
  if (input.hasLicense) signals.push('declared-license')
  if (input.organizationOwned) signals.push('organization-owned')
  if (input.installs > 0) signals.push('market-adoption')
  if (input.stars > 0 || input.forks > 0) signals.push('repository-adoption')
  if (input.registryTier === 'official') signals.push('ecosystem-official')
  else if (input.registryTier === 'verified') signals.push('ecosystem-verified')
  else if (input.registryTier === 'community') signals.push('ecosystem-community')

  const warnings: RemoteQualityWarning[] = []
  if (!crossSource) warnings.push('single-source')
  if (!contentPinned) warnings.push('content-not-previewed')
  if (age === undefined) warnings.push('activity-unknown')
  else if (age > input.recentActivityDays * 3) warnings.push('stale-activity')
  if (!input.hasLicense) warnings.push('license-missing')
  if (input.installs < 10 && input.stars < 5 && input.forks < 2) warnings.push('low-adoption')
  if (input.registryTier === 'unreviewed') warnings.push('ecosystem-unreviewed')

  const hasCommunityEvidence = contentPinned
    || (input.hasLicense && freshness > 0 && (input.installs > 0 || input.stars > 0 || input.forks > 0))
  const trustLevel: RemoteTrustLevel = input.trustedSource
    ? 'trusted'
    : crossSource && contentPinned
      ? 'corroborated'
      : hasCommunityEvidence
        ? 'community'
        : 'unverified'

  return {
    trustLevel,
    breakdown: { relevance, adoption, repository, freshness, trust, provenance, total },
    signals,
    warnings,
  }
}

export function remoteTrustPolicyAllows(level: RemoteTrustLevel, policy: RemoteTrustPolicy): boolean {
  if (policy === 'open') return true
  return TRUST_RANK[level] >= TRUST_RANK[policy]
}

export function compareRemoteTrust(left: RemoteTrustLevel, right: RemoteTrustLevel): number {
  return TRUST_RANK[left] - TRUST_RANK[right]
}

export function compareRemoteCandidates(left: RemoteCandidate, right: RemoteCandidate): number {
  return right.qualityScore - left.qualityScore
    || right.relevanceScore - left.relevanceScore
    || compareRemoteTrust(right.trustLevel, left.trustLevel)
    || Number(right.trustedSource) - Number(left.trustedSource)
    || Number(right.recentlyActive) - Number(left.recentlyActive)
    || right.installs - left.installs
    || right.stars - left.stars
    || `${left.source}/${left.name}`.localeCompare(`${right.source}/${right.name}`, 'en')
}

export function deduplicateRemoteCandidates(candidates: readonly RemoteCandidate[]): RemoteCandidate[] {
  const byId = new Map<string, RemoteCandidate>()
  for (const candidate of candidates) {
    const prior = byId.get(candidate.id)
    if (prior === undefined || compareRemoteCandidates(candidate, prior) < 0) byId.set(candidate.id, candidate)
  }
  // Equal root SKILL.md hashes do not prove equal directories: adjacent scripts
  // and resources may differ. Only exact candidate identities are collapsed.
  return [...byId.values()].sort(compareRemoteCandidates)
}
