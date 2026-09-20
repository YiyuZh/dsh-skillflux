import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isModelInvocable, type SkillCatalogSnapshot, type SkillRegistry, type SkillViewOptions } from '@deepseek-ai/dsh-skill'
import { candidateGovernanceReason, currentCandidateTrust } from './approval.js'
import type { SkillCache } from './cache.js'
import type { EmbeddingRouter } from './embedding.js'
import type { RemoteDiscoveryClient } from './remote.js'
import { cacheCandidates, registryCandidates, selectCandidates, tokenize } from './router.js'
import { skillLookup } from './state.js'
import type { UsageStore } from './usage.js'
import type {
  CacheEntry,
  CachedCandidate,
  McpCandidate,
  ResolvedSkillFluxConfig,
  SkillFluxCandidate,
} from './types.js'

export interface DiscoveryHost {
  readonly runtimeCtx: Context
  readonly cache: SkillCache
  readonly remote: RemoteDiscoveryClient
  readonly config: ResolvedSkillFluxConfig
  readonly embedding: EmbeddingRouter | undefined
  readonly usage: UsageStore | undefined
  readonly mcp?: McpDiscoveryPort
}

export interface McpDiscoveryPort {
  listCandidates(
    query: string,
    signal?: AbortSignal,
  ): Promise<{ candidates: readonly McpCandidate[]; complete: boolean }>
}

export function governedCacheCandidates(
  entries: readonly CacheEntry[],
  config: ResolvedSkillFluxConfig,
): Array<CachedCandidate | McpCandidate> {
  return cacheCandidates(entries).flatMap((candidate): Array<CachedCandidate | McpCandidate> => {
    if (candidate.origin === 'mcp') {
      if (candidateGovernanceReason(candidate, config) !== undefined) return []
      const trustLevel = currentCandidateTrust(candidate, config)
      return [{ ...candidate, trustLevel }]
    }
    if (candidate.origin !== 'cache') return []
    if (candidateGovernanceReason(candidate, config) !== undefined) return []
    const trustLevel = currentCandidateTrust(candidate, config)
    return [{ ...candidate, trustLevel }]
  })
}

export function automaticDiscoveryQuery(task: string): string {
  return [...tokenize(task)]
    .filter(token => token.length >= 2 && token.length <= 32 && !/^(?:sk|key|token)-?[a-z0-9]{12,}$/u.test(token))
    .slice(0, 12)
    .join(' ')
}

export function dedupeByName(candidates: readonly SkillFluxCandidate[]): SkillFluxCandidate[] {
  const unique = new Map<string, SkillFluxCandidate>()
  for (const candidate of candidates) if (!unique.has(candidate.name)) unique.set(candidate.name, candidate)
  return [...unique.values()]
}

function dedupeById(candidates: readonly SkillFluxCandidate[]): SkillFluxCandidate[] {
  return [...new Map(candidates.map(candidate => [candidate.id, candidate])).values()]
}

/**
 * Observe the registry catalog with one retry. The filesystem provider's
 * watcher can report transiently incomplete observations while roots settle;
 * a second observation usually completes. Persistent incompleteness still
 * returns the partial observation so callers can fail open with usable
 * candidates instead of stalling search and routing.
 */
export async function retriedSnapshot(
  skills: Pick<SkillRegistry, 'snapshot'>,
  options: SkillViewOptions,
  warn?: (message: string) => void,
): Promise<SkillCatalogSnapshot> {
  let snapshot = await skills.snapshot(options)
  if (snapshot.complete) return snapshot
  options.signal?.throwIfAborted()
  await new Promise<void>(resolve => { setTimeout(resolve, 60) })
  options.signal?.throwIfAborted()
  snapshot = await skills.snapshot(options)
  if (!snapshot.complete) {
    warn?.('SkillFlux catalog snapshot is incomplete; continuing with partial candidates')
  }
  return snapshot
}

export class DiscoveryCoordinator {
  constructor(private readonly host: DiscoveryHost) {}

  private async withMcp(
    query: string,
    candidates: readonly SkillFluxCandidate[],
    signal?: AbortSignal,
  ): Promise<SkillFluxCandidate[]> {
    if (this.host.mcp === undefined || this.host.config.mcpDiscovery === 'off') return [...candidates]
    const mcp = await this.host.mcp.listCandidates(query, signal)
    signal?.throwIfAborted()
    return dedupeById([...candidates, ...mcp.candidates])
  }

  async discover(
    agent: Agent,
    query: string,
    options: { readonly remote?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<SkillFluxCandidate[]> {
    const snapshot = await retriedSnapshot(
      this.host.runtimeCtx.skills,
      skillLookup(agent, options.signal),
      message => { this.host.runtimeCtx.logger.warn(message) },
    )
    options.signal?.throwIfAborted()
    const installed = snapshot.skills.filter(isModelInvocable)
    const cached = await this.host.cache.list()
    options.signal?.throwIfAborted()
    const local = dedupeByName([...registryCandidates(installed), ...governedCacheCandidates(cached, this.host.config)])
    const selected = await this.selectLocalCandidates(
      query,
      local,
      this.host.config.remoteSearchLimit,
      this.host.config.remoteSearchLimit,
      options.signal,
    )
    options.signal?.throwIfAborted()
    if (options.remote !== true || this.host.config.remoteDiscovery === 'off') {
      return await this.withMcp(query, selected, options.signal)
    }
    const remote = await this.host.remote.search(query, options.signal)
    options.signal?.throwIfAborted()
    const merged = await this.withMcp(query, dedupeById([...selected, ...remote]), options.signal)
    return merged.slice(0, this.host.config.remoteSearchLimit * 2)
  }

  async selectLocalCandidates(
    query: string,
    candidates: readonly SkillFluxCandidate[],
    limit: number,
    semanticTrigger: number,
    signal?: AbortSignal,
  ): Promise<SkillFluxCandidate[]> {
    if (limit <= 0 || candidates.length === 0) return []
    let boosts: ReadonlyMap<string, number> | undefined
    if (this.host.config.adaptiveRouting && this.host.usage !== undefined) {
      try {
        boosts = await this.host.usage.boosts(candidates, {
          maxBoost: this.host.config.adaptiveMaxBoost,
          minUses: this.host.config.adaptiveMinUses,
          halfLifeDays: this.host.config.adaptiveHalfLifeDays,
        })
        signal?.throwIfAborted()
      } catch (error: unknown) {
        signal?.throwIfAborted()
        this.host.runtimeCtx.logger.warn(`SkillFlux adaptive routing failed open: ${errorMessage(error)}`)
      }
    }
    const lexical = selectCandidates(query, candidates, {
      limit,
      minScore: this.host.config.minRouteScore,
      routes: this.host.config.routes,
      ...(boosts === undefined ? {} : { boosts }),
    })
    if (this.host.embedding === undefined || lexical.length >= semanticTrigger || lexical.length >= limit) return lexical
    const selectedNames = new Set(lexical.map(candidate => candidate.name))
    const remaining = candidates.filter(candidate => !selectedNames.has(candidate.name))
    try {
      const semantic = await this.host.embedding.rank(query, remaining, limit - lexical.length, signal)
      signal?.throwIfAborted()
      return [...lexical, ...semantic]
    } catch (error: unknown) {
      signal?.throwIfAborted()
      this.host.runtimeCtx.logger.warn(`SkillFlux embedding routing failed open: ${errorMessage(error)}`)
      return lexical
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
