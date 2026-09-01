import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { materializeVerifiedRemoteSkill, verifyUniqueRemoteSkill } from '../src/remote-source.js'

const ref = 'a'.repeat(40)
const markdown = '---\nname: pdf-reader\ndescription: Read PDF documents\n---\nUse the PDF reader.\n'
const roots: string[] = []

function gitBlobSha(content: string | Buffer): string {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

function treeBlob(path: string, content: string | Buffer, mode = '100644') {
  return { path, type: 'blob', mode, sha: gitBlobSha(content), size: Buffer.byteLength(content) }
}

function blob(content: string | Buffer, sha = gitBlobSha(content)): Response {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
  return new Response(JSON.stringify({
    content: bytes.toString('base64'), encoding: 'base64', size: bytes.length, sha,
  }), { status: 200 })
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })))
})

function sourceCandidate(path?: string) {
  return {
    source: 'owner/repo', ref, skillId: 'pdf-reader',
    ...(path === undefined ? {} : {
      path,
      skillFileHash: createHash('sha256').update(markdown).digest('hex'),
    }),
  }
}

describe('remote source uniqueness verification', () => {
  it('binds a candidate to its single pinned path and selected directory files', async () => {
    const notes = 'PDF notes\n'
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/git/trees/')) {
        return new Response(JSON.stringify({
          truncated: false,
          tree: [
            treeBlob('skills/pdf-reader/SKILL.md', markdown),
            treeBlob('skills/pdf-reader/references/notes.md', notes),
            treeBlob('README.md', 'Repository readme\n'),
          ],
        }), { status: 200 })
      }
      expect(url).toBe(`https://api.github.com/repos/owner/repo/git/blobs/${gitBlobSha(markdown)}`)
      return blob(markdown)
    }))
    await expect(verifyUniqueRemoteSkill(sourceCandidate())).resolves.toEqual({
      path: 'skills/pdf-reader/SKILL.md',
      skillFileHash: createHash('sha256').update(markdown).digest('hex'),
      files: [
        { path: 'SKILL.md', sha: gitBlobSha(markdown), size: Buffer.byteLength(markdown) },
        { path: 'references/notes.md', sha: gitBlobSha(notes), size: Buffer.byteLength(notes) },
      ],
    })
  })

  it('rejects equal same-name entry files at multiple repository paths', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => String(input).includes('/git/trees/')
      ? new Response(JSON.stringify({
          truncated: false,
          tree: [treeBlob('skills/a/SKILL.md', markdown), treeBlob('skills/b/SKILL.md', markdown)],
        }), { status: 200 })
      : blob(markdown)))
    await expect(verifyUniqueRemoteSkill(sourceCandidate())).rejects.toThrow(
      'contains 2 usable Skills named "pdf-reader"',
    )
  })

  it('rejects a symbolic link anywhere in the selected Skill directory', async () => {
    const link = '../../outside'
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => String(input).includes('/git/trees/')
      ? new Response(JSON.stringify({
          truncated: false,
          tree: [treeBlob('skills/pdf-reader/SKILL.md', markdown), treeBlob('skills/pdf-reader/link', link, '120000')],
        }), { status: 200 })
      : blob(markdown)))
    await expect(verifyUniqueRemoteSkill(sourceCandidate())).rejects.toThrow('unsupported symbolic link')
  })

  it('fails closed when GitHub cannot provide a complete pinned tree', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      truncated: true, tree: [treeBlob('skills/pdf-reader/SKILL.md', markdown)],
    }), { status: 200 })))
    await expect(verifyUniqueRemoteSkill(sourceCandidate('skills/pdf-reader/SKILL.md'))).rejects.toThrow(
      'cannot prove remote Skill uniqueness',
    )
  })

  it.each([
    {
      label: 'missing truncated marker',
      payload: { tree: [treeBlob('skills/pdf-reader/SKILL.md', markdown)] },
    },
    {
      label: 'malformed competing SKILL item',
      payload: {
        truncated: false,
        tree: [treeBlob('skills/pdf-reader/SKILL.md', markdown), { path: 'skills/other/SKILL.md' }],
      },
    },
  ])('fails closed for an invalid GitHub tree: $label', async ({ payload }) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })))
    await expect(verifyUniqueRemoteSkill(sourceCandidate())).rejects.toThrow(
      'cannot prove remote Skill uniqueness',
    )
  })

  it('fails closed for malformed GitHub blob content', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => String(input).includes('/git/trees/')
      ? new Response(JSON.stringify({
          truncated: false, tree: [treeBlob('skills/pdf-reader/SKILL.md', markdown)],
        }), { status: 200 })
      : new Response(JSON.stringify({
          content: 'not base64!', encoding: 'base64', size: 1, sha: gitBlobSha(markdown),
        }), { status: 200 })))
    await expect(verifyUniqueRemoteSkill(sourceCandidate())).rejects.toThrow('invalid base64')
  })

  it('recomputes and enforces the Git blob SHA', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => String(input).includes('/git/trees/')
      ? new Response(JSON.stringify({
          truncated: false, tree: [treeBlob('skills/pdf-reader/SKILL.md', markdown)],
        }), { status: 200 })
      : blob('tampered', gitBlobSha(markdown))))
    await expect(verifyUniqueRemoteSkill(sourceCandidate())).rejects.toThrow('does not match its tree blob SHA')
  })
})

describe('verified remote Skill materialization', () => {
  it('downloads nested target files without downloading a sibling Skill', async () => {
    const notes = 'PDF notes\n'
    const contents = new Map([[gitBlobSha(markdown), markdown], [gitBlobSha(notes), notes]])
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const content = contents.get(String(input).split('/').at(-1)!)
      return content === undefined ? new Response(null, { status: 404 }) : blob(content)
    }))
    const root = await mkdtemp(join(tmpdir(), 'skillflux-materialize-'))
    roots.push(root)
    await materializeVerifiedRemoteSkill(sourceCandidate(), {
      path: 'skills/pdf-reader/SKILL.md',
      skillFileHash: createHash('sha256').update(markdown).digest('hex'),
      files: [
        { path: 'SKILL.md', sha: gitBlobSha(markdown), size: Buffer.byteLength(markdown) },
        { path: 'references/notes.md', sha: gitBlobSha(notes), size: Buffer.byteLength(notes) },
      ],
    }, root, { maxFiles: 2, maxBytes: 10_000 })
    expect(await readFile(join(root, 'SKILL.md'), 'utf8')).toBe(markdown)
    expect(await readFile(join(root, 'references', 'notes.md'), 'utf8')).toBe(notes)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2)
  })

  it.each([
    { maxFiles: 1, maxBytes: 10_000, message: '1-file' },
    { maxFiles: 2, maxBytes: 1, message: '1-byte' },
  ])('rejects declared limits before making a request: $message', async limits => {
    const root = await mkdtemp(join(tmpdir(), 'skillflux-materialize-limit-'))
    roots.push(root)
    vi.stubGlobal('fetch', vi.fn())
    await expect(materializeVerifiedRemoteSkill(sourceCandidate(), {
      path: 'skills/pdf-reader/SKILL.md',
      skillFileHash: createHash('sha256').update(markdown).digest('hex'),
      files: [
        { path: 'SKILL.md', sha: gitBlobSha(markdown), size: Buffer.byteLength(markdown) },
        { path: 'notes.md', sha: gitBlobSha('notes'), size: 5 },
      ],
    }, root, limits)).rejects.toThrow('installation limit')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects traversal metadata before creating the destination', async () => {
    const root = join(tmpdir(), `skillflux-materialize-traversal-${Date.now()}`)
    vi.stubGlobal('fetch', vi.fn())
    await expect(materializeVerifiedRemoteSkill(sourceCandidate(), {
      path: 'skills/pdf-reader/SKILL.md',
      skillFileHash: createHash('sha256').update(markdown).digest('hex'),
      files: [{ path: '../outside', sha: gitBlobSha(markdown), size: Buffer.byteLength(markdown) }],
    }, root, { maxFiles: 1, maxBytes: 10_000 })).rejects.toThrow('invalid file metadata')
    expect(fetch).not.toHaveBeenCalled()
  })
})
