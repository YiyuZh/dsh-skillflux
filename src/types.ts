import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'

export type ApprovalPolicy = 'always' | 'session' | 'automatic'
export type RemoteDiscovery = 'automatic' | 'on-demand' | 'off'
export type RemoteDiscoveryProvider = 'skills.sh' | 'github'
export type CandidateOrigin = 'registry' | 'cache' | 'remote'
export type RouterMode = 'lexical' | 'hybrid'
export type EmbeddingProvider = 'ollama' | 'openai-compatible'
export type CandidateSelection = 'rule' | 'lexical' | 'embedding' | 'remote-quality' | 'manual'

export interface RouteRule {
  matchAll?: string[]
  matchAny?: string[]
  skills: string[]
}

export interface SkillFluxConfig {
  readonly maxActiveSkills?: number
  readonly minRouteScore?: number
  readonly approvalPolicy?: ApprovalPolicy
  readonly remoteDiscovery?: RemoteDiscovery
  readonly remoteProviders?: RemoteDiscoveryProvider[]
  readonly remoteSearchLimit?: number
  readonly remoteSearchTimeoutMs?: number
  readonly remoteMinQualityScore?: number
  readonly remoteMinStars?: number
  readonly remoteRecentActivityDays?: number
  readonly remoteTrustedOwners?: string[]
  readonly remoteCacheTtlMs?: number
  readonly remoteCacheStaleIfErrorMs?: number
  readonly remoteCacheMaxEntries?: number
  readonly cacheAutoPrune?: boolean
  readonly cacheMaxEntries?: number
  readonly cacheMaxTotalBytes?: number
  /** Zero disables idle-time eviction. */
  readonly cacheMaxIdleDays?: number
  readonly catalogDescriptionMaxLength?: number
  readonly catalogTokenBudget?: number
  readonly maxSkillFiles?: number
  readonly maxSkillBytes?: number
  readonly installTimeoutMs?: number
  readonly routerMode?: RouterMode
  readonly embeddingProvider?: EmbeddingProvider
  readonly embeddingEndpoint?: string
  readonly embeddingModel?: string
  readonly embeddingApiKeyEnv?: string
  readonly embeddingTimeoutMs?: number
  readonly embeddingCandidateLimit?: number
  readonly embeddingCacheSize?: number
  readonly minEmbeddingSimilarity?: number
  readonly usageTracking?: boolean
  readonly usageMaxEntries?: number
  readonly adaptiveRouting?: boolean
  readonly adaptiveMaxBoost?: number
  readonly adaptiveMinUses?: number
  readonly adaptiveHalfLifeDays?: number
  readonly routes?: RouteRule[]
}

export interface ResolvedSkillFluxConfig {
  readonly maxActiveSkills: number
  readonly minRouteScore: number
  readonly approvalPolicy: ApprovalPolicy
  readonly remoteDiscovery: RemoteDiscovery
  readonly remoteProviders: readonly RemoteDiscoveryProvider[]
  readonly remoteSearchLimit: number
  readonly remoteSearchTimeoutMs: number
  readonly remoteMinQualityScore: number
  readonly remoteMinStars: number
  readonly remoteRecentActivityDays: number
  readonly remoteTrustedOwners: readonly string[]
  readonly remoteCacheTtlMs: number
  readonly remoteCacheStaleIfErrorMs: number
  readonly remoteCacheMaxEntries: number
  readonly cacheAutoPrune: boolean
  readonly cacheMaxEntries: number
  readonly cacheMaxTotalBytes: number
  readonly cacheMaxIdleDays: number
  readonly catalogDescriptionMaxLength: number
  readonly catalogTokenBudget: number
  readonly maxSkillFiles: number
  readonly maxSkillBytes: number
  readonly installTimeoutMs: number
  readonly routerMode: RouterMode
  readonly embeddingProvider: EmbeddingProvider
  readonly embeddingEndpoint: string
  readonly embeddingModel: string
  readonly embeddingApiKeyEnv: string
  readonly embeddingTimeoutMs: number
  readonly embeddingCandidateLimit: number
  readonly embeddingCacheSize: number
  readonly minEmbeddingSimilarity: number
  readonly usageTracking: boolean
  readonly usageMaxEntries: number
  readonly adaptiveRouting: boolean
  readonly adaptiveMaxBoost: number
  readonly adaptiveMinUses: number
  readonly adaptiveHalfLifeDays: number
  readonly routes: readonly RouteRule[]
}

export interface EmbeddingRouterStats {
  readonly requests: number
  readonly cacheHits: number
  readonly cacheMisses: number
  readonly cacheEntries: number
}

export interface RemoteDiscoveryCacheStats {
  readonly enabled: boolean
  readonly entries: number
  readonly hits: number
  readonly misses: number
  readonly staleHits: number
  readonly writes: number
}

export interface CandidateRoutingMetadata {
  readonly selection?: CandidateSelection
  readonly baseScore?: number
  readonly adaptiveBoost?: number
}

export interface RegistryCandidate extends CandidateRoutingMetadata {
  readonly id: string
  readonly origin: 'registry'
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly source: string
  readonly score: number
  readonly summary: SkillSummary
}

export interface CachedCandidate extends CandidateRoutingMetadata {
  readonly id: string
  readonly origin: 'cache'
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly source: string
  readonly ref: string
  readonly score: number
  readonly cacheId: string
  readonly installs?: number
  readonly qualityScore?: number
  readonly stars?: number
  readonly pushedAt?: string
  readonly discoverySources?: readonly RemoteDiscoveryProvider[]
}

export interface RemoteCandidate extends CandidateRoutingMetadata {
  readonly id: string
  readonly origin: 'remote'
  readonly name: string
  readonly description: string
  readonly source: string
  readonly ref: string
  readonly score: number
  readonly skillId: string
  readonly installs: number
  readonly discoverySources: readonly RemoteDiscoveryProvider[]
  readonly qualityScore: number
  readonly relevanceScore: number
  readonly stars: number
  readonly forks: number
  readonly pushedAt?: string
  readonly license?: string
  readonly recentlyActive: boolean
  readonly trustedSource: boolean
  readonly path?: string
  readonly skillFileHash?: string
}

export type SkillFluxCandidate = RegistryCandidate | CachedCandidate | RemoteCandidate

export interface MountedSkill {
  readonly candidateId: string
  readonly name: string
  readonly origin: CandidateOrigin
  readonly source: string
  readonly cacheId?: string
  readonly selection: CandidateSelection
  readonly score: number
  readonly baseScore?: number
  readonly adaptiveBoost?: number
  readonly definition: SkillDefinition
}

export interface RoutingTrace {
  readonly turn?: number
  readonly candidateId: string
  readonly name: string
  readonly origin: CandidateOrigin
  readonly source: string
  readonly selection: CandidateSelection
  readonly outcome: 'selected' | 'mounted' | 'budget-skipped'
  readonly score: number
  readonly baseScore?: number
  readonly adaptiveBoost?: number
}

export interface CatalogStats {
  readonly mountedSkills: number
  readonly estimatedTokens: number
  readonly budget?: number
}

export interface SkillUsageIdentity {
  readonly candidateId: string
  readonly name: string
  readonly origin: CandidateOrigin
  readonly source: string
  /** Present for remote and cached mounts after immutable installation. */
  readonly cacheId?: string
}

export interface SkillUsageRecord extends SkillUsageIdentity {
  readonly mounts: number
  readonly uses: number
  readonly lastMountedAt?: number
  readonly lastUsedAt?: number
}

export interface CacheManifest {
  readonly version: 1
  readonly cacheId: string
  readonly source: string
  readonly ref: string
  readonly skillId: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly installs?: number
  readonly qualityScore?: number
  readonly stars?: number
  readonly pushedAt?: string
  readonly discoverySources?: readonly RemoteDiscoveryProvider[]
  readonly installedAt: string
  readonly fileCount: number
  readonly totalBytes: number
  readonly contentHash: string
}

export interface CacheEntry {
  readonly manifest: CacheManifest
  readonly directory: string
}
