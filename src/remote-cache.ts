import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { candidateId } from './router.js'
import type { RemoteCandidate, RemoteDiscoveryCacheStats, RemoteDiscoveryProvider } from './types.js'

const CACHE_VERSION = 1
const MAX_CACHE_FILE_BYTES = 4 * 1024 * 1024
const MAX_CACHE_ENTRIES = 1_000
const CACHE_KEY = /^[0-9a-f]{64}$/u
const CANDIDATE_ID = /^[0-9a-f]{24}$/u
const COMMIT_SHA = /^[0-9a-f]{40}$/u
const CONTENT_HASH = /^[0-9a-f]{64}$/u
const GITHUB_SOURCE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

interface DiscoveryCacheEntry {
  readonly key: string
  readonly storedAt: number
  readonly candidates: readonly RemoteCandidate[]
}

interface DiscoveryCacheDocument {
  readonly version: 1
  readonly entries: readonly DiscoveryCacheEntry[]
}

export interface RemoteDiscoveryCacheOptions {
  readonly file: string
  readonly ttlMs: number
  readonly staleIfErrorMs: number
  readonly maxEntries: number
  readonly now?: () => number
  readonly warn?: (message: string) => void
}

export interface RemoteDiscoveryCacheHit {
  readonly state: 'fresh' | 'stale'
  readonly candidates: readonly RemoteCandidate[]
}

export type RemoteDiscoveryCacheState = 'fresh' | 'stale' | 'expired'

export function remoteDiscoveryCacheState(
  ageMs: number,
  ttlMs: number,
  staleIfErrorMs: number,
): RemoteDiscoveryCacheState {
  if (!count(ageMs) || !count(ttlMs) || !count(staleIfErrorMs)) {
    throw new Error('remote discovery cache policy inputs must be non-negative integers')
  }
  if (ttlMs === 0) return 'expired'
  if (ageMs <= ttlMs) return 'fresh'
  if (staleIfErrorMs > 0 && ageMs - ttlMs <= staleIfErrorMs) return 'stale'
  return 'expired'
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function count(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
}

function optionalCount(value: unknown): boolean {
  return value === undefined || count(value)
}

function validProviders(value: unknown): value is readonly RemoteDiscoveryProvider[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 2
    && value.every(provider => provider === 'skills.sh' || provider === 'github')
    && new Set(value).size === value.length
}

function validSkillPath(value: unknown): boolean {
  if (value === undefined) return true
  if (typeof value !== 'string' || value.length === 0 || value.length > 512
    || value.startsWith('/') || value.includes('\\')) return false
  const segments = value.split('/')
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
    && segments.at(-1)?.toLocaleLowerCase('en-US') === 'skill.md'
}

function validCandidate(value: unknown): value is RemoteCandidate {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  if (!(typeof item.id === 'string' && CANDIDATE_ID.test(item.id)
    && item.origin === 'remote'
    && boundedString(item.name, 128) && SKILL_NAME.test(item.name)
    && boundedString(item.description, 4_096)
    && typeof item.source === 'string' && GITHUB_SOURCE.test(item.source)
    && typeof item.ref === 'string' && COMMIT_SHA.test(item.ref)
    && count(item.score)
    && item.selection === 'remote-quality'
    && optionalCount(item.baseScore)
    && optionalCount(item.adaptiveBoost)
    && typeof item.skillId === 'string' && SKILL_NAME.test(item.skillId)
    && count(item.installs)
    && validProviders(item.discoverySources)
    && count(item.qualityScore, 100)
    && count(item.relevanceScore)
    && count(item.stars)
    && count(item.forks)
    && (item.pushedAt === undefined
      || (boundedString(item.pushedAt, 64) && Number.isFinite(Date.parse(item.pushedAt))))
    && (item.license === undefined || boundedString(item.license, 128))
    && typeof item.recentlyActive === 'boolean'
    && typeof item.trustedSource === 'boolean'
    && validSkillPath(item.path)
    && (item.skillFileHash === undefined
      || (typeof item.skillFileHash === 'string' && CONTENT_HASH.test(item.skillFileHash))))) return false
  const providers = item.discoverySources as readonly RemoteDiscoveryProvider[]
  return item.name === item.skillId
    && item.id === candidateId('remote', item.source as string, item.ref as string, item.skillId)
    && item.score === item.qualityScore
    && item.baseScore === item.relevanceScore
    && item.adaptiveBoost === 0
    && (!providers.includes('github')
      || (typeof item.path === 'string' && typeof item.skillFileHash === 'string'))
}

function validEntry(value: unknown): value is DiscoveryCacheEntry {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return typeof item.key === 'string' && CACHE_KEY.test(item.key)
    && count(item.storedAt)
    && Array.isArray(item.candidates)
    && item.candidates.length <= 25
    && item.candidates.every(validCandidate)
}

function validDocument(value: unknown): value is DiscoveryCacheDocument {
  if (typeof value !== 'object' || value === null) return false
  const document = value as Record<string, unknown>
  if (document.version !== CACHE_VERSION || !Array.isArray(document.entries)
    || document.entries.length > MAX_CACHE_ENTRIES || !document.entries.every(validEntry)) return false
  return new Set(document.entries.map(entry => entry.key)).size === document.entries.length
}

function cloneCandidates(candidates: readonly RemoteCandidate[]): RemoteCandidate[] {
  return candidates.map(candidate => ({
    ...candidate,
    discoverySources: [...candidate.discoverySources],
  }))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class RemoteDiscoveryCache {
  private readonly now: () => number
  private entries: Map<string, DiscoveryCacheEntry> | undefined
  private loadTask: Promise<Map<string, DiscoveryCacheEntry>> | undefined
  private writeQueue: Promise<void> = Promise.resolve()
  private cacheHits = 0
  private cacheMisses = 0
  private staleHits = 0
  private writeCount = 0

  constructor(private readonly options: RemoteDiscoveryCacheOptions) {
    if (!count(options.ttlMs)) throw new Error('remote discovery cache ttlMs must be a non-negative integer')
    if (!count(options.staleIfErrorMs)) {
      throw new Error('remote discovery cache staleIfErrorMs must be a non-negative integer')
    }
    if (!Number.isSafeInteger(options.maxEntries)
      || options.maxEntries < 1 || options.maxEntries > MAX_CACHE_ENTRIES) {
      throw new Error(`remote discovery cache maxEntries must be between 1 and ${MAX_CACHE_ENTRIES}`)
    }
    this.now = options.now ?? Date.now
  }

  get enabled(): boolean {
    return this.options.ttlMs > 0
  }

  async get(key: string): Promise<RemoteDiscoveryCacheHit | undefined> {
    if (!CACHE_KEY.test(key)) throw new Error('invalid remote discovery cache key')
    if (!this.enabled) {
      this.cacheMisses += 1
      return undefined
    }
    await this.writeQueue
    const entries = await this.load()
    const entry = entries.get(key)
    if (entry === undefined) {
      this.cacheMisses += 1
      return undefined
    }
    const age = Math.max(0, this.currentTime() - entry.storedAt)
    const state = remoteDiscoveryCacheState(age, this.options.ttlMs, this.options.staleIfErrorMs)
    if (state === 'fresh') {
      this.cacheHits += 1
      return { state: 'fresh', candidates: cloneCandidates(entry.candidates) }
    }
    if (state === 'stale') {
      this.cacheMisses += 1
      return { state: 'stale', candidates: cloneCandidates(entry.candidates) }
    }
    entries.delete(key)
    this.cacheMisses += 1
    return undefined
  }

  async put(key: string, candidates: readonly RemoteCandidate[]): Promise<void> {
    if (!CACHE_KEY.test(key)) throw new Error('invalid remote discovery cache key')
    if (!this.enabled) return
    const cloned = cloneCandidates(candidates)
    if (cloned.length > 25 || !cloned.every(validCandidate)) {
      this.warn('SkillFlux skipped invalid remote discovery cache candidates.')
      return
    }
    try {
      await this.enqueue(async entries => {
        entries.set(key, { key, storedAt: this.currentTime(), candidates: cloned })
      })
      this.writeCount += 1
    } catch (error: unknown) {
      this.warn(`SkillFlux remote discovery cache write failed open: ${errorMessage(error)}`)
    }
  }

  recordStaleHit(): void {
    this.staleHits += 1
  }

  async clear(): Promise<number> {
    await this.writeQueue
    const entries = await this.load()
    const removed = entries.size
    entries.clear()
    try {
      await unlink(this.options.file)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return removed
  }

  async stats(): Promise<RemoteDiscoveryCacheStats> {
    await this.writeQueue
    const entries = await this.load()
    return {
      enabled: this.enabled,
      entries: entries.size,
      hits: this.cacheHits,
      misses: this.cacheMisses,
      staleHits: this.staleHits,
      writes: this.writeCount,
    }
  }

  async flush(): Promise<void> {
    await this.writeQueue
  }

  private async enqueue(update: (entries: Map<string, DiscoveryCacheEntry>) => Promise<void>): Promise<void> {
    const task = this.writeQueue.then(async () => {
      const entries = await this.load()
      await update(entries)
      this.trim(entries)
      await this.save(entries)
    })
    this.writeQueue = task.catch(() => undefined)
    await task
  }

  private async load(): Promise<Map<string, DiscoveryCacheEntry>> {
    if (this.entries !== undefined) return this.entries
    if (this.loadTask !== undefined) return await this.loadTask
    this.loadTask = this.readDocument()
    try {
      this.entries = await this.loadTask
      this.trim(this.entries)
      return this.entries
    } finally {
      this.loadTask = undefined
    }
  }

  private async readDocument(): Promise<Map<string, DiscoveryCacheEntry>> {
    try {
      const metadata = await stat(this.options.file)
      if (!metadata.isFile() || metadata.size > MAX_CACHE_FILE_BYTES) {
        this.warn(`SkillFlux remote discovery cache is invalid or exceeds ${MAX_CACHE_FILE_BYTES} bytes; starting empty.`)
        return new Map()
      }
      const parsed = JSON.parse(await readFile(this.options.file, 'utf8')) as unknown
      if (!validDocument(parsed)) {
        this.warn('SkillFlux remote discovery cache failed validation; starting empty.')
        return new Map()
      }
      return new Map(parsed.entries.map(entry => [entry.key, {
        key: entry.key,
        storedAt: entry.storedAt,
        candidates: cloneCandidates(entry.candidates),
      }]))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
      this.warn(`SkillFlux remote discovery cache could not be read; starting empty: ${errorMessage(error)}`)
      return new Map()
    }
  }

  private trim(entries: Map<string, DiscoveryCacheEntry>): void {
    const excess = entries.size - this.options.maxEntries
    if (excess <= 0) return
    const oldest = [...entries.values()]
      .sort((left, right) => left.storedAt - right.storedAt || left.key.localeCompare(right.key, 'en'))
      .slice(0, excess)
    for (const entry of oldest) entries.delete(entry.key)
  }

  private async save(entries: Map<string, DiscoveryCacheEntry>): Promise<void> {
    const directory = dirname(this.options.file)
    const temporary = join(directory, `.${basename(this.options.file)}.${randomUUID()}.tmp`)
    const serialized = this.serializeWithinLimit(entries)
    await mkdir(directory, { recursive: true })
    try {
      await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, this.options.file)
    } catch (error: unknown) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  private serializeWithinLimit(entries: Map<string, DiscoveryCacheEntry>): string {
    const prefix = `{"version":${CACHE_VERSION},"entries":[`
    const suffix = ']}\n'
    let bytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix)
    const kept: Array<{ entry: DiscoveryCacheEntry; serialized: string }> = []
    for (const entry of [...entries.values()]
      .sort((left, right) => right.storedAt - left.storedAt || left.key.localeCompare(right.key, 'en'))) {
      const serialized = JSON.stringify(entry)
      const nextBytes = Buffer.byteLength(serialized) + (kept.length === 0 ? 0 : 1)
      if (bytes + nextBytes > MAX_CACHE_FILE_BYTES) continue
      kept.push({ entry, serialized })
      bytes += nextBytes
    }
    const keptKeys = new Set(kept.map(item => item.entry.key))
    for (const key of entries.keys()) if (!keptKeys.has(key)) entries.delete(key)
    const body = kept
      .sort((left, right) => left.entry.key.localeCompare(right.entry.key, 'en'))
      .map(item => item.serialized)
      .join(',')
    return `${prefix}${body}${suffix}`
  }

  private warn(message: string): void {
    this.options.warn?.(message)
  }

  private currentTime(): number {
    const value = this.now()
    if (!count(value)) throw new Error('remote discovery cache clock must return a non-negative safe integer')
    return value
  }
}
