import { describe, expect, it } from 'vitest'
import { planCachePrune, type CacheUsageEvidence } from '../src/cache-governance.js'
import type { CacheEntry } from '../src/types.js'

const NOW = Date.parse('2030-01-01T00:00:00.000Z')
const DAY_MS = 24 * 60 * 60_000

function entry(
  id: string,
  options: { bytes?: number; ageDays?: number; source?: string; name?: string; qualityScore?: number; installs?: number } = {},
): CacheEntry {
  const name = options.name ?? `skill-${id}`
  return {
    directory: `/cache/${id}`,
    manifest: {
      version: 1,
      cacheId: id.padEnd(24, '0').slice(0, 24),
      source: options.source ?? 'owner/repo',
      ref: id.padEnd(40, 'a').slice(0, 40),
      skillId: name,
      name,
      description: name,
      ...(options.qualityScore === undefined ? {} : { qualityScore: options.qualityScore }),
      ...(options.installs === undefined ? {} : { installs: options.installs }),
      installedAt: new Date(NOW - (options.ageDays ?? 0) * DAY_MS).toISOString(),
      fileCount: 1,
      totalBytes: options.bytes ?? 100,
      contentHash: 'f'.repeat(64),
    },
  }
}

function evidence(
  target: CacheEntry,
  options: { mounts?: number; uses?: number; lastActivityDays?: number } = {},
): CacheUsageEvidence {
  const lastActivity = NOW - (options.lastActivityDays ?? 0) * DAY_MS
  return {
    source: target.manifest.source,
    name: target.manifest.name,
    cacheId: target.manifest.cacheId,
    mounts: options.mounts ?? 0,
    uses: options.uses ?? 0,
    lastMountedAt: lastActivity,
    lastUsedAt: lastActivity,
  }
}

describe('installed cache governance', () => {
  it('keeps a healthy cache unchanged', () => {
    const entries = [entry('a'), entry('b')]
    const plan = planCachePrune(entries, [], { maxEntries: 2, maxTotalBytes: 200, maxIdleMs: 90 * DAY_MS }, new Set(), NOW)
    expect(plan).toMatchObject({ decisions: [], beforeEntries: 2, afterEntries: 2, beforeBytes: 200, afterBytes: 200 })
  })

  it('evicts entries exactly at the idle boundary and allows the policy to be disabled', () => {
    const old = entry('a', { ageDays: 90 })
    expect(planCachePrune([old], [], { maxEntries: 10, maxTotalBytes: 1_000, maxIdleMs: 90 * DAY_MS }, new Set(), NOW).decisions)
      .toEqual([{ cacheId: old.manifest.cacheId, reason: 'idle' }])
    expect(planCachePrune([old], [], { maxEntries: 10, maxTotalBytes: 1_000, maxIdleMs: 0 }, new Set(), NOW).decisions)
      .toEqual([])
  })

  it('retains frequently used Skills when the entry limit is exceeded', () => {
    const unused = entry('a')
    const used = entry('b')
    const plan = planCachePrune(
      [unused, used],
      [evidence(used, { mounts: 4, uses: 3 })],
      { maxEntries: 1, maxTotalBytes: 1_000, maxIdleMs: 0 },
      new Set(),
      NOW,
    )
    expect(plan.decisions).toEqual([{ cacheId: unused.manifest.cacheId, reason: 'entry-limit' }])
  })

  it('aggregates remote and cached candidate usage by source and Skill name', () => {
    const common = entry('a', { source: 'owner/common', name: 'common' })
    const other = entry('b', { source: 'owner/other', name: 'other' })
    const splitEvidence = [
      { ...evidence(common, { uses: 2 }), mounts: 1 },
      { ...evidence(common, { uses: 3 }), mounts: 2 },
    ]
    const plan = planCachePrune(
      [common, other],
      splitEvidence,
      { maxEntries: 1, maxTotalBytes: 1_000, maxIdleMs: 0 },
      new Set(),
      NOW,
    )
    expect(plan.decisions[0]?.cacheId).toBe(other.manifest.cacheId)
  })

  it('keeps usage value scoped to an immutable cache version', () => {
    const oldVersion = entry('a', { source: 'owner/versioned', name: 'versioned', ageDays: 120 })
    const newVersion = entry('b', { source: 'owner/versioned', name: 'versioned', ageDays: 1 })
    const plan = planCachePrune(
      [oldVersion, newVersion],
      [evidence(newVersion, { mounts: 3, uses: 2 })],
      { maxEntries: 10, maxTotalBytes: 1_000, maxIdleMs: 90 * DAY_MS },
      new Set(),
      NOW,
    )
    expect(plan.decisions).toEqual([{ cacheId: oldVersion.manifest.cacheId, reason: 'idle' }])
  })

  it('applies legacy source-and-name evidence only to the newest immutable version', () => {
    const oldVersion = entry('a', { source: 'owner/legacy', name: 'legacy', ageDays: 120 })
    const newVersion = entry('b', { source: 'owner/legacy', name: 'legacy', ageDays: 1 })
    const legacy = {
      source: newVersion.manifest.source,
      name: newVersion.manifest.name,
      mounts: 4,
      uses: 3,
      lastMountedAt: NOW,
      lastUsedAt: NOW,
    }
    const plan = planCachePrune(
      [oldVersion, newVersion],
      [legacy],
      { maxEntries: 10, maxTotalBytes: 1_000, maxIdleMs: 90 * DAY_MS },
      new Set(),
      NOW,
    )
    expect(plan.decisions).toEqual([{ cacheId: oldVersion.manifest.cacheId, reason: 'idle' }])
  })

  it('uses recency, quality, and adoption as deterministic tie-breakers', () => {
    const stale = entry('a', { ageDays: 30 })
    const lowQuality = entry('b', { qualityScore: 20, installs: 10 })
    const highQuality = entry('c', { qualityScore: 90, installs: 1_000 })
    const plan = planCachePrune(
      [stale, lowQuality, highQuality],
      [],
      { maxEntries: 1, maxTotalBytes: 1_000, maxIdleMs: 0 },
      new Set(),
      NOW,
    )
    expect(plan.decisions.map(item => item.cacheId)).toEqual([stale.manifest.cacheId, lowQuality.manifest.cacheId])
  })

  it('removes enough entries to satisfy the total-byte limit', () => {
    const entries = [entry('a', { bytes: 80 }), entry('b', { bytes: 70 }), entry('c', { bytes: 60 })]
    const plan = planCachePrune(entries, [], { maxEntries: 10, maxTotalBytes: 100, maxIdleMs: 0 }, new Set(), NOW)
    expect(plan.decisions).toHaveLength(2)
    expect(plan.decisions.every(item => item.reason === 'byte-limit')).toBe(true)
    expect(plan).toMatchObject({ beforeBytes: 210, afterBytes: 60, afterEntries: 1 })
  })

  it('reports combined pressure and never selects active entries', () => {
    const active = entry('a', { bytes: 100 })
    const removable = entry('b', { bytes: 100 })
    const plan = planCachePrune(
      [active, removable],
      [evidence(removable, { uses: 100 })],
      { maxEntries: 1, maxTotalBytes: 100, maxIdleMs: 0 },
      new Set([active.manifest.cacheId]),
      NOW,
    )
    expect(plan.decisions).toEqual([{ cacheId: removable.manifest.cacheId, reason: 'entry-and-byte-limit' }])
    expect(plan.protected).toEqual([active.manifest.cacheId])
  })

  it('fails fast for invalid policies and clocks', () => {
    expect(() => planCachePrune([], [], { maxEntries: 0, maxTotalBytes: 1, maxIdleMs: 0 })).toThrow('maxEntries')
    expect(() => planCachePrune([], [], { maxEntries: 1, maxTotalBytes: 0, maxIdleMs: 0 })).toThrow('maxTotalBytes')
    expect(() => planCachePrune([], [], { maxEntries: 1, maxTotalBytes: 1, maxIdleMs: -1 })).toThrow('maxIdleMs')
    expect(() => planCachePrune([], [], { maxEntries: 1, maxTotalBytes: 1, maxIdleMs: 0 }, new Set(), -1)).toThrow('clock')
    expect(() => planCachePrune([], [{ source: '', name: 'bad', mounts: 0, uses: 0 }], { maxEntries: 1, maxTotalBytes: 1, maxIdleMs: 0 })).toThrow('evidence')
    expect(() => planCachePrune([], [{ source: 'owner/repo', name: 'bad', mounts: -1, uses: 0 }], { maxEntries: 1, maxTotalBytes: 1, maxIdleMs: 0 })).toThrow('evidence')
  })
})
