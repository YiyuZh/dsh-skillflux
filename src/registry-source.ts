import type { RegistryTier } from './types.js'

const GITHUB_SOURCE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const GIT_REF = /^[0-9a-f]{40}$/u
const TIERS: readonly RegistryTier[] = ['official', 'verified', 'community', 'unreviewed']

export const REGISTRY_MAX_ENTRIES = 1_000
export const REGISTRY_MAX_DESCRIPTION_LENGTH = 4_096

/** One validated entry from a federated ecosystem index. */
export interface RegistryIndexEntry {
  readonly name: string
  readonly description: string
  /** Public GitHub repository, e.g. `owner/repo`. */
  readonly source: string
  /** Immutable 40-character commit that the entry is pinned to. */
  readonly ref: string
  /** Advisory ecosystem tier; evidence, never a trust grant. */
  readonly tier: RegistryTier
  readonly installs?: number
  readonly license?: string
  readonly whenToUse?: string
}

/**
 * Transport for one federated ecosystem index. Entries are advisory: they
 * flow into the same immutable-commit, evidence, and approval pipeline as
 * every other remote candidate.
 */
export interface RegistryIndexTransport {
  list(signal?: AbortSignal): Promise<{ entries: readonly unknown[]; partial: boolean }>
}

export function validateRegistryIndexEntry(value: unknown): RegistryIndexEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const item = value as Record<string, unknown>
  if (typeof item.name !== 'string' || !SKILL_NAME.test(item.name)) return undefined
  if (typeof item.description !== 'string'
    || item.description.trim().length === 0
    || item.description.length > REGISTRY_MAX_DESCRIPTION_LENGTH) return undefined
  if (typeof item.source !== 'string' || !GITHUB_SOURCE.test(item.source)) return undefined
  if (typeof item.ref !== 'string' || !GIT_REF.test(item.ref)) return undefined
  if (typeof item.tier !== 'string' || !TIERS.includes(item.tier as RegistryTier)) return undefined
  if (item.installs !== undefined
    && (typeof item.installs !== 'number' || !Number.isSafeInteger(item.installs) || item.installs < 0)) return undefined
  if (item.license !== undefined && typeof item.license !== 'string') return undefined
  if (item.whenToUse !== undefined && (typeof item.whenToUse !== 'string' || item.whenToUse.trim().length === 0)) {
    return undefined
  }
  return {
    name: item.name,
    description: item.description.trim(),
    source: item.source,
    ref: item.ref,
    tier: item.tier as RegistryTier,
    ...(item.installs === undefined ? {} : { installs: item.installs }),
    ...(typeof item.license === 'string' ? { license: item.license } : {}),
    ...(typeof item.whenToUse === 'string' ? { whenToUse: item.whenToUse.trim() } : {}),
  }
}

export interface RegistryIndexListing {
  readonly entries: RegistryIndexEntry[]
  /** True when the index reported truncation or any entry was invalid. */
  readonly partial: boolean
}

/** Validate and bound one index listing; invalid entries are dropped. */
export class RegistryIndexClient {
  constructor(private readonly transport: RegistryIndexTransport) {}

  async listEntries(signal?: AbortSignal): Promise<RegistryIndexListing> {
    signal?.throwIfAborted()
    const listed = await this.transport.list(signal)
    signal?.throwIfAborted()
    if (!Array.isArray(listed.entries)) throw new Error('registry index returned an invalid entries array')
    const entries: RegistryIndexEntry[] = []
    let partial = listed.partial === true
    const seen = new Set<string>()
    for (const item of listed.entries) {
      const entry = validateRegistryIndexEntry(item)
      if (entry === undefined) {
        partial = true
        continue
      }
      const key = `${entry.source}\0${entry.ref}\0${entry.name}`
      if (seen.has(key)) {
        partial = true
        continue
      }
      seen.add(key)
      entries.push(entry)
      if (entries.length >= REGISTRY_MAX_ENTRIES) {
        partial = true
        break
      }
    }
    return { entries, partial }
  }
}

