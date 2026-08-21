import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { inspectSkillDirectory } from './skill-file.js'
import type { CacheEntry, CacheManifest, RemoteCandidate } from './types.js'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'

const execFileAsync = promisify(execFile)
const MANIFEST_NAME = '.skillflux.json'
const CACHE_ID = /^[0-9a-f]{24}$/u

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
    && typeof item.installedAt === 'string'
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
}

export class SkillCache {
  readonly root: string
  private readonly entriesRoot: string
  private readonly stagingRoot: string

  constructor(private readonly options: CacheManagerOptions) {
    this.root = resolve(options.root)
    this.entriesRoot = join(this.root, 'entries')
    this.stagingRoot = join(this.root, '.staging')
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

  async load(entry: CacheEntry): Promise<SkillDefinition> {
    const inspected = await inspectSkillDirectory(entry.directory, {
      maxFiles: this.options.maxFiles,
      maxBytes: this.options.maxBytes,
    })
    if (inspected.definition.name !== entry.manifest.name) throw new Error('cached skill name no longer matches its manifest')
    if (inspected.fileCount !== entry.manifest.fileCount
      || inspected.totalBytes !== entry.manifest.totalBytes
      || inspected.contentHash !== entry.manifest.contentHash) {
      throw new Error('cached skill contents no longer match their manifest')
    }
    return inspected.definition
  }

  async install(candidate: RemoteCandidate, signal?: AbortSignal): Promise<CacheEntry> {
    const id = cacheId(candidate.source, candidate.ref, candidate.skillId)
    const existing = await this.get(id)
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
        await execFileAsync(process.execPath, args, {
          cwd: workspace,
          timeout: this.options.installTimeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          signal,
          env,
        })
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
      const inspected = await inspectSkillDirectory(downloaded, {
        maxFiles: this.options.maxFiles,
        maxBytes: this.options.maxBytes,
      })
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
        installedAt: new Date().toISOString(),
        fileCount: inspected.fileCount,
        totalBytes: inspected.totalBytes,
        contentHash: inspected.contentHash,
      }
      await writeFile(join(downloaded, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      await mkdir(this.entriesRoot, { recursive: true })
      try {
        await rename(downloaded, destination)
      } catch (error: unknown) {
        const raced = await this.get(id)
        if (raced !== undefined) return raced
        throw error
      }
      return { manifest, directory: destination }
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async clean(selector: string, active: ReadonlySet<string> = new Set()): Promise<{ removed: string[]; skipped: string[] }> {
    const entries = selector === 'all'
      ? await this.list()
      : [await this.get(selector)].filter((entry): entry is CacheEntry => entry !== undefined)
    if (selector !== 'all' && entries.length === 0) throw new Error(`unknown cache id "${selector}"`)
    const removed: string[] = []
    const skipped: string[] = []
    for (const entry of entries) {
      if (active.has(entry.manifest.cacheId)) {
        skipped.push(entry.manifest.cacheId)
        continue
      }
      assertWithin(this.entriesRoot, entry.directory)
      await rm(entry.directory, { recursive: true, force: true })
      removed.push(entry.manifest.cacheId)
    }
    return { removed, skipped }
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
