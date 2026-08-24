import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteDiscoveryCache } from '../src/remote-cache.js'
import { candidateId } from '../src/router.js'
import type { RemoteCandidate } from '../src/types.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })))
})

async function cacheFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skillflux-remote-cache-'))
  roots.push(root)
  return join(root, 'nested', 'remote-discovery.json')
}

function candidate(name = 'pdf-reader'): RemoteCandidate {
  const source = 'acme/agent-skills'
  const ref = 'b'.repeat(40)
  return {
    id: candidateId('remote', source, ref, name),
    origin: 'remote',
    name,
    description: 'Read and analyze PDF documents.',
    source,
    ref,
    score: 80,
    selection: 'remote-quality',
    baseScore: 30,
    adaptiveBoost: 0,
    skillId: name,
    installs: 500,
    discoverySources: ['skills.sh', 'github'],
    qualityScore: 80,
    relevanceScore: 30,
    stars: 900,
    forks: 40,
    pushedAt: '2026-08-20T00:00:00Z',
    license: 'MIT',
    recentlyActive: true,
    trustedSource: false,
    path: `skills/${name}/SKILL.md`,
    skillFileHash: 'c'.repeat(64),
  }
}

describe('remote discovery cache', () => {
  it('persists only a query fingerprint and validated candidate metadata', async () => {
    const file = await cacheFile()
    const key = 'd'.repeat(64)
    const cache = new RemoteDiscoveryCache({ file, ttlMs: 1_000, staleIfErrorMs: 5_000, maxEntries: 10 })
    await cache.put(key, [candidate()])
    await cache.flush()

    const raw = await readFile(file, 'utf8')
    expect(raw).toContain(key)
    expect(raw).not.toContain('analyze my confidential PDF')

    const reopened = new RemoteDiscoveryCache({ file, ttlMs: 1_000, staleIfErrorMs: 5_000, maxEntries: 10 })
    expect(await reopened.get(key)).toMatchObject({ state: 'fresh', candidates: [{ name: 'pdf-reader' }] })
    expect(await reopened.stats()).toMatchObject({ entries: 1, hits: 1, misses: 0 })
  })

  it('separates fresh, stale-if-error, and expired windows', async () => {
    const file = await cacheFile()
    let now = 1_000
    const cache = new RemoteDiscoveryCache({
      file,
      ttlMs: 100,
      staleIfErrorMs: 400,
      maxEntries: 10,
      now: () => now,
    })
    const key = 'e'.repeat(64)
    await cache.put(key, [candidate()])
    now = 1_100
    expect((await cache.get(key))?.state).toBe('fresh')
    now = 1_101
    expect((await cache.get(key))?.state).toBe('stale')
    cache.recordStaleHit()
    now = 1_501
    expect(await cache.get(key)).toBeUndefined()
    expect(await cache.stats()).toMatchObject({ hits: 1, misses: 2, staleHits: 1, entries: 0 })
  })

  it('evicts the oldest entry, clears persisted state, and can be disabled', async () => {
    const file = await cacheFile()
    let now = 10
    const cache = new RemoteDiscoveryCache({ file, ttlMs: 1_000, staleIfErrorMs: 0, maxEntries: 2, now: () => now })
    await cache.put('1'.repeat(64), [candidate('first-skill')])
    now += 1
    await cache.put('2'.repeat(64), [candidate('second-skill')])
    now += 1
    await cache.put('3'.repeat(64), [candidate('third-skill')])
    expect(await cache.get('1'.repeat(64))).toBeUndefined()
    expect((await cache.stats()).entries).toBe(2)
    expect(await cache.clear()).toBe(2)
    expect((await cache.stats()).entries).toBe(0)

    const disabled = new RemoteDiscoveryCache({ file, ttlMs: 0, staleIfErrorMs: 0, maxEntries: 2 })
    await disabled.put('4'.repeat(64), [candidate()])
    expect(await disabled.get('4'.repeat(64))).toBeUndefined()
    expect(await disabled.stats()).toMatchObject({ enabled: false, entries: 0 })
  })

  it('fails open when persisted data is corrupt', async () => {
    const file = await cacheFile()
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, '{"version":1,"entries":"bad"}', 'utf8')
    const warn = vi.fn()
    const cache = new RemoteDiscoveryCache({ file, ttlMs: 1_000, staleIfErrorMs: 5_000, maxEntries: 10, warn })
    expect(await cache.get('f'.repeat(64))).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed validation'))
  })

  it('refuses candidate metadata whose opaque identity no longer matches its pinned source', async () => {
    const file = await cacheFile()
    const warn = vi.fn()
    const cache = new RemoteDiscoveryCache({ file, ttlMs: 1_000, staleIfErrorMs: 5_000, maxEntries: 10, warn })
    const tampered = { ...candidate(), source: 'attacker/other-repository' }
    await cache.put('9'.repeat(64), [tampered])
    expect(await cache.stats()).toMatchObject({ entries: 0, writes: 0 })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped invalid'))
  })
})
