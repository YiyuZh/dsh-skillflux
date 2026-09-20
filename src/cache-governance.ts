import type { CacheEntry } from './types.js'

export type CachePruneReason = 'idle' | 'entry-limit' | 'byte-limit' | 'entry-and-byte-limit'

export interface CacheUsageEvidence {
  readonly source: string
  readonly name: string
  /** Exact immutable cache version. Omitted only by legacy usage records. */
  readonly cacheId?: string
  readonly mounts: number
  readonly uses: number
  readonly lastMountedAt?: number
  readonly lastUsedAt?: number
  /** Sum of recorded loaded-body token estimates for this cache version. */
  readonly totalLoadedBodyTokens?: number
}

export interface CachePrunePolicy {
  readonly maxEntries: number
  readonly maxTotalBytes: number
  /** Zero disables idle-time eviction. */
  readonly maxIdleMs: number
}

export interface CachePruneDecision {
  readonly cacheId: string
  readonly reason: CachePruneReason
}

export interface CachePrunePlan {
  readonly decisions: readonly CachePruneDecision[]
  readonly protected: readonly string[]
  readonly beforeEntries: number
  readonly beforeBytes: number
  readonly afterEntries: number
  readonly afterBytes: number
}

interface RankedEntry {
  readonly entry: CacheEntry
  readonly mounts: number
  readonly uses: number
  readonly lastActivityAt: number
  readonly totalLoadedBodyTokens: number
}

function evidenceKey(source: string, name: string): string {
  return JSON.stringify([source, name])
}

function safeTimestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function safeSum(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

interface EvidenceIndex {
  readonly exact: ReadonlyMap<string, CacheUsageEvidence>
  readonly legacy: ReadonlyMap<string, CacheUsageEvidence>
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function validateEvidence(item: CacheUsageEvidence): void {
  if (typeof item.source !== 'string' || item.source.length === 0 || item.source.length > 2_048
    || typeof item.name !== 'string' || item.name.length === 0 || item.name.length > 128
    || !validCount(item.mounts) || !validCount(item.uses)
    || (item.cacheId !== undefined && !/^[0-9a-f]{24}$/u.test(item.cacheId))
    || (item.lastMountedAt !== undefined && !validCount(item.lastMountedAt))
    || (item.lastUsedAt !== undefined && !validCount(item.lastUsedAt))
    || (item.totalLoadedBodyTokens !== undefined && !validCount(item.totalLoadedBodyTokens))) {
    throw new Error('invalid cache usage evidence')
  }
}

function mergeEvidence(
  previous: CacheUsageEvidence | undefined,
  item: CacheUsageEvidence | undefined,
): CacheUsageEvidence | undefined {
  if (item === undefined) return previous
  if (previous === undefined) return item
  const lastMountedAt = Math.max(previous.lastMountedAt ?? 0, item.lastMountedAt ?? 0)
  const lastUsedAt = Math.max(previous.lastUsedAt ?? 0, item.lastUsedAt ?? 0)
  return {
    source: item.source,
    name: item.name,
    ...(item.cacheId === undefined ? {} : { cacheId: item.cacheId }),
    mounts: safeSum(previous.mounts, item.mounts),
    uses: safeSum(previous.uses, item.uses),
    ...(lastMountedAt === 0 ? {} : { lastMountedAt }),
    ...(lastUsedAt === 0 ? {} : { lastUsedAt }),
    ...(item.totalLoadedBodyTokens === undefined && previous.totalLoadedBodyTokens === undefined
      ? {}
      : { totalLoadedBodyTokens: safeSum(previous.totalLoadedBodyTokens ?? 0, item.totalLoadedBodyTokens ?? 0) }),
  }
}

function aggregateEvidence(items: readonly CacheUsageEvidence[]): EvidenceIndex {
  const exact = new Map<string, CacheUsageEvidence>()
  const legacy = new Map<string, CacheUsageEvidence>()
  for (const item of items) {
    validateEvidence(item)
    if (item.cacheId !== undefined) exact.set(item.cacheId, mergeEvidence(exact.get(item.cacheId), item)!)
    else {
      const key = evidenceKey(item.source, item.name)
      legacy.set(key, mergeEvidence(legacy.get(key), item)!)
    }
  }
  return { exact, legacy }
}

function evictionOrder(left: RankedEntry, right: RankedEntry): number {
  if (left.uses !== right.uses) return left.uses - right.uses
  if (left.mounts !== right.mounts) return left.mounts - right.mounts
  if (left.lastActivityAt !== right.lastActivityAt) return left.lastActivityAt - right.lastActivityAt
  if ((left.entry.manifest.qualityScore ?? 0) !== (right.entry.manifest.qualityScore ?? 0)) {
    return (left.entry.manifest.qualityScore ?? 0) - (right.entry.manifest.qualityScore ?? 0)
  }
  if ((left.entry.manifest.installs ?? 0) !== (right.entry.manifest.installs ?? 0)) {
    return (left.entry.manifest.installs ?? 0) - (right.entry.manifest.installs ?? 0)
  }
  // Deterministic value-governance tie-break: among otherwise equal entries,
  // the higher token-cost version is evicted first. Absent evidence, zero
  // keeps the historical ordering intact.
  if (left.totalLoadedBodyTokens !== right.totalLoadedBodyTokens) {
    return right.totalLoadedBodyTokens - left.totalLoadedBodyTokens
  }
  return left.entry.manifest.cacheId.localeCompare(right.entry.manifest.cacheId, 'en')
}

function limitReason(entries: number, bytes: number, policy: CachePrunePolicy): CachePruneReason {
  const overEntries = entries > policy.maxEntries
  const overBytes = bytes > policy.maxTotalBytes
  if (overEntries && overBytes) return 'entry-and-byte-limit'
  return overEntries ? 'entry-limit' : 'byte-limit'
}

function validatePolicy(policy: CachePrunePolicy): void {
  if (!Number.isSafeInteger(policy.maxEntries) || policy.maxEntries < 1) {
    throw new Error('cache prune maxEntries must be a positive safe integer')
  }
  if (!Number.isSafeInteger(policy.maxTotalBytes) || policy.maxTotalBytes < 1) {
    throw new Error('cache prune maxTotalBytes must be a positive safe integer')
  }
  if (!Number.isSafeInteger(policy.maxIdleMs) || policy.maxIdleMs < 0) {
    throw new Error('cache prune maxIdleMs must be a non-negative safe integer')
  }
}

export function planCachePrune(
  entries: readonly CacheEntry[],
  evidence: readonly CacheUsageEvidence[],
  policy: CachePrunePolicy,
  active: ReadonlySet<string> = new Set(),
  now = Date.now(),
): CachePrunePlan {
  validatePolicy(policy)
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('cache prune clock must be a non-negative safe integer')

  const usage = aggregateEvidence(evidence)
  const newestBySkill = new Map<string, CacheEntry>()
  for (const entry of entries) {
    const key = evidenceKey(entry.manifest.source, entry.manifest.name)
    const previous = newestBySkill.get(key)
    if (previous === undefined
      || safeTimestamp(entry.manifest.installedAt) > safeTimestamp(previous.manifest.installedAt)
      || (entry.manifest.installedAt === previous.manifest.installedAt
        && entry.manifest.cacheId.localeCompare(previous.manifest.cacheId, 'en') > 0)) {
      newestBySkill.set(key, entry)
    }
  }
  const ranked = entries.map(entry => {
    const installedAt = safeTimestamp(entry.manifest.installedAt)
    const key = evidenceKey(entry.manifest.source, entry.manifest.name)
    const legacy = newestBySkill.get(key)?.manifest.cacheId === entry.manifest.cacheId
      ? usage.legacy.get(key)
      : undefined
    const item = mergeEvidence(usage.exact.get(entry.manifest.cacheId), legacy)
    return {
      entry,
      mounts: item?.mounts ?? 0,
      uses: item?.uses ?? 0,
      lastActivityAt: Math.min(now, Math.max(installedAt, item?.lastMountedAt ?? 0, item?.lastUsedAt ?? 0)),
      totalLoadedBodyTokens: item?.totalLoadedBodyTokens ?? 0,
    }
  })
  const protectedEntries = ranked.filter(item => active.has(item.entry.manifest.cacheId))
  const removable = ranked.filter(item => !active.has(item.entry.manifest.cacheId)).sort(evictionOrder)
  const decisions: CachePruneDecision[] = []
  const removed = new Set<string>()
  let remainingEntries = entries.length
  let remainingBytes = entries.reduce((total, entry) => safeSum(total, entry.manifest.totalBytes), 0)

  if (policy.maxIdleMs > 0) {
    for (const item of removable) {
      if (Math.max(0, now - item.lastActivityAt) < policy.maxIdleMs) continue
      const id = item.entry.manifest.cacheId
      decisions.push({ cacheId: id, reason: 'idle' })
      removed.add(id)
      remainingEntries -= 1
      remainingBytes -= item.entry.manifest.totalBytes
    }
  }

  for (const item of removable) {
    if (remainingEntries <= policy.maxEntries && remainingBytes <= policy.maxTotalBytes) break
    const id = item.entry.manifest.cacheId
    if (removed.has(id)) continue
    decisions.push({ cacheId: id, reason: limitReason(remainingEntries, remainingBytes, policy) })
    removed.add(id)
    remainingEntries -= 1
    remainingBytes -= item.entry.manifest.totalBytes
  }

  return {
    decisions,
    protected: protectedEntries.map(item => item.entry.manifest.cacheId).sort((left, right) => left.localeCompare(right, 'en')),
    beforeEntries: entries.length,
    beforeBytes: entries.reduce((total, entry) => safeSum(total, entry.manifest.totalBytes), 0),
    afterEntries: remainingEntries,
    afterBytes: remainingBytes,
  }
}
