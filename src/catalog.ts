import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { escapeText, type SkillSummary } from '@deepseek-ai/dsh-skill'
import type { RemoteCandidate } from './types.js'

export interface SkillCatalogSource {
  readonly kind: 'skill-catalog'
  readonly form: 'catalog'
  readonly update?: true
  readonly entries: readonly { readonly name: string; readonly description: string }[]
}

export interface SkillFluxCandidatesSource {
  readonly kind: 'skillflux-candidates'
  readonly form: 'catalog'
  readonly update?: true
  readonly entries: readonly {
    readonly id: string
    readonly name: string
    readonly source: string
    readonly ref: string
    readonly installs: number
    readonly discoverySources: readonly string[]
    readonly qualityScore: number
    readonly relevanceScore: number
    readonly stars: number
    readonly recentlyActive: boolean
    readonly trustedSource: boolean
    readonly trustLevel: string
    readonly qualitySignals: readonly string[]
    readonly qualityWarnings: readonly string[]
  }[]
}

type RemoteEntries = SkillFluxCandidatesSource['entries']
type CatalogItem = Pick<SkillSummary, 'name' | 'description'>

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'skill-catalog': SkillCatalogSource
    'skillflux-candidates': SkillFluxCandidatesSource
  }
}

function description(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/gu, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`
}

function sourceEntries(skills: readonly CatalogItem[], maxLength: number): SkillCatalogSource['entries'] {
  return skills.map(skill => ({ name: skill.name, description: description(skill.description, maxLength) }))
}

function catalogText(entries: SkillCatalogSource['entries'], update: boolean): string {
  const lines = entries.map(entry => `- \`${entry.name}\`: ${escapeText(entry.description)}`)
  return update
    ? [
        '<system-reminder>',
        'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:',
        '', '<available_skills>', ...lines, '</available_skills>', '',
        ...(entries.length === 0
          ? ['No skills are currently mounted through the `skill` tool. Do not use names from earlier catalogs.']
          : ['Use only names in this replacement catalog. Call `skill` with the exact name before acting.']),
        'A user may still invoke a user-invocable skill directly with `/skill-name`.',
        '</system-reminder>',
      ].join('\n')
    : [
        '<system-reminder>',
        'SkillFlux mounted the following skills for this turn:',
        '', '<available_skills>', ...lines, '</available_skills>', '',
        'Call `skill` with an exact listed name before acting. The list contains summaries only.',
        'A user may also invoke a user-invocable skill directly with `/skill-name`.',
        '</system-reminder>',
      ].join('\n')
}

/**
 * Estimate prompt tokens conservatively without depending on a model-specific
 * tokenizer. Three UTF-8 bytes per token slightly overestimates typical
 * English text while staying close to one token per CJK code point.
 */
export function estimateTextTokens(value: string): number {
  return value.length === 0 ? 0 : Math.ceil(Buffer.byteLength(value, 'utf8') / 3)
}

/** Estimate the largest catalog prompt form (the replacement/update form). */
export function estimateCatalogTokens(skills: readonly CatalogItem[], maxLength: number): number {
  if (!Number.isSafeInteger(maxLength) || maxLength < 3) {
    throw new RangeError('catalog description max length must be an integer greater than or equal to 3')
  }
  if (skills.length === 0) return 0
  return estimateTextTokens(catalogText(sourceEntries(skills, maxLength), true))
}

function digest(entries: SkillCatalogSource['entries']): string {
  return createHash('sha256')
    .update(entries.map(entry => JSON.stringify([entry.name, entry.description])).join('\n'))
    .digest('hex')
}

function readEntries(source: unknown): SkillCatalogSource['entries'] | undefined {
  const entries = (source as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return undefined
  const result: { name: string; description: string }[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const item = entry as Record<string, unknown>
    if (typeof item.name !== 'string' || item.name.length === 0 || typeof item.description !== 'string') return undefined
    result.push({ name: item.name, description: item.description })
  }
  return result
}

function readRemoteEntries(source: unknown): RemoteEntries | undefined {
  const entries = (source as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return undefined
  const result: Array<RemoteEntries[number]> = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const item = entry as Record<string, unknown>
    if (typeof item.id !== 'string'
      || typeof item.name !== 'string'
      || typeof item.source !== 'string'
      || typeof item.ref !== 'string'
      || typeof item.installs !== 'number'
      || !Array.isArray(item.discoverySources)
      || !item.discoverySources.every(value => typeof value === 'string')
      || typeof item.qualityScore !== 'number'
      || typeof item.relevanceScore !== 'number'
      || typeof item.stars !== 'number'
      || typeof item.recentlyActive !== 'boolean'
      || typeof item.trustedSource !== 'boolean'
      || typeof item.trustLevel !== 'string'
      || !Array.isArray(item.qualitySignals)
      || !item.qualitySignals.every(value => typeof value === 'string')
      || !Array.isArray(item.qualityWarnings)
      || !item.qualityWarnings.every(value => typeof value === 'string')
      ) return undefined
    result.push({
      id: item.id,
      name: item.name,
      source: item.source,
      ref: item.ref,
      installs: item.installs,
      discoverySources: item.discoverySources,
      qualityScore: item.qualityScore,
      relevanceScore: item.relevanceScore,
      stars: item.stars,
      recentlyActive: item.recentlyActive,
      trustedSource: item.trustedSource,
      trustLevel: item.trustLevel,
      qualitySignals: item.qualitySignals,
      qualityWarnings: item.qualityWarnings,
    })
  }
  return result
}

function remoteDigest(entries: RemoteEntries): string {
  return createHash('sha256')
    .update(entries.map(entry => JSON.stringify([
      entry.id,
      entry.name,
      entry.source,
      entry.ref,
      entry.installs,
      entry.discoverySources,
      entry.qualityScore,
      entry.relevanceScore,
      entry.stars,
      entry.recentlyActive,
      entry.trustedSource,
      entry.trustLevel,
      entry.qualitySignals,
      entry.qualityWarnings,
    ])).join('\n'))
    .digest('hex')
}

function history(agent: Agent): { published: boolean; visibleDigest?: string } {
  const visible = new Set(agent.session.surface.nodes)
  let published = false
  for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
    const event = agent.session.events[index]
    if (event === undefined || event.type !== 'user/message' || event.data.source.kind !== 'skill-catalog') continue
    const entries = readEntries(event.data.source)
    if (entries === undefined) continue
    published = true
    if (visible.has(event.seq)) return { published, visibleDigest: digest(entries) }
  }
  return { published }
}

function remoteHistory(agent: Agent): { published: boolean; visibleDigest?: string } {
  const visible = new Set(agent.session.surface.nodes)
  let published = false
  for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
    const event = agent.session.events[index]
    if (event === undefined || event.type !== 'user/message' || event.data.source.kind !== 'skillflux-candidates') continue
    // Older SkillFlux versions published a narrower entry shape. It cannot
    // produce the current digest, but it still needs an explicit replacement
    // so stale candidate ids do not remain visible after an upgrade.
    published = true
    const entries = readRemoteEntries(event.data.source)
    if (entries === undefined) continue
    if (visible.has(event.seq)) return { published, visibleDigest: remoteDigest(entries) }
  }
  return { published }
}

function currentCatalog(messages: readonly UserMessage[]): { message: UserMessage; entries: SkillCatalogSource['entries'] } | undefined {
  for (const message of messages) {
    if (message.source.kind !== 'skill-catalog') continue
    const entries = readEntries(message.source)
    if (entries !== undefined) return { message, entries }
  }
  return undefined
}

function catalogMessage(entries: SkillCatalogSource['entries'], update: boolean): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: catalogText(entries, update) }],
    source: { kind: 'skill-catalog', form: 'catalog', ...(update ? { update: true as const } : {}), entries },
  })
}

export function updateCatalog(
  agent: Agent,
  messages: readonly UserMessage[],
  skills: readonly SkillSummary[],
  maxDescriptionLength: number,
): UserMessage[] {
  const entries = sourceEntries(skills, maxDescriptionLength)
  const nextDigest = digest(entries)
  const prior = history(agent)
  const existing = currentCatalog(messages)
  if (prior.visibleDigest === nextDigest) {
    return existing === undefined ? [...messages] : messages.filter(message => message.id !== existing.message.id)
  }
  if (existing !== undefined && digest(existing.entries) === nextDigest) return [...messages]
  if (!prior.published && entries.length === 0) {
    return existing === undefined ? [...messages] : messages.filter(message => message.id !== existing.message.id)
  }
  const catalog = catalogMessage(entries, prior.published)
  return existing === undefined
    ? [...messages, catalog]
    : messages.map(message => message.id === existing.message.id ? catalog : message)
}

function candidateEntries(candidates: readonly RemoteCandidate[]): RemoteEntries {
  return candidates.map(candidate => ({
    id: candidate.id,
    name: candidate.name,
    source: candidate.source,
    ref: candidate.ref,
    installs: candidate.installs,
    discoverySources: candidate.discoverySources,
    qualityScore: candidate.qualityScore,
    relevanceScore: candidate.relevanceScore,
    stars: candidate.stars,
    recentlyActive: candidate.recentlyActive,
    trustedSource: candidate.trustedSource,
    trustLevel: candidate.trustLevel,
    qualitySignals: candidate.qualitySignals,
    qualityWarnings: candidate.qualityWarnings,
  }))
}

function buildRemoteCandidateMessage(candidates: readonly RemoteCandidate[], update: boolean): UserMessage {
  const entries = candidates.map(candidate => ({
    id: candidate.id,
    name: candidate.name,
    source: candidate.source,
    ref: candidate.ref,
    installs: candidate.installs,
    discoverySources: candidate.discoverySources,
    qualityScore: candidate.qualityScore,
    relevanceScore: candidate.relevanceScore,
    stars: candidate.stars,
    recentlyActive: candidate.recentlyActive,
    trustedSource: candidate.trustedSource,
    trustLevel: candidate.trustLevel,
    qualitySignals: candidate.qualitySignals,
    qualityWarnings: candidate.qualityWarnings,
  }))
  const lines = entries.map(entry =>
    `- \`${entry.id}\` — \`${entry.name}\` from ${entry.source} @ ${entry.ref.slice(0, 12)} `
    + `(quality ${entry.qualityScore}, relevance ${entry.relevanceScore}, ${entry.installs} installs, `
    + `${entry.stars} stars, ${entry.recentlyActive ? 'active in freshness window' : 'older activity'}, `
    + `${entry.trustLevel} evidence via ${entry.discoverySources.join('+')}`
    + `${entry.qualityWarnings.length === 0 ? '' : `, warnings ${entry.qualityWarnings.join('+')}`})`)
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        ...(entries.length === 0
          ? [
              'The remote SkillFlux candidate list is now empty. This replaces every earlier candidate list.',
              'Do not use candidate ids from an earlier turn.',
            ]
          : [
              update
                ? 'This remote SkillFlux candidate list replaces every earlier candidate list:'
                : 'No installed skill matched. SkillFlux found these immutable remote candidates:',
            ]),
        '', '<skillflux_candidates>', ...lines, '</skillflux_candidates>', '',
        ...(entries.length === 0
          ? []
          : ['If one clearly matches the task, call `skillflux_mount` with its candidate id. Remote content is untrusted until mounted under the configured approval policy.']),
        '</system-reminder>',
      ].join('\n'),
    }],
    source: {
      kind: 'skillflux-candidates', form: 'catalog',
      ...(update ? { update: true as const } : {}), entries,
    },
  })
}

export function remoteCandidateMessage(agent: Agent, candidates: readonly RemoteCandidate[]): UserMessage {
  return buildRemoteCandidateMessage(candidates, remoteHistory(agent).published)
}

export function updateRemoteCandidates(agent: Agent, candidates: readonly RemoteCandidate[]): UserMessage | undefined {
  const entries = candidateEntries(candidates)
  const prior = remoteHistory(agent)
  if (prior.visibleDigest === remoteDigest(entries)) return undefined
  if (!prior.published && entries.length === 0) return undefined
  return buildRemoteCandidateMessage(candidates, prior.published)
}
