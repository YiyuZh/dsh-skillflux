import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { selectCandidates } from '../src/router.js'
import type { CandidateOrigin, RouteRule, SkillFluxCandidate } from '../src/types.js'

interface EvalCandidate {
  readonly key: string
  readonly origin: CandidateOrigin
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly source: string
  readonly installs?: number
}

interface EvalCase {
  readonly id: string
  readonly category: string
  readonly task: string
  readonly pool: string[]
  readonly expected: string[]
  readonly expectedForced?: string[]
  readonly limit?: number
  readonly minScore?: number
  readonly routes?: RouteRule[]
  readonly boosts?: Readonly<Record<string, number>>
}

interface EvalCorpus {
  readonly version: number
  readonly description: string
  readonly defaults: {
    readonly limit: number
    readonly minScore: number
  }
  readonly candidates: EvalCandidate[]
  readonly cases: EvalCase[]
}

interface EvalResult {
  readonly testCase: EvalCase
  readonly predicted: string[]
  readonly forced: string[]
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) result[key] = item
  return result
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : nonEmptyString(value, label)
}

function integer(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function optionalInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  return value === undefined ? undefined : integer(value, label, minimum, maximum)
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  return value.map((item, index) => nonEmptyString(item, `${label}[${index}]`))
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  return value === undefined ? undefined : stringArray(value, label)
}

function parseOrigin(value: unknown, label: string): CandidateOrigin {
  if (value !== 'registry' && value !== 'cache' && value !== 'remote') {
    throw new TypeError(`${label} must be registry, cache, or remote`)
  }
  return value
}

function parseCandidate(value: unknown, index: number): EvalCandidate {
  const label = `candidates[${index}]`
  const item = record(value, label)
  const origin = parseOrigin(item.origin, `${label}.origin`)
  const whenToUse = optionalString(item.whenToUse, `${label}.whenToUse`)
  const installs = optionalInteger(item.installs, `${label}.installs`, 0)
  if (origin === 'remote' && installs === undefined) {
    throw new TypeError(`${label}.installs is required for a remote candidate`)
  }
  return {
    key: nonEmptyString(item.key, `${label}.key`),
    origin,
    name: nonEmptyString(item.name, `${label}.name`),
    description: nonEmptyString(item.description, `${label}.description`),
    ...(whenToUse === undefined ? {} : { whenToUse }),
    source: nonEmptyString(item.source, `${label}.source`),
    ...(installs === undefined ? {} : { installs }),
  }
}

function parseRoute(value: unknown, label: string): RouteRule {
  const item = record(value, label)
  const matchAll = optionalStringArray(item.matchAll, `${label}.matchAll`)
  const matchAny = optionalStringArray(item.matchAny, `${label}.matchAny`)
  if ((matchAll?.length ?? 0) === 0 && (matchAny?.length ?? 0) === 0) {
    throw new TypeError(`${label} must contain matchAll or matchAny values`)
  }
  const skills = stringArray(item.skills, `${label}.skills`)
  if (skills.length === 0) throw new TypeError(`${label}.skills must not be empty`)
  return {
    ...(matchAll === undefined ? {} : { matchAll }),
    ...(matchAny === undefined ? {} : { matchAny }),
    skills,
  }
}

function parseCase(value: unknown, index: number): EvalCase {
  const label = `cases[${index}]`
  const item = record(value, label)
  const expectedForced = optionalStringArray(item.expectedForced, `${label}.expectedForced`)
  const limit = optionalInteger(item.limit, `${label}.limit`, 1, 3)
  const minScore = optionalInteger(item.minScore, `${label}.minScore`, 0)
  let routes: RouteRule[] | undefined
  if (item.routes !== undefined) {
    if (!Array.isArray(item.routes)) throw new TypeError(`${label}.routes must be an array`)
    routes = item.routes.map((route, routeIndex) => parseRoute(route, `${label}.routes[${routeIndex}]`))
  }
  let boosts: Record<string, number> | undefined
  if (item.boosts !== undefined) {
    const rawBoosts = record(item.boosts, `${label}.boosts`)
    boosts = {}
    for (const [key, boost] of Object.entries(rawBoosts)) {
      boosts[nonEmptyString(key, `${label}.boosts key`)] = integer(boost, `${label}.boosts.${key}`, 0, 20)
    }
  }
  return {
    id: nonEmptyString(item.id, `${label}.id`),
    category: nonEmptyString(item.category, `${label}.category`),
    task: nonEmptyString(item.task, `${label}.task`),
    pool: stringArray(item.pool, `${label}.pool`),
    expected: stringArray(item.expected, `${label}.expected`),
    ...(expectedForced === undefined ? {} : { expectedForced }),
    ...(limit === undefined ? {} : { limit }),
    ...(minScore === undefined ? {} : { minScore }),
    ...(routes === undefined ? {} : { routes }),
    ...(boosts === undefined ? {} : { boosts }),
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${label} contains duplicates`)
}

function validateCorpus(corpus: EvalCorpus): EvalCorpus {
  if (corpus.candidates.length === 0) throw new TypeError('corpus.candidates must not be empty')
  if (corpus.cases.length === 0) throw new TypeError('corpus.cases must not be empty')
  if (!corpus.cases.some(testCase => testCase.expected.length > 0)) {
    throw new TypeError('corpus.cases must contain a positive case')
  }
  if (!corpus.cases.some(testCase => testCase.expected.length === 0)) {
    throw new TypeError('corpus.cases must contain a negative case')
  }
  const candidateKeys = corpus.candidates.map(candidate => candidate.key)
  assertUnique(candidateKeys, 'candidate keys')
  assertUnique(corpus.cases.map(testCase => testCase.id), 'case ids')
  const known = new Set(candidateKeys)
  for (const testCase of corpus.cases) {
    if (testCase.pool.length === 0) throw new TypeError(`${testCase.id}.pool must not be empty`)
    assertUnique(testCase.pool, `${testCase.id}.pool`)
    assertUnique(testCase.expected, `${testCase.id}.expected`)
    assertUnique(testCase.expectedForced ?? [], `${testCase.id}.expectedForced`)
    for (const key of [...testCase.pool, ...testCase.expected, ...(testCase.expectedForced ?? [])]) {
      if (!known.has(key)) throw new TypeError(`${testCase.id} references unknown candidate ${key}`)
    }
    for (const key of testCase.expected) {
      if (!testCase.pool.includes(key)) throw new TypeError(`${testCase.id} expects ${key} outside its pool`)
    }
    for (const key of testCase.expectedForced ?? []) {
      if (!testCase.expected.includes(key)) throw new TypeError(`${testCase.id} forces unexpected candidate ${key}`)
    }
    for (const key of Object.keys(testCase.boosts ?? {})) {
      if (!testCase.pool.includes(key)) throw new TypeError(`${testCase.id} boosts ${key} outside its pool`)
    }
    if (testCase.expected.length > (testCase.limit ?? corpus.defaults.limit)) {
      throw new TypeError(`${testCase.id}.expected exceeds its selector limit`)
    }
  }
  return corpus
}

function parseCorpus(value: unknown): EvalCorpus {
  const corpus = record(value, 'corpus')
  if (corpus.version !== 1) throw new TypeError('corpus.version must be 1')
  const defaults = record(corpus.defaults, 'corpus.defaults')
  if (!Array.isArray(corpus.candidates)) throw new TypeError('corpus.candidates must be an array')
  if (!Array.isArray(corpus.cases)) throw new TypeError('corpus.cases must be an array')
  return validateCorpus({
    version: 1,
    description: nonEmptyString(corpus.description, 'corpus.description'),
    defaults: {
      limit: integer(defaults.limit, 'corpus.defaults.limit', 1, 3),
      minScore: integer(defaults.minScore, 'corpus.defaults.minScore', 0),
    },
    candidates: corpus.candidates.map(parseCandidate),
    cases: corpus.cases.map(parseCase),
  })
}

function toCandidate(candidate: EvalCandidate): SkillFluxCandidate {
  const common = {
    id: candidate.key,
    name: candidate.name,
    description: candidate.description,
    ...(candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse }),
    source: candidate.source,
    score: 0,
  }
  if (candidate.origin === 'registry') {
    return {
      ...common,
      origin: 'registry',
      summary: {
        name: candidate.name,
        description: candidate.description,
        ...(candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse }),
        source: candidate.source,
        provider: 'eval-corpus',
        invocation: { modelInvocable: true, userInvocable: true },
      },
    }
  }
  if (candidate.origin === 'cache') {
    return {
      ...common,
      origin: 'cache',
      ref: 'a'.repeat(40),
      cacheId: candidate.key.padEnd(24, '0').slice(0, 24),
      ...(candidate.installs === undefined ? {} : { installs: candidate.installs }),
    }
  }
  return {
    ...common,
    origin: 'remote',
    ref: 'b'.repeat(40),
    skillId: candidate.name,
    installs: candidate.installs ?? 0,
  }
}

async function loadCorpus(): Promise<EvalCorpus> {
  const path = fileURLToPath(new URL('../evals/routing-cases.json', import.meta.url))
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  return parseCorpus(value)
}

describe('routing evaluation corpus', () => {
  it('contains valid, uniquely identified candidates and cases', async () => {
    const corpus = await loadCorpus()
    const candidateKeys = corpus.candidates.map(candidate => candidate.key)
    const caseIds = corpus.cases.map(testCase => testCase.id)
    expect(corpus.version).toBe(1)
    expect(corpus.cases.length).toBeGreaterThanOrEqual(30)
    expect(new Set(candidateKeys).size).toBe(candidateKeys.length)
    expect(new Set(caseIds).size).toBe(caseIds.length)
    for (const testCase of corpus.cases) {
      expect(testCase.pool.length, `${testCase.id}: empty candidate pool`).toBeGreaterThan(0)
      expect(new Set(testCase.pool).size, `${testCase.id}: duplicate pool candidate`).toBe(testCase.pool.length)
      expect(new Set(testCase.expected).size, `${testCase.id}: duplicate expected candidate`)
        .toBe(testCase.expected.length)
      for (const key of [...testCase.pool, ...testCase.expected, ...(testCase.expectedForced ?? [])]) {
        expect(candidateKeys, `${testCase.id}: unknown candidate ${key}`).toContain(key)
      }
      for (const key of testCase.expected) {
        expect(testCase.pool, `${testCase.id}: expected candidate ${key} is outside the pool`).toContain(key)
      }
      for (const key of testCase.expectedForced ?? []) {
        expect(testCase.expected, `${testCase.id}: forced candidate ${key} is not expected`).toContain(key)
      }
      expect(testCase.expected.length, `${testCase.id}: expected result exceeds limit`)
        .toBeLessThanOrEqual(testCase.limit ?? corpus.defaults.limit)
    }
  })

  it('rejects malformed origins and cross-pool expectations', () => {
    const candidate = {
      key: 'pdf-reader',
      origin: 'registry',
      name: 'pdf-reader',
      description: 'Read PDF files',
      source: 'project-skills',
    }
    const otherCandidate = {
      ...candidate,
      key: 'document-parser',
      name: 'document-parser',
      description: 'Parse documents',
    }
    const base = {
      version: 1,
      description: 'Schema validation fixture',
      defaults: { limit: 3, minScore: 8 },
      candidates: [candidate, otherCandidate],
      cases: [{
        id: 'valid-case',
        category: 'schema',
        task: 'Read a PDF',
        pool: ['pdf-reader'],
        expected: ['pdf-reader'],
      }, {
        id: 'negative-case',
        category: 'schema',
        task: 'Book a flight',
        pool: ['pdf-reader'],
        expected: [],
      }],
    }
    expect(() => parseCorpus({
      ...base,
      candidates: [{ ...candidate, origin: 'cahce' }],
    })).toThrow('must be registry, cache, or remote')
    expect(() => parseCorpus({
      ...base,
      cases: [{ ...base.cases[0], expected: ['document-parser'] }, base.cases[1]],
    })).toThrow('expects document-parser outside its pool')
  })

  it('meets the deterministic routing quality gates', async () => {
    const corpus = await loadCorpus()
    const byKey = new Map(corpus.candidates.map(candidate => [candidate.key, candidate]))
    const results: EvalResult[] = corpus.cases.map(testCase => {
      const candidates = testCase.pool.map((key) => {
        const candidate = byKey.get(key)
        if (candidate === undefined) throw new Error(`${testCase.id}: unknown candidate ${key}`)
        return toCandidate(candidate)
      })
      const selected = selectCandidates(testCase.task, candidates, {
        limit: testCase.limit ?? corpus.defaults.limit,
        minScore: testCase.minScore ?? corpus.defaults.minScore,
        routes: testCase.routes ?? [],
        ...(testCase.boosts === undefined ? {} : { boosts: new Map(Object.entries(testCase.boosts)) }),
      })
      return {
        testCase,
        predicted: selected.map(candidate => candidate.id),
        forced: selected
          .filter(candidate => candidate.score === Number.MAX_SAFE_INTEGER)
          .map(candidate => candidate.id),
      }
    })

    const failures = results.filter(({ testCase, predicted, forced }) =>
      JSON.stringify(predicted) !== JSON.stringify(testCase.expected)
      || JSON.stringify(forced) !== JSON.stringify(testCase.expectedForced ?? []))
    const positives = results.filter(({ testCase }) => testCase.expected.length > 0)
    const negatives = results.filter(({ testCase }) => testCase.expected.length === 0)
    expect(positives.length).toBeGreaterThan(0)
    expect(negatives.length).toBeGreaterThan(0)
    const exactMatches = results.length - failures.length
    const topOneMatches = positives.filter(({ testCase, predicted }) => predicted[0] === testCase.expected[0]).length
    const rejectedNegatives = negatives.filter(({ predicted }) => predicted.length === 0).length
    const limitCompliant = results.filter(({ testCase, predicted }) =>
      predicted.length <= (testCase.limit ?? corpus.defaults.limit)
    ).length
    const percent = (value: number, total: number): string => `${((value / total) * 100).toFixed(1)}%`

    console.info([
      `SkillFlux routing eval: ${results.length} cases`,
      `exact=${percent(exactMatches, results.length)}`,
      `top1=${percent(topOneMatches, positives.length)}`,
      `negative-rejection=${percent(rejectedNegatives, negatives.length)}`,
      `selector-limit=${percent(limitCompliant, results.length)}`,
    ].join(' | '))

    expect(failures.map(({ testCase, predicted, forced }) => ({
      id: testCase.id,
      expected: testCase.expected,
      predicted,
      expectedForced: testCase.expectedForced ?? [],
      forced,
    }))).toEqual([])
    expect(topOneMatches / positives.length).toBeGreaterThanOrEqual(0.95)
    expect(rejectedNegatives).toBe(negatives.length)
    expect(limitCompliant).toBe(results.length)
  })
})
