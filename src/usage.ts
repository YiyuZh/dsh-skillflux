import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { lock } from 'proper-lockfile'
import type {
  SkillFluxCandidate,
  SkillUsageIdentity,
  SkillUsageRecord,
  TokenEstimatorKind,
} from './types.js'
import type { CacheUsageEvidence } from './cache-governance.js'

const USAGE_VERSION = 1
const MAX_USAGE_FILE_BYTES = 2 * 1024 * 1024
const MAX_USAGE_RECORDS = 5_000
const DAY_MS = 24 * 60 * 60 * 1_000
const CACHE_ID = /^[0-9a-f]{24}$/u

interface UsageDocument {
  readonly version: 1
  readonly records: readonly SkillUsageRecord[]
}

export interface UsageStoreOptions {
  readonly file: string
  readonly maxEntries: number
  readonly now?: () => number
  readonly warn?: (message: string) => void
}

export interface AdaptiveUsageOptions {
  readonly maxBoost: number
  readonly minUses: number
  readonly halfLifeDays: number
}

export interface SkillUsageTelemetry {
  readonly loadedBodyTokens?: number
  readonly catalogFootprintTokens?: number
  readonly estimator?: TokenEstimatorKind
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function timestamp(value: unknown): value is number | undefined {
  return value === undefined || count(value)
}

function validRecord(value: unknown): value is SkillUsageRecord {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return boundedString(item.candidateId, 512)
    && boundedString(item.name, 128)
    && (item.origin === 'registry' || item.origin === 'cache' || item.origin === 'remote' || item.origin === 'mcp')
    && boundedString(item.source, 2_048)
    && (item.cacheId === undefined || (typeof item.cacheId === 'string' && CACHE_ID.test(item.cacheId)))
    && count(item.mounts)
    && count(item.uses)
    && timestamp(item.lastMountedAt)
    && timestamp(item.lastUsedAt)
    && (item.catalogFootprintTokens === undefined || count(item.catalogFootprintTokens))
    && (item.loadedBodyTokens === undefined || count(item.loadedBodyTokens))
    && (item.totalLoadedBodyTokens === undefined || count(item.totalLoadedBodyTokens))
    && timestamp(item.lastLoadedAt)
    && (item.tokenEstimator === undefined
      || item.tokenEstimator === 'token-meter'
      || item.tokenEstimator === 'portable')
}

function validDocument(value: unknown): value is UsageDocument {
  if (typeof value !== 'object' || value === null) return false
  const document = value as Record<string, unknown>
  if (document.version !== USAGE_VERSION || !Array.isArray(document.records)) return false
  if (document.records.length > MAX_USAGE_RECORDS || !document.records.every(validRecord)) return false
  return new Set(document.records.map(record => record.candidateId)).size === document.records.length
}

function usageOrder(left: SkillUsageRecord, right: SkillUsageRecord): number {
  if (left.uses !== right.uses) return right.uses - left.uses
  if (left.mounts !== right.mounts) return right.mounts - left.mounts
  if ((left.lastUsedAt ?? 0) !== (right.lastUsedAt ?? 0)) return (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0)
  if ((left.lastMountedAt ?? 0) !== (right.lastMountedAt ?? 0)) {
    return (right.lastMountedAt ?? 0) - (left.lastMountedAt ?? 0)
  }
  return left.candidateId.localeCompare(right.candidateId, 'en')
}

function evictionOrder(left: SkillUsageRecord, right: SkillUsageRecord): number {
  const leftRecent = Math.max(left.lastUsedAt ?? 0, left.lastMountedAt ?? 0)
  const rightRecent = Math.max(right.lastUsedAt ?? 0, right.lastMountedAt ?? 0)
  if (leftRecent !== rightRecent) return leftRecent - rightRecent
  if (left.uses !== right.uses) return left.uses - right.uses
  if (left.mounts !== right.mounts) return left.mounts - right.mounts
  return left.candidateId.localeCompare(right.candidateId, 'en')
}

function identityRecord(identity: SkillUsageIdentity): SkillUsageRecord {
  if (!validRecord({ ...identity, mounts: 0, uses: 0 })) throw new Error('invalid SkillFlux usage identity')
  return { ...identity, mounts: 0, uses: 0 }
}

function increment(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + 1)
}

export class UsageStore {
  private readonly now: () => number
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly options: UsageStoreOptions) {
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1 || options.maxEntries > MAX_USAGE_RECORDS) {
      throw new Error(`usage maxEntries must be between 1 and ${MAX_USAGE_RECORDS}`)
    }
    this.now = options.now ?? Date.now
  }

  async recordMount(identity: SkillUsageIdentity): Promise<void> {
    await this.enqueue(async records => {
      const previous = records.get(identity.candidateId) ?? identityRecord(identity)
      records.set(identity.candidateId, {
        ...identityRecord(identity),
        mounts: increment(previous.mounts),
        uses: previous.uses,
        ...(previous.lastUsedAt === undefined ? {} : { lastUsedAt: previous.lastUsedAt }),
        lastMountedAt: this.currentTime(),
      })
    })
  }

  async recordUse(identity: SkillUsageIdentity): Promise<void> {
    await this.enqueue(async records => {
      const previous = records.get(identity.candidateId) ?? identityRecord(identity)
      records.set(identity.candidateId, {
        ...identityRecord(identity),
        mounts: previous.mounts,
        uses: increment(previous.uses),
        ...(previous.lastMountedAt === undefined ? {} : { lastMountedAt: previous.lastMountedAt }),
        lastUsedAt: this.currentTime(),
      })
    })
  }

  /**
   * Merge bounded token telemetry into a usage record. Only token counts are
   * stored; skill bodies and task text never reach the usage document.
   */
  async recordTelemetry(identity: SkillUsageIdentity, telemetry: SkillUsageTelemetry): Promise<void> {
    const loadedBodyTokens = telemetry.loadedBodyTokens
    if (loadedBodyTokens !== undefined && !count(loadedBodyTokens)) {
      throw new Error('invalid loaded body token estimate')
    }
    const catalogFootprintTokens = telemetry.catalogFootprintTokens
    if (catalogFootprintTokens !== undefined && !count(catalogFootprintTokens)) {
      throw new Error('invalid catalog footprint token estimate')
    }
    if (telemetry.estimator !== undefined
      && telemetry.estimator !== 'token-meter'
      && telemetry.estimator !== 'portable') {
      throw new Error('invalid token estimator kind')
    }
    await this.enqueue(async records => {
      const previous = records.get(identity.candidateId) ?? identityRecord(identity)
      records.set(identity.candidateId, {
        ...identityRecord(identity),
        mounts: previous.mounts,
        uses: previous.uses,
        ...(previous.lastMountedAt === undefined ? {} : { lastMountedAt: previous.lastMountedAt }),
        ...(previous.lastUsedAt === undefined ? {} : { lastUsedAt: previous.lastUsedAt }),
        ...(previous.catalogFootprintTokens === undefined
          ? {}
          : { catalogFootprintTokens: previous.catalogFootprintTokens }),
        ...(previous.loadedBodyTokens === undefined ? {} : { loadedBodyTokens: previous.loadedBodyTokens }),
        ...(previous.totalLoadedBodyTokens === undefined
          ? {}
          : { totalLoadedBodyTokens: previous.totalLoadedBodyTokens }),
        ...(previous.lastLoadedAt === undefined ? {} : { lastLoadedAt: previous.lastLoadedAt }),
        ...(previous.tokenEstimator === undefined ? {} : { tokenEstimator: previous.tokenEstimator }),
        ...(loadedBodyTokens === undefined
          ? {}
          : {
              loadedBodyTokens,
              totalLoadedBodyTokens: Math.min(
                Number.MAX_SAFE_INTEGER,
                (previous.totalLoadedBodyTokens ?? 0) + loadedBodyTokens,
              ),
              lastLoadedAt: this.currentTime(),
            }),
        ...(catalogFootprintTokens === undefined ? {} : { catalogFootprintTokens }),
        ...(telemetry.estimator === undefined ? {} : { tokenEstimator: telemetry.estimator }),
      })
    })
  }

  async list(limit = this.options.maxEntries): Promise<SkillUsageRecord[]> {
    await this.writeQueue
    const records = await this.readLatest()
    return [...records.values()]
      .sort(usageOrder)
      .slice(0, Math.max(0, Math.min(limit, this.options.maxEntries)))
      .map(record => ({ ...record }))
  }

  async cacheEvidence(): Promise<CacheUsageEvidence[]> {
    await this.writeQueue
    const records = await this.readLatest()
    return [...records.values()].map(record => ({
      source: record.source,
      name: record.name,
      ...(record.cacheId === undefined ? {} : { cacheId: record.cacheId }),
      mounts: record.mounts,
      uses: record.uses,
      ...(record.lastMountedAt === undefined ? {} : { lastMountedAt: record.lastMountedAt }),
      ...(record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt }),
      ...(record.totalLoadedBodyTokens === undefined
        ? {}
        : { totalLoadedBodyTokens: record.totalLoadedBodyTokens }),
    }))
  }

  async boosts(
    candidates: readonly SkillFluxCandidate[],
    options: AdaptiveUsageOptions,
  ): Promise<ReadonlyMap<string, number>> {
    if (!Number.isSafeInteger(options.maxBoost) || options.maxBoost < 0 || options.maxBoost > 20) {
      throw new Error('adaptive maxBoost must be an integer from 0 to 20')
    }
    if (!Number.isSafeInteger(options.minUses) || options.minUses < 1 || options.minUses > 1_000) {
      throw new Error('adaptive minUses must be an integer from 1 to 1000')
    }
    if (!Number.isFinite(options.halfLifeDays) || options.halfLifeDays < 0.1 || options.halfLifeDays > 3_650) {
      throw new Error('adaptive halfLifeDays must be from 0.1 to 3650')
    }
    await this.writeQueue
    const records = await this.readLatest()
    const result = new Map<string, number>()
    const now = this.currentTime()
    for (const candidate of candidates) {
      const record = records.get(candidate.id)
      if (record === undefined || record.uses < options.minUses || record.lastUsedAt === undefined) continue
      const frequency = 1 - Math.exp(-record.uses / 4)
      const ageDays = Math.max(0, now - record.lastUsedAt) / DAY_MS
      const recency = 0.5 ** (ageDays / options.halfLifeDays)
      const boost = Math.round(options.maxBoost * frequency * recency)
      if (boost > 0) result.set(candidate.id, Math.min(boost, options.maxBoost))
    }
    return result
  }

  async flush(): Promise<void> {
    await this.writeQueue
  }

  private async enqueue(update: (records: Map<string, SkillUsageRecord>) => Promise<void>): Promise<void> {
    const task = this.writeQueue.then(async () => await this.withFileLock(async signal => {
      const records = await this.readDocument()
      signal.throwIfAborted()
      await update(records)
      signal.throwIfAborted()
      this.trim(records)
      await this.save(records, signal)
    }))
    this.writeQueue = task.catch(() => undefined)
    await task
  }

  private async readLatest(): Promise<Map<string, SkillUsageRecord>> {
    return await this.withFileLock(async signal => {
      const records = await this.readDocument()
      signal.throwIfAborted()
      this.trim(records)
      return records
    })
  }

  private async readDocument(): Promise<Map<string, SkillUsageRecord>> {
    try {
      const metadata = await stat(this.options.file)
      if (!metadata.isFile() || metadata.size > MAX_USAGE_FILE_BYTES) {
        this.warn(`SkillFlux usage data is invalid or exceeds ${MAX_USAGE_FILE_BYTES} bytes; starting with empty statistics.`)
        return new Map()
      }
      const parsed = JSON.parse(await readFile(this.options.file, 'utf8')) as unknown
      if (!validDocument(parsed)) {
        this.warn('SkillFlux usage data failed validation; starting with empty statistics.')
        return new Map()
      }
      return new Map(parsed.records.map(record => [record.candidateId, { ...record }]))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
      this.warn(`SkillFlux usage data could not be read; starting with empty statistics: ${errorMessage(error)}`)
      return new Map()
    }
  }

  private trim(records: Map<string, SkillUsageRecord>): void {
    const excess = records.size - this.options.maxEntries
    if (excess <= 0) return
    for (const record of [...records.values()].sort(evictionOrder).slice(0, excess)) records.delete(record.candidateId)
  }

  private async save(records: Map<string, SkillUsageRecord>, signal?: AbortSignal): Promise<void> {
    const directory = dirname(this.options.file)
    const temporary = join(directory, `.${basename(this.options.file)}.${randomUUID()}.tmp`)
    const serialized = this.serializeWithinLimit(records)
    signal?.throwIfAborted()
    await mkdir(directory, { recursive: true })
    try {
      signal?.throwIfAborted()
      await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx' })
      signal?.throwIfAborted()
      await rename(temporary, this.options.file)
      signal?.throwIfAborted()
    } catch (error: unknown) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  private async withFileLock<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    await mkdir(dirname(this.options.file), { recursive: true })
    const controller = new AbortController()
    let compromised: Error | undefined
    const release = await lock(this.options.file, {
      realpath: false,
      stale: 10_000,
      update: 5_000,
      retries: { retries: 50, factor: 1, minTimeout: 100, maxTimeout: 100, randomize: true },
      onCompromised: error => {
        compromised = error
        controller.abort(error)
      },
    })
    let result: T | undefined
    let operationError: unknown
    try {
      controller.signal.throwIfAborted()
      result = await operation(controller.signal)
      controller.signal.throwIfAborted()
    } catch (error: unknown) {
      operationError = error
    }
    let releaseError: unknown
    try {
      await release()
    } catch (error: unknown) {
      releaseError = error
    }
    if (compromised !== undefined) {
      throw new Error(`SkillFlux usage lock was compromised: ${errorMessage(compromised)}`, { cause: compromised })
    }
    if (operationError !== undefined) throw operationError
    if (releaseError !== undefined) throw releaseError
    return result as T
  }

  private serializeWithinLimit(records: Map<string, SkillUsageRecord>): string {
    const prefix = `{"version":${USAGE_VERSION},"records":[`
    const suffix = ']}\n'
    let bytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix)
    const kept = new Map<string, string>()
    for (const record of [...records.values()].sort((left, right) => evictionOrder(right, left))) {
      const serialized = JSON.stringify(record)
      const nextBytes = Buffer.byteLength(serialized) + (kept.size === 0 ? 0 : 1)
      if (bytes + nextBytes > MAX_USAGE_FILE_BYTES) continue
      kept.set(record.candidateId, serialized)
      bytes += nextBytes
    }
    for (const candidateId of records.keys()) if (!kept.has(candidateId)) records.delete(candidateId)
    const body = [...kept.entries()]
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([, serialized]) => serialized)
      .join(',')
    return `${prefix}${body}${suffix}`
  }

  private warn(message: string): void {
    this.options.warn?.(message)
  }

  private currentTime(): number {
    const value = this.now()
    if (!count(value)) throw new Error('usage clock must return a non-negative safe integer')
    return value
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
