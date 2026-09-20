import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateRegistryIndexEntry } from '../src/registry-source.js'

interface RegistrySourceCase {
  readonly id: string
  readonly name: string
  readonly entry: unknown
  readonly expect: 'accept' | 'reject'
}

interface RegistrySourceCorpus {
  readonly version: 1
  readonly cases: readonly RegistrySourceCase[]
}

async function loadCorpus(): Promise<RegistrySourceCorpus> {
  const path = fileURLToPath(new URL('../evals/registry-source-cases.json', import.meta.url))
  return JSON.parse(await readFile(path, 'utf8')) as RegistrySourceCorpus
}

describe('registry source evaluation corpus', () => {
  it('accepts exactly the entries that can be pinned and evidenced', async () => {
    const corpus = await loadCorpus()
    expect(corpus.version).toBe(1)
    expect(corpus.cases.length).toBeGreaterThanOrEqual(8)
    for (const testCase of corpus.cases) {
      const accepted = validateRegistryIndexEntry(testCase.entry) !== undefined
      if (testCase.expect === 'accept') {
        expect(accepted, `${testCase.id}: ${testCase.name}`).toBe(true)
      } else {
        expect(accepted, `${testCase.id}: ${testCase.name}`).toBe(false)
      }
    }
  })
})

