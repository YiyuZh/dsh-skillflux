import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteDiscoveryClient } from '../src/remote.js'
import { remoteQualityEvidence } from '../src/remote-governance.js'
import {
  REGISTRY_MAX_ENTRIES,
  RegistryIndexClient,
  validateRegistryIndexEntry,
  type RegistryIndexTransport,
} from '../src/registry-source.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'refunds',
    description: 'Process customer refunds',
    source: 'acme/skills',
    ref: 'a'.repeat(40),
    tier: 'community',
    ...overrides,
  }
}

function transport(listing: { entries: readonly unknown[]; partial?: boolean }): RegistryIndexTransport {
  return { list: async () => ({ entries: listing.entries, partial: listing.partial ?? false }) }
}

describe('registry index entry validation', () => {
  it('accepts a minimal pinned entry and optional fields', () => {
    expect(validateRegistryIndexEntry(entry())).toMatchObject({
      name: 'refunds',
      source: 'acme/skills',
      ref: 'a'.repeat(40),
      tier: 'community',
    })
    expect(validateRegistryIndexEntry(entry({
      installs: 12,
      license: 'MIT',
      whenToUse: 'When processing refunds',
      tier: 'official',
    }))).toMatchObject({ installs: 12, license: 'MIT', tier: 'official' })
  })

  it('rejects unpinned, malformed, or unsafe entries', () => {
    expect(validateRegistryIndexEntry(entry({ ref: 'main' }))).toBeUndefined()
    expect(validateRegistryIndexEntry(entry({ ref: 'B'.repeat(40) }))).toBeUndefined()
    expect(validateRegistryIndexEntry(entry({ name: 'Bad Name' }))).toBeUndefined()
    expect(validateRegistryIndexEntry(entry({ source: 'not-a-repo' }))).toBeUndefined()
    expect(validateRegistryIndexEntry(entry({ tier: 'elite' }))).toBeUndefined()
    expect(validateRegistryIndexEntry(entry({ installs: -1 }))).toBeUndefined()
    expect(validateRegistryIndexEntry(entry({ description: '' }))).toBeUndefined()
    expect(validateRegistryIndexEntry(entry({ whenToUse: '  ' }))).toBeUndefined()
  })
})

describe('RegistryIndexClient', () => {
  it('bounds listings, drops invalid and duplicate entries, and reports partial', async () => {
    const over = Array.from({ length: REGISTRY_MAX_ENTRIES + 5 }, (_, index) =>
      entry({ name: `skill-${index}` }))
    const truncated = await new RegistryIndexClient(transport({ entries: over })).listEntries()
    expect(truncated.entries).toHaveLength(REGISTRY_MAX_ENTRIES)
    expect(truncated.partial).toBe(true)

    const mixed = await new RegistryIndexClient(transport({
      entries: [entry(), entry({ ref: 'main' }), entry()],
    })).listEntries()
    expect(mixed.entries).toHaveLength(1)
    expect(mixed.partial).toBe(true)
  })
})

describe('registry tier evidence', () => {
  const base = {
    relevanceScore: 100,
    installs: 0,
    stars: 0,
    forks: 0,
    recentActivityDays: 30,
    trustedSource: false,
    organizationOwned: false,
    hasLicense: false,
    now: Date.parse('2026-09-20T00:00:00Z'),
  }

  it('records tiers as advisory signals and warnings without granting trust', () => {
    const official = remoteQualityEvidence({ ...base, registryTier: 'official' })
    expect(official.signals).toContain('ecosystem-official')
    const verified = remoteQualityEvidence({ ...base, registryTier: 'verified' })
    expect(verified.signals).toContain('ecosystem-verified')
    const community = remoteQualityEvidence({ ...base, registryTier: 'community' })
    expect(community.signals).toContain('ecosystem-community')
    const unreviewed = remoteQualityEvidence({ ...base, registryTier: 'unreviewed' })
    expect(unreviewed.warnings).toContain('ecosystem-unreviewed')
    // A tier is evidence, never a trust grant: without pinned content or
    // other community evidence the level stays unverified.
    expect(official.trustLevel).toBe('unverified')
    expect(community.trustLevel).toBe('unverified')
    expect(official.breakdown.trust).toBeGreaterThan(community.breakdown.trust)
  })
})

describe('registry discovery pipeline', () => {
  it('resolves index seeds through the shared remote pipeline and honors the pinned ref', async () => {
    const responses: Record<string, Record<string, unknown>> = {
      'https://api.github.com/repos/acme/skills': {
        stargazers_count: 12,
        forks_count: 3,
        pushed_at: '2026-09-18T00:00:00Z',
        archived: false,
        disabled: false,
        private: false,
        owner: { type: 'User' },
        license: { spdx_id: 'MIT' },
      },
      'https://api.github.com/repos/acme/skills/commits/HEAD': { sha: 'b'.repeat(40) },
    }
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      const body = responses[url]
      if (body === undefined) return new Response('not found', { status: 404 })
      return new Response(JSON.stringify(body), { status: 200 })
    }))
    const client = new RemoteDiscoveryClient({
      searchLimit: 5,
      timeoutMs: 5_000,
      providers: ['registry-index'],
      registryDiscovery: 'automatic',
      registry: {
        listSeeds: async () => ({
          seeds: [validateRegistryIndexEntry(entry({ tier: 'official' }))!],
          partial: false,
        }),
      },
      now: () => Date.parse('2026-09-20T00:00:00Z'),
    })
    const observation = await client.searchWithStatus('process refunds')
    expect(observation.complete).toBe(true)
    expect(observation.candidates).toHaveLength(1)
    expect(observation.candidates[0]).toMatchObject({
      name: 'refunds',
      source: 'acme/skills',
      ref: 'a'.repeat(40),
      discoverySources: ['registry-index'],
    })
    expect(observation.candidates[0]?.qualitySignals).toContain('ecosystem-official')
  })

  it('treats a partial index listing as a degraded observation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })))
    const client = new RemoteDiscoveryClient({
      searchLimit: 5,
      timeoutMs: 5_000,
      providers: ['registry-index'],
      registryDiscovery: 'automatic',
      registry: { listSeeds: async () => ({ seeds: [], partial: true }) },
    })
    await expect(client.searchWithStatus('refunds')).rejects.toThrow('partial')
  })
})

