import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { remoteQualityScore, type RemoteQualityInput } from '../src/remote.js'

interface QualityFixture {
  readonly relevanceScore: number
  readonly installs: number
  readonly stars: number
  readonly forks: number
  readonly ageDays: number
  readonly trustedSource: boolean
  readonly organizationOwned: boolean
  readonly hasLicense: boolean
}

interface QualityCase {
  readonly name: string
  readonly left: QualityFixture
  readonly right: QualityFixture
  readonly expected: 'left' | 'right'
  readonly expectedLeftScore?: number
}

interface QualityCorpus {
  readonly version: 1
  readonly cases: readonly QualityCase[]
}

const NOW = Date.parse('2026-08-24T00:00:00Z')

function qualityInput(fixture: QualityFixture): RemoteQualityInput {
  return {
    relevanceScore: fixture.relevanceScore,
    installs: fixture.installs,
    stars: fixture.stars,
    forks: fixture.forks,
    pushedAt: new Date(NOW - fixture.ageDays * 86_400_000).toISOString(),
    recentActivityDays: 30,
    trustedSource: fixture.trustedSource,
    organizationOwned: fixture.organizationOwned,
    hasLicense: fixture.hasLicense,
    now: NOW,
  }
}

async function loadCorpus(): Promise<QualityCorpus> {
  const path = fileURLToPath(new URL('../evals/remote-quality-cases.json', import.meta.url))
  return JSON.parse(await readFile(path, 'utf8')) as QualityCorpus
}

describe('remote quality evaluation corpus', () => {
  it('keeps relevance primary while using current quality evidence as tie-breakers', async () => {
    const corpus = await loadCorpus()
    expect(corpus.version).toBe(1)
    expect(corpus.cases.length).toBeGreaterThanOrEqual(8)
    for (const testCase of corpus.cases) {
      const left = remoteQualityScore(qualityInput(testCase.left))
      const right = remoteQualityScore(qualityInput(testCase.right))
      if (testCase.expected === 'left') expect(left, testCase.name).toBeGreaterThan(right)
      else expect(right, testCase.name).toBeGreaterThan(left)
      if (testCase.expectedLeftScore !== undefined) expect(left, testCase.name).toBe(testCase.expectedLeftScore)
    }
  })
})
