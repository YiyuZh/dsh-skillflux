import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteDiscoveryClient } from '../src/remote.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('remote discovery', () => {
  it('validates skills.sh results and pins each candidate to a GitHub commit', async () => {
    const sha = 'a'.repeat(40)
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.startsWith('https://skills.sh/')) {
        return new Response(JSON.stringify({
          skills: [
            { skillId: 'pdf', name: 'pdf', installs: 100, source: 'openai/skills' },
            { skillId: '../bad', name: 'bad', installs: 1, source: 'evil/repo' },
          ],
        }), { status: 200 })
      }
      expect(url).toContain('/repos/openai/skills/commits/HEAD')
      return new Response(JSON.stringify({ sha }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new RemoteDiscoveryClient(5, 1_000)
    const result = await client.search('pdf')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ source: 'openai/skills', skillId: 'pdf', ref: sha, installs: 100 })
    expect(result[0]?.id).toMatch(/^[0-9a-f]{24}$/u)
  })

  it('fails closed on a malformed marketplace response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"skills":{}}', { status: 200 })))
    await expect(new RemoteDiscoveryClient(5, 1_000).search('pdf')).rejects.toThrow('invalid response')
  })

  it('drops a candidate whose immutable HEAD cannot be resolved', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => String(input).includes('skills.sh')
      ? new Response(JSON.stringify({ skills: [{ skillId: 'pdf', name: 'pdf', installs: 10, source: 'openai/skills' }] }), { status: 200 })
      : new Response('{}', { status: 429 })))
    const result = await new RemoteDiscoveryClient(5, 1_000).search('pdf')
    expect(result).toEqual([])
  })
})
