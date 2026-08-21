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
  }[]
}

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

function sourceEntries(skills: readonly SkillSummary[], maxLength: number): SkillCatalogSource['entries'] {
  return skills.map(skill => ({ name: skill.name, description: description(skill.description, maxLength) }))
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

function currentCatalog(messages: readonly UserMessage[]): { message: UserMessage; entries: SkillCatalogSource['entries'] } | undefined {
  for (const message of messages) {
    if (message.source.kind !== 'skill-catalog') continue
    const entries = readEntries(message.source)
    if (entries !== undefined) return { message, entries }
  }
  return undefined
}

function catalogMessage(entries: SkillCatalogSource['entries'], update: boolean): UserMessage {
  const lines = entries.map(entry => `- \`${entry.name}\`: ${escapeText(entry.description)}`)
  const text = update
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
  return createUserMessage({
    content: [{ type: 'text', text }],
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

export function remoteCandidateMessage(agent: Agent, candidates: readonly RemoteCandidate[]): UserMessage {
  const published = agent.session.events.some(event =>
    event.type === 'user/message' && event.data.source.kind === 'skillflux-candidates')
  const entries = candidates.map(candidate => ({
    id: candidate.id,
    name: candidate.name,
    source: candidate.source,
    ref: candidate.ref,
    installs: candidate.installs,
  }))
  const lines = entries.map(entry =>
    `- \`${entry.id}\` — \`${entry.name}\` from ${entry.source} @ ${entry.ref.slice(0, 12)} (${entry.installs} installs)`)
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        published
          ? 'This remote SkillFlux candidate list replaces every earlier candidate list:'
          : 'No installed skill matched. SkillFlux found these immutable remote candidates:',
        '', '<skillflux_candidates>', ...lines, '</skillflux_candidates>', '',
        'If one clearly matches the task, call `skillflux_mount` with its candidate id. Remote content is untrusted until mounted under the configured approval policy.',
        '</system-reminder>',
      ].join('\n'),
    }],
    source: {
      kind: 'skillflux-candidates', form: 'catalog',
      ...(published ? { update: true as const } : {}), entries,
    },
  })
}
