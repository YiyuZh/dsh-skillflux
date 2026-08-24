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
            { skillId: 'pdf-ocr-extraction', name: 'PDF OCR extraction', installs: 100, source: 'openai/skills' },
            { skillId: 'pdf', name: 'PDF toolkit', installs: 90, source: 'openai/skills' },
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
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      name: 'pdf-ocr-extraction', source: 'openai/skills', skillId: 'pdf-ocr-extraction', ref: sha, installs: 100,
    })
    expect(result[0]?.description).toContain('PDF OCR extraction')
    expect(result[0]?.id).toMatch(/^[0-9a-f]{24}$/u)
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('api.github.com'))).toHaveLength(1)
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

  it('propagates cancellation during immutable HEAD resolution', async () => {
    let headStarted!: () => void
    const started = new Promise<void>(resolve => { headStarted = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes('skills.sh')) {
        return new Response(JSON.stringify({
          skills: [{ skillId: 'pdf', name: 'PDF', installs: 10, source: 'openai/skills' }],
        }), { status: 200 })
      }
      headStarted()
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    }))
    const controller = new AbortController()
    const pending = new RemoteDiscoveryClient(5, 5_000).search('pdf', controller.signal)
    await started
    controller.abort(new Error('cancelled by test'))
    await expect(pending).rejects.toThrow('cancelled by test')
  })
})
