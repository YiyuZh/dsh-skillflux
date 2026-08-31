import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteDiscoveryClient, remoteQualityScore } from '../src/remote.js'
import { RemoteDiscoveryCache } from '../src/remote-cache.js'

const sha = 'a'.repeat(40)
const roots: string[] = []

function repository(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    private: false,
    stargazers_count: 250,
    forks_count: 20,
    pushed_at: '2026-08-20T00:00:00Z',
    archived: false,
    disabled: false,
    owner: { type: 'Organization' },
    license: { spdx_id: 'MIT' },
    ...overrides,
  }
}

function skillMarkdown(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nUse this skill.\n`
}

function graphqlRepository(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    isPrivate: false,
    stargazerCount: 250,
    forkCount: 20,
    pushedAt: '2026-08-20T00:00:00Z',
    isArchived: false,
    isDisabled: false,
    owner: { __typename: 'Organization' },
    licenseInfo: { spdxId: 'MIT' },
    defaultBranchRef: { target: { oid: sha } },
    ...overrides,
  }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })))
})

describe('remote discovery', () => {
  it('validates skills.sh results, enriches quality, and pins each candidate to a GitHub commit', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.startsWith('https://skills.sh/')) {
        return new Response(JSON.stringify({
          skills: [
            { skillId: 'pdf-ocr-extraction', name: 'PDF OCR extraction', installs: 100, source: 'openai/skills' },
            { skillId: 'pdf', name: 'PDF toolkit', installs: 90, source: 'openai/skills' },
            { skillId: '../bad', name: 'bad', installs: 1, source: 'evil/repo' },
          ],
        }), { status: 200 })
      }
      if (url.endsWith('/commits/HEAD')) return new Response(JSON.stringify({ sha }), { status: 200 })
      expect(url).toBe('https://api.github.com/repos/openai/skills')
      return new Response(JSON.stringify(repository()), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new RemoteDiscoveryClient({
      searchLimit: 5,
      timeoutMs: 1_000,
      providers: ['skills.sh'],
      now: () => Date.parse('2026-08-24T00:00:00Z'),
    })
    const result = await client.search('pdf')
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      name: 'pdf',
      source: 'openai/skills',
      skillId: 'pdf',
      ref: sha,
      installs: 90,
      discoverySources: ['skills.sh'],
      stars: 250,
      recentlyActive: true,
      license: 'MIT',
      selection: 'remote-quality',
      trustLevel: 'community',
      qualityWarnings: expect.arrayContaining(['single-source', 'content-not-previewed']),
    })
    expect(result[0]?.qualityScore).toBeGreaterThan(0)
    expect(result[0]?.description).toContain('PDF toolkit')
    expect(result[0]?.id).toMatch(/^[0-9a-f]{24}$/u)
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/commits/HEAD'))).toHaveLength(1)
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === 'https://api.github.com/repos/openai/skills')).toHaveLength(1)
  })

  it('searches public SKILL.md files through GitHub when a token is available', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.startsWith('https://api.github.com/search/code')) {
        return new Response(JSON.stringify({
          items: [
            { path: 'skills/pdf-reader/SKILL.md', repository: { full_name: 'acme/agent-skills', private: false } },
            { path: 'skills/private/SKILL.md', repository: { full_name: 'acme/private-skills', private: true } },
          ],
        }), { status: 200 })
      }
      if (url === 'https://api.github.com/graphql') {
        return new Response(JSON.stringify({ data: { r0: graphqlRepository({ stargazerCount: 900 }) } }), { status: 200 })
      }
      expect(url).toBe(`https://raw.githubusercontent.com/acme/agent-skills/${sha}/skills/pdf-reader/SKILL.md`)
      return new Response(skillMarkdown('pdf-reader', 'Read and analyze PDF documents with OCR.'), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await new RemoteDiscoveryClient({
      searchLimit: 5,
      timeoutMs: 1_000,
      providers: ['github'],
      githubToken: 'test-token',
      now: () => Date.parse('2026-08-24T00:00:00Z'),
    }).search('analyze pdf')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      name: 'pdf-reader',
      description: 'Read and analyze PDF documents with OCR.',
      source: 'acme/agent-skills',
      path: 'skills/pdf-reader/SKILL.md',
      discoverySources: ['github'],
      stars: 900,
      installs: 0,
      trustLevel: 'community',
      qualitySignals: expect.arrayContaining(['content-pinned']),
    })
  })

  it('merges marketplace adoption with GitHub skill-level metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.startsWith('https://skills.sh/')) {
        return new Response(JSON.stringify({
          skills: [{ skillId: 'pdf-reader', name: 'PDF reader', installs: 4_200, source: 'acme/agent-skills' }],
        }), { status: 200 })
      }
      if (url.startsWith('https://api.github.com/search/code')) {
        return new Response(JSON.stringify({
          items: [{ path: 'skills/pdf-reader/SKILL.md', repository: { full_name: 'acme/agent-skills', private: false } }],
        }), { status: 200 })
      }
      if (url === 'https://api.github.com/graphql') {
        return new Response(JSON.stringify({ data: { r0: graphqlRepository() } }), { status: 200 })
      }
      return new Response(skillMarkdown('pdf-reader', 'Analyze PDF files and extract tables.'), { status: 200 })
    }))
    const result = await new RemoteDiscoveryClient({
      searchLimit: 5,
      timeoutMs: 1_000,
      githubToken: 'test-token',
      now: () => Date.parse('2026-08-24T00:00:00Z'),
    }).search('analyze pdf')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      installs: 4_200,
      description: 'Analyze PDF files and extract tables.',
      discoverySources: ['skills.sh', 'github'],
      trustLevel: 'corroborated',
      qualitySignals: expect.arrayContaining(['cross-source', 'content-pinned']),
    })
  })

  it('rejects same-name Skills found at multiple paths even when SKILL.md bytes match', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.startsWith('https://api.github.com/search/code')) {
        return new Response(JSON.stringify({
          items: [
            { path: 'skills/a/SKILL.md', repository: { full_name: 'acme/agent-skills', private: false } },
            { path: 'skills/b/SKILL.md', repository: { full_name: 'acme/agent-skills', private: false } },
          ],
        }), { status: 200 })
      }
      if (url === 'https://api.github.com/graphql') {
        return new Response(JSON.stringify({ data: { r0: graphqlRepository() } }), { status: 200 })
      }
      return new Response(skillMarkdown('pdf-reader', 'Read PDF documents with OCR.'), { status: 200 })
    }))
    const result = await new RemoteDiscoveryClient({
      searchLimit: 5,
      timeoutMs: 1_000,
      providers: ['github'],
      githubToken: 'test-token',
      now: () => Date.parse('2026-08-24T00:00:00Z'),
    }).search('pdf reader')
    expect(result).toEqual([])
  })

  it('enforces trusted and blocked owner governance independently of stars', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.startsWith('https://skills.sh/')) {
        return new Response(JSON.stringify({
          skills: [
            { skillId: 'pdf-trusted', name: 'PDF trusted', installs: 1, source: 'trusted/repo' },
            { skillId: 'pdf-popular', name: 'PDF popular', installs: 100_000, source: 'popular/repo' },
            { skillId: 'pdf-blocked', name: 'PDF blocked', installs: 1_000_000, source: 'blocked/repo' },
          ],
        }), { status: 200 })
      }
      if (url.endsWith('/commits/HEAD')) return new Response(JSON.stringify({ sha }), { status: 200 })
      const stars = url.includes('/blocked/') ? 1_000_000 : url.includes('/popular/') ? 100_000 : 0
      return new Response(JSON.stringify(repository({ stargazers_count: stars })), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await new RemoteDiscoveryClient({
      searchLimit: 5,
      timeoutMs: 1_000,
      providers: ['skills.sh'],
      trustPolicy: 'trusted',
      trustedOwners: ['trusted'],
      blockedOwners: ['blocked'],
      now: () => Date.parse('2026-08-24T00:00:00Z'),
    }).search('pdf')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ source: 'trusted/repo', trustLevel: 'trusted', trustedSource: true })
    expect(fetchMock.mock.calls.map(([input]) => String(input)).some(url => url.includes('/blocked/repo'))).toBe(false)
  })

  it('filters archived repositories and configurable low-value results', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.startsWith('https://skills.sh/')) {
        return new Response(JSON.stringify({
          skills: [
            { skillId: 'pdf', name: 'PDF toolkit', installs: 1, source: 'small/repo' },
            { skillId: 'pdf-reader', name: 'PDF reader', installs: 1_000, source: 'archived/repo' },
          ],
        }), { status: 200 })
      }
      if (url.endsWith('/commits/HEAD')) return new Response(JSON.stringify({ sha }), { status: 200 })
      if (url.includes('/repos/archived/repo')) {
        return new Response(JSON.stringify(repository({ stargazers_count: 5_000, archived: true })), { status: 200 })
      }
      return new Response(JSON.stringify(repository({ stargazers_count: 5 })), { status: 200 })
    }))
    const result = await new RemoteDiscoveryClient({
      searchLimit: 5,
      timeoutMs: 1_000,
      providers: ['skills.sh'],
      minStars: 10,
    }).search('pdf')
    expect(result).toEqual([])
  })

  it('fails closed on a malformed marketplace response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"skills":{}}', { status: 200 })))
    await expect(new RemoteDiscoveryClient({
      searchLimit: 5,
      timeoutMs: 1_000,
      providers: ['skills.sh'],
    }).search('pdf')).rejects.toThrow('invalid response')
  })

  it('drops a candidate whose immutable HEAD cannot be resolved', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('skills.sh')) {
        return new Response(JSON.stringify({ skills: [{ skillId: 'pdf', name: 'pdf', installs: 10, source: 'openai/skills' }] }), { status: 200 })
      }
      if (url.endsWith('/commits/HEAD')) return new Response('{}', { status: 429 })
      return new Response(JSON.stringify(repository()), { status: 200 })
    }))
    const result = await new RemoteDiscoveryClient({
      searchLimit: 5,
      timeoutMs: 1_000,
      providers: ['skills.sh'],
    }).search('pdf')
    expect(result).toEqual([])
  })

  it('propagates cancellation during immutable HEAD resolution', async () => {
    let headStarted!: () => void
    const started = new Promise<void>(resolve => { headStarted = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('skills.sh')) {
        return new Response(JSON.stringify({
          skills: [{ skillId: 'pdf', name: 'PDF', installs: 10, source: 'openai/skills' }],
        }), { status: 200 })
      }
      if (!url.endsWith('/commits/HEAD')) return new Response(JSON.stringify(repository()), { status: 200 })
      headStarted()
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    }))
    const controller = new AbortController()
    const pending = new RemoteDiscoveryClient({
      searchLimit: 5,
      timeoutMs: 5_000,
      providers: ['skills.sh'],
    }).search('pdf', controller.signal)
    await started
    controller.abort(new Error('cancelled by test'))
    await expect(pending).rejects.toThrow('cancelled by test')
  })

  it('reuses fresh discovery results and falls back to stale pinned candidates only on provider failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillflux-remote-integration-'))
    roots.push(root)
    let now = Date.parse('2026-08-24T00:00:00Z')
    const cache = new RemoteDiscoveryCache({
      file: join(root, 'remote-discovery.json'),
      ttlMs: 100,
      staleIfErrorMs: 1_000,
      maxEntries: 10,
      now: () => now,
    })
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.startsWith('https://skills.sh/')) {
        return new Response(JSON.stringify({
          skills: [{ skillId: 'pdf-reader', name: 'PDF reader', installs: 500, source: 'acme/agent-skills' }],
        }), { status: 200 })
      }
      if (url.endsWith('/commits/HEAD')) return new Response(JSON.stringify({ sha }), { status: 200 })
      return new Response(JSON.stringify(repository()), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new RemoteDiscoveryClient({
      searchLimit: 5,
      timeoutMs: 1_000,
      providers: ['skills.sh'],
      cache,
      now: () => now,
    })
    const live = await client.search('read pdf')
    const callsAfterLiveSearch = fetchMock.mock.calls.length
    expect(live).toHaveLength(1)
    expect(await client.search('read pdf')).toEqual(live)
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterLiveSearch)

    now += 101
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => String(input).startsWith('https://skills.sh/')
      ? new Response(JSON.stringify({
          skills: [{ skillId: 'pdf-reader', name: 'PDF reader', installs: 500, source: 'acme/agent-skills' }],
        }), { status: 200 })
      : new Response('{}', { status: 503 })))
    expect(await client.search('read pdf')).toEqual(live)
    expect(await client.discoveryCacheStats()).toMatchObject({
      entries: 1,
      hits: 1,
      misses: 2,
      staleHits: 1,
      writes: 1,
    })

    let searchStarted!: () => void
    const started = new Promise<void>(resolve => { searchStarted = resolve })
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL, init?: RequestInit) => {
      searchStarted()
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    }))
    const controller = new AbortController()
    const cancelled = client.search('read pdf', controller.signal)
    await started
    controller.abort(new Error('cancelled with stale cache available'))
    await expect(cancelled).rejects.toThrow('cancelled with stale cache available')
  })

  it('does not reuse cached results across ranking configurations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillflux-remote-config-cache-'))
    roots.push(root)
    const cache = new RemoteDiscoveryCache({
      file: join(root, 'remote-discovery.json'),
      ttlMs: 10_000,
      staleIfErrorMs: 10_000,
      maxEntries: 10,
    })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.startsWith('https://skills.sh/')) {
        return new Response(JSON.stringify({
          skills: [{ skillId: 'pdf-reader', name: 'PDF reader', installs: 500, source: 'acme/agent-skills' }],
        }), { status: 200 })
      }
      if (url.endsWith('/commits/HEAD')) return new Response(JSON.stringify({ sha }), { status: 200 })
      return new Response(JSON.stringify(repository()), { status: 200 })
    }))
    await new RemoteDiscoveryClient({
      searchLimit: 5,
      timeoutMs: 1_000,
      providers: ['skills.sh'],
      minStars: 0,
      cache,
    }).search('read pdf')

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('must query the stricter configuration') }))
    const stricter = new RemoteDiscoveryClient({
      searchLimit: 5,
      timeoutMs: 1_000,
      providers: ['skills.sh'],
      minStars: 1_000,
      cache,
    })
    await expect(stricter.search('read pdf')).rejects.toThrow('must query the stricter configuration')
  })

  it('short-term caches useful cold-start results when one provider is degraded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillflux-remote-partial-cache-'))
    roots.push(root)
    const cache = new RemoteDiscoveryCache({
      file: join(root, 'remote-discovery.json'),
      ttlMs: 10_000,
      staleIfErrorMs: 10_000,
      maxEntries: 10,
    })
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.startsWith('https://skills.sh/')) {
        return new Response(JSON.stringify({
          skills: [{ skillId: 'pdf-reader', name: 'PDF reader', installs: 500, source: 'acme/agent-skills' }],
        }), { status: 200 })
      }
      if (url.startsWith('https://api.github.com/search/code')) return new Response('{}', { status: 503 })
      expect(url).toBe('https://api.github.com/graphql')
      return new Response(JSON.stringify({ data: { r0: graphqlRepository() } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new RemoteDiscoveryClient({
      searchLimit: 5,
      timeoutMs: 1_000,
      githubToken: 'test-token',
      cache,
    })
    const partial = await client.search('read pdf')
    const calls = fetchMock.mock.calls.length
    expect(partial).toHaveLength(1)
    expect(await client.search('read pdf')).toEqual(partial)
    expect(fetchMock).toHaveBeenCalledTimes(calls)
    expect(await client.discoveryCacheStats()).toMatchObject({ hits: 1, writes: 1 })
  })

  it('rewards activity inside the configured 30-day window without making it mandatory', () => {
    const common = {
      relevanceScore: 20,
      installs: 100,
      stars: 100,
      forks: 10,
      recentActivityDays: 30,
      trustedSource: false,
      organizationOwned: false,
      hasLicense: true,
      now: Date.parse('2026-08-24T00:00:00Z'),
    }
    const recent = remoteQualityScore({ ...common, pushedAt: '2026-08-10T00:00:00Z' })
    const maintained = remoteQualityScore({ ...common, pushedAt: '2026-05-30T00:00:00Z' })
    const stale = remoteQualityScore({ ...common, pushedAt: '2024-01-01T00:00:00Z' })
    expect(recent).toBeGreaterThan(maintained)
    expect(maintained).toBeGreaterThan(stale)
  })
})
