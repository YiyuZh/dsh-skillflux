import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { UsageStore } from '../src/usage.js'
import type { SkillFluxCandidate, SkillUsageIdentity, SkillUsageRecord } from '../src/types.js'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'skillflux-usage-'))
  roots.push(root)
  return { root, file: join(root, 'nested', 'usage.json') }
}

function identity(candidateId: string): SkillUsageIdentity {
  return { candidateId, name: candidateId, origin: 'registry', source: 'runtime' }
}

function candidate(candidateId: string): SkillFluxCandidate {
  return {
    id: candidateId,
    origin: 'cache',
    name: candidateId,
    description: 'PDF analysis',
    source: 'example/repository',
    ref: 'a'.repeat(40),
    cacheId: candidateId.padEnd(24, '0').slice(0, 24),
    score: 0,
  }
}

describe('UsageStore', () => {
  it('serializes concurrent updates and reloads persisted counters', async () => {
    const { file } = await fixture()
    let now = 1_000
    const store = new UsageStore({ file, maxEntries: 100, now: () => now++ })
    await Promise.all([
      ...Array.from({ length: 5 }, async () => await store.recordMount(identity('pdf-reader'))),
      ...Array.from({ length: 3 }, async () => await store.recordUse(identity('pdf-reader'))),
    ])

    const reloaded = new UsageStore({ file, maxEntries: 100 })
    expect(await reloaded.list()).toMatchObject([{
      candidateId: 'pdf-reader',
      mounts: 5,
      uses: 3,
    }])
    const raw = await readFile(file, 'utf8')
    expect(raw).not.toContain('task')
    expect(raw).not.toContain('content')
  })

  it('merges updates from multiple stores sharing one DSH usage file', async () => {
    const { file } = await fixture()
    const first = new UsageStore({ file, maxEntries: 100, now: () => 1_000 })
    const second = new UsageStore({ file, maxEntries: 100, now: () => 2_000 })
    await Promise.all([
      first.recordMount(identity('shared-skill')),
      second.recordMount(identity('shared-skill')),
      first.recordUse(identity('first-only')),
      second.recordUse(identity('second-only')),
    ])
    const records = await new UsageStore({ file, maxEntries: 100 }).list()
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: 'shared-skill', mounts: 2 }),
      expect.objectContaining({ candidateId: 'first-only', uses: 1 }),
      expect.objectContaining({ candidateId: 'second-only', uses: 1 }),
    ]))
    expect(records).toHaveLength(3)
  })

  it('evicts the least recently useful records at the configured bound', async () => {
    const { file } = await fixture()
    let now = 100
    const store = new UsageStore({ file, maxEntries: 2, now: () => now++ })
    await store.recordMount(identity('old'))
    await store.recordMount(identity('used'))
    await store.recordUse(identity('used'))
    await store.recordMount(identity('new'))
    expect((await store.list()).map(record => record.candidateId)).toEqual(['used', 'new'])
  })

  it('requires successful uses and decays adaptive boosts over time', async () => {
    const { file } = await fixture()
    const day = 24 * 60 * 60 * 1_000
    let now = 10 * day
    const store = new UsageStore({ file, maxEntries: 10, now: () => now })
    await store.recordUse(identity('experienced'))
    await store.recordUse(identity('experienced'))
    await store.recordUse(identity('newcomer'))
    const options = { maxBoost: 10, minUses: 2, halfLifeDays: 30 }
    const candidates = [candidate('experienced'), candidate('newcomer')]
    const fresh = await store.boosts(candidates, options)
    expect(fresh.get('experienced')).toBeGreaterThan(0)
    expect(fresh.has('newcomer')).toBe(false)

    now += 30 * day
    const aged = await store.boosts(candidates, options)
    expect(aged.get('experienced')).toBeLessThan(fresh.get('experienced')!)
    expect(aged.get('experienced')).toBeGreaterThan(0)
  })

  it('exposes privacy-preserving cache governance evidence', async () => {
    const { file } = await fixture()
    const store = new UsageStore({ file, maxEntries: 10, now: () => 123 })
    const cacheId = 'a'.repeat(24)
    await store.recordMount({ candidateId: 'remote-id', name: 'pdf-reader', origin: 'remote', source: 'owner/repo', cacheId })
    await store.recordUse({ candidateId: 'cache-id', name: 'pdf-reader', origin: 'cache', source: 'owner/repo', cacheId })
    const evidence = await store.cacheEvidence()
    expect(evidence).toEqual(expect.arrayContaining([
      { source: 'owner/repo', name: 'pdf-reader', cacheId, mounts: 1, uses: 0, lastMountedAt: 123 },
      { source: 'owner/repo', name: 'pdf-reader', cacheId, mounts: 0, uses: 1, lastUsedAt: 123 },
    ]))
    expect(evidence).toHaveLength(2)
  })

  it('upgrades a legacy candidate record to immutable cache identity on its next mount', async () => {
    const { file } = await fixture()
    const legacy = new UsageStore({ file, maxEntries: 10, now: () => 100 })
    await legacy.recordMount({ candidateId: 'remote-version', name: 'versioned', origin: 'remote', source: 'owner/repo' })
    const upgraded = new UsageStore({ file, maxEntries: 10, now: () => 200 })
    const cacheId = 'b'.repeat(24)
    await upgraded.recordMount({
      candidateId: 'remote-version', name: 'versioned', origin: 'remote', source: 'owner/repo', cacheId,
    })
    expect(await upgraded.cacheEvidence()).toEqual([{
      source: 'owner/repo', name: 'versioned', cacheId, mounts: 2, uses: 0, lastMountedAt: 200,
    }])
  })

  it('fails closed to empty data for corrupt and oversized files', async () => {
    const { root } = await fixture()
    const warnings: string[] = []
    await writeFile(join(root, 'corrupt.json'), '{nope', 'utf8')
    const corrupt = new UsageStore({
      file: join(root, 'corrupt.json'),
      maxEntries: 10,
      warn: message => { warnings.push(message) },
    })
    expect(await corrupt.list()).toEqual([])

    const oversizedFile = join(root, 'oversized.json')
    await writeFile(oversizedFile, 'x'.repeat(2 * 1024 * 1024 + 1), 'utf8')
    const oversized = new UsageStore({
      file: oversizedFile,
      maxEntries: 10,
      warn: message => { warnings.push(message) },
    })
    expect(await oversized.list()).toEqual([])
    expect(warnings).toHaveLength(2)
  })

  it('rejects invalid capacity configuration', async () => {
    const target = await fixture()
    expect(() => new UsageStore({ file: target.file, maxEntries: 0 })).toThrow('maxEntries')
    expect(() => new UsageStore({ file: target.file, maxEntries: 5_001 })).toThrow('maxEntries')
  })

  it('rejects adaptive parameters outside service configuration bounds', async () => {
    const { file } = await fixture()
    const store = new UsageStore({ file, maxEntries: 10 })
    await expect(store.boosts([], { maxBoost: 21, minUses: 2, halfLifeDays: 30 })).rejects.toThrow('maxBoost')
    await expect(store.boosts([], { maxBoost: 6, minUses: 0, halfLifeDays: 30 })).rejects.toThrow('minUses')
    await expect(store.boosts([], { maxBoost: 6, minUses: 2, halfLifeDays: 0 })).rejects.toThrow('halfLifeDays')
  })

  it('keeps serialized output within the hard file-size limit', async () => {
    const { file } = await fixture()
    const store = new UsageStore({ file, maxEntries: 2_000 })
    const records = new Map<string, SkillUsageRecord>()
    for (let index = 0; index < 1_100; index += 1) {
      const candidateId = `candidate-${index}`
      records.set(candidateId, {
        candidateId,
        name: `skill-${index}`,
        origin: 'remote',
        source: `${'s'.repeat(2_000)}-${index}`,
        mounts: 1,
        uses: index,
        lastMountedAt: index,
        lastUsedAt: index,
      })
    }
    const serializer = store as unknown as {
      serializeWithinLimit(items: Map<string, SkillUsageRecord>): string
    }
    const serialized = serializer.serializeWithinLimit(records)
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(records.size).toBeLessThan(1_100)
    expect(JSON.parse(serialized)).toMatchObject({ version: 1 })
  })
})
