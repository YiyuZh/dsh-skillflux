import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdir } from 'node:fs/promises'
import { lock, type LockOptions } from 'proper-lockfile'
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
  type SkillSummary,
} from '@deepseek-ai/dsh-skill'
import { defineTool, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { activateCandidate, usageIdentity, type ActivationHost, type CacheProcessLockRelease } from './activation.js'
import { MOUNT_TOOL, candidateGovernanceReason, registerApprovalGate, type ApprovalHost } from './approval.js'
import { SkillCache, type CacheInventoryStats } from './cache.js'
import type { CachePrunePlan } from './cache-governance.js'
import { estimateCatalogTokens, updateCatalog, updateRemoteCandidates } from './catalog.js'
import {
  DiscoveryCoordinator,
  automaticDiscoveryQuery,
  dedupeByName,
  governedCacheCandidates,
  type DiscoveryHost,
} from './discovery.js'
import { EmbeddingRouter } from './embedding.js'
import { SKILLFLUX_PROVIDER, SkillFluxProviderManager } from './provider.js'
import { RemoteDiscoveryClient } from './remote.js'
import { RemoteDiscoveryCache } from './remote-cache.js'
import { cacheCandidates, registryCandidates } from './router.js'
import { ExpiredAgentStateError, TurnStateRegistry, skillLookup, type AgentState } from './state.js'
import { UsageStore } from './usage.js'
import type {
  CacheEntry,
  CatalogStats,
  EmbeddingRouterStats,
  MountedSkill,
  RemoteCandidate,
  RemoteDiscoveryCacheStats,
  ResolvedSkillFluxConfig,
  RoutingTrace,
  SkillFluxCandidate,
  SkillFluxConfig,
  SkillUsageRecord,
} from './types.js'

export type * from './types.js'
export { normalizeText, routeScore, selectCandidates, tokenize } from './router.js'
export { estimateCatalogTokens, estimateTextTokens } from './catalog.js'
export { parseSkillMarkdown, inspectSkillDirectory } from './skill-file.js'
export {
  verifyUniqueRemoteSkill,
  type RemoteCandidateVerifier,
  type VerifiedRemoteSkill,
} from './remote-source.js'
export { SkillCache, isLoopbackProxyFailure, type CacheInventoryStats } from './cache.js'
export {
  planCachePrune,
  type CachePruneDecision,
  type CachePrunePlan,
  type CachePrunePolicy,
  type CachePruneReason,
  type CacheUsageEvidence,
} from './cache-governance.js'
export { EmbeddingRouter, type EmbeddingRouterOptions } from './embedding.js'
export {
  RemoteDiscoveryClient,
  remoteQualityScore,
  type RemoteDiscoveryOptions,
  type RemoteQualityInput,
} from './remote.js'
export {
  compareRemoteCandidates,
  compareRemoteTrust,
  deduplicateRemoteCandidates,
  remoteQualityEvidence,
  remoteTrustPolicyAllows,
  type RemoteEvidenceInput,
  type RemoteQualityEvidence,
} from './remote-governance.js'
export {
  RemoteDiscoveryCache,
  remoteDiscoveryCacheState,
  type RemoteDiscoveryCacheHit,
  type RemoteDiscoveryCacheOptions,
  type RemoteDiscoveryCacheState,
} from './remote-cache.js'
export { UsageStore, type AdaptiveUsageOptions, type UsageStoreOptions } from './usage.js'

export const name = 'skillflux'
const OLLAMA_EMBEDDING_ENDPOINT = 'http://127.0.0.1:11434/api/embed'
const OPENAI_EMBEDDING_ENDPOINT = 'https://api.openai.com/v1/embeddings'
const DEFAULTS: ResolvedSkillFluxConfig = {
  maxActiveSkills: 3,
  minRouteScore: 8,
  approvalPolicy: 'always',
  remoteDiscovery: 'automatic',
  remoteProviders: ['skills.sh', 'github'],
  remoteSearchLimit: 5,
  remoteAutoMountLimit: 3,
  remoteSearchTimeoutMs: 30_000,
  remoteMinQualityScore: 35,
  remoteMinStars: 0,
  remoteRecentActivityDays: 30,
  remoteTrustPolicy: 'community',
  remoteTrustedOwners: [],
  remoteBlockedOwners: [],
  remoteCacheTtlMs: 5 * 60_000,
  remoteCacheStaleIfErrorMs: 24 * 60 * 60_000,
  remoteCacheMaxEntries: 100,
  cacheAutoPrune: true,
  cacheMaxEntries: 100,
  cacheMaxTotalBytes: 512 * 1024 * 1024,
  cacheMaxIdleDays: 90,
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

type CacheLockFunction = (file: string, options?: LockOptions) => Promise<() => Promise<void>>

function remoteProviders(values: ResolvedSkillFluxConfig['remoteProviders']): ResolvedSkillFluxConfig['remoteProviders'] {
  const providers = [...new Set(values)]
  if (providers.length === 0) throw new Error('dsh-skillflux: remoteProviders must contain at least one provider')
  return providers
}

function remoteOwners(name: 'remoteTrustedOwners' | 'remoteBlockedOwners', values: readonly string[]): readonly string[] {
  const owners = values.map(value => value.trim()).filter(value => value.length > 0)
  for (const owner of owners) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(owner)) {
      throw new Error(`dsh-skillflux: invalid GitHub owner "${owner}" in ${name}`)
    }
  }
  return [...new Set(owners.map(owner => owner.toLocaleLowerCase('en-US')))]
    .sort((left, right) => left.localeCompare(right, 'en'))
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
    remoteProviders: remoteProviders(config.remoteProviders ?? DEFAULTS.remoteProviders),
    remoteSearchLimit: boundedInteger('remoteSearchLimit', config.remoteSearchLimit ?? DEFAULTS.remoteSearchLimit, 1, 25),
    remoteAutoMountLimit: boundedInteger('remoteAutoMountLimit', config.remoteAutoMountLimit ?? DEFAULTS.remoteAutoMountLimit, 1, 5),
    remoteSearchTimeoutMs: boundedInteger(
      'remoteSearchTimeoutMs',
      config.remoteSearchTimeoutMs ?? DEFAULTS.remoteSearchTimeoutMs,
      100,
      120_000,
    ),
    remoteMinQualityScore: boundedInteger(
      'remoteMinQualityScore',
      config.remoteMinQualityScore ?? DEFAULTS.remoteMinQualityScore,
      0,
      100,
    ),
    remoteMinStars: boundedInteger('remoteMinStars', config.remoteMinStars ?? DEFAULTS.remoteMinStars, 0, 10_000_000),
    remoteRecentActivityDays: boundedInteger(
      'remoteRecentActivityDays',
      config.remoteRecentActivityDays ?? DEFAULTS.remoteRecentActivityDays,
      1,
      3_650,
    ),
    remoteTrustPolicy: config.remoteTrustPolicy ?? DEFAULTS.remoteTrustPolicy,
    remoteTrustedOwners: remoteOwners(
      'remoteTrustedOwners',
      config.remoteTrustedOwners ?? DEFAULTS.remoteTrustedOwners,
    ),
    remoteBlockedOwners: remoteOwners(
      'remoteBlockedOwners',
      config.remoteBlockedOwners ?? DEFAULTS.remoteBlockedOwners,
    ),
    remoteCacheTtlMs: boundedInteger(
      'remoteCacheTtlMs',
      config.remoteCacheTtlMs ?? DEFAULTS.remoteCacheTtlMs,
      0,
      7 * 24 * 60 * 60_000,
    ),
    remoteCacheStaleIfErrorMs: boundedInteger(
      'remoteCacheStaleIfErrorMs',
      config.remoteCacheStaleIfErrorMs ?? DEFAULTS.remoteCacheStaleIfErrorMs,
      0,
      30 * 24 * 60 * 60_000,
    ),
    remoteCacheMaxEntries: boundedInteger(
      'remoteCacheMaxEntries',
      config.remoteCacheMaxEntries ?? DEFAULTS.remoteCacheMaxEntries,
      1,
      1_000,
    ),
    cacheAutoPrune: config.cacheAutoPrune ?? DEFAULTS.cacheAutoPrune,
    cacheMaxEntries: boundedInteger(
      'cacheMaxEntries',
      config.cacheMaxEntries ?? DEFAULTS.cacheMaxEntries,
      1,
      10_000,
    ),
    cacheMaxTotalBytes: boundedInteger(
      'cacheMaxTotalBytes',
      config.cacheMaxTotalBytes ?? DEFAULTS.cacheMaxTotalBytes,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    cacheMaxIdleDays: boundedInteger(
      'cacheMaxIdleDays',
      config.cacheMaxIdleDays ?? DEFAULTS.cacheMaxIdleDays,
      0,
      3_650,
    ),
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
  const blockedOwners = new Set(resolved.remoteBlockedOwners)
  const conflictingOwner = resolved.remoteTrustedOwners.find(owner => blockedOwners.has(owner))
  if (conflictingOwner !== undefined) {
    throw new Error(`dsh-skillflux: GitHub owner "${conflictingOwner}" cannot be both trusted and blocked`)
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
    remoteProviders: z.array(z.union(['skills.sh', 'github'] as const)).default([...DEFAULTS.remoteProviders]),
    remoteSearchLimit: z.number().default(DEFAULTS.remoteSearchLimit),
    remoteAutoMountLimit: z.number().default(DEFAULTS.remoteAutoMountLimit),
    remoteSearchTimeoutMs: z.number().default(DEFAULTS.remoteSearchTimeoutMs),
    remoteMinQualityScore: z.number().default(DEFAULTS.remoteMinQualityScore),
    remoteMinStars: z.number().default(DEFAULTS.remoteMinStars),
    remoteRecentActivityDays: z.number().default(DEFAULTS.remoteRecentActivityDays),
    remoteTrustPolicy: z.union(['open', 'community', 'corroborated', 'trusted'] as const)
      .default(DEFAULTS.remoteTrustPolicy),
    remoteTrustedOwners: z.array(z.string()).default([]),
    remoteBlockedOwners: z.array(z.string()).default([]),
    remoteCacheTtlMs: z.number().default(DEFAULTS.remoteCacheTtlMs),
    remoteCacheStaleIfErrorMs: z.number().default(DEFAULTS.remoteCacheStaleIfErrorMs),
    remoteCacheMaxEntries: z.number().default(DEFAULTS.remoteCacheMaxEntries),
    cacheAutoPrune: z.boolean().default(DEFAULTS.cacheAutoPrune),
    cacheMaxEntries: z.number().default(DEFAULTS.cacheMaxEntries),
    cacheMaxTotalBytes: z.number().default(DEFAULTS.cacheMaxTotalBytes),
    cacheMaxIdleDays: z.number().default(DEFAULTS.cacheMaxIdleDays),
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
  private cacheLeaseCount = 0
  private cacheMaintenancePending = false
  private readonly cacheLeaseWaiters = new Set<() => void>()
  private readonly cacheIdleWaiters = new Set<() => void>()
  private readonly activeLeaseTasks = new Set<Promise<void>>()
  private readonly pendingActiveLeaseCleanups = new Set<() => Promise<void>>()
  private readonly cacheProcessLock: CacheLockFunction = lock
  private cacheMaintenanceQueue: Promise<void> = Promise.resolve()
  private autoPruneTask: Promise<void> | undefined
  private autoPruneRequested = false
  private readonly turnStates: TurnStateRegistry
  private readonly discovery: DiscoveryCoordinator
  private readonly providers: SkillFluxProviderManager
  private readonly trustedBySession = new WeakMap<Session, Set<string>>()
  private readonly cachePruneSessions = new WeakSet<Session>()

  constructor(ctx: Context, config: SkillFluxConfig = {}) {
    super(ctx, 'skillFlux')
    this.runtimeCtx = ctx
    this.config = resolveConfig(config)
    this.turnStates = new TurnStateRegistry(message => { ctx.logger.warn(message) })
    this.cache = new SkillCache({
      root: dshHomePath('cache', 'skillflux'),
      maxFiles: this.config.maxSkillFiles,
      maxBytes: this.config.maxSkillBytes,
      installTimeoutMs: this.config.installTimeoutMs,
    })
    const discoveryCache = new RemoteDiscoveryCache({
      file: dshHomePath('storages', 'skillflux', 'remote-discovery.json'),
      ttlMs: this.config.remoteCacheTtlMs,
      staleIfErrorMs: this.config.remoteCacheStaleIfErrorMs,
      maxEntries: this.config.remoteCacheMaxEntries,
      warn: message => { ctx.logger.warn(message) },
    })
    this.remote = new RemoteDiscoveryClient({
      searchLimit: this.config.remoteSearchLimit,
      timeoutMs: this.config.remoteSearchTimeoutMs,
      providers: this.config.remoteProviders,
      minQualityScore: this.config.remoteMinQualityScore,
      minStars: this.config.remoteMinStars,
      recentActivityDays: this.config.remoteRecentActivityDays,
      trustPolicy: this.config.remoteTrustPolicy,
      trustedOwners: this.config.remoteTrustedOwners,
      blockedOwners: this.config.remoteBlockedOwners,
      cache: discoveryCache,
    })
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
    this.discovery = new DiscoveryCoordinator(this.discoveryHost)
    this.providers = new SkillFluxProviderManager(agent => ({
      catalog: () => this.turnStates.peek(agent)?.published ?? { candidates: [], complete: true },
      load: (candidates, signal) => this.loadProviderBody(agent, candidates, signal),
    }), message => { ctx.logger.warn(message) })

    const skillTool = this.createSkillTool()
    ctx.tools.register(skillTool)
    ctx.tools.register(this.createSearchTool())
    ctx.tools.register(this.createMountTool())
    registerApprovalGate(ctx, this.approvalHost)
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
      const published = state.published.candidates.map(candidate => ({
        name: candidate.name,
        description: candidate.description,
        invocation: { modelInvocable: true, userInvocable: false },
        source: SKILLFLUX_PROVIDER,
        provider: SKILLFLUX_PROVIDER,
      }))
      const skills: SkillSummary[] = [...active, ...published].slice(0, this.config.maxActiveSkills)
      return {
        kind: 'enter',
        messages: updateCatalog(agent, decision.messages, skills, this.config.catalogDescriptionMaxLength),
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
      if (event.type !== 'turn/end') return
      this.cleanupSession(session)
      this.scheduleSessionCachePrune(session)
    })
    ctx.on('session/disposed', session => { this.disposeSession(session) })
    ctx.on('agent/disposed', ({ agent }) => { this.disposeAgent(agent) })
    ctx.effect(() => async () => {
      this.turnStates.cleanupAll()
      await Promise.all(this.usageTasks)
      await this.usage?.flush()
      while (this.activeLeaseTasks.size > 0) await Promise.all(this.activeLeaseTasks)
      await this.retryPendingActiveLeaseCleanups()
      await this.autoPruneTask
    })
  }

  private get discoveryHost(): DiscoveryHost {
    return {
      runtimeCtx: this.runtimeCtx,
      cache: this.cache,
      remote: this.remote,
      config: this.config,
      embedding: this.embedding,
      usage: this.usage,
    }
  }

  private get activationHost(): ActivationHost {
    return {
      config: this.config,
      cache: this.cache,
      runtimeCtx: this.runtimeCtx,
      usage: this.usage,
      trustedBySession: this.trustedBySession,
      cachePruneSessions: this.cachePruneSessions,
      trackUsage: operation => { this.trackUsage(operation) },
      acquireCacheLease: () => this.acquireCacheLease(),
      trackActiveLeaseCleanup: operation => this.trackActiveLeaseCleanup(operation),
      assertCapacity: (state, name) => { this.assertCapacity(state, name) },
      assertCatalogBudget: (state, skill) => { this.assertCatalogBudget(state, skill) },
      assertMountCurrent: (state, generation, name, mountEpoch) => { this.assertMountCurrent(state, generation, name, mountEpoch) },
      rememberRouting: (state, mounted) => { this.rememberRouting(state, mounted) },
      scheduleAutoPrune: () => { this.scheduleAutoPrune() },
    }
  }

  private get approvalHost(): ApprovalHost {
    return {
      config: this.config,
      trustedBySession: this.trustedBySession,
      candidate: (agent, candidateId) => this.candidate(agent, candidateId),
      publishedRemote: (agent, name) => this.publishedRemote(agent, name),
    }
  }

  async discover(
    agent: Agent,
    query: string,
    options: { readonly remote?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<SkillFluxCandidate[]> {
    return await this.discovery.discover(agent, query, options)
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
    const state = this.turnStates.peek(agent)
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
    return this.turnStates.mounted(agent)
  }

  catalogStats(agent: Agent): CatalogStats {
    const mounted = this.mounted(agent)
    const state = this.turnStates.peek(agent)
    const skills: SkillSummary[] = [
      ...mounted.map(item => item.definition),
      ...(state?.published.candidates.map(candidate => ({
        name: candidate.name,
        description: candidate.description,
        invocation: { modelInvocable: true, userInvocable: false },
        source: SKILLFLUX_PROVIDER,
        provider: SKILLFLUX_PROVIDER,
      })) ?? []),
    ]
    return {
      mountedSkills: skills.length,
      estimatedTokens: estimateCatalogTokens(
        skills,
        this.config.catalogDescriptionMaxLength,
      ),
      ...(this.config.catalogTokenBudget === 0 ? {} : { budget: this.config.catalogTokenBudget }),
    }
  }

  lastRouting(agent: Agent): readonly RoutingTrace[] {
    return this.turnStates.lastRouting(agent)
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

  async cacheStats(): Promise<CacheInventoryStats> {
    return await this.cache.stats()
  }

  async discoveryCacheStats(): Promise<RemoteDiscoveryCacheStats | undefined> {
    return await this.remote.discoveryCacheStats()
  }

  async clearDiscoveryCache(): Promise<number> {
    return await this.remote.clearDiscoveryCache()
  }

  async cleanCache(selector: string): Promise<{ removed: string[]; skipped: string[] }> {
    return await this.runCacheMaintenance(async signal =>
      await this.cache.clean(selector, this.activeCacheIds(), signal))
  }

  async pruneCache(): Promise<CachePrunePlan> {
    return await this.runCacheMaintenance(async signal => {
      signal.throwIfAborted()
      await Promise.all(this.usageTasks)
      signal.throwIfAborted()
      const evidence = await this.usage?.cacheEvidence() ?? []
      signal.throwIfAborted()
      return await this.cache.prune({
        maxEntries: this.config.cacheMaxEntries,
        maxTotalBytes: this.config.cacheMaxTotalBytes,
        maxIdleMs: this.config.cacheMaxIdleDays * 24 * 60 * 60_000,
      }, evidence, this.activeCacheIds(), Date.now(), signal)
    })
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
        const definition = await this.skillDefinition(agent, args.name, exec.signal)
        if (definition === undefined) throw new Error(`skill "${args.name}" is not mounted for this turn`)
        if (!isModelInvocable(definition)) throw new Error(`skill "${args.name}" is not model-invocable`)
        const active = this.turnStates.active(agent, args.name)
        if (active !== undefined) this.trackUsage(this.usage?.recordUse(usageIdentity(active)))
        return skillResult(definition)
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
                  discoverySources: { type: 'array', items: { type: 'string' } },
                  qualityScore: { type: 'integer' },
                  relevanceScore: { type: 'integer' },
                  stars: { type: 'integer' },
                  forks: { type: 'integer' },
                  pushedAt: { type: 'string' },
                  license: { type: 'string' },
                  recentlyActive: { type: 'boolean' },
                  trustedSource: { type: 'boolean' },
                  trustLevel: { type: 'string' },
                  qualityBreakdown: {
                    type: 'object', additionalProperties: false,
                    properties: {
                      relevance: { type: 'integer', required: true },
                      adoption: { type: 'integer', required: true },
                      repository: { type: 'integer', required: true },
                      freshness: { type: 'integer', required: true },
                      trust: { type: 'integer', required: true },
                      provenance: { type: 'integer', required: true },
                      total: { type: 'integer', required: true },
                    },
                  },
                  qualitySignals: { type: 'array', items: { type: 'string' } },
                  qualityWarnings: { type: 'array', items: { type: 'string' } },
                  path: { type: 'string' },
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
            ...(candidate.origin !== 'remote' ? {} : {
              discoverySources: [...candidate.discoverySources],
              qualityScore: candidate.qualityScore,
              relevanceScore: candidate.relevanceScore,
              stars: candidate.stars,
              forks: candidate.forks,
              ...(candidate.pushedAt === undefined ? {} : { pushedAt: candidate.pushedAt }),
              ...(candidate.license === undefined ? {} : { license: candidate.license }),
              recentlyActive: candidate.recentlyActive,
              trustedSource: candidate.trustedSource,
              trustLevel: candidate.trustLevel,
              qualityBreakdown: candidate.qualityBreakdown,
              qualitySignals: [...candidate.qualitySignals],
              qualityWarnings: [...candidate.qualityWarnings],
              ...(candidate.path === undefined ? {} : { path: candidate.path }),
            }),
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
      input: { hint: 'status | explain | usage | cache list | cache prune | cache clean <cache-id|all> | discovery-cache status | discovery-cache clean' },
      handler: async invocation => await this.executeCommand(invocation),
    })
  }

  private async executeCommand(invocation: CommandInvocation): Promise<CommandResult> {
    const parts = invocation.rawInput.trim().split(/\s+/u).filter(Boolean)
    if (parts.length === 1 && parts[0] === 'status') {
      const mounted = this.mounted(invocation.agent)
      const stats = this.embeddingStats()
      const discoveryCache = await this.discoveryCacheStats()
      const installedCache = await this.cacheStats()
      const catalog = this.catalogStats(invocation.agent)
      const router = this.config.routerMode === 'lexical'
        ? 'Router: lexical.'
        : `Router: hybrid (${this.config.embeddingProvider}, ${this.config.embeddingModel}); embedding requests ${stats?.requests ?? 0}, cache ${stats?.cacheEntries ?? 0}/${this.config.embeddingCacheSize}.`
      const telemetry = `Usage tracking: ${this.config.usageTracking ? 'on' : 'off'}; adaptive routing: ${this.config.adaptiveRouting ? 'on' : 'off'}.`
      const catalogBudget = catalog.budget === undefined ? 'off' : String(catalog.budget)
      const discovery = `Remote discovery: ${this.config.remoteDiscovery}; providers ${this.config.remoteProviders
        .map(provider => provider === 'github' && !this.remote.githubSearchEnabled ? 'github (token unavailable)' : provider)
        .join(', ')}; evidence policy ${this.config.remoteTrustPolicy}; quality >= ${this.config.remoteMinQualityScore}; stars >= ${this.config.remoteMinStars}; recent window ${this.config.remoteRecentActivityDays} days; ${this.config.remoteBlockedOwners.length} blocked owner(s).`
      const discoveryCacheStatus = discoveryCache === undefined
        ? 'Remote discovery cache: unavailable.'
        : `Remote discovery cache: ${discoveryCache.enabled ? 'on' : 'off'}; ${discoveryCache.entries}/${this.config.remoteCacheMaxEntries} entries; hits ${discoveryCache.hits}, misses ${discoveryCache.misses}, stale fallbacks ${discoveryCache.staleHits}.`
      const idlePolicy = this.config.cacheMaxIdleDays === 0 ? 'off' : `${this.config.cacheMaxIdleDays} days`
      const invalidCacheStatus = installedCache.invalidEntries === 0 ? '' : `; invalid entries ${installedCache.invalidEntries} (use cache clean all)`
      const installedCacheStatus = `Installed Skill cache: ${installedCache.entries}/${this.config.cacheMaxEntries} entries, ${installedCache.totalBytes}/${this.config.cacheMaxTotalBytes} bytes; auto prune ${this.config.cacheAutoPrune ? 'on' : 'off'}; idle limit ${idlePolicy}${invalidCacheStatus}.`
      return {
        kind: 'success',
        text: `${router}\n${telemetry}\n${discovery}\n${discoveryCacheStatus}\n${installedCacheStatus}\nCatalog: ${catalog.mountedSkills} mounted, ~${catalog.estimatedTokens} estimated tokens; budget ${catalogBudget}.\n${mounted.length === 0
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
    if (parts.length === 2 && parts[0] === 'cache' && parts[1] === 'prune') {
      const plan = await this.pruneCache()
      const reasons = new Map<string, number>()
      for (const decision of plan.decisions) reasons.set(decision.reason, (reasons.get(decision.reason) ?? 0) + 1)
      const reasonText = [...reasons.entries()].map(([reason, count]) => `${reason}: ${count}`).join(', ')
      return {
        kind: 'success',
        text: `SkillFlux cache prune removed ${plan.decisions.length} entr${plan.decisions.length === 1 ? 'y' : 'ies'}${reasonText.length === 0 ? '' : ` (${reasonText})`}; ${plan.afterEntries} entries and ${plan.afterBytes} bytes remain${plan.protected.length === 0 ? '.' : `; protected active: ${plan.protected.join(', ')}.`}`,
      }
    }
    if (parts.length === 2 && parts[0] === 'discovery-cache' && parts[1] === 'status') {
      const stats = await this.discoveryCacheStats()
      return {
        kind: 'success',
        text: stats === undefined
          ? 'SkillFlux remote discovery cache is unavailable.'
          : `SkillFlux remote discovery cache: ${stats.enabled ? 'enabled' : 'disabled'}, ${stats.entries}/${this.config.remoteCacheMaxEntries} entries, ${stats.hits} hits, ${stats.misses} misses, ${stats.staleHits} stale fallbacks, ${stats.writes} writes.`,
      }
    }
    if (parts.length === 2 && parts[0] === 'discovery-cache' && parts[1] === 'clean') {
      const removed = await this.clearDiscoveryCache()
      return { kind: 'success', text: `Removed ${removed} remote discovery cache entr${removed === 1 ? 'y' : 'ies'}.` }
    }
    return { kind: 'error', text: 'Usage: /skillflux status | explain | usage | cache list | cache prune | cache clean <cache-id|all> | discovery-cache status | discovery-cache clean' }
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
      ...governedCacheCandidates(cached, this.config),
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
    const selected = await this.discovery.selectLocalCandidates(
      task,
      local,
      Math.min(local.length, this.config.maxActiveSkills * 3),
      this.config.maxActiveSkills,
      signal,
    )
    signal.throwIfAborted()
    this.assertStateCurrent(state, generation)
    state.lastRouting = selected.map(candidate => routingTrace(candidate, turn))
    const published: SkillFluxCandidate[] = []
    for (const candidate of selected) {
      if (state.active.size + published.length >= this.config.maxActiveSkills) break
      let accepted = false
      let budgetSkipped = false
      for (const fallback of fallbacksByName.get(candidate.name) ?? []) {
        const normalized: SkillFluxCandidate = {
          ...fallback,
          ...(candidate.selection === undefined ? {} : { selection: candidate.selection }),
          ...(candidate.baseScore === undefined ? {} : { baseScore: candidate.baseScore }),
          ...(candidate.adaptiveBoost === undefined ? {} : { adaptiveBoost: candidate.adaptiveBoost }),
          score: candidate.score,
        }
        if (normalized.origin === 'registry') {
          try {
            await this.mountCandidate(state, normalized, signal, generation)
            accepted = true
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
        } else {
          // Cache and remote candidates stay metadata-only: the provider
          // downloads, verifies, and loads the body lazily in get().
          if (state.active.size + published.length >= this.config.maxActiveSkills) break
          if (!this.catalogFitsBudget(state, normalized)) {
            budgetSkipped = true
            continue
          }
          published.push(normalized)
          accepted = true
        }
      }
      if (!accepted && budgetSkipped) this.markRoutingOutcome(state, candidate.id, 'budget-skipped')
    }
    state.published = { candidates: published, complete: true }
    this.providers.invalidate(agent)
    if (state.active.size > 0 || published.length > 0 || this.config.remoteDiscovery !== 'automatic') {
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
      // Incomplete observation: keep the last-good catalog contract by
      // publishing an empty but non-authoritative provider observation.
      state.published = { candidates: [], complete: false }
      this.providers.invalidate(agent)
      return updateRemoteCandidates(agent, [])
    }
    const remote: RemoteCandidate[] = []
    for (const candidate of discoveredRemote) {
      if (this.catalogFitsBudget(state, candidate)) remote.push(candidate)
      else state.lastRouting.push({ ...routingTrace(candidate, turn), outcome: 'budget-skipped' })
    }
    for (const candidate of remote) state.candidates.set(candidate.id, candidate)
    if (remote.length === 0) {
      state.published = { candidates: [], complete: true }
      this.providers.invalidate(agent)
      return updateRemoteCandidates(agent, [])
    }
    // Publish remote metadata for lazy activation; approval happens when the
    // model actually calls `skill`, just before the provider downloads.
    // Blocked or under-trust candidates stay out of the model-facing catalog.
    const publishable = remote.filter(candidate => candidateGovernanceReason(candidate, this.config) === undefined)
    state.published = { candidates: publishable.slice(0, this.config.remoteAutoMountLimit), complete: true }
    this.providers.invalidate(agent)
    return updateRemoteCandidates(agent, remote.filter(candidate => state.candidates.has(candidate.id)))
  }

  private async mountCandidate(
    state: AgentState,
    candidate: SkillFluxCandidate,
    signal?: AbortSignal,
    expectedGeneration = state.generation,
    expectedMountEpoch = state.mountEpochs.get(candidate.name) ?? 0,
  ): Promise<MountedSkill> {
    return await activateCandidate(this.activationHost, state, candidate, signal, expectedGeneration, expectedMountEpoch)
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
      [...this.catalogSkills(state), skill],
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
      [...this.catalogSkills(state), skill],
      this.config.catalogDescriptionMaxLength,
    ) <= this.config.catalogTokenBudget
  }

  private catalogSkills(state: AgentState): Pick<SkillSummary, 'name' | 'description'>[] {
    return [
      ...[...state.active.values()].map(item => item.definition),
      ...state.published.candidates.map(candidate => ({ name: candidate.name, description: candidate.description })),
    ]
  }

  private assertStateCurrent(state: AgentState, generation: number): void {
    this.turnStates.assertStateCurrent(state, generation)
  }

  private assertMountCurrent(state: AgentState, generation: number, name: string, mountEpoch: number): void {
    this.turnStates.assertMountCurrent(state, generation, name, mountEpoch)
  }

  private beginTurn(agent: Agent, turn: number): AgentState {
    const state = this.turnStates.beginTurn(agent, turn)
    this.providers.register(agent)
    return state
  }

  private state(agent: Agent): AgentState {
    return this.turnStates.state(agent)
  }

  private cleanupState(state: AgentState, forget: boolean): void {
    this.turnStates.cleanupState(state, forget)
    this.providers.dispose(state.agent)
  }

  private rememberRouting(state: AgentState, mounted: MountedSkill): void {
    this.turnStates.rememberRouting(state, mounted)
  }

  private markRoutingOutcome(state: AgentState, candidateId: string, outcome: RoutingTrace['outcome']): void {
    this.turnStates.markRoutingOutcome(state, candidateId, outcome)
  }

  private recordRoutingOutcome(state: AgentState, candidate: SkillFluxCandidate, outcome: RoutingTrace['outcome']): void {
    const trace: RoutingTrace = { ...routingTrace(candidate, state.turn), outcome }
    const index = state.lastRouting.findIndex(item => item.candidateId === candidate.id)
    if (index === -1) state.lastRouting.push(trace)
    else state.lastRouting[index] = trace
  }

  private candidate(agent: Agent, candidateId: string): SkillFluxCandidate | undefined {
    return this.turnStates.candidate(agent, candidateId)
  }

  private publishedRemote(agent: Agent, name: string): SkillFluxCandidate | undefined {
    const candidate = this.turnStates.peek(agent)?.published.candidates.find(item => item.name === name)
    if (candidate === undefined || candidate.origin !== 'remote') return undefined
    return candidate
  }

  private async skillDefinition(
    agent: Agent,
    name: string,
    signal?: AbortSignal,
  ): Promise<SkillDefinition | undefined> {
    const mounted = this.turnStates.active(agent, name)
    if (mounted !== undefined) return mounted.definition
    const published = this.turnStates.peek(agent)?.published.candidates.find(item => item.name === name)
    if (published === undefined) return undefined
    // Load through the agent-scoped provider so the lazy download,
    // verification, and load run without a same-name runtime entry shadowing
    // the provider candidate inside the shared registry.
    return await this.providers.load(agent, name, signal)
  }

  private async loadProviderBody(
    agent: Agent,
    candidates: readonly SkillFluxCandidate[],
    signal?: AbortSignal,
  ): Promise<SkillDefinition> {
    const state = this.turnStates.peek(agent)
    if (state === undefined) throw new Error('SkillFlux turn state is gone')
    const generation = state.generation
    // Share one deadline across the chain so fallback cannot multiply the
    // install budget. Await rollback/lock cleanup before trying another.
    const deadline = AbortSignal.timeout(this.config.installTimeoutMs)
    const loadSignal = signal === undefined
      ? deadline
      : AbortSignal.any([signal, deadline])
    let lastError: unknown
    for (const candidate of candidates) {
      signal?.throwIfAborted()
      this.assertStateCurrent(state, generation)
      const mountEpoch = state.mountEpochs.get(candidate.name) ?? 0
      this.assertMountCurrent(state, generation, candidate.name, mountEpoch)
      if (deadline.aborted) break
      try {
        const definition = await this.loadOne(agent, candidate, loadSignal)
        this.assertStateCurrent(state, generation)
        this.assertMountCurrent(state, generation, candidate.name, mountEpoch)
        state.candidates.clear()
        this.recordRoutingOutcome(state, candidate, 'loaded')
        return definition
      } catch (error: unknown) {
        signal?.throwIfAborted()
        if (error instanceof ExpiredAgentStateError) throw error
        // An explicit unmount or turn cleanup during the attempt invalidates
        // every remaining fallback before any outcome is recorded.
        this.assertMountCurrent(state, generation, candidate.name, mountEpoch)
        if (deadline.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
          lastError = error
          state.candidates.delete(candidate.id)
          this.recordRoutingOutcome(state, candidate, 'mount-timeout')
          break
        }
        const outcome = error instanceof CatalogBudgetExceededError ? 'budget-skipped' : 'mount-failed'
        this.recordRoutingOutcome(state, candidate, outcome)
        // Do not immediately offer an already-failed candidate back to the
        // model. A new explicit search may retry it; no persistent ban.
        state.candidates.delete(candidate.id)
        this.runtimeCtx.logger.warn(
          `SkillFlux lazy load ${outcome} for ${candidate.name} from ${candidate.source}: ${errorMessage(error)}`,
        )
        lastError = error
      }
    }
    throw lastError ?? new Error('SkillFlux lazy load expired before any candidate was attempted')
  }

  private async loadOne(
    agent: Agent,
    candidate: SkillFluxCandidate,
    signal?: AbortSignal,
  ): Promise<SkillDefinition> {
    if (candidate.origin === 'registry') {
      throw new Error(`registry skill "${candidate.name}" must be mounted eagerly`)
    }
    const governanceReason = candidateGovernanceReason(candidate, this.config)
    if (governanceReason !== undefined) throw new Error(`SkillFlux load denied: ${governanceReason}`)
    const releaseLease = await this.acquireCacheLease()
    const cacheSignal = releaseLease.signal === undefined
      ? signal
      : signal === undefined
        ? releaseLease.signal
        : AbortSignal.any([signal, releaseLease.signal])
    try {
      let entry: CacheEntry
      if (candidate.origin === 'cache') {
        const cached = await this.cache.get(candidate.cacheId)
        cacheSignal?.throwIfAborted()
        if (cached === undefined) throw new Error(`cache entry "${candidate.cacheId}" no longer exists`)
        const currentCachedCandidate = cacheCandidates([cached])[0]
        if (currentCachedCandidate === undefined) throw new Error(`cache entry "${candidate.cacheId}" is invalid`)
        const currentGovernanceReason = candidateGovernanceReason(currentCachedCandidate, this.config)
        if (currentGovernanceReason !== undefined) {
          throw new Error(`SkillFlux load denied: ${currentGovernanceReason}`)
        }
        entry = cached
      } else {
        entry = await this.cache.install(candidate, cacheSignal)
        cacheSignal?.throwIfAborted()
      }
      const definition = await this.cache.load(entry, cacheSignal)
      cacheSignal?.throwIfAborted()
      if (!isModelInvocable(definition)) throw new Error(`skill "${definition.name}" is not model-invocable`)
      if (candidate.origin === 'remote') {
        this.cachePruneSessions.add(agent.session)
        this.scheduleAutoPrune()
        if (this.config.approvalPolicy === 'session') {
          let trusted = this.trustedBySession.get(agent.session)
          if (trusted === undefined) {
            trusted = new Set()
            this.trustedBySession.set(agent.session, trusted)
          }
          trusted.add(candidate.source)
        }
      }
      return definition
    } finally {
      await releaseLease()
    }
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

  private activeCacheIds(): Set<string> {
    return this.turnStates.activeCacheIds()
  }

  private async acquireCacheLease(): Promise<CacheProcessLockRelease> {
    while (this.cacheMaintenancePending) {
      await new Promise<void>(resolve => { this.cacheLeaseWaiters.add(resolve) })
    }
    this.cacheLeaseCount += 1
    let releaseProcessLock: CacheProcessLockRelease
    try {
      releaseProcessLock = await this.acquireCacheProcessLock()
    } catch (error: unknown) {
      this.releaseLocalCacheLease()
      throw error
    }
    let releaseTask: Promise<void> | undefined
    const release = async () => {
      releaseTask ??= (async () => {
        try {
          await releaseProcessLock()
        } finally {
          this.releaseLocalCacheLease()
        }
      })()
      await releaseTask
    }
    return Object.assign(release, { signal: releaseProcessLock.signal })
  }

  private releaseLocalCacheLease(): void {
    this.cacheLeaseCount = Math.max(0, this.cacheLeaseCount - 1)
    if (this.cacheLeaseCount !== 0) return
    for (const resolve of this.cacheIdleWaiters) resolve()
    this.cacheIdleWaiters.clear()
  }

  private async acquireCacheProcessLock(): Promise<CacheProcessLockRelease> {
    await mkdir(this.cache.root, { recursive: true })
    const stale = Math.max(10_000, this.config.installTimeoutMs * 2)
    const controller = new AbortController()
    let compromised: Error | undefined
    const releaseFileLock = await this.cacheProcessLock(this.cache.root, {
      realpath: false,
      stale,
      update: Math.max(1_000, Math.min(10_000, Math.floor(stale / 2))),
      retries: {
        retries: Math.ceil((this.config.installTimeoutMs + 30_000) / 250),
        factor: 1,
        minTimeout: 250,
        maxTimeout: 250,
        randomize: true,
      },
      onCompromised: error => {
        compromised = error
        controller.abort(error)
      },
    })
    let releaseTask: Promise<void> | undefined
    const release = async () => {
      releaseTask ??= (async () => {
        let releaseError: unknown
        try {
          await releaseFileLock()
        } catch (error: unknown) {
          releaseError = error
        }
        if (compromised !== undefined) {
          throw new Error(`SkillFlux cache process lock was compromised: ${errorMessage(compromised)}`, {
            cause: compromised,
          })
        }
        if (releaseError !== undefined) throw releaseError
      })()
      await releaseTask
    }
    return Object.assign(release, { signal: controller.signal })
  }

  private async runCacheMaintenance<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const task = this.cacheMaintenanceQueue.then(async () => {
      this.cacheMaintenancePending = true
      if (this.cacheLeaseCount > 0) {
        await new Promise<void>(resolve => { this.cacheIdleWaiters.add(resolve) })
      }
      await this.retryPendingActiveLeaseCleanups()
      let releaseProcessLock: CacheProcessLockRelease | undefined
      try {
        releaseProcessLock = await this.acquireCacheProcessLock()
        releaseProcessLock.signal.throwIfAborted()
        const result = await operation(releaseProcessLock.signal)
        releaseProcessLock.signal.throwIfAborted()
        await releaseProcessLock()
        return result
      } finally {
        try {
          if (releaseProcessLock !== undefined) await releaseProcessLock()
        } finally {
          this.cacheMaintenancePending = false
          for (const resolve of this.cacheLeaseWaiters) resolve()
          this.cacheLeaseWaiters.clear()
        }
      }
    })
    this.cacheMaintenanceQueue = task.then(() => undefined, () => undefined)
    return await task
  }

  private trackActiveLeaseCleanup(operation: () => Promise<void>): Promise<void> {
    this.pendingActiveLeaseCleanups.add(operation)
    let tracked: Promise<void>
    tracked = this.retryActiveLeaseCleanup(operation)
      .then(() => { this.pendingActiveLeaseCleanups.delete(operation) })
      .catch((error: unknown) => {
        this.runtimeCtx.logger.warn(`SkillFlux active cache lease cleanup failed: ${errorMessage(error)}`)
      })
      .finally(() => { this.activeLeaseTasks.delete(tracked) })
    this.activeLeaseTasks.add(tracked)
    return tracked
  }

  private async retryPendingActiveLeaseCleanups(): Promise<void> {
    while (this.activeLeaseTasks.size > 0) await Promise.all(this.activeLeaseTasks)
    for (const operation of this.pendingActiveLeaseCleanups) {
      try {
        await this.retryActiveLeaseCleanup(operation)
        this.pendingActiveLeaseCleanups.delete(operation)
      } catch (error: unknown) {
        this.runtimeCtx.logger.warn(`SkillFlux pending active cache lease cleanup failed: ${errorMessage(error)}`)
      }
    }
  }

  private async retryActiveLeaseCleanup(operation: () => Promise<void>): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await operation()
        return
      } catch (error: unknown) {
        lastError = error
        if (attempt < 2) await new Promise<void>(resolve => { setTimeout(resolve, 25 * (attempt + 1)) })
      }
    }
    throw lastError
  }

  private scheduleAutoPrune(): void {
    if (!this.config.cacheAutoPrune) return
    this.autoPruneRequested = true
    if (this.autoPruneTask !== undefined) return
    const task = (async () => {
      while (this.autoPruneRequested) {
        this.autoPruneRequested = false
        try {
          const plan = await this.pruneCache()
          if (plan.decisions.length > 0) {
            this.runtimeCtx.logger.info(`SkillFlux cache governance removed ${plan.decisions.length} low-value entr${plan.decisions.length === 1 ? 'y' : 'ies'}.`)
          }
        } catch (error: unknown) {
          this.runtimeCtx.logger.warn(`SkillFlux automatic cache pruning failed open: ${errorMessage(error)}`)
        }
      }
    })()
      .finally(() => {
        if (this.autoPruneTask === task) this.autoPruneTask = undefined
      })
    this.autoPruneTask = task
  }

  private cleanupSession(session: Session): void {
    this.turnStates.cleanupSession(session)
    this.scheduleSessionCachePrune(session)
  }

  private disposeSession(session: Session): void {
    this.turnStates.disposeSession(session)
    this.trustedBySession.delete(session)
    this.scheduleSessionCachePrune(session)
  }

  private disposeAgent(agent: Agent): void {
    const session = this.turnStates.disposeAgent(agent)
    if (session !== undefined) this.scheduleSessionCachePrune(session)
  }

  private scheduleSessionCachePrune(session: Session): void {
    if (!this.cachePruneSessions.has(session)) return
    this.cachePruneSessions.delete(session)
    this.scheduleAutoPrune()
  }
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

function formatTimestamp(value: number | undefined): string {
  return value === undefined ? 'never' : new Date(value).toISOString()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default SkillFluxService
