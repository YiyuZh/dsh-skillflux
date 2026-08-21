import { describe, expect, it } from 'vitest'
import { routeScore, selectCandidates, tokenize } from '../src/router.js'
import type { SkillFluxCandidate } from '../src/types.js'

function candidate(name: string, description: string, source = 'bundled'): SkillFluxCandidate {
  return {
    id: name,
    origin: 'cache',
    name,
    description,
    source,
    ref: 'a'.repeat(40),
    score: 0,
    cacheId: name.padEnd(24, '0').slice(0, 24),
  }
}

describe('router', () => {
  it('tokenizes English words and CJK bigrams without filler words', () => {
    const tokens = tokenize('Please help me 分析 PDF 文档')
    expect(tokens).toContain('pdf')
    expect(tokens).toContain('分析')
    expect(tokens).toContain('文档')
    expect(tokens).not.toContain('please')
  })

  it('weights exact names above description-only matches', () => {
    const exact = routeScore('Use pdf-reader for this file', candidate('pdf-reader', 'Read documents'))
    const description = routeScore('Read a PDF file', candidate('document-parser', 'Read PDF files'))
    expect(exact).toBeGreaterThan(description)
    expect(exact).toBeGreaterThanOrEqual(100)
  })

  it('applies ordered rules before lexical scoring and enforces the limit', () => {
    const candidates = [
      candidate('pdf-reader', 'Read PDF files'),
      candidate('document-parser', 'Parse documents'),
      candidate('markdown-converter', 'Convert to markdown'),
    ]
    const selected = selectCandidates('convert this PDF', candidates, {
      limit: 2,
      minScore: 8,
      routes: [{ matchAll: ['convert', 'pdf'], skills: ['markdown-converter'] }],
    })
    expect(selected.map(item => item.name)).toEqual(['markdown-converter', 'pdf-reader'])
    expect(selected[0]?.score).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('returns no automatic selection below the configured score', () => {
    const selected = selectCandidates('book a flight', [candidate('pdf-reader', 'Read PDF files')], {
      limit: 3,
      minScore: 8,
      routes: [],
    })
    expect(selected).toEqual([])
  })

  it('uses registry candidates before cache candidates for equal scores', () => {
    const cache = candidate('pdf-reader', 'Read PDF files', 'remote/repo')
    const registry: SkillFluxCandidate = {
      id: 'registry-pdf',
      origin: 'registry',
      name: 'pdf-local',
      description: 'Read PDF files',
      source: 'project-agents',
      score: 0,
      summary: {
        name: 'pdf-local', description: 'Read PDF files', source: 'project-agents', provider: 'filesystem',
        invocation: { modelInvocable: true, userInvocable: true },
      },
    }
    const selected = selectCandidates('read pdf', [cache, registry], { limit: 2, minScore: 1, routes: [] })
    expect(selected[0]?.origin).toBe('registry')
  })
})
