import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planCachePrune, type CacheUsageEvidence } from '../src/cache-governance.js'
import { UsageStore } from '../src/usage.js'
import type { CacheEntry } from '../src/types.js'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function cacheEntry(id: string, source = 'acme/skills', name = 'refunds'): CacheEntry {
  return {
    directory: `/cache/${id}`,
    manifest: {
      version: 1,
      cacheId: id,
      source,
      ref: 'a'.repeat(40),
      skillId: name,
      name,
      description: 'Process refunds',
      installedAt: '2026-09-20T00:00:00.000Z',
      fileCount: 1,
      totalBytes: 1_000,
      contentHash: 'b'.repeat(64),
    },
  }
}

function evidence(id: string, overrides: Partial<CacheUsageEvidence> = {}): CacheUsageEvidence {
  return {
    source: 'acme/skills',
    name: 'refunds',
    cacheId: id,
    mounts: 1,
    uses: 1,
    lastUsedAt: 1_000,
    ...overrides,
  }
}

describe('token-aware cache governance', () => {
  it('evicts the higher token-cost version first among otherwise equal entries', () => {
    const low = cacheEntry('1'.repeat(24))
    const high = cacheEntry('2'.repeat(24))
    const plan = planCachePrune(
      [low, high],
      [
        evidence(low.manifest.cacheId, { totalLoadedBodyTokens: 10 }),
        evidence(high.manifest.cacheId, { totalLoadedBodyTokens: 500 }),
      ],
      { maxEntries: 1, maxTotalBytes: 10_000, maxIdleMs: 0 },
    )
    expect(plan.decisions.map(decision => decision.cacheId)).toEqual([high.manifest.cacheId])
    expect(plan.afterEntries).toBe(1)
  })

  it('keeps the historical ordering when no token evidence exists', () => {
    const low = cacheEntry('1'.repeat(24))
    const high = cacheEntry('2'.repeat(24))
    const plan = planCachePrune(
      [low, high],
      [evidence(low.manifest.cacheId), evidence(high.manifest.cacheId)],
      { maxEntries: 1, maxTotalBytes: 10_000, maxIdleMs: 0 },
    )
    expect(plan.decisions.map(decision => decision.cacheId)).toEqual([low.manifest.cacheId])
  })

  it('is deterministic across repeated plans', () => {
    const entries = [cacheEntry('1'.repeat(24)), cacheEntry('2'.repeat(24)), cacheEntry('3'.repeat(24))]
    const evidenceItems = [
      evidence('1'.repeat(24), { totalLoadedBodyTokens: 100 }),
      evidence('2'.repeat(24), { totalLoadedBodyTokens: 300 }),
      evidence('3'.repeat(24), { totalLoadedBodyTokens: 200 }),
    ]
    const policy = { maxEntries: 1, maxTotalBytes: 10_000, maxIdleMs: 0 }
    const first = planCachePrune(entries, evidenceItems, policy)
    const second = planCachePrune(entries, evidenceItems, policy)
    expect(first.decisions).toEqual(second.decisions)
    expect(first.decisions.map(decision => decision.cacheId)).toEqual([
      '2'.repeat(24),
      '3'.repeat(24),
    ])
  })

  it('exposes token evidence from persisted usage records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillflux-token-governance-'))
    roots.push(root)
    const store = new UsageStore({
      file: join(root, 'usage.json'),
      maxEntries: 100,
      now: () => 1_000,
    })
    const identity = {
      candidateId: '1'.repeat(24),
      name: 'refunds',
      origin: 'cache' as const,
      source: 'acme/skills',
      cacheId: '1'.repeat(24),
    }
    await store.recordMount(identity)
    await store.recordTelemetry(identity, {
      loadedBodyTokens: 7,
      catalogFootprintTokens: 20,
      estimator: 'portable',
    })
    await store.recordTelemetry(identity, { loadedBodyTokens: 5 })
    expect(await store.cacheEvidence()).toMatchObject([{
      cacheId: '1'.repeat(24),
      totalLoadedBodyTokens: 12,
    }])
  })
})

