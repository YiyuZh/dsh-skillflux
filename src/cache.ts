import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { access, mkdir, readFile, readdir, rename, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { inspectSkillDirectory } from './skill-file.js'
import { planCachePrune, type CachePrunePlan, type CachePrunePolicy, type CacheUsageEvidence } from './cache-governance.js'
import type { CacheEntry, CacheManifest, RemoteCandidate } from './types.js'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'

const execFileAsync = promisify(execFile)
const MANIFEST_NAME = '.skillflux.json'
const CACHE_ID = /^[0-9a-f]{24}$/u
const PROCESS_INSTANCE_KEY = Symbol.for('dsh-skillflux.process-instance-id')
const PROCESS_LIVE_LEASES_KEY = Symbol.for('dsh-skillflux.process-live-leases')
const processScope = globalThis as typeof globalThis & Record<symbol, unknown>
const existingProcessInstanceId = processScope[PROCESS_INSTANCE_KEY]
const PROCESS_INSTANCE_ID = typeof existingProcessInstanceId === 'string'
  ? existingProcessInstanceId
  : randomUUID()
processScope[PROCESS_INSTANCE_KEY] = PROCESS_INSTANCE_ID
const existingLiveLeases = processScope[PROCESS_LIVE_LEASES_KEY]
const PROCESS_LIVE_LEASE_IDS: Set<string> = existingLiveLeases instanceof Set
  ? existingLiveLeases as Set<string>
  : new Set<string>()
processScope[PROCESS_LIVE_LEASES_KEY] = PROCESS_LIVE_LEASE_IDS
const ACTIVE_LEASE_HEARTBEAT_MS = 30_000
const ACTIVE_LEASE_STALE_MS = 24 * 60 * 60_000

function assertWithin(root: string, target: string): void {
  const normalizedRoot = resolve(root)
  const normalizedTarget = resolve(target)
  const pathFromRoot = relative(normalizedRoot, normalizedTarget)
  if (pathFromRoot === '' || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new Error(`refusing filesystem operation outside the SkillFlux cache: ${normalizedTarget}`)
  }
}

function cacheId(source: string, ref: string, skillId: string): string {
  return createHash('sha256').update(JSON.stringify([source, ref, skillId])).digest('hex').slice(0, 24)
}

function immutableArchiveUrl(source: string, ref: string): string {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(source)
  if (match === null || !/^[0-9a-f]{40}$/u.test(ref)) throw new Error('remote cache source is not a pinned public GitHub repository')
  const owner = match[1]
  const repository = match[2]
  if (owner === undefined || repository === undefined) throw new Error('invalid GitHub repository source')
  return `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/tar.gz/${ref}`
}

function validManifest(value: unknown): value is CacheManifest {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return item.version === 1
    && typeof item.cacheId === 'string' && CACHE_ID.test(item.cacheId)
    && typeof item.source === 'string'
    && typeof item.ref === 'string' && /^[0-9a-f]{40}$/u.test(item.ref)
    && typeof item.skillId === 'string'
    && typeof item.name === 'string'
    && typeof item.description === 'string'
    && (item.installs === undefined
      || (typeof item.installs === 'number' && Number.isSafeInteger(item.installs) && item.installs >= 0))
    && (item.qualityScore === undefined
      || (typeof item.qualityScore === 'number' && Number.isSafeInteger(item.qualityScore)
        && item.qualityScore >= 0 && item.qualityScore <= 100))
    && (item.stars === undefined
      || (typeof item.stars === 'number' && Number.isSafeInteger(item.stars) && item.stars >= 0))
    && (item.pushedAt === undefined || typeof item.pushedAt === 'string')
    && (item.discoverySources === undefined
      || (Array.isArray(item.discoverySources)
        && item.discoverySources.every(source => source === 'skills.sh' || source === 'github')))
    && typeof item.installedAt === 'string' && Number.isFinite(Date.parse(item.installedAt))
    && typeof item.fileCount === 'number'
    && Number.isSafeInteger(item.fileCount) && item.fileCount >= 1
    && typeof item.totalBytes === 'number'
    && Number.isSafeInteger(item.totalBytes) && item.totalBytes >= 0
    && typeof item.contentHash === 'string' && /^[0-9a-f]{64}$/u.test(item.contentHash)
    && (item.whenToUse === undefined || typeof item.whenToUse === 'string')
}

function skillsCliPath(): string {
  const require = createRequire(import.meta.url)
  const packagePath = require.resolve('skills/package.json')
  return join(dirname(packagePath), 'bin', 'cli.mjs')
}

function commandOutput(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error)
  const record = error as { message?: unknown; stdout?: unknown; stderr?: unknown }
  return [record.message, record.stdout, record.stderr]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
}

export function isLoopbackProxyFailure(error: unknown): boolean {
  return /Failed to connect to (?:127\.0\.0\.1|localhost) port \d+/iu.test(commandOutput(error))
}

function withoutLoopbackProxy(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    delete result[key]
  }
  const inheritedCount = Number.parseInt(environment.GIT_CONFIG_COUNT ?? '0', 10)
  const offset = Number.isSafeInteger(inheritedCount) && inheritedCount >= 0 && inheritedCount < 100
    ? inheritedCount
    : 0
  result.GIT_CONFIG_COUNT = String(offset + 2)
  result[`GIT_CONFIG_KEY_${offset}`] = 'http.proxy'
  result[`GIT_CONFIG_VALUE_${offset}`] = ''
  result[`GIT_CONFIG_KEY_${offset + 1}`] = 'https.proxy'
  result[`GIT_CONFIG_VALUE_${offset + 1}`] = ''
  return result
}

export interface CacheManagerOptions {
  readonly root: string
  readonly maxFiles: number
  readonly maxBytes: number
  readonly installTimeoutMs: number
  readonly runInstaller?: SkillInstaller
  readonly removeLeaseMarker?: (file: string, directory: string) => Promise<void>
  readonly beforeInstallCommit?: () => Promise<void>
  readonly beforeLeaseDirectoryRead?: (directory: string) => Promise<void>
}

export interface SkillInstallerInvocation {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  readonly env: NodeJS.ProcessEnv
}

export type SkillInstaller = (invocation: SkillInstallerInvocation) => Promise<void>

export interface CacheInventoryStats {
  readonly entries: number
  readonly totalBytes: number
  readonly invalidEntries: number
}

export class SkillCache {
  readonly root: string
  private readonly entriesRoot: string
  private readonly stagingRoot: string
  private readonly leasesRoot: string

  constructor(private readonly options: CacheManagerOptions) {
    this.root = resolve(options.root)
    this.entriesRoot = join(this.root, 'entries')
    this.stagingRoot = join(this.root, '.staging')
    this.leasesRoot = join(this.root, '.leases')
  }

  async list(): Promise<CacheEntry[]> {
    await mkdir(this.entriesRoot, { recursive: true })
    const names = await readdir(this.entriesRoot)
    const entries = await Promise.all(names.filter(name => CACHE_ID.test(name)).map(name => this.read(name)))
    return entries
      .filter((entry): entry is CacheEntry => entry !== undefined)
      .sort((left, right) => right.manifest.installedAt.localeCompare(left.manifest.installedAt, 'en'))
  }

  async get(id: string): Promise<CacheEntry | undefined> {
    if (!CACHE_ID.test(id)) return undefined
    return await this.read(id)
  }

  async find(source: string, ref: string, skillId: string): Promise<CacheEntry | undefined> {
    return await this.get(cacheId(source, ref, skillId))
  }

  async load(entry: CacheEntry, signal?: AbortSignal): Promise<SkillDefinition> {
    const inspected = await inspectSkillDirectory(entry.directory, {
      maxFiles: this.options.maxFiles,
      maxBytes: this.options.maxBytes,
    }, signal)
    if (inspected.definition.name !== entry.manifest.name) throw new Error('cached skill name no longer matches its manifest')
    if (inspected.fileCount !== entry.manifest.fileCount
      || inspected.totalBytes !== entry.manifest.totalBytes
      || inspected.contentHash !== entry.manifest.contentHash) {
      throw new Error('cached skill contents no longer match their manifest')
    }
    return inspected.definition
  }

  async install(candidate: RemoteCandidate, signal?: AbortSignal): Promise<CacheEntry> {
    signal?.throwIfAborted()
    const id = cacheId(candidate.source, candidate.ref, candidate.skillId)
    const existing = await this.get(id)
    signal?.throwIfAborted()
    if (existing !== undefined) return existing
    const staging = join(this.stagingRoot, randomUUID())
    const workspace = join(staging, 'workspace')
    const downloaded = join(workspace, '.agents', 'skills', candidate.skillId)
    const destination = join(this.entriesRoot, id)
    assertWithin(this.root, staging)
    assertWithin(this.root, destination)
    await mkdir(workspace, { recursive: true })
    try {
      const source = immutableArchiveUrl(candidate.source, candidate.ref)
      const args = [
        skillsCliPath(), 'add', source, '--skill', candidate.skillId,
        '--agent', 'codex', '--yes', '--copy',
      ]
      const baseEnvironment = {
        ...process.env,
        CI: '1',
        NO_COLOR: '1',
        SKILLS_NO_TELEMETRY: '1',
        // This bounds the transport archive, which may contain many sibling
        // skills. The selected skill is independently constrained by
        // maxSkillFiles/maxSkillBytes before it enters the cache.
        SKILLS_EXTRACT_MAX_FILES: '5000',
      }
      const execute = async (env: NodeJS.ProcessEnv): Promise<void> => {
        if (this.options.runInstaller !== undefined) {
          await this.options.runInstaller({
            executable: process.execPath,
            args,
            cwd: workspace,
            timeoutMs: this.options.installTimeoutMs,
            ...(signal === undefined ? {} : { signal }),
            env,
          })
        } else {
          await execFileAsync(process.execPath, args, {
            cwd: workspace,
            timeout: this.options.installTimeoutMs,
            maxBuffer: 2 * 1024 * 1024,
            signal,
            env,
          })
        }
      }
      try {
        await execute(baseEnvironment)
      } catch (error: unknown) {
        if (!isLoopbackProxyFailure(error)) throw error
        await rm(workspace, { recursive: true, force: true })
        await mkdir(workspace, { recursive: true })
        await execute(withoutLoopbackProxy(baseEnvironment))
      }
      await access(downloaded)
      signal?.throwIfAborted()
      if (candidate.skillFileHash !== undefined) {
        const downloadedSkill = await readFile(join(downloaded, 'SKILL.md'))
        signal?.throwIfAborted()
        const downloadedHash = createHash('sha256').update(downloadedSkill).digest('hex')
        if (downloadedHash !== candidate.skillFileHash) {
          throw new Error('downloaded SKILL.md does not match the GitHub search preview')
        }
      }
      const inspected = await inspectSkillDirectory(downloaded, {
        maxFiles: this.options.maxFiles,
        maxBytes: this.options.maxBytes,
      }, signal)
      signal?.throwIfAborted()
      if (inspected.definition.name !== candidate.skillId) {
        throw new Error(`downloaded skill name "${inspected.definition.name}" does not match "${candidate.skillId}"`)
      }
      const manifest: CacheManifest = {
        version: 1,
        cacheId: id,
        source: candidate.source,
        ref: candidate.ref,
        skillId: candidate.skillId,
        name: inspected.definition.name,
        description: inspected.definition.description,
        ...(inspected.definition.whenToUse === undefined ? {} : { whenToUse: inspected.definition.whenToUse }),
        installs: candidate.installs,
        qualityScore: candidate.qualityScore,
        stars: candidate.stars,
        ...(candidate.pushedAt === undefined ? {} : { pushedAt: candidate.pushedAt }),
        discoverySources: candidate.discoverySources,
        installedAt: new Date().toISOString(),
        fileCount: inspected.fileCount,
        totalBytes: inspected.totalBytes,
        contentHash: inspected.contentHash,
      }
      signal?.throwIfAborted()
      await writeFile(join(downloaded, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      signal?.throwIfAborted()
      await mkdir(this.entriesRoot, { recursive: true })
      await this.options.beforeInstallCommit?.()
      signal?.throwIfAborted()
      try {
        await rename(downloaded, destination)
        signal?.throwIfAborted()
      } catch (error: unknown) {
        const raced = await this.get(id)
        signal?.throwIfAborted()
        if (raced !== undefined) return raced
        throw error
      }
      return { manifest, directory: destination }
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async clean(
    selector: string,
    active: ReadonlySet<string> = new Set(),
    signal?: AbortSignal,
  ): Promise<{ removed: string[]; skipped: string[] }> {
    signal?.throwIfAborted()
    const protectedIds = new Set([...active, ...await this.activeLeaseIds(signal)])
    signal?.throwIfAborted()
    if (selector === 'all') {
      await mkdir(this.entriesRoot, { recursive: true })
      const directories = (await readdir(this.entriesRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && CACHE_ID.test(entry.name))
        .map(entry => ({ id: entry.name, directory: join(this.entriesRoot, entry.name) }))
      const removed: string[] = []
      const skipped: string[] = []
      for (const entry of directories) {
        signal?.throwIfAborted()
        if (protectedIds.has(entry.id)) {
          skipped.push(entry.id)
          continue
        }
        assertWithin(this.entriesRoot, entry.directory)
        await rm(entry.directory, { recursive: true, force: true })
        removed.push(entry.id)
      }
      signal?.throwIfAborted()
      return { removed, skipped }
    }
    const entries = [await this.get(selector)].filter((entry): entry is CacheEntry => entry !== undefined)
    if (entries.length === 0) throw new Error(`unknown cache id "${selector}"`)
    const removed: string[] = []
    const skipped: string[] = []
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (protectedIds.has(entry.manifest.cacheId)) {
        skipped.push(entry.manifest.cacheId)
        continue
      }
      assertWithin(this.entriesRoot, entry.directory)
      await rm(entry.directory, { recursive: true, force: true })
      removed.push(entry.manifest.cacheId)
    }
    signal?.throwIfAborted()
    return { removed, skipped }
  }

  async stats(): Promise<CacheInventoryStats> {
    await mkdir(this.entriesRoot, { recursive: true })
    const directories = (await readdir(this.entriesRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && CACHE_ID.test(entry.name))
    const entries = await this.list()
    return {
      entries: entries.length,
      totalBytes: entries.reduce((total, entry) => Math.min(Number.MAX_SAFE_INTEGER, total + entry.manifest.totalBytes), 0),
      invalidEntries: Math.max(0, directories.length - entries.length),
    }
  }

  async prune(
    policy: CachePrunePolicy,
    evidence: readonly CacheUsageEvidence[] = [],
    active: ReadonlySet<string> = new Set(),
    now = Date.now(),
    signal?: AbortSignal,
  ): Promise<CachePrunePlan> {
    signal?.throwIfAborted()
    const protectedIds = new Set([...active, ...await this.activeLeaseIds(signal)])
    signal?.throwIfAborted()
    const plan = planCachePrune(await this.list(), evidence, policy, protectedIds, now)
    for (const decision of plan.decisions) {
      signal?.throwIfAborted()
      const directory = join(this.entriesRoot, decision.cacheId)
      assertWithin(this.entriesRoot, directory)
      await rm(directory, { recursive: true, force: true })
    }
    signal?.throwIfAborted()
    return plan
  }

  async createActiveLease(cacheId: string): Promise<() => Promise<void>> {
    if (!CACHE_ID.test(cacheId)) throw new Error(`invalid cache lease id "${cacheId}"`)
    const directory = join(this.leasesRoot, cacheId)
    const leaseId = randomUUID()
    const file = join(directory, `${process.pid}-${leaseId}.json`)
    assertWithin(this.root, directory)
    assertWithin(this.root, file)
    await mkdir(directory, { recursive: true })
    await writeFile(file, `${JSON.stringify({
      version: 1,
      pid: process.pid,
      instanceId: PROCESS_INSTANCE_ID,
      leaseId,
      createdAt: Date.now(),
    })}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    })
    PROCESS_LIVE_LEASE_IDS.add(leaseId)
    const heartbeat = setInterval(() => {
      const now = new Date()
      void utimes(file, now, now).catch(() => undefined)
    }, ACTIVE_LEASE_HEARTBEAT_MS)
    heartbeat.unref()
    let heartbeatStopped = false
    let released = false
    return async () => {
      if (released) return
      if (!heartbeatStopped) {
        clearInterval(heartbeat)
        heartbeatStopped = true
      }
      PROCESS_LIVE_LEASE_IDS.delete(leaseId)
      if (this.options.removeLeaseMarker !== undefined) await this.options.removeLeaseMarker(file, directory)
      else await removeLeaseMarker(file, directory)
      released = true
    }
  }

  async activeLeaseIds(signal?: AbortSignal): Promise<Set<string>> {
    signal?.throwIfAborted()
    await mkdir(this.leasesRoot, { recursive: true })
    const active = new Set<string>()
    const directories = await readdir(this.leasesRoot, { withFileTypes: true })
    for (const directory of directories) {
      signal?.throwIfAborted()
      if (!directory.isDirectory() || !CACHE_ID.test(directory.name)) continue
      const leaseDirectory = join(this.leasesRoot, directory.name)
      assertWithin(this.root, leaseDirectory)
      await this.options.beforeLeaseDirectoryRead?.(leaseDirectory)
      let names: string[]
      try {
        names = await readdir(leaseDirectory)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      for (const name of names) {
        signal?.throwIfAborted()
        const file = join(leaseDirectory, name)
        assertWithin(this.root, file)
        let pid: number | undefined
        let instanceId: string | undefined
        let leaseId: string | undefined
        let heartbeatAt: number | undefined
        try {
          const [raw, metadata] = await Promise.all([readFile(file, 'utf8'), stat(file)])
          const parsed = JSON.parse(raw) as unknown
          if (typeof parsed === 'object' && parsed !== null) {
            const candidate = (parsed as Record<string, unknown>).pid
            if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0) pid = candidate
            const candidateInstance = (parsed as Record<string, unknown>).instanceId
            if (typeof candidateInstance === 'string' && candidateInstance.length > 0) instanceId = candidateInstance
            const candidateLease = (parsed as Record<string, unknown>).leaseId
            if (typeof candidateLease === 'string' && candidateLease.length > 0) leaseId = candidateLease
          }
          heartbeatAt = metadata.mtimeMs
        } catch {
          // Invalid and abandoned lease markers are removed below.
        }
        const heartbeatFresh = heartbeatAt !== undefined
          && Math.max(0, Date.now() - heartbeatAt) <= ACTIVE_LEASE_STALE_MS
        const currentInstance = pid === process.pid && instanceId === PROCESS_INSTANCE_ID
          && leaseId !== undefined && PROCESS_LIVE_LEASE_IDS.has(leaseId)
        const activeExternalProcess = pid !== undefined && pid !== process.pid
          && heartbeatFresh && processIsAlive(pid)
        if (currentInstance || activeExternalProcess) {
          active.add(directory.name)
          continue
        }
        signal?.throwIfAborted()
        await rm(file, { force: true })
      }
      await removeEmptyLeaseDirectory(leaseDirectory)
    }
    signal?.throwIfAborted()
    return active
  }

  private async read(id: string): Promise<CacheEntry | undefined> {
    if (!CACHE_ID.test(id)) return undefined
    const directory = join(this.entriesRoot, id)
    assertWithin(this.entriesRoot, directory)
    try {
      const raw = await readFile(join(directory, MANIFEST_NAME), 'utf8')
      const manifest = JSON.parse(raw) as unknown
      if (!validManifest(manifest) || manifest.cacheId !== id) return undefined
      return { manifest, directory }
    } catch {
      return undefined
    }
  }
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function removeLeaseMarker(file: string, directory: string): Promise<void> {
  await rm(file, { force: true })
  await removeEmptyLeaseDirectory(directory)
}

async function removeEmptyLeaseDirectory(directory: string): Promise<void> {
  try {
    await rmdir(directory)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
  }
}
