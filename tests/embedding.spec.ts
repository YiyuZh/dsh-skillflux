import { afterEach, describe, expect, it, vi } from 'vitest'
import { EmbeddingRouter, type EmbeddingRouterOptions } from '../src/embedding.js'
import { EmbeddingRouter as PublishedEmbeddingRouter } from '../lib/index.js'
import type { SkillFluxCandidate } from '../src/types.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function candidate(name: string, description: string): SkillFluxCandidate {
  return {
    id: name,
    origin: 'cache',
    name,
    description,
    source: 'test/repo',
    ref: 'a'.repeat(40),
    cacheId: name.padEnd(24, '0').slice(0, 24),
    score: 0,
  }
}

function options(overrides: Partial<EmbeddingRouterOptions> = {}): EmbeddingRouterOptions {
  return {
    provider: 'ollama',
    endpoint: 'http://127.0.0.1:11434/api/embed',
    model: 'embeddinggemma',
    apiKeyEnv: 'SKILLFLUX_EMBEDDING_TEST_KEY',
    timeoutMs: 1_000,
    candidateLimit: 16,
    cacheSize: 32,
    minSimilarity: 0.45,
    ...overrides,
  }
}

describe('EmbeddingRouter', () => {
  it('ranks semantic candidates and reuses cached query and document vectors', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { model: string; input: string[] }
      expect(request.model).toBe('embeddinggemma')
      return new Response(JSON.stringify({
        embeddings: request.input.map(text => text.includes('calendar') ? [0, 1] : [1, 0]),
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const router = new EmbeddingRouter(options())
    const candidates = [
      candidate('ocr-reader', 'Extract printed words from images'),
      candidate('calendar-agent', 'Manage calendar events'),
    ]
    await expect(router.rank('make a receipt searchable', candidates, 1)).resolves.toMatchObject([
      { name: 'ocr-reader', score: 100 },
    ])
    await router.rank('make a receipt searchable', candidates, 1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(router.stats()).toEqual({ requests: 1, cacheHits: 3, cacheMisses: 3, cacheEntries: 3 })
  })

  it('supports indexed OpenAI-compatible responses and optional bearer authentication', async () => {
    vi.stubEnv('SKILLFLUX_EMBEDDING_TEST_KEY', 'test-embedding-token')
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-embedding-token')
      const request = JSON.parse(String(init?.body)) as { input: string[] }
      return new Response(JSON.stringify({
        data: request.input.map((text, index) => ({
          index,
          embedding: text.includes('calendar') || text.includes('schedule') ? [0, 1] : [1, 0],
        })).reverse(),
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const router = new EmbeddingRouter(options({
      provider: 'openai-compatible',
      endpoint: 'https://embedding.example.test/v1/embeddings',
    }))
    await expect(router.rank('schedule a meeting', [
      candidate('ocr-reader', 'Extract printed words'),
      candidate('calendar-agent', 'Manage calendar events'),
    ], 1)).resolves.toMatchObject([{ name: 'calendar-agent' }])
  })

  it('rejects malformed and dimension-changing responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      embeddings: [[1, 0], [1, 0, 0]],
    }), { status: 200 })))
    const router = new EmbeddingRouter(options())
    await expect(router.rank('query', [candidate('ocr-reader', 'Read images')], 1))
      .rejects.toThrow('changed vector dimensions')
  })

  it('limits the semantic candidate pool before sending metadata', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { input: string[] }
      expect(request.input).toHaveLength(3)
      return new Response(JSON.stringify({ embeddings: request.input.map(() => [1, 0]) }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const router = new EmbeddingRouter(options({ candidateLimit: 2 }))
    const result = await router.rank('query', [
      candidate('first', 'First capability'),
      candidate('second', 'Second capability'),
      candidate('third', 'Third capability'),
    ], 3)
    expect(result.map(item => item.name)).toEqual(['first', 'second'])
  })

  it('propagates parent cancellation while the endpoint is pending', async () => {
    let started!: () => void
    const requestStarted = new Promise<void>(resolve => { started = resolve })
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      started()
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    }))
    const controller = new AbortController()
    const pending = new EmbeddingRouter(options()).rank(
      'query',
      [candidate('ocr-reader', 'Read images')],
      1,
      controller.signal,
    )
    await requestStarted
    controller.abort(new Error('embedding cancelled by test'))
    await expect(pending).rejects.toThrow('embedding cancelled by test')
  })

  it('ships the embedding router through the package entry', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { input: string[] }
      return new Response(JSON.stringify({ embeddings: request.input.map(() => [1, 0]) }), { status: 200 })
    }))
    const router = new PublishedEmbeddingRouter(options())
    await expect(router.rank('query', [candidate('published-router', 'Published capability')], 1))
      .resolves.toMatchObject([{ name: 'published-router' }])
  })
})
