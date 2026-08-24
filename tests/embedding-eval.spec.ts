import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EmbeddingRouter } from '../src/embedding.js'
import type { SkillFluxCandidate } from '../src/types.js'

interface SemanticEvalCandidate {
  readonly name: string
  readonly description: string
  readonly source?: string
  readonly vector: number[]
}

interface SemanticEvalCase {
  readonly id: string
  readonly query: string
  readonly queryVector: number[]
  readonly candidates: SemanticEvalCandidate[]
  readonly expected: string[]
  readonly limit?: number
}

afterEach(() => { vi.unstubAllGlobals() })

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'number' && Number.isFinite(item))
}

function parseCase(value: unknown, index: number): SemanticEvalCase {
  if (typeof value !== 'object' || value === null) throw new Error(`semantic case ${index} must be an object`)
  const item = value as Record<string, unknown>
  if (typeof item.id !== 'string' || typeof item.query !== 'string' || !isNumberArray(item.queryVector)) {
    throw new Error(`semantic case ${index} has invalid identity or query fields`)
  }
  const queryVector = item.queryVector
  if (!Array.isArray(item.expected) || !item.expected.every(name => typeof name === 'string')) {
    throw new Error(`semantic case ${item.id} has invalid expectations`)
  }
  if (!Array.isArray(item.candidates)) throw new Error(`semantic case ${item.id} has no candidates`)
  const candidates = item.candidates.map((candidate, candidateIndex): SemanticEvalCandidate => {
    if (typeof candidate !== 'object' || candidate === null) {
      throw new Error(`semantic case ${item.id} candidate ${candidateIndex} must be an object`)
    }
    const entry = candidate as Record<string, unknown>
    if (typeof entry.name !== 'string' || typeof entry.description !== 'string' || !isNumberArray(entry.vector)) {
      throw new Error(`semantic case ${item.id} candidate ${candidateIndex} is invalid`)
    }
    if (entry.vector.length !== queryVector.length) {
      throw new Error(`semantic case ${item.id} candidate ${entry.name} changes dimensions`)
    }
    if (entry.source !== undefined && typeof entry.source !== 'string') {
      throw new Error(`semantic case ${item.id} candidate ${entry.name} has an invalid source`)
    }
    return {
      name: entry.name,
      description: entry.description,
      ...(entry.source === undefined ? {} : { source: entry.source }),
      vector: entry.vector,
    }
  })
  if (item.limit !== undefined && (!Number.isSafeInteger(item.limit) || (item.limit as number) < 1)) {
    throw new Error(`semantic case ${item.id} has an invalid limit`)
  }
  return {
    id: item.id,
    query: item.query,
    queryVector,
    candidates,
    expected: item.expected as string[],
    ...(item.limit === undefined ? {} : { limit: item.limit as number }),
  }
}

function runtimeCandidate(candidate: SemanticEvalCandidate): SkillFluxCandidate {
  return {
    id: candidate.name,
    origin: 'cache',
    name: candidate.name,
    description: candidate.description,
    source: candidate.source ?? 'eval/repo',
    ref: 'a'.repeat(40),
    cacheId: candidate.name.padEnd(24, '0').slice(0, 24),
    score: 0,
  }
}

describe('semantic routing evaluation corpus', () => {
  it('meets the provider-independent ranking contract', async () => {
    const raw = JSON.parse(await readFile(
      fileURLToPath(new URL('../evals/semantic-routing-cases.json', import.meta.url)),
      'utf8',
    )) as unknown
    if (!Array.isArray(raw)) throw new Error('semantic routing corpus must be an array')
    const cases = raw.map(parseCase)
    let exact = 0
    let top1 = 0
    let positive = 0
    let rejected = 0
    let negative = 0
    for (const item of cases) {
      const vectors = new Map(item.candidates.map(candidate => [candidate.name, candidate.vector]))
      vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { input: string[] }
        return new Response(JSON.stringify({
          embeddings: request.input.map(text => {
            if (text === item.query) return item.queryVector
            const name = /Skill: ([a-z0-9-]+)/u.exec(text)?.[1]
            const vector = name === undefined ? undefined : vectors.get(name)
            if (vector === undefined) throw new Error(`missing eval vector for ${text}`)
            return vector
          }),
        }), { status: 200 })
      }))
      const router = new EmbeddingRouter({
        provider: 'ollama',
        endpoint: 'http://127.0.0.1:11434/api/embed',
        model: 'semantic-eval',
        apiKeyEnv: 'SKILLFLUX_SEMANTIC_EVAL_KEY',
        timeoutMs: 1_000,
        candidateLimit: 32,
        cacheSize: 64,
        minSimilarity: 0.45,
      })
      const selected = await router.rank(
        item.query,
        item.candidates.map(runtimeCandidate),
        item.limit ?? 1,
      )
      const names = selected.map(candidate => candidate.name)
      if (JSON.stringify(names) === JSON.stringify(item.expected)) exact += 1
      if (item.expected.length === 0) {
        negative += 1
        if (names.length === 0) rejected += 1
      } else {
        positive += 1
        if (names[0] === item.expected[0]) top1 += 1
      }
      expect(names, item.id).toEqual(item.expected)
      vi.unstubAllGlobals()
    }
    const exactRate = exact / cases.length
    const top1Rate = top1 / positive
    const rejectionRate = rejected / negative
    console.log(
      `SkillFlux semantic eval: ${cases.length} cases | exact=${(exactRate * 100).toFixed(1)}% | top1=${(top1Rate * 100).toFixed(1)}% | negative-rejection=${(rejectionRate * 100).toFixed(1)}%`,
    )
    expect(exactRate).toBe(1)
    expect(top1Rate).toBe(1)
    expect(rejectionRate).toBe(1)
  })
})
