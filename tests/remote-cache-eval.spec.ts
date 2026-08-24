import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { remoteDiscoveryCacheState, type RemoteDiscoveryCacheState } from '../src/remote-cache.js'

interface CachePolicyCase {
  readonly id: string
  readonly ageMs: number
  readonly ttlMs: number
  readonly staleIfErrorMs: number
  readonly expected: RemoteDiscoveryCacheState
}

function isCase(value: unknown): value is CachePolicyCase {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string'
    && typeof item.ageMs === 'number'
    && typeof item.ttlMs === 'number'
    && typeof item.staleIfErrorMs === 'number'
    && (item.expected === 'fresh' || item.expected === 'stale' || item.expected === 'expired')
}

describe('remote discovery cache policy corpus', () => {
  it('matches every versioned TTL and stale-if-error boundary', async () => {
    const parsed = JSON.parse(await readFile(new URL('../evals/remote-cache-cases.json', import.meta.url), 'utf8')) as unknown
    expect(Array.isArray(parsed)).toBe(true)
    const cases = (parsed as unknown[]).filter(isCase)
    expect(cases).toHaveLength((parsed as unknown[]).length)
    expect(new Set(cases.map(item => item.id)).size).toBe(cases.length)
    for (const item of cases) {
      expect(remoteDiscoveryCacheState(item.ageMs, item.ttlMs, item.staleIfErrorMs), item.id).toBe(item.expected)
    }
  })
})
