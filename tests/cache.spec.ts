import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isLoopbackProxyFailure, SkillCache } from '../src/cache.js'
import { inspectSkillDirectory } from '../src/skill-file.js'
import { cacheCandidates } from '../src/router.js'
import type { CacheManifest, RemoteCandidate } from '../src/types.js'

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

  it('removes corrupt cache directories with clean all', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillflux-cache-corrupt-'))
    roots.push(root)
    const id = 'c'.repeat(24)
    const directory = join(root, 'entries', id)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, '.skillflux.json'), '{not-json}\n')
    const cache = new SkillCache({ root, maxFiles: 10, maxBytes: 10_000, installTimeoutMs: 1_000 })
    expect(await cache.list()).toEqual([])
    expect(await cache.clean('all')).toEqual({ removed: [id], skipped: [] })
    await expect(access(directory)).rejects.toThrow()
  })

  it('uses the pinned installer contract and retries a loopback proxy failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillflux-cache-install-'))
    roots.push(root)
    const downloadedMarkdown = '---\nname: demo\ndescription: Demo remote skill\n---\nUse the remote demo.\n'
    const candidate: RemoteCandidate = {
      id: 'remote-demo',
      origin: 'remote',
      name: 'demo',
      description: 'Demo remote skill',
      source: 'owner/repo',
      ref: 'd'.repeat(40),
      score: 1,
      skillId: 'demo',
      installs: 42,
      discoverySources: ['github'],
      qualityScore: 72,
      relevanceScore: 100,
      stars: 120,
      forks: 8,
      pushedAt: '2026-08-20T00:00:00Z',
      license: 'MIT',
      recentlyActive: true,
      trustedSource: false,
      skillFileHash: createHash('sha256').update(downloadedMarkdown).digest('hex'),
    }
    const invocations: Array<{ args: readonly string[]; cwd: string; timeoutMs: number }> = []
    const cache = new SkillCache({
      root,
      maxFiles: 10,
      maxBytes: 10_000,
      installTimeoutMs: 1_234,
      runInstaller: async invocation => {
        invocations.push({ args: invocation.args, cwd: invocation.cwd, timeoutMs: invocation.timeoutMs })
        if (invocations.length === 1) throw { stderr: 'Failed to connect to localhost port 7890: refused' }
        const downloaded = join(invocation.cwd, '.agents', 'skills', 'demo')
        await mkdir(downloaded, { recursive: true })
        await writeFile(join(downloaded, 'SKILL.md'), downloadedMarkdown)
      },
    })
    const installed = await cache.install(candidate)
    expect(invocations).toHaveLength(2)
    expect(invocations[1]?.args.slice(1)).toEqual([
      'add',
      `https://codeload.github.com/owner/repo/tar.gz/${candidate.ref}`,
      '--skill', 'demo', '--agent', 'codex', '--yes', '--copy',
    ])
    expect(invocations[1]?.timeoutMs).toBe(1_234)
    expect(installed.manifest).toMatchObject({
      source: 'owner/repo', ref: candidate.ref, skillId: 'demo', name: 'demo', installs: 42,
    })
    expect(cacheCandidates([installed])[0]).toMatchObject({ name: 'demo', installs: 42 })
    expect((await cache.load(installed)).content).toContain('Use the remote demo')
  })

  it('rejects an installed SKILL.md that differs from its GitHub search preview', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillflux-cache-preview-'))
    roots.push(root)
    const candidate: RemoteCandidate = {
      id: 'remote-preview',
      origin: 'remote',
      name: 'demo',
      description: 'Demo remote skill',
      source: 'owner/repo',
      ref: 'e'.repeat(40),
      score: 70,
      skillId: 'demo',
      installs: 0,
      discoverySources: ['github'],
      qualityScore: 70,
      relevanceScore: 100,
      stars: 100,
      forks: 5,
      recentlyActive: true,
      trustedSource: false,
      skillFileHash: '0'.repeat(64),
    }
    const cache = new SkillCache({
      root,
      maxFiles: 10,
      maxBytes: 10_000,
      installTimeoutMs: 1_000,
      runInstaller: async invocation => {
        const downloaded = join(invocation.cwd, '.agents', 'skills', 'demo')
        await mkdir(downloaded, { recursive: true })
        await writeFile(join(downloaded, 'SKILL.md'), '---\nname: demo\ndescription: Changed\n---\nChanged.\n')
      },
    })
    await expect(cache.install(candidate)).rejects.toThrow('does not match the GitHub search preview')
  })
})
