import { access, mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isLoopbackProxyFailure, SkillCache } from '../src/cache.js'
import { SkillCache as PublishedSkillCache } from '../lib/index.js'
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

  it('persists active leases so other service instances skip mounted entries', async () => {
    const fixture = await cachedFixture()
    const cache = new SkillCache({ root: fixture.root, maxFiles: 10, maxBytes: 10_000, installTimeoutMs: 1_000 })
    const release = await cache.createActiveLease(fixture.id)
    expect(await cache.clean(fixture.id)).toEqual({ removed: [], skipped: [fixture.id] })
    await release()
    await expect(access(join(fixture.root, '.leases', fixture.id))).rejects.toThrow()
    expect(await cache.clean(fixture.id)).toEqual({ removed: [fixture.id], skipped: [] })
  })

  it('keeps a same-process lease active even when its heartbeat timestamp is old', async () => {
    const fixture = await cachedFixture()
    const cache = new SkillCache({ root: fixture.root, maxFiles: 10, maxBytes: 10_000, installTimeoutMs: 1_000 })
    const release = await cache.createActiveLease(fixture.id)
    const leaseDirectory = join(fixture.root, '.leases', fixture.id)
    const [marker] = await readdir(leaseDirectory)
    expect(marker).toBeDefined()
    const stale = new Date(Date.now() - 25 * 60 * 60_000)
    await utimes(join(leaseDirectory, marker!), stale, stale)
    expect(await cache.activeLeaseIds()).toEqual(new Set([fixture.id]))
    await release()
  })

  it('allows a failed active lease deletion to be retried', async () => {
    const fixture = await cachedFixture()
    let attempts = 0
    const cache = new SkillCache({
      root: fixture.root,
      maxFiles: 10,
      maxBytes: 10_000,
      installTimeoutMs: 1_000,
      removeLeaseMarker: async (file, directory) => {
        attempts += 1
        if (attempts === 1) throw new Error('transient lease deletion failure')
        await rm(file, { force: true })
        await rm(directory, { recursive: true, force: true })
      },
    })
    const release = await cache.createActiveLease(fixture.id)
    await expect(release()).rejects.toThrow('transient')
    await expect(release()).resolves.toBeUndefined()
    expect(attempts).toBe(2)
    expect(await cache.activeLeaseIds()).toEqual(new Set())
  })

  it('lets a reloaded same-process cache reclaim a retired lease marker', async () => {
    const fixture = await cachedFixture()
    const first = new SkillCache({
      root: fixture.root,
      maxFiles: 10,
      maxBytes: 10_000,
      installTimeoutMs: 1_000,
      removeLeaseMarker: async () => { throw new Error('persistent lease deletion failure') },
    })
    const release = await first.createActiveLease(fixture.id)
    await expect(release()).rejects.toThrow('persistent')
    const reloaded = new SkillCache({
      root: fixture.root, maxFiles: 10, maxBytes: 10_000, installTimeoutMs: 1_000,
    })
    expect(await reloaded.activeLeaseIds()).toEqual(new Set())
    await expect(access(join(fixture.root, '.leases', fixture.id))).rejects.toThrow()
  })

  it('ships retired lease reclamation through the published package entry', async () => {
    const fixture = await cachedFixture()
    const first = new PublishedSkillCache({
      root: fixture.root,
      maxFiles: 10,
      maxBytes: 10_000,
      installTimeoutMs: 1_000,
      removeLeaseMarker: async () => { throw new Error('published lease deletion failure') },
    })
    const release = await first.createActiveLease(fixture.id)
    await expect(release()).rejects.toThrow('published')
    const reloaded = new PublishedSkillCache({
      root: fixture.root, maxFiles: 10, maxBytes: 10_000, installTimeoutMs: 1_000,
    })
    expect(await reloaded.activeLeaseIds()).toEqual(new Set())
  })

  it('reclaims a marker from a previous process instance when its PID is reused', async () => {
    const fixture = await cachedFixture()
    const leaseDirectory = join(fixture.root, '.leases', fixture.id)
    const marker = join(leaseDirectory, `${process.pid}-orphan.json`)
    await mkdir(leaseDirectory, { recursive: true })
    await writeFile(marker, `${JSON.stringify({
      version: 1,
      pid: process.pid,
      instanceId: 'previous-process-instance',
      createdAt: Date.now(),
    })}\n`)
    const cache = new SkillCache({ root: fixture.root, maxFiles: 10, maxBytes: 10_000, installTimeoutMs: 1_000 })
    expect(await cache.activeLeaseIds()).toEqual(new Set())
    await expect(access(leaseDirectory)).rejects.toThrow()
  })

  it('treats a lease directory removed during scanning as already empty', async () => {
    const fixture = await cachedFixture()
    const leaseDirectory = join(fixture.root, '.leases', fixture.id)
    await mkdir(leaseDirectory, { recursive: true })
    await writeFile(join(leaseDirectory, 'abandoned.json'), '{}\n')
    const cache = new SkillCache({
      root: fixture.root,
      maxFiles: 10,
      maxBytes: 10_000,
      installTimeoutMs: 1_000,
      beforeLeaseDirectoryRead: async directory => { await rm(directory, { recursive: true, force: true }) },
    })
    await expect(cache.activeLeaseIds()).resolves.toEqual(new Set())
  })

  it('executes a governance plan against the persistent cache', async () => {
    const fixture = await cachedFixture()
    const cache = new SkillCache({ root: fixture.root, maxFiles: 10, maxBytes: 10_000, installTimeoutMs: 1_000 })
    const plan = await cache.prune({ maxEntries: 10, maxTotalBytes: 10_000, maxIdleMs: 1 }, [], new Set(), Date.parse('2026-08-22T00:00:00.000Z'))
    expect(plan.decisions).toEqual([{ cacheId: fixture.id, reason: 'idle' }])
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
    expect(await cache.stats()).toEqual({ entries: 0, totalBytes: 0, invalidEntries: 1 })
    expect(await cache.clean('all')).toEqual({ removed: [id], skipped: [] })
    await expect(access(directory)).rejects.toThrow()
  })

  it('does not commit an installed entry after its coordination signal aborts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillflux-cache-abort-commit-'))
    roots.push(root)
    const controller = new AbortController()
    const downloadedMarkdown = '---\nname: demo\ndescription: Abort commit fixture\n---\nStop before commit.\n'
    const cache = new SkillCache({
      root,
      maxFiles: 10,
      maxBytes: 10_000,
      installTimeoutMs: 1_000,
      verifyCandidate: async () => ({
        path: 'skills/demo/SKILL.md',
        skillFileHash: createHash('sha256').update(downloadedMarkdown).digest('hex'),
      }),
      runInstaller: async invocation => {
        const directory = join(invocation.cwd, '.agents', 'skills', 'demo')
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'SKILL.md'), downloadedMarkdown)
      },
      beforeInstallCommit: async () => { controller.abort(new Error('cache coordination compromised')) },
    })
    const candidate: RemoteCandidate = {
      id: 'abort-commit',
      origin: 'remote',
      name: 'demo',
      description: 'Abort commit fixture',
      source: 'owner/repo',
      ref: 'd'.repeat(40),
      score: 1,
      skillId: 'demo',
      installs: 0,
      discoverySources: ['github'],
      qualityScore: 50,
      relevanceScore: 100,
      stars: 0,
      forks: 0,
      recentlyActive: true,
      trustedSource: false,
      trustLevel: 'community',
      qualityBreakdown: { relevance: 50, adoption: 0, repository: 0, freshness: 0, trust: 0, provenance: 0, total: 50 },
      qualitySignals: ['content-pinned'],
      qualityWarnings: [],
    }
    await expect(cache.install(candidate, controller.signal)).rejects.toThrow('cache coordination compromised')
    expect(await cache.list()).toEqual([])
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
      trustLevel: 'community',
      qualityBreakdown: { relevance: 55, adoption: 4, repository: 5, freshness: 4, trust: 0, provenance: 4, total: 72 },
      qualitySignals: ['content-pinned'],
      qualityWarnings: [],
      skillFileHash: createHash('sha256').update(downloadedMarkdown).digest('hex'),
    }
    const invocations: Array<{ args: readonly string[]; cwd: string; timeoutMs: number }> = []
    const cache = new SkillCache({
      root,
      maxFiles: 10,
      maxBytes: 10_000,
      installTimeoutMs: 1_234,
      verifyCandidate: async () => ({
        path: 'skills/demo/SKILL.md',
        skillFileHash: candidate.skillFileHash!,
      }),
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
      trustLevel: 'community', sourcePath: 'skills/demo/SKILL.md',
      sourceSkillFileHash: candidate.skillFileHash,
    })
    expect(cacheCandidates([installed])[0]).toMatchObject({ name: 'demo', installs: 42, trustLevel: 'community' })
    expect((await cache.load(installed)).content).toContain('Use the remote demo')
  })

  it('rejects an installed SKILL.md that differs from its unique pinned source', async () => {
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
      trustLevel: 'community',
      qualityBreakdown: { relevance: 55, adoption: 0, repository: 5, freshness: 6, trust: 0, provenance: 4, total: 70 },
      qualitySignals: ['content-pinned'],
      qualityWarnings: [],
      skillFileHash: '0'.repeat(64),
    }
    const cache = new SkillCache({
      root,
      maxFiles: 10,
      maxBytes: 10_000,
      installTimeoutMs: 1_000,
      verifyCandidate: async () => ({ path: 'skills/demo/SKILL.md', skillFileHash: candidate.skillFileHash! }),
      runInstaller: async invocation => {
        const downloaded = join(invocation.cwd, '.agents', 'skills', 'demo')
        await mkdir(downloaded, { recursive: true })
        await writeFile(join(downloaded, 'SKILL.md'), '---\nname: demo\ndescription: Changed\n---\nChanged.\n')
      },
    })
    await expect(cache.install(candidate)).rejects.toThrow('does not match the unique pinned GitHub source')
  })

  it('times out a non-cooperative verifier and remains usable for the next install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillflux-cache-verifier-timeout-'))
    roots.push(root)
    const downloadedMarkdown = '---\nname: demo\ndescription: Timeout recovery\n---\nRecover after timeout.\n'
    const sourceHash = createHash('sha256').update(downloadedMarkdown).digest('hex')
    let verifierHangs = true
    let verifierCalls = 0
    const cache = new SkillCache({
      root,
      maxFiles: 10,
      maxBytes: 10_000,
      // The recovery attempt also needs time for real filesystem operations.
      installTimeoutMs: 1_000,
      verifyCandidate: async () => {
        verifierCalls += 1
        return verifierHangs
          ? await new Promise(() => undefined)
          : { path: 'skills/demo/SKILL.md', skillFileHash: sourceHash }
      },
      runInstaller: async invocation => {
        const downloaded = join(invocation.cwd, '.agents', 'skills', 'demo')
        await mkdir(downloaded, { recursive: true })
        await writeFile(join(downloaded, 'SKILL.md'), downloadedMarkdown)
      },
    })
    const candidate: RemoteCandidate = {
      id: 'remote-timeout', origin: 'remote', name: 'demo', description: 'Timeout recovery',
      source: 'owner/repo', ref: 'f'.repeat(40), score: 70, skillId: 'demo', installs: 0,
      discoverySources: ['skills.sh'], qualityScore: 70, relevanceScore: 100, stars: 1, forks: 0,
      recentlyActive: true, trustedSource: false, trustLevel: 'community',
      qualityBreakdown: { relevance: 55, adoption: 0, repository: 1, freshness: 10, trust: 2, provenance: 0, total: 68 },
      qualitySignals: ['recent-activity'], qualityWarnings: ['single-source', 'content-not-previewed'],
    }
    await expect(cache.install(candidate)).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(verifierCalls).toBe(1)
    expect(await cache.list()).toEqual([])
    verifierHangs = false
    await expect(cache.install(candidate)).resolves.toMatchObject({
      manifest: { name: 'demo', sourcePath: 'skills/demo/SKILL.md', sourceSkillFileHash: sourceHash },
    })
    expect(verifierCalls).toBe(2)
  })
})
