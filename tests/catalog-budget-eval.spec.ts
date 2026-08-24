import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { estimateCatalogTokens } from '../src/catalog.js'

interface BudgetCandidate {
  readonly key: string
  readonly name: string
  readonly description: string
}

interface BudgetCase {
  readonly id: string
  readonly pool: readonly string[]
  readonly budget: number
  readonly maxDescriptionLength?: number
  readonly expected: readonly string[]
}

interface BudgetCorpus {
  readonly version: 1
  readonly defaults: { readonly maxDescriptionLength: number }
  readonly candidates: readonly BudgetCandidate[]
  readonly cases: readonly BudgetCase[]
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`)
  return value
}

function integer(value: unknown, label: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be an integer greater than or equal to ${minimum}`)
  }
  return value
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  return value.map((item, index) => text(item, `${label}[${index}]`))
}

function parseCorpus(value: unknown): BudgetCorpus {
  const root = record(value, 'corpus')
  if (root.version !== 1) throw new TypeError('corpus.version must be 1')
  const defaults = record(root.defaults, 'corpus.defaults')
  if (!Array.isArray(root.candidates) || !Array.isArray(root.cases)) throw new TypeError('corpus arrays are required')
  const candidates = root.candidates.map((value, index) => {
    const item = record(value, `candidates[${index}]`)
    return {
      key: text(item.key, `candidates[${index}].key`),
      name: text(item.name, `candidates[${index}].name`),
      description: text(item.description, `candidates[${index}].description`),
    }
  })
  const cases = root.cases.map((value, index) => {
    const item = record(value, `cases[${index}]`)
    const maxDescriptionLength = item.maxDescriptionLength === undefined
      ? undefined
      : integer(item.maxDescriptionLength, `cases[${index}].maxDescriptionLength`, 3)
    return {
      id: text(item.id, `cases[${index}].id`),
      pool: strings(item.pool, `cases[${index}].pool`),
      budget: integer(item.budget, `cases[${index}].budget`, 0),
      ...(maxDescriptionLength === undefined ? {} : { maxDescriptionLength }),
      expected: strings(item.expected, `cases[${index}].expected`),
    }
  })
  const known = new Set(candidates.map(candidate => candidate.key))
  if (known.size !== candidates.length) throw new TypeError('candidate keys must be unique')
  if (new Set(cases.map(testCase => testCase.id)).size !== cases.length) throw new TypeError('case ids must be unique')
  for (const testCase of cases) {
    for (const key of [...testCase.pool, ...testCase.expected]) {
      if (!known.has(key)) throw new TypeError(`${testCase.id} references unknown candidate ${key}`)
    }
  }
  return {
    version: 1,
    defaults: { maxDescriptionLength: integer(defaults.maxDescriptionLength, 'defaults.maxDescriptionLength', 3) },
    candidates,
    cases,
  }
}

async function loadCorpus(): Promise<BudgetCorpus> {
  const path = fileURLToPath(new URL('../evals/catalog-budget-cases.json', import.meta.url))
  return parseCorpus(JSON.parse(await readFile(path, 'utf8')) as unknown)
}

function applyBudget(
  candidates: readonly BudgetCandidate[],
  budget: number,
  maxDescriptionLength: number,
): BudgetCandidate[] {
  if (budget === 0) return [...candidates]
  const selected: BudgetCandidate[] = []
  for (const candidate of candidates) {
    if (estimateCatalogTokens([...selected, candidate], maxDescriptionLength) <= budget) selected.push(candidate)
  }
  return selected
}

describe('catalog budget evaluation corpus', () => {
  it('meets footprint boundaries and ordered greedy selection', async () => {
    const corpus = await loadCorpus()
    const byKey = new Map(corpus.candidates.map(candidate => [candidate.key, candidate]))
    const failures: Array<{ id: string; expected: readonly string[]; predicted: string[] }> = []
    for (const testCase of corpus.cases) {
      const pool = testCase.pool.map(key => byKey.get(key)!)
      const predicted = applyBudget(
        pool,
        testCase.budget,
        testCase.maxDescriptionLength ?? corpus.defaults.maxDescriptionLength,
      ).map(candidate => candidate.key)
      if (JSON.stringify(predicted) !== JSON.stringify(testCase.expected)) {
        failures.push({ id: testCase.id, expected: testCase.expected, predicted })
      }
    }
    const exact = corpus.cases.length - failures.length
    console.info(`SkillFlux catalog budget eval: ${corpus.cases.length} cases | exact=${((exact / corpus.cases.length) * 100).toFixed(1)}%`)
    expect(failures).toEqual([])
  })
})
