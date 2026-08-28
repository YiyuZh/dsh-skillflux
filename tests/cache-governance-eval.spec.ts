import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { planCachePrune, type CachePruneDecision, type CachePrunePolicy, type CacheUsageEvidence } from '../src/cache-governance.js'
import type { CacheEntry } from '../src/types.js'

interface CacheGovernanceEntry {
  readonly cacheId: string
  readonly source: string
  readonly name: string
  readonly installedAt: string
  readonly totalBytes: number
  readonly qualityScore?: number
  readonly installs?: number
}

interface CacheGovernanceCase {
  readonly id: string
  readonly now: number
  readonly policy: CachePrunePolicy
  readonly entries: readonly CacheGovernanceEntry[]
  readonly evidence: readonly CacheUsageEvidence[]
  readonly active: readonly string[]
  readonly expected: readonly CachePruneDecision[]
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isCase(value: unknown): value is CacheGovernanceCase {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string'
    && isNonNegativeInteger(item.now)
    && typeof item.policy === 'object' && item.policy !== null
    && Array.isArray(item.entries)
    && Array.isArray(item.evidence)
    && Array.isArray(item.active)
    && Array.isArray(item.expected)
}

function cacheEntry(item: CacheGovernanceEntry): CacheEntry {
  return {
    directory: `/cache/${item.cacheId}`,
    manifest: {
      version: 1,
      cacheId: item.cacheId,
      source: item.source,
      ref: 'a'.repeat(40),
      skillId: item.name,
      name: item.name,
      description: item.name,
      ...(item.qualityScore === undefined ? {} : { qualityScore: item.qualityScore }),
      ...(item.installs === undefined ? {} : { installs: item.installs }),
      installedAt: item.installedAt,
      fileCount: 1,
      totalBytes: item.totalBytes,
      contentHash: 'f'.repeat(64),
    },
  }
}

describe('installed cache governance policy corpus', () => {
  it('matches every value, age, capacity, byte, and active-lease case', async () => {
    const parsed = JSON.parse(await readFile(new URL('../evals/cache-governance-cases.json', import.meta.url), 'utf8')) as unknown
    expect(Array.isArray(parsed)).toBe(true)
    const cases = (parsed as unknown[]).filter(isCase)
    expect(cases).toHaveLength((parsed as unknown[]).length)
    expect(new Set(cases.map(item => item.id)).size).toBe(cases.length)
    for (const item of cases) {
      const plan = planCachePrune(
        item.entries.map(cacheEntry),
        item.evidence,
        item.policy,
        new Set(item.active),
        item.now,
      )
      expect(plan.decisions, item.id).toEqual(item.expected)
    }
  })
})
