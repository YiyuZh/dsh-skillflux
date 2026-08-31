import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { remoteQualityEvidence, remoteTrustPolicyAllows } from '../src/remote-governance.js'
import type {
  RemoteQualitySignal,
  RemoteQualityWarning,
  RemoteTrustLevel,
  RemoteTrustPolicy,
} from '../src/types.js'

interface GovernanceCase {
  readonly id: string
  readonly input: {
    readonly relevanceScore: number
    readonly installs: number
    readonly stars: number
    readonly forks: number
    readonly ageDays: number | null
    readonly trustedSource: boolean
    readonly organizationOwned: boolean
    readonly hasLicense: boolean
    readonly discoverySourceCount: number
    readonly contentPinned: boolean
  }
  readonly expectedLevel: RemoteTrustLevel
  readonly allowedPolicies: readonly RemoteTrustPolicy[]
  readonly signals: readonly RemoteQualitySignal[]
  readonly warnings: readonly RemoteQualityWarning[]
}

interface GovernanceCorpus {
  readonly version: 1
  readonly cases: readonly GovernanceCase[]
}

const NOW = Date.parse('2026-08-28T00:00:00Z')
const POLICIES: readonly RemoteTrustPolicy[] = ['open', 'community', 'corroborated', 'trusted']

describe('remote evidence governance evaluation corpus', () => {
  it('keeps evidence labels and policy boundaries deterministic', async () => {
    const path = fileURLToPath(new URL('../evals/remote-governance-cases.json', import.meta.url))
    const corpus = JSON.parse(await readFile(path, 'utf8')) as GovernanceCorpus
    expect(corpus.version).toBe(1)
    expect(corpus.cases.length).toBeGreaterThanOrEqual(8)
    expect(new Set(corpus.cases.map(testCase => testCase.id)).size).toBe(corpus.cases.length)
    for (const testCase of corpus.cases) {
      const evidence = remoteQualityEvidence({
        ...testCase.input,
        ...(testCase.input.ageDays === null
          ? {}
          : { pushedAt: new Date(NOW - testCase.input.ageDays * 86_400_000).toISOString() }),
        recentActivityDays: 30,
        now: NOW,
      })
      expect(evidence.trustLevel, testCase.id).toBe(testCase.expectedLevel)
      expect(evidence.signals, testCase.id).toEqual(expect.arrayContaining([...testCase.signals]))
      expect(evidence.warnings, testCase.id).toEqual(expect.arrayContaining([...testCase.warnings]))
      for (const policy of POLICIES) {
        expect(remoteTrustPolicyAllows(evidence.trustLevel, policy), `${testCase.id}:${policy}`)
          .toBe(testCase.allowedPolicies.includes(policy))
      }
    }
  })
})
