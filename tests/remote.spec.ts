import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteDiscoveryClient, remoteQualityScore } from '../src/remote.js'

const sha = 'a'.repeat(40)

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

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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
    })
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
