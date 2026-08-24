import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { remoteCandidateMessage, updateRemoteCandidates } from '../src/catalog.js'
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
