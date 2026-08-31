import { describe, expect, it } from 'vitest'
import {
  deduplicateRemoteCandidates,
  remoteQualityEvidence,
  remoteTrustPolicyAllows,
} from '../src/remote-governance.js'
import type { RemoteCandidate } from '../src/types.js'

const NOW = Date.parse('2026-08-28T00:00:00Z')

function candidate(source: string, hash?: string): RemoteCandidate {
  return {
    id: source.padEnd(24, '0').slice(0, 24),
    origin: 'remote',
    name: 'pdf-reader',
    description: 'Read PDF documents with OCR.',
    source,
    ref: 'a'.repeat(40),
    score: 70,
    selection: 'remote-quality',
    baseScore: 30,
    adaptiveBoost: 0,
    skillId: 'pdf-reader',
    installs: 0,
    discoverySources: ['github'],
    qualityScore: 70,
    relevanceScore: 30,
    stars: 1,
    forks: 0,
    pushedAt: '2026-08-27T00:00:00Z',
    license: 'MIT',
    recentlyActive: true,
    trustedSource: false,
    trustLevel: 'community',
    qualityBreakdown: { relevance: 50, adoption: 0, repository: 2, freshness: 10, trust: 2, provenance: 6, total: 70 },
    qualitySignals: ['content-pinned'],
    qualityWarnings: ['single-source'],
    path: 'skills/pdf-reader/SKILL.md',
    ...(hash === undefined ? {} : { skillFileHash: hash }),
  }
}

describe('remote evidence governance', () => {
  it('keeps an exact low-star GitHub match when its Skill content is pinned', () => {
    const evidence = remoteQualityEvidence({
      relevanceScore: 100,
      installs: 0,
      stars: 1,
      forks: 0,
      pushedAt: '2026-08-27T00:00:00Z',
      recentActivityDays: 30,
      trustedSource: false,
      organizationOwned: false,
      hasLicense: true,
      discoverySourceCount: 1,
      contentPinned: true,
      now: NOW,
    })
    expect(evidence.trustLevel).toBe('community')
    expect(evidence.breakdown.relevance).toBe(55)
    expect(evidence.breakdown.provenance).toBe(4)
    expect(evidence.signals).toContain('content-pinned')
    expect(evidence.warnings).toContain('low-adoption')
  })

  it('distinguishes corroborated discovery from explicit owner trust', () => {
    const common = {
      relevanceScore: 20,
      installs: 100,
      stars: 100,
      forks: 10,
      pushedAt: '2026-08-20T00:00:00Z',
      recentActivityDays: 30,
      organizationOwned: true,
      hasLicense: true,
      discoverySourceCount: 2,
      contentPinned: true,
      now: NOW,
    }
    expect(remoteQualityEvidence({ ...common, trustedSource: false }).trustLevel).toBe('corroborated')
    expect(remoteQualityEvidence({ ...common, trustedSource: true }).trustLevel).toBe('trusted')
  })

  it('applies monotonic evidence policies', () => {
    expect(remoteTrustPolicyAllows('unverified', 'open')).toBe(true)
    expect(remoteTrustPolicyAllows('unverified', 'community')).toBe(false)
    expect(remoteTrustPolicyAllows('community', 'community')).toBe(true)
    expect(remoteTrustPolicyAllows('community', 'corroborated')).toBe(false)
    expect(remoteTrustPolicyAllows('corroborated', 'trusted')).toBe(false)
    expect(remoteTrustPolicyAllows('trusted', 'trusted')).toBe(true)
  })

  it('retains equal entry files across repositories because adjacent resources may differ', () => {
    const hash = 'b'.repeat(64)
    const result = deduplicateRemoteCandidates([
      candidate('mirror/source', hash),
      candidate('best/source', hash),
      candidate('independent/source'),
    ])
    expect(result).toHaveLength(3)
    expect(result.map(item => item.source)).toEqual(['best/source', 'independent/source', 'mirror/source'])
    expect(result.every(item => !item.qualitySignals.includes('cross-source'))).toBe(true)
  })
})
