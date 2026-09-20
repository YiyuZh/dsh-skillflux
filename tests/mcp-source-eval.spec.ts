import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateMcpSkillEntry } from '../src/mcp-source.js'

interface McpSourceCase {
  readonly id: string
  readonly name: string
  readonly entry: unknown
  readonly expect: 'accept' | 'reject'
}

interface McpSourceCorpus {
  readonly version: 1
  readonly cases: readonly McpSourceCase[]
}

async function loadCorpus(): Promise<McpSourceCorpus> {
  const path = fileURLToPath(new URL('../evals/mcp-source-cases.json', import.meta.url))
  return JSON.parse(await readFile(path, 'utf8')) as McpSourceCorpus
}

describe('MCP source evaluation corpus', () => {
  it('accepts exactly the entries that can be content-bound and verified', async () => {
    const corpus = await loadCorpus()
    expect(corpus.version).toBe(1)
    expect(corpus.cases.length).toBeGreaterThanOrEqual(10)
    for (const testCase of corpus.cases) {
      const accepted = validateMcpSkillEntry(testCase.entry) !== undefined
      if (testCase.expect === 'accept') {
        expect(accepted, `${testCase.id}: ${testCase.name}`).toBe(true)
      } else {
        expect(accepted, `${testCase.id}: ${testCase.name}`).toBe(false)
      }
    }
  })
})

