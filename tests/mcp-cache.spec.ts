import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillCache } from '../src/cache.js'
import { mcpCandidates, validateMcpSkillEntry } from '../src/mcp-source.js'
import type { McpCandidate, McpSkillEntry } from '../src/types.js'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const SKILL_CONTENT = `---
name: cache-skill
description: Cache skill
---

# Cache skill

Verified instructions.
`
const GUIDE_CONTENT = '# Guide\n'
const SKILL_URI = 'skill://cache-skill/SKILL.md'
const GUIDE_URI = 'skill://cache-skill/references/guide.md'

function digestOf(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function entry(files: ReadonlyArray<readonly [string, string]> = [['references/guide.md', GUIDE_CONTENT]]): McpSkillEntry {
  return validateMcpSkillEntry({
    uri: SKILL_URI,
    frontmatter: { name: 'cache-skill', description: 'Cache skill' },
    resources: [
      { uri: SKILL_URI, digest: digestOf(SKILL_CONTENT), size: Buffer.byteLength(SKILL_CONTENT, 'utf8') },
      ...files.map(([path, content]) => ({
        uri: `skill://cache-skill/${path}`,
        digest: digestOf(content),
        size: Buffer.byteLength(content, 'utf8'),
      })),
    ],
  })!
}

function candidateFor(value: McpSkillEntry): McpCandidate {
  return mcpCandidates('demo-server', [value])[0]!
}

async function makeCache(): Promise<SkillCache> {
  const root = await mkdtemp(join(tmpdir(), 'skillflux-mcp-cache-'))
  roots.push(root)
  return new SkillCache({
    root: join(root, 'cache', 'skillflux'),
    maxFiles: 1_000,
    maxBytes: 10 * 1024 * 1024,
    installTimeoutMs: 10_000,
  })
}

function reader(
  overrides: Record<string, { content: string }> = {},
): (uri: string) => Promise<Buffer> {
  return async (uri: string) => {
    const source = overrides[uri] ?? (uri === SKILL_URI
      ? { content: SKILL_CONTENT }
      : uri === GUIDE_URI
        ? { content: GUIDE_CONTENT }
        : { content: '' })
    return Buffer.from(source.content, 'utf8')
  }
}

describe('SkillCache MCP installation', () => {
  it('materializes, verifies, and loads a content-bound MCP skill', async () => {
    const cache = await makeCache()
    const candidate = candidateFor(entry())
    const installed = await cache.installMcp(candidate, reader())
    expect(installed.manifest).toMatchObject({
      origin: 'mcp',
      source: 'demo-server',
      ref: candidate.contentBoundKey,
      skillId: 'cache-skill',
      name: 'cache-skill',
      mcp: {
        serverLabel: 'demo-server',
        skillUri: SKILL_URI,
        contentBoundKey: candidate.contentBoundKey,
      },
    })
    expect(installed.manifest.mcp?.resources).toHaveLength(2)
    const definition = await cache.load(installed)
    expect(definition).toMatchObject({
      name: 'cache-skill',
      description: 'Cache skill',
      content: '# Cache skill\n\nVerified instructions.',
    })
    const guide = await readFile(join(installed.directory, 'references', 'guide.md'), 'utf8')
    expect(guide).toBe(GUIDE_CONTENT)
  })

  it('reuses the immutable entry id when the content set is unchanged', async () => {
    const cache = await makeCache()
    const candidate = candidateFor(entry())
    const first = await cache.installMcp(candidate, reader())
    const second = await cache.installMcp(candidate, reader())
    expect(second.manifest.cacheId).toBe(first.manifest.cacheId)
    expect(await cache.list()).toHaveLength(1)
  })

  it('refuses a size or digest mismatch on read', async () => {
    const cache = await makeCache()
    const candidate = candidateFor(entry())
    await expect(cache.installMcp(candidate, reader({
      [GUIDE_URI]: { content: 'short' },
    }))).rejects.toThrow('size changed')
    await expect(cache.installMcp(candidate, reader({
      [GUIDE_URI]: { content: '# Gxide\n' },
    }))).rejects.toThrow('digest mismatch')
  })

  it('refuses frontmatter that differs from the entry', async () => {
    const cache = await makeCache()
    const original = entry()
    const altered = validateMcpSkillEntry({
      ...original,
      frontmatter: { name: 'cache-skill', description: 'Different description' },
    })
    // The altered frontmatter must not be silently accepted even though the
    // SKILL.md bytes and digests are unchanged.
    await expect(cache.installMcp(
      mcpCandidates('demo-server', [altered!])[0]!,
      reader(),
    )).rejects.toThrow('frontmatter does not match')
  })

  it('re-verifies cached bytes against the held digests on every load', async () => {
    const cache = await makeCache()
    const candidate = candidateFor(entry())
    const installed = await cache.installMcp(candidate, reader())
    const guidePath = join(installed.directory, 'references', 'guide.md')
    await writeFile(guidePath, '# Gxide\n', 'utf8')
    await expect(cache.load(installed)).rejects.toThrow('digest mismatch')
  })

  it('lands a changed content set at a fresh cache id', async () => {
    const cache = await makeCache()
    const first = candidateFor(entry())
    const changed = entry([['references/guide.md', '# Changed guide\n']])
    const secondCandidate = mcpCandidates('demo-server', [changed])[0]!
    const firstEntry = await cache.installMcp(first, reader())
    const secondEntry = await cache.installMcp(secondCandidate, async (uri: string) => {
      if (uri === GUIDE_URI) return Buffer.from('# Changed guide\n', 'utf8')
      return Buffer.from(SKILL_CONTENT, 'utf8')
    })
    expect(secondEntry.manifest.cacheId).not.toBe(firstEntry.manifest.cacheId)
    expect(await cache.list()).toHaveLength(2)
  })
})
