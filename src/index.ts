import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import {
  isModelInvocable,
  isSkillName,
  isUserInvocable,
  renderSkillContent,
  type SkillDefinition,
  type SkillInvocationSource,
} from '@deepseek-ai/dsh-skill'
import { defineTool, type PreToolDecision, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { SkillCache } from './cache.js'
import { estimateCatalogTokens, updateCatalog, updateRemoteCandidates } from './catalog.js'
import { EmbeddingRouter } from './embedding.js'
import { RemoteDiscoveryClient } from './remote.js'
import { cacheCandidates, registryCandidates, selectCandidates, tokenize } from './router.js'
import { UsageStore } from './usage.js'
import type {
  CacheEntry,
  CatalogStats,
  EmbeddingRouterStats,
  MountedSkill,
  RemoteCandidate,
  ResolvedSkillFluxConfig,
  RoutingTrace,
  SkillFluxCandidate,
  SkillFluxConfig,
  SkillUsageIdentity,
  SkillUsageRecord,
} from './types.js'

export type * from './types.js'
export { normalizeText, routeScore, selectCandidates, tokenize } from './router.js'
export { estimateCatalogTokens, estimateTextTokens } from './catalog.js'
export { parseSkillMarkdown, inspectSkillDirectory } from './skill-file.js'
export { SkillCache, isLoopbackProxyFailure } from './cache.js'
export { EmbeddingRouter, type EmbeddingRouterOptions } from './embedding.js'
export { RemoteDiscoveryClient } from './remote.js'
export { UsageStore, type AdaptiveUsageOptions, type UsageStoreOptions } from './usage.js'

export const name = 'skillflux'
const MOUNT_TOOL = 'skillflux_mount'
const OLLAMA_EMBEDDING_ENDPOINT = 'http://127.0.0.1:11434/api/embed'
const OPENAI_EMBEDDING_ENDPOINT = 'https://api.openai.com/v1/embeddings'
const DEFAULTS: ResolvedSkillFluxConfig = {
  maxActiveSkills: 3,
  minRouteScore: 8,
  approvalPolicy: 'always',
  remoteDiscovery: 'automatic',
  remoteSearchLimit: 5,
  remoteSearchTimeoutMs: 8_000,
  catalogDescriptionMaxLength: 160,
  catalogTokenBudget: 0,
  maxSkillFiles: 1_000,
  maxSkillBytes: 10 * 1024 * 1024,
  installTimeoutMs: 300_000,
  routerMode: 'lexical',
  embeddingProvider: 'ollama',
  embeddingEndpoint: OLLAMA_EMBEDDING_ENDPOINT,
  embeddingModel: 'embeddinggemma',
  embeddingApiKeyEnv: 'SKILLFLUX_EMBEDDING_API_KEY',
  embeddingTimeoutMs: 5_000,
  embeddingCandidateLimit: 128,
  embeddingCacheSize: 512,
  minEmbeddingSimilarity: 0.45,
  usageTracking: true,
  usageMaxEntries: 1_000,
  adaptiveRouting: false,
  adaptiveMaxBoost: 6,
  adaptiveMinUses: 2,
  adaptiveHalfLifeDays: 30,
  routes: [],
}

interface AgentState {
  readonly agent: Agent
  turn?: number
  generation: number
  readonly mountEpochs: Map<string, number>
  readonly active: Map<string, MountedSkill>
  readonly disposers: Map<string, () => void>
  readonly candidates: Map<string, SkillFluxCandidate>
  lastRouting: RoutingTrace[]
}

class ExpiredAgentStateError extends Error {
  constructor() {
    super('SkillFlux mount expired because its turn or agent lifecycle ended')
    this.name = 'ExpiredAgentStateError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    skillFlux: SkillFluxService
  }
}

const routeRuleSchema = z.object({
  matchAll: z.array(z.string()),
  matchAny: z.array(z.string()),
  skills: z.array(z.string()),
})

function positiveInteger(name: string, value: number, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`dsh-skillflux: ${name} must be an integer greater than or equal to ${minimum}`)
  }
  return value
}

class CatalogBudgetExceededError extends Error {
  constructor(readonly skill: string, readonly estimatedTokens: number, readonly budget: number) {
    super(`cannot mount skill "${skill}": estimated catalog size ${estimatedTokens} exceeds token budget ${budget}`)
    this.name = 'CatalogBudgetExceededError'
  }
}

function boundedNumber(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`dsh-skillflux: ${name} must be between ${minimum} and ${maximum}`)
  }
  return value
}

function boundedInteger(name: string, value: number, minimum: number, maximum: number): number {
  positiveInteger(name, value, minimum)
  if (value > maximum) throw new Error(`dsh-skillflux: ${name} must be less than or equal to ${maximum}`)
  return value
}

function catalogTokenBudget(value: number): number {
  if (value === 0) return value
  return boundedInteger('catalogTokenBudget', value, 64, 1_000_000)
}

function nonEmptyString(name: string, value: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`dsh-skillflux: ${name} must not be empty`)
  return normalized
}

function embeddingEndpoint(value: string): string {
  let endpoint: URL
  try {
    endpoint = new URL(nonEmptyString('embeddingEndpoint', value))
  } catch {
    throw new Error('dsh-skillflux: embeddingEndpoint must be an absolute URL')
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error('dsh-skillflux: embeddingEndpoint must use http or https')
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0 || endpoint.hash.length > 0) {
    throw new Error('dsh-skillflux: embeddingEndpoint must not contain credentials or a fragment')
  }
  return endpoint.toString()
}

function environmentVariable(value: string): string {
  const name = nonEmptyString('embeddingApiKeyEnv', value)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new Error('dsh-skillflux: embeddingApiKeyEnv must be an environment variable name')
  }
  return name
}

function resolveConfig(config: SkillFluxConfig): ResolvedSkillFluxConfig {
  const embeddingProvider = config.embeddingProvider ?? DEFAULTS.embeddingProvider
  const resolved: ResolvedSkillFluxConfig = {
    maxActiveSkills: positiveInteger('maxActiveSkills', config.maxActiveSkills ?? DEFAULTS.maxActiveSkills),
    minRouteScore: positiveInteger('minRouteScore', config.minRouteScore ?? DEFAULTS.minRouteScore, 0),
    approvalPolicy: config.approvalPolicy ?? DEFAULTS.approvalPolicy,
    remoteDiscovery: config.remoteDiscovery ?? DEFAULTS.remoteDiscovery,
    remoteSearchLimit: positiveInteger('remoteSearchLimit', config.remoteSearchLimit ?? DEFAULTS.remoteSearchLimit),
    remoteSearchTimeoutMs: positiveInteger('remoteSearchTimeoutMs', config.remoteSearchTimeoutMs ?? DEFAULTS.remoteSearchTimeoutMs),
    catalogDescriptionMaxLength: positiveInteger(
      'catalogDescriptionMaxLength',
      config.catalogDescriptionMaxLength ?? DEFAULTS.catalogDescriptionMaxLength,
      3,
    ),
    catalogTokenBudget: catalogTokenBudget(config.catalogTokenBudget ?? DEFAULTS.catalogTokenBudget),
    maxSkillFiles: positiveInteger('maxSkillFiles', config.maxSkillFiles ?? DEFAULTS.maxSkillFiles),
    maxSkillBytes: positiveInteger('maxSkillBytes', config.maxSkillBytes ?? DEFAULTS.maxSkillBytes),
    installTimeoutMs: positiveInteger('installTimeoutMs', config.installTimeoutMs ?? DEFAULTS.installTimeoutMs),
    routerMode: config.routerMode ?? DEFAULTS.routerMode,
    embeddingProvider,
    embeddingEndpoint: embeddingEndpoint(config.embeddingEndpoint ?? (embeddingProvider === 'ollama'
      ? OLLAMA_EMBEDDING_ENDPOINT
      : OPENAI_EMBEDDING_ENDPOINT)),
    embeddingModel: nonEmptyString('embeddingModel', config.embeddingModel ?? (embeddingProvider === 'ollama'
      ? DEFAULTS.embeddingModel
      : 'text-embedding-3-small')),
    embeddingApiKeyEnv: environmentVariable(config.embeddingApiKeyEnv ?? DEFAULTS.embeddingApiKeyEnv),
    embeddingTimeoutMs: boundedInteger(
      'embeddingTimeoutMs',
      config.embeddingTimeoutMs ?? DEFAULTS.embeddingTimeoutMs,
      100,
      120_000,
    ),
    embeddingCandidateLimit: boundedInteger(
      'embeddingCandidateLimit',
      config.embeddingCandidateLimit ?? DEFAULTS.embeddingCandidateLimit,
      1,
      512,
    ),
    embeddingCacheSize: boundedInteger(
      'embeddingCacheSize',
      config.embeddingCacheSize ?? DEFAULTS.embeddingCacheSize,
      1,
      10_000,
    ),
    minEmbeddingSimilarity: boundedNumber(
      'minEmbeddingSimilarity',
      config.minEmbeddingSimilarity ?? DEFAULTS.minEmbeddingSimilarity,
      0,
      1,
    ),
    usageTracking: config.usageTracking ?? DEFAULTS.usageTracking,
    usageMaxEntries: boundedInteger(
      'usageMaxEntries',
      config.usageMaxEntries ?? DEFAULTS.usageMaxEntries,
      1,
      5_000,
    ),
    adaptiveRouting: config.adaptiveRouting ?? DEFAULTS.adaptiveRouting,
    adaptiveMaxBoost: boundedInteger(
      'adaptiveMaxBoost',
      config.adaptiveMaxBoost ?? DEFAULTS.adaptiveMaxBoost,
      0,
      20,
    ),
    adaptiveMinUses: boundedInteger(
      'adaptiveMinUses',
      config.adaptiveMinUses ?? DEFAULTS.adaptiveMinUses,
      1,
      1_000,
    ),
    adaptiveHalfLifeDays: boundedNumber(
      'adaptiveHalfLifeDays',
      config.adaptiveHalfLifeDays ?? DEFAULTS.adaptiveHalfLifeDays,
      0.1,
      3_650,
    ),
    routes: config.routes ?? DEFAULTS.routes,
  }
  if (resolved.adaptiveRouting && !resolved.usageTracking) {
    throw new Error('dsh-skillflux: adaptiveRouting requires usageTracking')
  }
  return resolved
}

function directTask(messages: readonly UserMessage[]): string | undefined {
  const parts: string[] = []
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    for (const block of message.content) if (block.type === 'text') parts.push(block.text)
  }
  const text = parts.join('\n').trim()
  return text.length === 0 ? undefined : text
}

const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/gu

function invokedSkillNames(messages: readonly UserMessage[]): string[] {
  const names: string[] = []
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      for (const match of block.text.matchAll(SKILL_GESTURE)) {
        const skillName = match[2]
        if (skillName !== undefined && !names.includes(skillName)) names.push(skillName)
      }
    }
  }
  return names
}

function skillLookup(agent: Agent, signal?: AbortSignal): { cwd?: string; scope: Agent; signal?: AbortSignal } {
  return {
    ...(agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd }),
    scope: agent,
    ...(signal === undefined ? {} : { signal }),
  }
}

interface SkillToolValue {
  readonly name: string
  readonly provider: string
  readonly resourceBase?: NonNullable<SkillDefinition['resourceBase']>
  readonly content: string
}

function skillResult(definition: SkillDefinition): SkillToolValue {
  return {
    name: definition.name,
    provider: definition.provider,
    ...(definition.resourceBase === undefined ? {} : { resourceBase: { ...definition.resourceBase } }),
    content: definition.content,
  }
}

const skillOutputSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    name: { type: 'string' as const, required: true },
    provider: { type: 'string' as const, required: true },
    resourceBase: {
      oneOf: [
        {
          type: 'object' as const,
          additionalProperties: false,
          properties: {
            kind: { type: 'string' as const, required: true, const: 'directory' },
            path: { type: 'string' as const, required: true },
          },
        },
        {
          type: 'object' as const,
          additionalProperties: false,
          properties: {
            kind: { type: 'string' as const, required: true, const: 'url' },
            url: { type: 'string' as const, required: true },
          },
        },
        {
          type: 'object' as const,
          additionalProperties: false,
          properties: {
            kind: { type: 'string' as const, required: true, const: 'opaque' },
            description: { type: 'string' as const, required: true },
          },
        },
      ],
    },
    content: { type: 'string' as const, required: true },
  },
} as const satisfies ValueSchemaSpec

export class SkillFluxService extends Service {
  static inject = ['agents', 'tools', 'skills', 'commands']

  static Config: z<SkillFluxConfig> = z.object({
    maxActiveSkills: z.number().default(DEFAULTS.maxActiveSkills),
    minRouteScore: z.number().default(DEFAULTS.minRouteScore),
    approvalPolicy: z.union(['always', 'session', 'automatic'] as const).default(DEFAULTS.approvalPolicy),
    remoteDiscovery: z.union(['automatic', 'on-demand', 'off'] as const).default(DEFAULTS.remoteDiscovery),
    remoteSearchLimit: z.number().default(DEFAULTS.remoteSearchLimit),
    remoteSearchTimeoutMs: z.number().default(DEFAULTS.remoteSearchTimeoutMs),
    catalogDescriptionMaxLength: z.number().default(DEFAULTS.catalogDescriptionMaxLength),
    catalogTokenBudget: z.number().default(DEFAULTS.catalogTokenBudget),
    maxSkillFiles: z.number().default(DEFAULTS.maxSkillFiles),
    maxSkillBytes: z.number().default(DEFAULTS.maxSkillBytes),
    installTimeoutMs: z.number().default(DEFAULTS.installTimeoutMs),
    routerMode: z.union(['lexical', 'hybrid'] as const).default(DEFAULTS.routerMode),
    embeddingProvider: z.union(['ollama', 'openai-compatible'] as const).default(DEFAULTS.embeddingProvider),
    embeddingEndpoint: z.string(),
    embeddingModel: z.string(),
    embeddingApiKeyEnv: z.string().default(DEFAULTS.embeddingApiKeyEnv),
    embeddingTimeoutMs: z.number().default(DEFAULTS.embeddingTimeoutMs),
    embeddingCandidateLimit: z.number().default(DEFAULTS.embeddingCandidateLimit),
    embeddingCacheSize: z.number().default(DEFAULTS.embeddingCacheSize),
    minEmbeddingSimilarity: z.number().default(DEFAULTS.minEmbeddingSimilarity),
    usageTracking: z.boolean().default(DEFAULTS.usageTracking),
    usageMaxEntries: z.number().default(DEFAULTS.usageMaxEntries),
    adaptiveRouting: z.boolean().default(DEFAULTS.adaptiveRouting),
    adaptiveMaxBoost: z.number().default(DEFAULTS.adaptiveMaxBoost),
    adaptiveMinUses: z.number().default(DEFAULTS.adaptiveMinUses),
    adaptiveHalfLifeDays: z.number().default(DEFAULTS.adaptiveHalfLifeDays),
    routes: z.array(routeRuleSchema).default([]),
  })

  readonly config: ResolvedSkillFluxConfig
  private readonly runtimeCtx: Context
  private readonly cache: SkillCache
  private readonly remote: RemoteDiscoveryClient
  private readonly embedding: EmbeddingRouter | undefined
  private readonly usage: UsageStore | undefined
  private readonly usageTasks = new Set<Promise<void>>()
  private readonly stateByAgent = new WeakMap<Agent, AgentState>()
  private readonly states = new Set<AgentState>()
  private readonly trustedBySession = new WeakMap<Session, Set<string>>()

  constructor(ctx: Context, config: SkillFluxConfig = {}) {
    super(ctx, 'skillFlux')
    this.runtimeCtx = ctx
    this.config = resolveConfig(config)
    this.cache = new SkillCache({
      root: dshHomePath('cache', 'skillflux'),
      maxFiles: this.config.maxSkillFiles,
      maxBytes: this.config.maxSkillBytes,
      installTimeoutMs: this.config.installTimeoutMs,
    })
    this.remote = new RemoteDiscoveryClient(this.config.remoteSearchLimit, this.config.remoteSearchTimeoutMs)
    this.usage = this.config.usageTracking
      ? new UsageStore({
          file: dshHomePath('storages', 'skillflux', 'usage.json'),
          maxEntries: this.config.usageMaxEntries,
          warn: message => { ctx.logger.warn(message) },
        })
      : undefined
    this.embedding = this.config.routerMode === 'hybrid'
      ? new EmbeddingRouter({
          provider: this.config.embeddingProvider,
          endpoint: this.config.embeddingEndpoint,
          model: this.config.embeddingModel,
          apiKeyEnv: this.config.embeddingApiKeyEnv,
          timeoutMs: this.config.embeddingTimeoutMs,
          candidateLimit: this.config.embeddingCandidateLimit,
          cacheSize: this.config.embeddingCacheSize,
          minSimilarity: this.config.minEmbeddingSimilarity,
        })
      : undefined

    const skillTool = this.createSkillTool()
    ctx.tools.register(skillTool)
    ctx.tools.register(this.createSearchTool())
    ctx.tools.register(this.createMountTool())
    this.registerApprovalGate(ctx)
    this.registerCommand(ctx)

    // Registration order is intentional. Cordis waterfalls resume in reverse:
    // routing runs first, the filtered catalog observes its mounts, and an
    // explicit /skill-name body is appended last, closest to the model answer.
    this.registerExplicitInvocation(ctx)
    ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      signal.throwIfAborted()
      if (ctx.tools.get(skillTool.name, agent) !== skillTool) return decision
      const state = this.state(agent)
      const active = [...state.active.values()]
        .map(item => item.definition)
        .filter(isModelInvocable)
        .slice(0, this.config.maxActiveSkills)
      return {
        kind: 'enter',
        messages: updateCatalog(agent, decision.messages, active, this.config.catalogDescriptionMaxLength),
      }
    })
    ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || step !== 1) return decision
      const task = directTask(messages)
      if (task === undefined) {
        this.beginTurn(agent, turn)
        const hint = updateRemoteCandidates(agent, [])
        return hint === undefined ? decision : { kind: 'enter', messages: [...decision.messages, hint] }
      }
      try {
        const explicit = new Set<string>()
        for (const skillName of invokedSkillNames(messages)) {
          const definition = await ctx.skills.get(skillName, skillLookup(agent, signal))
          signal.throwIfAborted()
          if (definition !== undefined && isUserInvocable(definition)) explicit.add(skillName)
        }
        const hint = await this.routeTurn(agent, task, turn, explicit, signal)
        return hint === undefined
          ? decision
          : { kind: 'enter', messages: [...decision.messages, hint] }
      } catch (error: unknown) {
        signal.throwIfAborted()
        if (error instanceof ExpiredAgentStateError) return decision
        ctx.logger.warn(`SkillFlux routing failed open: ${errorMessage(error)}`)
        const hint = updateRemoteCandidates(agent, [])
        return hint === undefined ? decision : { kind: 'enter', messages: [...decision.messages, hint] }
      }
    })

    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end') this.cleanupSession(session)
    })
    ctx.on('session/disposed', session => { this.disposeSession(session) })
    ctx.on('agent/disposed', ({ agent }) => { this.disposeAgent(agent) })
    ctx.effect(() => () => {
      for (const state of this.states) this.cleanupState(state, true)
    })
  }

  async discover(
    agent: Agent,
    query: string,
    options: { readonly remote?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<SkillFluxCandidate[]> {
    const snapshot = await this.runtimeCtx.skills.snapshot(skillLookup(agent, options.signal))
    options.signal?.throwIfAborted()
    if (!snapshot.complete) throw new Error('SkillFlux discovery is incomplete; retry the search')
    const installed = snapshot.skills.filter(isModelInvocable)
    const cached = await this.cache.list()
    options.signal?.throwIfAborted()
    const local = dedupeByName([...registryCandidates(installed), ...cacheCandidates(cached)])
    const selected = await this.selectLocalCandidates(
      query,
      local,
      this.config.remoteSearchLimit,
      this.config.remoteSearchLimit,
      options.signal,
    )
    options.signal?.throwIfAborted()
    if (options.remote !== true || this.config.remoteDiscovery === 'off') return selected
    const remote = await this.remote.search(query, options.signal)
    options.signal?.throwIfAborted()
    return dedupeById([...selected, ...remote]).slice(0, this.config.remoteSearchLimit * 2)
  }

  async mount(agent: Agent, candidateId: string, signal?: AbortSignal): Promise<MountedSkill> {
    const state = this.state(agent)
    const candidate = state.candidates.get(candidateId)
    if (candidate === undefined) throw new Error('candidate id is unknown or expired; run skillflux_search again')
    try {
      return await this.mountCandidate(state, candidate, signal)
    } catch (error: unknown) {
      if (error instanceof CatalogBudgetExceededError) {
        const trace = routingTrace(candidate, state.turn)
        const existing = state.lastRouting.findIndex(item => item.candidateId === candidate.id)
        if (existing === -1) state.lastRouting.push({ ...trace, outcome: 'budget-skipped' })
        else this.markRoutingOutcome(state, candidate.id, 'budget-skipped')
      }
      throw error
    }
  }

  unmount(agent: Agent, name?: string): void {
    const state = this.stateByAgent.get(agent)
    if (state === undefined) return
    if (name !== undefined) {
      state.mountEpochs.set(name, (state.mountEpochs.get(name) ?? 0) + 1)
      try {
        state.disposers.get(name)?.()
      } catch (error: unknown) {
        this.runtimeCtx.logger.warn(`SkillFlux unmount failed: ${errorMessage(error)}`)
      } finally {
        state.disposers.delete(name)
        state.active.delete(name)
      }
      return
    }
    this.cleanupState(state, false)
  }

  async reload(agent: Agent, name: string, signal?: AbortSignal): Promise<MountedSkill> {
    const state = this.state(agent)
    this.unmount(agent, name)
    const generation = state.generation
    const mountEpoch = state.mountEpochs.get(name) ?? 0
    const candidates = await this.discover(agent, name, signal === undefined ? {} : { signal })
    signal?.throwIfAborted()
    this.assertMountCurrent(state, generation, name, mountEpoch)
    const candidate = candidates.find(item => item.name === name)
    if (candidate === undefined) throw new Error(`skill "${name}" was not found`)
    state.candidates.set(candidate.id, candidate)
    return await this.mountCandidate(state, candidate, signal, generation, mountEpoch)
  }

  mounted(agent: Agent): readonly MountedSkill[] {
    return [...(this.stateByAgent.get(agent)?.active.values() ?? [])]
  }

  catalogStats(agent: Agent): CatalogStats {
    const mounted = this.mounted(agent)
    return {
      mountedSkills: mounted.length,
      estimatedTokens: estimateCatalogTokens(
        mounted.map(item => item.definition),
        this.config.catalogDescriptionMaxLength,
      ),
      ...(this.config.catalogTokenBudget === 0 ? {} : { budget: this.config.catalogTokenBudget }),
    }
  }

  lastRouting(agent: Agent): readonly RoutingTrace[] {
    return (this.stateByAgent.get(agent)?.lastRouting ?? []).map(trace => ({ ...trace }))
  }

  async usageRecords(limit = 20): Promise<SkillUsageRecord[]> {
    await Promise.all(this.usageTasks)
    return await this.usage?.list(limit) ?? []
  }

  embeddingStats(): EmbeddingRouterStats | undefined {
    return this.embedding?.stats()
  }

  async listCache(): Promise<CacheEntry[]> {
    return await this.cache.list()
  }

  async cleanCache(selector: string): Promise<{ removed: string[]; skipped: string[] }> {
    const activeIds = new Set<string>()
    for (const state of this.states) {
      for (const item of state.active.values()) if (item.cacheId !== undefined) activeIds.add(item.cacheId)
    }
    return await this.cache.clean(selector, activeIds)
  }

  private createSkillTool() {
    return defineTool({
      name: 'skill',
      description: 'Load the full instructions for a skill mounted by SkillFlux for the current turn.',
      parameters: {
        name: { type: 'string', required: true, description: 'Exact name from the current SkillFlux catalog.' },
      },
      output: {
        schema: skillOutputSchema,
        render: (_args, value) => [{ type: 'text', text: renderSkillContent(value) }],
      },
      execute: async (args, exec) => {
        if (!isSkillName(args.name)) throw new Error(`invalid skill name "${args.name}"`)
        const agent = exec.agent
        if (agent === undefined) throw new Error('skill calls require an agent')
        const active = this.stateByAgent.get(agent)?.active.get(args.name)
        if (active === undefined) throw new Error(`skill "${args.name}" is not mounted for this turn`)
        if (!isModelInvocable(active.definition)) throw new Error(`skill "${args.name}" is not model-invocable`)
        this.trackUsage(this.usage?.recordUse(usageIdentity(active)))
        return skillResult(active.definition)
      },
      presentCall: args => ({ card: 'generic', title: `Load skill ${args.name}`, kind: 'read', rawInput: args.name }),
    })
  }

  private createSearchTool() {
    return defineTool({
      name: 'skillflux_search',
      description: 'Search installed, cached, and remote skills when no mounted skill clearly fits the task.',
      parameters: {
        query: { type: 'string', required: true, description: 'Concise capability query; do not include secrets.' },
        remote: { type: 'boolean', description: 'Include immutable skills.sh/GitHub candidates. Defaults to true.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            query: { type: 'string', required: true },
            candidates: {
              type: 'array', required: true,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  origin: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  description: { type: 'string', required: true },
                  source: { type: 'string', required: true },
                  ref: { type: 'string' },
                  installs: { type: 'integer' },
                  score: { type: 'integer', required: true },
                  selection: { type: 'string' },
                  baseScore: { type: 'integer' },
                  adaptiveBoost: { type: 'integer' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async (args, exec) => {
        const agent = exec.agent
        if (agent === undefined) throw new Error('SkillFlux search requires an agent')
        const candidates = await this.discover(agent, args.query, {
          remote: args.remote !== false,
          signal: exec.signal,
        })
        const state = this.state(agent)
        state.candidates.clear()
        for (const candidate of candidates) state.candidates.set(candidate.id, candidate)
        return {
          query: args.query,
          candidates: candidates.map(candidate => ({
            id: candidate.id,
            origin: candidate.origin,
            name: candidate.name,
            description: candidate.description,
            source: candidate.source,
            ...('ref' in candidate ? { ref: candidate.ref } : {}),
            ...('installs' in candidate && candidate.installs !== undefined ? { installs: candidate.installs } : {}),
            score: candidate.score,
            ...(candidate.selection === undefined ? {} : { selection: candidate.selection }),
            ...(candidate.baseScore === undefined ? {} : { baseScore: candidate.baseScore }),
            ...(candidate.adaptiveBoost === undefined ? {} : { adaptiveBoost: candidate.adaptiveBoost }),
          })),
        }
      },
      isConcurrencySafe: () => false,
      presentCall: args => ({ card: 'generic', title: 'Search skills', kind: 'read', rawInput: args.query }),
    })
  }

  private createMountTool() {
    return defineTool({
      name: MOUNT_TOOL,
      description: 'Mount one exact candidate returned by SkillFlux search. Remote installs follow the configured approval policy.',
      parameters: {
        candidateId: { type: 'string', required: true, description: 'Opaque candidate id from skillflux_search.' },
      },
      output: {
        schema: skillOutputSchema,
        render: (_args, value) => [{ type: 'text', text: renderSkillContent(value) }],
      },
      execute: async (args, exec) => {
        const agent = exec.agent
        if (agent === undefined) throw new Error('SkillFlux mount requires an agent')
        const mounted = await this.mount(agent, args.candidateId, exec.signal)
        return skillResult(mounted.definition)
      },
      isConcurrencySafe: () => false,
      presentCall: args => ({ card: 'generic', title: 'Mount skill', kind: 'edit', rawInput: args.candidateId }),
    })
  }

  private registerApprovalGate(ctx: Context): void {
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      if (exec.name !== MOUNT_TOOL) return await next()
      const downstream = await next()
      if (downstream.kind !== 'allow') return downstream
      const agent = exec.agent
      const id = (exec.arguments as { candidateId?: unknown }).candidateId
      if (agent === undefined || typeof id !== 'string') return { kind: 'deny', reason: 'invalid SkillFlux mount request' }
      const candidate = this.stateByAgent.get(agent)?.candidates.get(id)
      if (candidate === undefined) return { kind: 'deny', reason: 'SkillFlux candidate id is unknown or expired' }
      if (candidate.origin !== 'remote' || this.config.approvalPolicy === 'automatic') return downstream
      const trusted = this.trustedBySession.get(agent.session)
      if (this.config.approvalPolicy === 'session' && trusted?.has(candidate.source) === true) return downstream
      return {
        kind: 'ask',
        reason: `Install remote skill ${candidate.skillId} from ${candidate.source} at immutable commit ${candidate.ref}?`,
      }
    })
  }

  private registerExplicitInvocation(ctx: Context): void {
    ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const names = invokedSkillNames(messages)
      if (names.length === 0) return decision
      const injections: UserMessage[] = []
      for (const skillName of names) {
        const definition = await ctx.skills.get(skillName, skillLookup(agent, signal))
        signal.throwIfAborted()
        if (definition === undefined || !isUserInvocable(definition)) continue
        const source: SkillInvocationSource = { kind: 'skill-invocation', name: skillName, form: 'instructions' }
        injections.push(createUserMessage({
          content: [{ type: 'text', text: renderSkillContent(definition) }],
          source,
        }))
      }
      return injections.length === 0
        ? decision
        : { kind: 'enter', messages: [...decision.messages, ...injections] }
    })
  }

  private registerCommand(ctx: Context): void {
    ctx.commands.register({
      name: 'skillflux',
      description: 'inspect SkillFlux mounts and manage its persistent cache',
      input: { hint: 'status | explain | usage | cache list | cache clean <cache-id|all>' },
      handler: async invocation => await this.executeCommand(invocation),
    })
  }

  private async executeCommand(invocation: CommandInvocation): Promise<CommandResult> {
    const parts = invocation.rawInput.trim().split(/\s+/u).filter(Boolean)
    if (parts.length === 1 && parts[0] === 'status') {
      const mounted = this.mounted(invocation.agent)
      const stats = this.embeddingStats()
      const catalog = this.catalogStats(invocation.agent)
      const router = this.config.routerMode === 'lexical'
        ? 'Router: lexical.'
        : `Router: hybrid (${this.config.embeddingProvider}, ${this.config.embeddingModel}); embedding requests ${stats?.requests ?? 0}, cache ${stats?.cacheEntries ?? 0}/${this.config.embeddingCacheSize}.`
      const telemetry = `Usage tracking: ${this.config.usageTracking ? 'on' : 'off'}; adaptive routing: ${this.config.adaptiveRouting ? 'on' : 'off'}.`
      const catalogBudget = catalog.budget === undefined ? 'off' : String(catalog.budget)
      return {
        kind: 'success',
        text: `${router}\n${telemetry}\nCatalog: ${catalog.mountedSkills} mounted, ~${catalog.estimatedTokens} estimated tokens; budget ${catalogBudget}.\n${mounted.length === 0
          ? 'SkillFlux: no skills are mounted for the current turn.'
          : `SkillFlux mounted:\n${mounted.map(item => `- ${item.name} (${item.origin}, ${item.source})`).join('\n')}`}`,
      }
    }
    if (parts.length === 1 && parts[0] === 'explain') {
      const traces = this.lastRouting(invocation.agent)
      return {
        kind: 'success',
        text: traces.length === 0
          ? 'SkillFlux: no routing decision has been recorded.'
          : `SkillFlux routing decision:\n${traces.map(trace => {
              const base = trace.baseScore === undefined ? '' : `, base=${trace.baseScore}`
              const boost = trace.adaptiveBoost === undefined ? '' : `, boost=${trace.adaptiveBoost}`
              return `- ${trace.name} [${trace.selection}, ${trace.outcome}] score=${trace.score}${base}${boost} (${trace.origin}, ${trace.source})`
            }).join('\n')}`,
      }
    }
    if (parts.length === 1 && parts[0] === 'usage') {
      const records = await this.usageRecords(20)
      return {
        kind: 'success',
        text: !this.config.usageTracking
          ? 'SkillFlux usage tracking is disabled.'
          : records.length === 0
            ? 'SkillFlux has no usage statistics yet.'
            : `SkillFlux usage (top ${records.length}):\n${records.map(record =>
                `- ${record.name} (${record.origin}, ${record.source}): uses ${record.uses}, mounts ${record.mounts}, last used ${formatTimestamp(record.lastUsedAt)}`)
              .join('\n')}`,
      }
    }
    if (parts.length === 2 && parts[0] === 'cache' && parts[1] === 'list') {
      const entries = await this.listCache()
      return {
        kind: 'success',
        text: entries.length === 0
          ? 'SkillFlux cache is empty.'
          : entries.map(entry =>
              `- ${entry.manifest.cacheId} ${entry.manifest.name} ${entry.manifest.source}@${entry.manifest.ref.slice(0, 12)} ${entry.manifest.totalBytes} bytes`)
            .join('\n'),
      }
    }
    if (parts.length === 3 && parts[0] === 'cache' && parts[1] === 'clean') {
      const selector = parts[2]
      if (selector === undefined || (selector !== 'all' && !/^[0-9a-f]{24}$/u.test(selector))) {
        return { kind: 'error', text: 'Usage: /skillflux cache clean <cache-id|all>' }
      }
      const result = await this.cleanCache(selector)
      return {
        kind: 'success',
        text: `Removed ${result.removed.length} cache entr${result.removed.length === 1 ? 'y' : 'ies'}${result.skipped.length === 0 ? '.' : `; skipped active: ${result.skipped.join(', ')}.`}`,
      }
    }
    return { kind: 'error', text: 'Usage: /skillflux status | explain | usage | cache list | cache clean <cache-id|all>' }
  }

  private async routeTurn(
    agent: Agent,
    task: string,
    turn: number,
    explicit: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<UserMessage | undefined> {
    const state = this.beginTurn(agent, turn)
    const generation = state.generation
    const snapshot = await this.runtimeCtx.skills.snapshot(skillLookup(agent, signal))
    signal.throwIfAborted()
    this.assertStateCurrent(state, generation)
    if (!snapshot.complete) return updateRemoteCandidates(agent, [])
    const cached = await this.cache.list()
    signal.throwIfAborted()
    this.assertStateCurrent(state, generation)
    const localPool = [
      ...registryCandidates(snapshot.skills.filter(isModelInvocable)),
      ...cacheCandidates(cached),
    ].filter(candidate => !explicit.has(candidate.name))
    const fallbacksByName = new Map<string, SkillFluxCandidate[]>()
    for (const candidate of localPool) {
      const fallbacks = fallbacksByName.get(candidate.name) ?? []
      fallbacks.push(candidate)
      fallbacksByName.set(candidate.name, fallbacks)
    }
    const local = dedupeByName(localPool)
    // Keep a few differently named fallbacks available: a corrupt top candidate
    // must not consume one of the bounded active slots for the entire turn.
    const selected = await this.selectLocalCandidates(
      task,
      local,
      Math.min(local.length, this.config.maxActiveSkills * 3),
      this.config.maxActiveSkills,
      signal,
    )
    signal.throwIfAborted()
    this.assertStateCurrent(state, generation)
    state.lastRouting = selected.map(candidate => routingTrace(candidate, turn))
    for (const candidate of selected) {
      if (state.active.size >= this.config.maxActiveSkills) break
      let mounted = false
      let budgetSkipped = false
      for (const fallback of fallbacksByName.get(candidate.name) ?? []) {
        try {
          await this.mountCandidate(state, {
            ...fallback,
            ...(candidate.selection === undefined ? {} : { selection: candidate.selection }),
            ...(candidate.baseScore === undefined ? {} : { baseScore: candidate.baseScore }),
            ...(candidate.adaptiveBoost === undefined ? {} : { adaptiveBoost: candidate.adaptiveBoost }),
            score: candidate.score,
          }, signal, generation)
          mounted = true
          break
        } catch (error: unknown) {
          signal.throwIfAborted()
          if (error instanceof ExpiredAgentStateError) throw error
          if (error instanceof CatalogBudgetExceededError) {
            budgetSkipped = true
          } else {
            this.runtimeCtx.logger.warn(
              `SkillFlux skipped candidate ${fallback.name} from ${fallback.source}: ${errorMessage(error)}`,
            )
          }
        }
      }
      if (!mounted && budgetSkipped) this.markRoutingOutcome(state, candidate.id, 'budget-skipped')
    }
    if (state.active.size > 0 || this.config.remoteDiscovery !== 'automatic') {
      return updateRemoteCandidates(agent, [])
    }
    let discoveredRemote: RemoteCandidate[]
    try {
      discoveredRemote = await this.remote.search(automaticDiscoveryQuery(task), signal)
      signal.throwIfAborted()
      this.assertStateCurrent(state, generation)
    } catch (error: unknown) {
      signal.throwIfAborted()
      if (error instanceof ExpiredAgentStateError) throw error
      this.runtimeCtx.logger.warn(`SkillFlux remote discovery skipped: ${errorMessage(error)}`)
      return updateRemoteCandidates(agent, [])
    }
    const remote: RemoteCandidate[] = []
    for (const candidate of discoveredRemote) {
      if (this.catalogFitsBudget(state, candidate)) remote.push(candidate)
      else state.lastRouting.push({ ...routingTrace(candidate, turn), outcome: 'budget-skipped' })
    }
    for (const candidate of remote) state.candidates.set(candidate.id, candidate)
    if (remote.length === 0) return updateRemoteCandidates(agent, [])
    if (this.config.approvalPolicy === 'automatic') {
      try {
        await this.mountCandidate(state, remote[0]!, signal, generation)
        state.candidates.clear()
        return updateRemoteCandidates(agent, [])
      } catch (error: unknown) {
        signal.throwIfAborted()
        if (error instanceof ExpiredAgentStateError) throw error
        if (error instanceof CatalogBudgetExceededError) {
          state.lastRouting.push({ ...routingTrace(remote[0]!, turn), outcome: 'budget-skipped' })
        } else {
          this.runtimeCtx.logger.warn(`SkillFlux automatic remote mount failed: ${errorMessage(error)}`)
        }
      }
    }
    return updateRemoteCandidates(agent, remote)
  }

  private async mountCandidate(
    state: AgentState,
    candidate: SkillFluxCandidate,
    signal?: AbortSignal,
    expectedGeneration = state.generation,
    expectedMountEpoch = state.mountEpochs.get(candidate.name) ?? 0,
  ): Promise<MountedSkill> {
    signal?.throwIfAborted()
    this.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch)
    const current = state.active.get(candidate.name)
    if (current !== undefined) return current
    this.assertCapacity(state, candidate.name)
    this.assertCatalogBudget(state, candidate)
    const lookup = skillLookup(state.agent, signal)
    if (candidate.origin === 'registry') {
      const definition = await this.runtimeCtx.skills.get(candidate.name, lookup)
      signal?.throwIfAborted()
      this.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch)
      if (definition === undefined) throw new Error(`skill "${candidate.name}" is no longer available`)
      if (definition.source !== candidate.summary.source || definition.provider !== candidate.summary.provider) {
        throw new Error(`skill candidate "${candidate.name}" expired because its provider changed; search again`)
      }
      if (!isModelInvocable(definition)) throw new Error(`skill "${candidate.name}" is no longer model-invocable`)
      const raced = state.active.get(definition.name)
      if (raced !== undefined) return raced
      this.assertCapacity(state, definition.name)
      this.assertCatalogBudget(state, definition)
      const mounted: MountedSkill = {
        candidateId: candidate.id,
        name: candidate.name,
        origin: 'registry',
        source: definition.source,
        selection: candidate.selection ?? 'manual',
        score: candidate.score,
        ...(candidate.baseScore === undefined ? {} : { baseScore: candidate.baseScore }),
        ...(candidate.adaptiveBoost === undefined ? {} : { adaptiveBoost: candidate.adaptiveBoost }),
        definition,
      }
      state.active.set(candidate.name, mounted)
      this.rememberRouting(state, mounted)
      this.trackUsage(this.usage?.recordMount(usageIdentity(mounted)))
      return mounted
    }

    let entry: CacheEntry
    if (candidate.origin === 'cache') {
      const cached = await this.cache.get(candidate.cacheId)
      signal?.throwIfAborted()
      this.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch)
      if (cached === undefined) throw new Error(`cache entry "${candidate.cacheId}" no longer exists`)
      entry = cached
    } else {
      entry = await this.cache.install(candidate, signal)
      signal?.throwIfAborted()
      this.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch)
    }
    const definition = await this.cache.load(entry, signal)
    signal?.throwIfAborted()
    this.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch)
    if (!isModelInvocable(definition)) throw new Error(`skill "${definition.name}" is not model-invocable`)
    const raced = state.active.get(definition.name)
    if (raced !== undefined) return raced
    this.assertCapacity(state, definition.name)
    this.assertCatalogBudget(state, definition)
    this.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch)
    const dispose = state.agent.ctx.skills.register({
      name: definition.name,
      description: definition.description,
      ...(definition.whenToUse === undefined ? {} : { whenToUse: definition.whenToUse }),
      invocation: definition.invocation,
      source: 'runtime',
      provider: 'skillflux-cache',
      ...(definition.resourceBase === undefined ? {} : { resourceBase: definition.resourceBase }),
      ...(definition.path === undefined ? {} : { path: definition.path }),
      ...(definition.metadata === undefined ? {} : { metadata: definition.metadata }),
      content: definition.content,
    })
    try {
      this.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch)
    } catch (error: unknown) {
      try { dispose() } catch (disposeError: unknown) {
        this.runtimeCtx.logger.warn(`SkillFlux stale mount rollback failed: ${errorMessage(disposeError)}`)
      }
      throw error
    }
    state.disposers.set(definition.name, dispose)
    const mounted: MountedSkill = {
      candidateId: candidate.id,
      name: definition.name,
      origin: candidate.origin,
      source: candidate.source,
      cacheId: entry.manifest.cacheId,
      selection: candidate.selection ?? 'manual',
      score: candidate.score,
      ...(candidate.baseScore === undefined ? {} : { baseScore: candidate.baseScore }),
      ...(candidate.adaptiveBoost === undefined ? {} : { adaptiveBoost: candidate.adaptiveBoost }),
      definition,
    }
    state.active.set(definition.name, mounted)
    this.rememberRouting(state, mounted)
    this.trackUsage(this.usage?.recordMount(usageIdentity(mounted)))
    if (candidate.origin === 'remote' && this.config.approvalPolicy === 'session') {
      let trusted = this.trustedBySession.get(state.agent.session)
      if (trusted === undefined) {
        trusted = new Set()
        this.trustedBySession.set(state.agent.session, trusted)
      }
      trusted.add(candidate.source)
    }
    return mounted
  }

  private assertCapacity(state: AgentState, name: string): void {
    if (state.active.has(name)) return
    if (state.active.size >= this.config.maxActiveSkills) {
      throw new Error(`cannot mount skill "${name}": the ${this.config.maxActiveSkills}-skill turn limit is reached`)
    }
  }

  private assertCatalogBudget(
    state: AgentState,
    skill: Pick<SkillDefinition, 'name' | 'description'>,
  ): void {
    if (this.catalogFitsBudget(state, skill)) return
    const estimatedTokens = estimateCatalogTokens(
      [...[...state.active.values()].map(item => item.definition), skill],
      this.config.catalogDescriptionMaxLength,
    )
    throw new CatalogBudgetExceededError(skill.name, estimatedTokens, this.config.catalogTokenBudget)
  }

  private catalogFitsBudget(
    state: AgentState,
    skill: Pick<SkillDefinition, 'name' | 'description'>,
  ): boolean {
    if (this.config.catalogTokenBudget === 0 || state.active.has(skill.name)) return true
    return estimateCatalogTokens(
      [...[...state.active.values()].map(item => item.definition), skill],
      this.config.catalogDescriptionMaxLength,
    ) <= this.config.catalogTokenBudget
  }

  private async selectLocalCandidates(
    query: string,
    candidates: readonly SkillFluxCandidate[],
    limit: number,
    semanticTrigger: number,
    signal?: AbortSignal,
  ): Promise<SkillFluxCandidate[]> {
    if (limit <= 0 || candidates.length === 0) return []
    let boosts: ReadonlyMap<string, number> | undefined
    if (this.config.adaptiveRouting && this.usage !== undefined) {
      try {
        boosts = await this.usage.boosts(candidates, {
          maxBoost: this.config.adaptiveMaxBoost,
          minUses: this.config.adaptiveMinUses,
          halfLifeDays: this.config.adaptiveHalfLifeDays,
        })
        signal?.throwIfAborted()
      } catch (error: unknown) {
        signal?.throwIfAborted()
        this.runtimeCtx.logger.warn(`SkillFlux adaptive routing failed open: ${errorMessage(error)}`)
      }
    }
    const lexical = selectCandidates(query, candidates, {
      limit,
      minScore: this.config.minRouteScore,
      routes: this.config.routes,
      ...(boosts === undefined ? {} : { boosts }),
    })
    if (this.embedding === undefined || lexical.length >= semanticTrigger || lexical.length >= limit) return lexical
    const selectedNames = new Set(lexical.map(candidate => candidate.name))
    const remaining = candidates.filter(candidate => !selectedNames.has(candidate.name))
    try {
      const semantic = await this.embedding.rank(query, remaining, limit - lexical.length, signal)
      signal?.throwIfAborted()
      return [...lexical, ...semantic]
    } catch (error: unknown) {
      signal?.throwIfAborted()
      this.runtimeCtx.logger.warn(`SkillFlux embedding routing failed open: ${errorMessage(error)}`)
      return lexical
    }
  }

  private assertStateCurrent(state: AgentState, generation: number): void {
    if (state.generation !== generation || this.stateByAgent.get(state.agent) !== state) {
      throw new ExpiredAgentStateError()
    }
  }

  private assertMountCurrent(state: AgentState, generation: number, name: string, mountEpoch: number): void {
    this.assertStateCurrent(state, generation)
    if ((state.mountEpochs.get(name) ?? 0) !== mountEpoch) throw new ExpiredAgentStateError()
  }

  private beginTurn(agent: Agent, turn: number): AgentState {
    const state = this.state(agent)
    if (state.turn !== turn) {
      this.cleanupState(state, false)
      state.turn = turn
      state.candidates.clear()
      state.lastRouting = []
    }
    return state
  }

  private state(agent: Agent): AgentState {
    let state = this.stateByAgent.get(agent)
    if (state === undefined) {
      state = {
        agent,
        generation: 0,
        mountEpochs: new Map(),
        active: new Map(),
        disposers: new Map(),
        candidates: new Map(),
        lastRouting: [],
      }
      this.stateByAgent.set(agent, state)
      this.states.add(state)
    }
    return state
  }

  private cleanupState(state: AgentState, forget: boolean): void {
    state.generation += 1
    for (const dispose of [...state.disposers.values()].reverse()) {
      try { dispose() } catch (error: unknown) {
        this.runtimeCtx.logger.warn(`SkillFlux unmount failed: ${errorMessage(error)}`)
      }
    }
    state.disposers.clear()
    state.active.clear()
    state.mountEpochs.clear()
    if (forget) {
      state.candidates.clear()
      this.states.delete(state)
      this.stateByAgent.delete(state.agent)
    }
  }

  private rememberRouting(state: AgentState, mounted: MountedSkill): void {
    const trace: RoutingTrace = {
      ...(state.turn === undefined ? {} : { turn: state.turn }),
      candidateId: mounted.candidateId,
      name: mounted.name,
      origin: mounted.origin,
      source: mounted.source,
      selection: mounted.selection,
      outcome: 'mounted',
      score: mounted.score,
      ...(mounted.baseScore === undefined ? {} : { baseScore: mounted.baseScore }),
      ...(mounted.adaptiveBoost === undefined ? {} : { adaptiveBoost: mounted.adaptiveBoost }),
    }
    const index = state.lastRouting.findIndex(item => item.candidateId === trace.candidateId)
    if (index === -1) state.lastRouting.push(trace)
    else state.lastRouting[index] = trace
  }

  private markRoutingOutcome(state: AgentState, candidateId: string, outcome: RoutingTrace['outcome']): void {
    const index = state.lastRouting.findIndex(item => item.candidateId === candidateId)
    const trace = state.lastRouting[index]
    if (index !== -1 && trace !== undefined) state.lastRouting[index] = { ...trace, outcome }
  }

  private trackUsage(operation: Promise<void> | undefined): void {
    if (operation === undefined) return
    let tracked: Promise<void>
    tracked = operation
      .catch((error: unknown) => {
        this.runtimeCtx.logger.warn(`SkillFlux usage tracking failed open: ${errorMessage(error)}`)
      })
      .finally(() => { this.usageTasks.delete(tracked) })
    this.usageTasks.add(tracked)
  }

  private cleanupSession(session: Session): void {
    for (const state of this.states) {
      if (state.agent.session !== session) continue
      this.cleanupState(state, false)
      state.candidates.clear()
    }
  }

  private disposeSession(session: Session): void {
    for (const state of this.states) {
      if (state.agent.session === session) this.cleanupState(state, true)
    }
    this.trustedBySession.delete(session)
  }

  private disposeAgent(agent: Agent): void {
    const state = this.stateByAgent.get(agent)
    if (state !== undefined) this.cleanupState(state, true)
    this.stateByAgent.delete(agent)
  }
}

function dedupeById(candidates: readonly SkillFluxCandidate[]): SkillFluxCandidate[] {
  return [...new Map(candidates.map(candidate => [candidate.id, candidate])).values()]
}

function dedupeByName(candidates: readonly SkillFluxCandidate[]): SkillFluxCandidate[] {
  const unique = new Map<string, SkillFluxCandidate>()
  for (const candidate of candidates) if (!unique.has(candidate.name)) unique.set(candidate.name, candidate)
  return [...unique.values()]
}

function automaticDiscoveryQuery(task: string): string {
  return [...tokenize(task)]
    .filter(token => token.length >= 2 && token.length <= 32 && !/^(?:sk|key|token)-?[a-z0-9]{12,}$/u.test(token))
    .slice(0, 12)
    .join(' ')
}

function routingTrace(candidate: SkillFluxCandidate, turn?: number): RoutingTrace {
  return {
    ...(turn === undefined ? {} : { turn }),
    candidateId: candidate.id,
    name: candidate.name,
    origin: candidate.origin,
    source: candidate.source,
    selection: candidate.selection ?? 'manual',
    outcome: 'selected',
    score: candidate.score,
    ...(candidate.baseScore === undefined ? {} : { baseScore: candidate.baseScore }),
    ...(candidate.adaptiveBoost === undefined ? {} : { adaptiveBoost: candidate.adaptiveBoost }),
  }
}

function usageIdentity(mounted: MountedSkill): SkillUsageIdentity {
  return {
    candidateId: mounted.candidateId,
    name: mounted.name,
    origin: mounted.origin,
    source: mounted.source,
  }
}

function formatTimestamp(value: number | undefined): string {
  return value === undefined ? 'never' : new Date(value).toISOString()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default SkillFluxService
