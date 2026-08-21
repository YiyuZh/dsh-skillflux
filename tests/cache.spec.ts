import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isLoopbackProxyFailure, SkillCache } from '../src/cache.js'
import { inspectSkillDirectory } from '../src/skill-file.js'
import type { CacheManifest } from '../src/types.js'

const roots: string[] = []

async function cachedFixture(): Promise<{ root: string; id: string; directory: string; manifest: CacheManifest }> {
  const root = await mkdtemp(join(tmpdir(), 'skillflux-cache-'))
  roots.push(root)
  const id = 'a'.repeat(24)
  const directory = join(root, 'entries', id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), '---\nname: demo\ndescription: Demo cache skill\n---\nUse the demo.\n')
  const inspected = await inspectSkillDirectory(directory, { maxFiles: 10, maxBytes: 10_000 })
  const manifest: CacheManifest = {
    version: 1,
    cacheId: id,
    source: 'owner/repo',
    ref: 'b'.repeat(40),
    skillId: 'demo',
    name: 'demo',
    description: 'Demo cache skill',
    installedAt: '2026-08-21T00:00:00.000Z',
    fileCount: inspected.fileCount,
    totalBytes: inspected.totalBytes,
    contentHash: inspected.contentHash,
  }
  await writeFile(join(directory, '.skillflux.json'), `${JSON.stringify(manifest)}\n`)
  return { root, id, directory, manifest }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('persistent cache', () => {
  it('recognizes only explicit loopback proxy connection failures', () => {
    expect(isLoopbackProxyFailure({ stderr: 'Failed to connect to 127.0.0.1 port 7890: refused' })).toBe(true)
    expect(isLoopbackProxyFailure({ stderr: 'Failed to connect to proxy.example.com port 443' })).toBe(false)
    expect(isLoopbackProxyFailure({ stderr: 'Authentication failed' })).toBe(false)
  })

  it('lists and verifies an intact cache entry', async () => {
    const fixture = await cachedFixture()
    const cache = new SkillCache({ root: fixture.root, maxFiles: 10, maxBytes: 10_000, installTimeoutMs: 1_000 })
    expect((await cache.list())[0]?.manifest.cacheId).toBe(fixture.id)
    const definition = await cache.load((await cache.get(fixture.id))!)
    expect(definition.name).toBe('demo')
  })

  it('detects content modified after the manifest was written', async () => {
    const fixture = await cachedFixture()
    const cache = new SkillCache({ root: fixture.root, maxFiles: 10, maxBytes: 10_000, installTimeoutMs: 1_000 })
    await writeFile(join(fixture.directory, 'SKILL.md'), '---\nname: demo\ndescription: Demo cache skill\n---\nTampered.\n')
    await expect(cache.load((await cache.get(fixture.id))!)).rejects.toThrow('no longer match')
  })

  it('skips active entries and removes them after they are unmounted', async () => {
    const fixture = await cachedFixture()
    const cache = new SkillCache({ root: fixture.root, maxFiles: 10, maxBytes: 10_000, installTimeoutMs: 1_000 })
    expect(await cache.clean('all', new Set([fixture.id]))).toEqual({ removed: [], skipped: [fixture.id] })
    expect(await readFile(join(fixture.directory, 'SKILL.md'), 'utf8')).toContain('Use the demo')
    expect(await cache.clean(fixture.id)).toEqual({ removed: [fixture.id], skipped: [] })
    expect(await cache.get(fixture.id)).toBeUndefined()
  })
})
