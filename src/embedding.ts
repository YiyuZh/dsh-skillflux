import { createHash } from 'node:crypto'
import type {
  EmbeddingProvider,
  EmbeddingRouterStats,
  SkillFluxCandidate,
} from './types.js'

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const MAX_VECTOR_DIMENSIONS = 8_192
const EMBEDDING_BATCH_SIZE = 64
const MAX_EMBEDDING_TEXT_LENGTH = 1_000

export interface EmbeddingRouterOptions {
  readonly provider: EmbeddingProvider
  readonly endpoint: string
  readonly model: string
  readonly apiKeyEnv: string
  readonly timeoutMs: number
  readonly candidateLimit: number
  readonly cacheSize: number
  readonly minSimilarity: number
}

type Vector = readonly number[]

function cacheKey(options: EmbeddingRouterOptions, text: string): string {
  return createHash('sha256')
    .update(JSON.stringify([options.provider, options.endpoint, options.model, text]))
    .digest('hex')
}

function boundedText(value: string): string {
  return value.normalize('NFKC').replaceAll(/\s+/gu, ' ').trim().slice(0, MAX_EMBEDDING_TEXT_LENGTH)
}

function candidateDocument(candidate: SkillFluxCandidate): string {
  return boundedText([
    `Skill: ${candidate.name}`,
    ...(!('whenToUse' in candidate) || candidate.whenToUse === undefined
      ? []
      : [`When to use: ${candidate.whenToUse}`]),
    `Description: ${candidate.description}`,
  ].join('\n'))
}

function normalizeVector(value: unknown): Vector {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_VECTOR_DIMENSIONS) {
    throw new Error('embedding response contains an invalid vector dimension')
  }
  const vector: number[] = []
  let normSquared = 0
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      throw new Error('embedding response contains a non-finite vector value')
    }
    vector.push(item)
    normSquared += item * item
  }
  if (!Number.isFinite(normSquared) || normSquared <= 0) {
    throw new Error('embedding response contains a zero-length vector')
  }
  const norm = Math.sqrt(normSquared)
  return vector.map(item => item / norm)
}

function parseOllamaResponse(value: unknown, expected: number): Vector[] {
  if (typeof value !== 'object' || value === null || !('embeddings' in value)) {
    throw new Error('Ollama embedding response is malformed')
  }
  const embeddings = value.embeddings
  if (!Array.isArray(embeddings) || embeddings.length !== expected) {
    throw new Error(`Ollama embedding response returned ${Array.isArray(embeddings) ? embeddings.length : 0} vectors for ${expected} inputs`)
  }
  return embeddings.map(normalizeVector)
}

function parseOpenAiResponse(value: unknown, expected: number): Vector[] {
  if (typeof value !== 'object' || value === null || !('data' in value) || !Array.isArray(value.data)) {
    throw new Error('OpenAI-compatible embedding response is malformed')
  }
  const vectors: Array<Vector | undefined> = Array.from({ length: expected })
  for (const item of value.data) {
    if (typeof item !== 'object' || item === null || !('index' in item) || !('embedding' in item)) {
      throw new Error('OpenAI-compatible embedding response contains a malformed item')
    }
    if (!Number.isSafeInteger(item.index) || (item.index as number) < 0 || (item.index as number) >= expected) {
      throw new Error('OpenAI-compatible embedding response contains an invalid index')
    }
    const index = item.index as number
    if (vectors[index] !== undefined) throw new Error('OpenAI-compatible embedding response contains a duplicate index')
    vectors[index] = normalizeVector(item.embedding)
  }
  if (vectors.some(vector => vector === undefined)) {
    throw new Error(`OpenAI-compatible embedding response returned ${value.data.length} vectors for ${expected} inputs`)
  }
  return vectors as Vector[]
}

function cosine(left: Vector, right: Vector): number {
  if (left.length !== right.length) throw new Error('embedding response changed vector dimensions')
  let score = 0
  for (let index = 0; index < left.length; index += 1) score += left[index]! * right[index]!
  return Math.max(-1, Math.min(1, score))
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (response.body === null) throw new Error('embedding response has no body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error(`embedding response exceeds ${MAX_RESPONSE_BYTES} bytes`)
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown
  } catch {
    throw new Error('embedding response is not valid JSON')
  }
}

function stableCandidateOrder(left: SkillFluxCandidate, right: SkillFluxCandidate): number {
  const originRank = { registry: 0, cache: 1, remote: 2 } as const
  if (originRank[left.origin] !== originRank[right.origin]) return originRank[left.origin] - originRank[right.origin]
  return `${left.source}/${left.name}`.localeCompare(`${right.source}/${right.name}`, 'en')
}

export class EmbeddingRouter {
  private readonly vectors = new Map<string, Vector>()
  private requests = 0
  private cacheHits = 0
  private cacheMisses = 0

  constructor(private readonly options: EmbeddingRouterOptions) {}

  stats(): EmbeddingRouterStats {
    return {
      requests: this.requests,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      cacheEntries: this.vectors.size,
    }
  }

  async rank(
    query: string,
    candidates: readonly SkillFluxCandidate[],
    limit: number,
    signal?: AbortSignal,
  ): Promise<SkillFluxCandidate[]> {
    signal?.throwIfAborted()
    if (limit <= 0 || candidates.length === 0) return []
    const pool = candidates.slice(0, this.options.candidateLimit)
    const texts = [boundedText(query), ...pool.map(candidateDocument)]
    if (texts[0]!.length === 0) return []
    let vectors = await this.embed(texts, signal)
    const dimension = vectors[0]!.length
    if (vectors.some(vector => vector.length !== dimension)) {
      this.vectors.clear()
      vectors = await this.embed(texts, signal)
      if (vectors.some(vector => vector.length !== vectors[0]!.length)) {
        throw new Error('embedding response changed vector dimensions')
      }
    }
    const queryVector = vectors[0]!
    return pool
      .map((candidate, index) => ({ candidate, similarity: cosine(queryVector, vectors[index + 1]!) }))
      .filter(item => item.similarity >= this.options.minSimilarity)
      .sort((left, right) => right.similarity - left.similarity || stableCandidateOrder(left.candidate, right.candidate))
      .slice(0, limit)
      .map(({ candidate, similarity }) => {
        const score = Math.round(similarity * 100)
        return { ...candidate, score, selection: 'embedding', baseScore: score, adaptiveBoost: 0 }
      })
  }

  private cached(key: string): Vector | undefined {
    const vector = this.vectors.get(key)
    if (vector === undefined) return undefined
    this.vectors.delete(key)
    this.vectors.set(key, vector)
    return vector
  }

  private store(key: string, vector: Vector): void {
    this.vectors.delete(key)
    this.vectors.set(key, vector)
    while (this.vectors.size > this.options.cacheSize) {
      const oldest = this.vectors.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.vectors.delete(oldest)
    }
  }

  private async embed(texts: readonly string[], signal?: AbortSignal): Promise<Vector[]> {
    const keys = texts.map(text => cacheKey(this.options, text))
    const resolved = new Map<string, Vector>()
    const missing = new Map<string, string>()
    for (let index = 0; index < texts.length; index += 1) {
      const key = keys[index]!
      const cached = this.cached(key)
      if (cached === undefined) {
        this.cacheMisses += 1
        missing.set(key, texts[index]!)
      } else {
        this.cacheHits += 1
        resolved.set(key, cached)
      }
    }
    const entries = [...missing.entries()]
    for (let offset = 0; offset < entries.length; offset += EMBEDDING_BATCH_SIZE) {
      const batch = entries.slice(offset, offset + EMBEDDING_BATCH_SIZE)
      const vectors = await this.request(batch.map(([, text]) => text), signal)
      for (let index = 0; index < batch.length; index += 1) {
        const key = batch[index]![0]
        const vector = vectors[index]!
        this.store(key, vector)
        resolved.set(key, vector)
      }
    }
    return keys.map(key => {
      const vector = resolved.get(key)
      if (vector === undefined) throw new Error('embedding cache invariant failed')
      return vector
    })
  }

  private async request(input: readonly string[], signal?: AbortSignal): Promise<Vector[]> {
    signal?.throwIfAborted()
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    const operation = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const apiKey = process.env[this.options.apiKeyEnv]?.trim()
    if (apiKey !== undefined && apiKey.length > 0 && !/^[\x21-\x7E]+$/u.test(apiKey)) {
      throw new Error(`embedding API key from ${this.options.apiKeyEnv} contains invalid header characters`)
    }
    this.requests += 1
    let response: Response
    try {
      response = await fetch(this.options.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(apiKey === undefined || apiKey.length === 0 ? {} : { authorization: `Bearer ${apiKey}` }),
        },
        body: JSON.stringify({ model: this.options.model, input }),
        signal: operation,
      })
    } catch (error: unknown) {
      signal?.throwIfAborted()
      if (timeout.aborted) throw new Error(`embedding request timed out after ${this.options.timeoutMs}ms`, { cause: error })
      throw error
    }
    signal?.throwIfAborted()
    if (!response.ok) throw new Error(`embedding endpoint returned HTTP ${response.status}`)
    let value: unknown
    try {
      value = await readBoundedJson(response)
    } catch (error: unknown) {
      signal?.throwIfAborted()
      if (timeout.aborted) throw new Error(`embedding request timed out after ${this.options.timeoutMs}ms`, { cause: error })
      throw error
    }
    signal?.throwIfAborted()
    return this.options.provider === 'ollama'
      ? parseOllamaResponse(value, input.length)
      : parseOpenAiResponse(value, input.length)
  }
}
