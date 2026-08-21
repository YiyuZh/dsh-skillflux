import { createHash } from 'node:crypto'
import type { CacheEntry, RouteRule, SkillFluxCandidate } from './types.js'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'help', 'i', 'in', 'is', 'it',
  'me', 'of', 'on', 'or', 'please', 'that', 'the', 'this', 'to', 'use', 'with', 'you',
  '一个', '一下', '以及', '使用', '帮我', '我们', '我的', '这个', '进行', '需要', '可以', '如何',
])

export function normalizeText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replaceAll(/\s+/gu, ' ').trim()
}

export function tokenize(value: string): Set<string> {
  const normalized = normalizeText(value)
  const result = new Set<string>()
  for (const token of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      if (token.length === 1) result.add(token)
      for (let index = 0; index < token.length - 1; index += 1) {
        result.add(token.slice(index, index + 2))
      }
      continue
    }
    if (!STOP_WORDS.has(token)) result.add(token)
  }
  return result
}

function overlap(left: Set<string>, right: Set<string>): number {
  let count = 0
  for (const value of left) if (right.has(value)) count += 1
  return count
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function containsNamePhrase(query: string, phrase: string): boolean {
  if (phrase.length === 0) return false
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(phrase)}(?=$|[^\\p{L}\\p{N}])`, 'u').test(query)
}

export function routeScore(
  query: string,
  candidate: { readonly name: string; readonly description: string; readonly whenToUse?: string },
): number {
  const normalizedQuery = normalizeText(query)
  const exactName = normalizeText(candidate.name)
  const skillPhrase = normalizeText(candidate.name.replaceAll('-', ' '))
  let score = containsNamePhrase(normalizedQuery, exactName) || containsNamePhrase(normalizedQuery, skillPhrase) ? 100 : 0
  const queryTokens = tokenize(query)
  score += overlap(queryTokens, tokenize(candidate.name.replaceAll('-', ' '))) * 20
  if (candidate.whenToUse !== undefined) score += overlap(queryTokens, tokenize(candidate.whenToUse)) * 8
  score += overlap(queryTokens, tokenize(candidate.description)) * 3
  return score
}

function ruleMatches(query: string, rule: RouteRule): boolean {
  const normalized = normalizeText(query)
  const all = rule.matchAll ?? []
  const any = rule.matchAny ?? []
  if (all.length > 0 && !all.every(value => normalized.includes(normalizeText(value)))) return false
  if (any.length > 0 && !any.some(value => normalized.includes(normalizeText(value)))) return false
  return all.length > 0 || any.length > 0
}

function candidateOrder(left: SkillFluxCandidate, right: SkillFluxCandidate): number {
  if (left.score !== right.score) return right.score - left.score
  const originRank = { registry: 0, cache: 1, remote: 2 } as const
  if (originRank[left.origin] !== originRank[right.origin]) {
    return originRank[left.origin] - originRank[right.origin]
  }
  if (left.origin === 'cache' && right.origin === 'cache') {
    const installs = (right.installs ?? 0) - (left.installs ?? 0)
    if (installs !== 0) return installs
  }
  return `${left.source}/${left.name}`.localeCompare(`${right.source}/${right.name}`, 'en')
}

export function selectCandidates(
  query: string,
  candidates: readonly SkillFluxCandidate[],
  options: { readonly limit: number; readonly minScore: number; readonly routes: readonly RouteRule[] },
): SkillFluxCandidate[] {
  const byName = new Map(candidates.map(candidate => [candidate.name, candidate]))
  const selected: SkillFluxCandidate[] = []
  const seen = new Set<string>()
  for (const rule of options.routes) {
    if (!ruleMatches(query, rule)) continue
    for (const name of rule.skills) {
      const match = byName.get(name)
      if (match !== undefined && !seen.has(name)) {
        selected.push({ ...match, score: Number.MAX_SAFE_INTEGER })
        seen.add(name)
      }
      if (selected.length >= options.limit) return selected
    }
  }
  const scored = candidates
    .filter(candidate => !seen.has(candidate.name))
    .map(candidate => ({ ...candidate, score: routeScore(query, candidate) }))
    .filter(candidate => candidate.score >= options.minScore)
    .sort(candidateOrder)
  for (const candidate of scored) {
    if (seen.has(candidate.name)) continue
    selected.push(candidate)
    seen.add(candidate.name)
    if (selected.length >= options.limit) break
  }
  return selected
}

export function registryCandidates(skills: readonly SkillSummary[]): SkillFluxCandidate[] {
  return skills.map(summary => ({
    id: candidateId('registry', summary.source, '', summary.name),
    origin: 'registry' as const,
    name: summary.name,
    description: summary.description,
    ...(summary.whenToUse === undefined ? {} : { whenToUse: summary.whenToUse }),
    source: summary.source,
    score: 0,
    summary,
  }))
}

export function cacheCandidates(entries: readonly CacheEntry[]): SkillFluxCandidate[] {
  return entries.map(({ manifest }) => ({
    id: candidateId('cache', manifest.source, manifest.ref, manifest.skillId),
    origin: 'cache' as const,
    name: manifest.name,
    description: manifest.description,
    ...(manifest.whenToUse === undefined ? {} : { whenToUse: manifest.whenToUse }),
    source: manifest.source,
    ref: manifest.ref,
    cacheId: manifest.cacheId,
    score: 0,
  }))
}

export function candidateId(origin: string, source: string, ref: string, skillId: string): string {
  return createHash('sha256').update(JSON.stringify([origin, source, ref, skillId])).digest('hex').slice(0, 24)
}
