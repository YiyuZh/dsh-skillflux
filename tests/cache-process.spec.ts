import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { lock } from 'proper-lockfile'
import { SkillCache } from '../src/cache.js'
import { inspectSkillDirectory } from '../src/skill-file.js'
import type { CacheManifest } from '../src/types.js'

const roots: string[] = []
const children = new Set<ChildProcessWithoutNullStreams>()

afterEach(async () => {
  for (const child of children) child.kill()
  children.clear()
  await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }) }))
})

async function waitForLine(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  child.stdout.setEncoding('utf8')
  await new Promise<void>((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => { reject(new Error(`worker did not emit ${expected}: ${output}`)) }, 5_000)
    child.stdout.on('data', chunk => {
      output += String(chunk)
      if (!output.includes(expected)) return
      clearTimeout(timeout)
      resolve()
    })
    child.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', code => {
      if (output.includes(expected)) return
      clearTimeout(timeout)
      reject(new Error(`worker exited ${code}: ${output}`))
    })
  })
}

function worker(mode: 'lock' | 'marker', root: string, cacheId?: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('./fixtures/cache-process-worker.mjs', import.meta.url)),
    mode,
    root,
    ...(cacheId === undefined ? [] : [cacheId]),
  ], { stdio: ['pipe', 'pipe', 'pipe'] })
  children.add(child)
  return child
}

async function cacheFixture(): Promise<{ root: string; id: string }> {
  const root = await mkdtemp(join(tmpdir(), 'skillflux-process-cache-'))
  roots.push(root)
  const id = 'a'.repeat(24)
  const directory = join(root, 'entries', id)
  const markdown = '---\nname: process-skill\ndescription: Process lease fixture\n---\nUse process-skill.\n'
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), markdown, 'utf8')
  const inspected = await inspectSkillDirectory(directory, { maxFiles: 10, maxBytes: 10_000 })
  const manifest: CacheManifest = {
    version: 1,
    cacheId: id,
    source: 'owner/process',
    ref: 'b'.repeat(40),
    skillId: 'process-skill',
    name: 'process-skill',
    description: 'Process lease fixture',
    installedAt: new Date().toISOString(),
    fileCount: inspected.fileCount,
    totalBytes: inspected.totalBytes,
    contentHash: inspected.contentHash,
  }
  await writeFile(join(directory, '.skillflux.json'), `${JSON.stringify(manifest)}\n`, 'utf8')
  return { root, id }
}

describe('cross-process cache coordination', () => {
  it('waits for a cache operation lock held by another process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillflux-process-lock-'))
    roots.push(root)
    const child = worker('lock', root)
    await waitForLine(child, 'LOCKED')
    let acquired = false
    const waiting = lock(root, {
      realpath: false,
      retries: { retries: 20, factor: 1, minTimeout: 25, maxTimeout: 25 },
    }).then(release => {
      acquired = true
      return release
    })
    await new Promise(resolve => { setTimeout(resolve, 100) })
    expect(acquired).toBe(false)
    child.stdin.end('\n')
    await once(child, 'exit')
    children.delete(child)
    const release = await waiting
    expect(acquired).toBe(true)
    await release()
  })

  it('protects a child-process active marker and reclaims it after the child exits', async () => {
    const fixture = await cacheFixture()
    const cache = new SkillCache({ root: fixture.root, maxFiles: 10, maxBytes: 10_000, installTimeoutMs: 5_000 })
    const child = worker('marker', fixture.root, fixture.id)
    await waitForLine(child, 'LEASED')
    expect(await cache.clean(fixture.id)).toEqual({ removed: [], skipped: [fixture.id] })
    child.kill()
    await once(child, 'exit')
    children.delete(child)
    expect(await cache.clean(fixture.id)).toEqual({ removed: [fixture.id], skipped: [] })
    await expect(access(join(fixture.root, '.leases', fixture.id))).rejects.toThrow()
  })
})
