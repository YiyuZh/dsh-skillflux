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

  it('does not repeat an already-visible empty replacement', () => {
    const agent = agentWithRemoteHistory([[candidate], []])
    expect(updateRemoteCandidates(agent, [])).toBeUndefined()
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
