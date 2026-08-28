import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyUniqueRemoteSkill } from '../src/remote-source.js'

const ref = 'a'.repeat(40)
const markdown = '---\nname: pdf-reader\ndescription: Read PDF documents\n---\nUse the PDF reader.\n'

afterEach(() => {
  vi.unstubAllGlobals()
})

function sourceCandidate(path?: string) {
  return {
    source: 'owner/repo',
    ref,
    skillId: 'pdf-reader',
    ...(path === undefined ? {} : {
      path,
      skillFileHash: createHash('sha256').update(markdown).digest('hex'),
    }),
  }
}

describe('remote source uniqueness verification', () => {
  it('binds a skills.sh-only candidate to its single pinned repository path', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/git/trees/')) {
        return new Response(JSON.stringify({
          truncated: false,
          tree: [
            { path: 'skills/pdf-reader/SKILL.md', type: 'blob' },
            { path: 'README.md', type: 'blob' },
          ],
        }), { status: 200 })
      }
      return new Response(markdown, { status: 200 })
    }))
    await expect(verifyUniqueRemoteSkill(sourceCandidate())).resolves.toEqual({
      path: 'skills/pdf-reader/SKILL.md',
      skillFileHash: createHash('sha256').update(markdown).digest('hex'),
    })
  })

  it('rejects equal same-name entry files at multiple repository paths', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/git/trees/')) {
        return new Response(JSON.stringify({
          truncated: false,
          tree: [
            { path: 'skills/a/SKILL.md', type: 'blob' },
            { path: 'skills/b/SKILL.md', type: 'blob' },
          ],
        }), { status: 200 })
      }
      return new Response(markdown, { status: 200 })
    }))
    await expect(verifyUniqueRemoteSkill(sourceCandidate())).rejects.toThrow(
      'contains 2 usable Skills named "pdf-reader"',
    )
  })

  it('fails closed when GitHub cannot provide a complete pinned tree', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      truncated: true,
      tree: [{ path: 'skills/pdf-reader/SKILL.md', type: 'blob' }],
    }), { status: 200 })))
    await expect(verifyUniqueRemoteSkill(sourceCandidate('skills/pdf-reader/SKILL.md'))).rejects.toThrow(
      'cannot prove remote Skill uniqueness',
    )
  })

  it.each([
    {
      label: 'missing truncated marker',
      payload: { tree: [{ path: 'skills/pdf-reader/SKILL.md', type: 'blob' }] },
    },
    {
      label: 'malformed competing SKILL item',
      payload: {
        truncated: false,
        tree: [
          { path: 'skills/pdf-reader/SKILL.md', type: 'blob' },
          { path: 'skills/other/SKILL.md' },
        ],
      },
    },
  ])('fails closed for an invalid GitHub tree: $label', async ({ payload }) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })))
    await expect(verifyUniqueRemoteSkill(sourceCandidate())).rejects.toThrow(
      'cannot prove remote Skill uniqueness',
    )
  })
})
