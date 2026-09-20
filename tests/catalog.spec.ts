import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  estimateCatalogTokens,
  estimateTextTokens,
  remoteCandidateMessage,
  updateRemoteCandidates,
} from '../src/catalog.js'
import type { RemoteCandidate } from '../src/types.js'

const candidate: RemoteCandidate = {
  id: 'a'.repeat(24),
  origin: 'remote',
  name: 'pdf-reader',
  description: 'Read PDF documents',
  source: 'owner/repo',
  ref: 'b'.repeat(40),
  score: 0,
  skillId: 'pdf-reader',
  installs: 100,
  discoverySources: ['skills.sh'],
  qualityScore: 80,
  relevanceScore: 100,
  stars: 500,
  forks: 20,
  pushedAt: '2026-08-20T00:00:00Z',
  license: 'MIT',
  recentlyActive: true,
  trustedSource: false,
  trustLevel: 'community',
  qualityBreakdown: { relevance: 55, adoption: 7, repository: 8, freshness: 8, trust: 2, provenance: 0, total: 80 },
  qualitySignals: ['recent-activity', 'declared-license'],
  qualityWarnings: ['single-source', 'content-not-previewed'],
}

function agentWithRemoteHistory(entries: readonly RemoteCandidate[][]): Agent {
  const events = entries.map((items, index) => {
    const message = remoteCandidateMessage({
      session: { events: [], surface: { nodes: [] } },
    } as unknown as Agent, items)
    return { type: 'user/message' as const, seq: index + 1, time: index + 1, data: message }
  })
  return {
    session: {
      events,
      surface: { nodes: events.length === 0 ? [] : [events.length] },
    },
  } as unknown as Agent
}

function agentWithAccessorHistory(entries: readonly RemoteCandidate[][]): Agent {
  const events = entries.map((items, index) => {
    const message = remoteCandidateMessage({
      session: { events: [], surface: { nodes: [] } },
    } as unknown as Agent, items)
    return { type: 'user/message' as const, seq: index + 1, time: index + 1, data: message }
  })
  return {
    session: {
      seq: events.length + 1,
      eventAt: (index: number) => events[index - 1],
      surface: { nodes: events.length === 0 ? [] : [events.length] },
    },
  } as unknown as Agent
}

describe('remote candidate catalog', () => {
  it('publishes one empty replacement for candidates from an earlier turn', () => {
    const agent = agentWithRemoteHistory([[candidate]])
    const cleared = updateRemoteCandidates(agent, [])
    expect(cleared?.source).toMatchObject({
      kind: 'skillflux-candidates', update: true, entries: [],
    })
    expect(cleared).toBeDefined()
    if (cleared === undefined) return
    expect((cleared.content[0] as { text?: string }).text).toContain('Do not use candidate ids from an earlier turn')
  })

  it('reads catalog history through the 0.1.6 session accessors', () => {
    const agent = agentWithAccessorHistory([[candidate]])
    const cleared = updateRemoteCandidates(agent, [])
    expect(cleared?.source).toMatchObject({
      kind: 'skillflux-candidates', update: true, entries: [],
    })
  })

  it('does not repeat an already-visible empty replacement', () => {
    const agent = agentWithRemoteHistory([[candidate], []])
    expect(updateRemoteCandidates(agent, [])).toBeUndefined()
  })

  it('replaces a visible legacy candidate catalog after an upgrade', () => {
    const legacy = {
      type: 'user/message' as const,
      seq: 1,
      time: 1,
      data: {
        id: 'legacy-message',
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'legacy candidates' }],
        source: {
          kind: 'skillflux-candidates' as const,
          form: 'catalog' as const,
          entries: [{
            id: candidate.id,
            name: candidate.name,
            source: candidate.source,
            ref: candidate.ref,
            installs: candidate.installs,
            discoverySources: candidate.discoverySources,
            qualityScore: candidate.qualityScore,
            relevanceScore: candidate.relevanceScore,
            stars: candidate.stars,
            recentlyActive: candidate.recentlyActive,
            trustedSource: candidate.trustedSource,
          }],
        },
      },
    }
    const agent = {
      session: { events: [legacy], surface: { nodes: [legacy.seq] } },
    } as unknown as Agent
    expect(updateRemoteCandidates(agent, [candidate])?.source).toMatchObject({
      kind: 'skillflux-candidates', update: true,
    })
  })
})

describe('catalog footprint estimation', () => {
  it('uses a conservative UTF-8 estimate for Latin and CJK text', () => {
    expect(estimateTextTokens('abcd')).toBe(2)
    expect(estimateTextTokens('中文')).toBe(2)
    expect(estimateTextTokens('')).toBe(0)
  })

  it('includes catalog framing and respects description truncation', () => {
    const short = [{ name: 'pdf-reader', description: 'Read PDF files' }]
    const long = [{ name: 'pdf-reader', description: 'x'.repeat(1_000) }]
    expect(estimateCatalogTokens([], 160)).toBe(0)
    expect(estimateCatalogTokens(short, 160)).toBeGreaterThan(estimateTextTokens('Read PDF files'))
    expect(estimateCatalogTokens(long, 20)).toBeLessThan(estimateCatalogTokens(long, 160))
    expect(estimateCatalogTokens([...short, ...short.map(item => ({ ...item, name: 'pdf-parser' }))], 160))
      .toBeGreaterThan(estimateCatalogTokens(short, 160))
    expect(() => estimateCatalogTokens(short, 2)).toThrow('greater than or equal to 3')
  })
})
