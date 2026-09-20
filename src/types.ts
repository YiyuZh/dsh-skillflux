import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'

export type ApprovalPolicy = 'always' | 'session' | 'automatic'
export type RemoteDiscovery = 'automatic' | 'on-demand' | 'off'
export type RemoteDiscoveryProvider = 'skills.sh' | 'github'
export type RemoteTrustPolicy = 'open' | 'community' | 'corroborated' | 'trusted'
export type RemoteTrustLevel = 'unverified' | 'community' | 'corroborated' | 'trusted'
export type RemoteQualitySignal =
  | 'trusted-owner'
  | 'cross-source'
  | 'content-pinned'
  | 'recent-activity'
  | 'declared-license'
  | 'organization-owned'
  | 'market-adoption'
  | 'repository-adoption'
export type RemoteQualityWarning =
  | 'single-source'
  | 'content-not-previewed'
  | 'activity-unknown'
  | 'stale-activity'
  | 'license-missing'
  | 'low-adoption'
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
  /** Maximum ranked candidates attempted per automatic remote mount sequence. */
  readonly remoteAutoMountLimit?: number
  readonly remoteSearchTimeoutMs?: number
  readonly remoteMinQualityScore?: number
  readonly remoteMinStars?: number
  readonly remoteRecentActivityDays?: number
  readonly remoteTrustPolicy?: RemoteTrustPolicy
  readonly remoteTrustedOwners?: string[]
  readonly remoteBlockedOwners?: string[]
  readonly remoteCacheTtlMs?: number
  readonly remoteCacheStaleIfErrorMs?: number
  readonly remoteCacheMaxEntries?: number
  /** Consecutive provider failures that trigger a cooldown. */
  readonly remoteHealthFailureThreshold?: number
  /** How long a repeatedly failing source stays skipped. */
  readonly remoteHealthCooldownMs?: number
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
  readonly remoteAutoMountLimit: number
  readonly remoteSearchTimeoutMs: number
  readonly remoteMinQualityScore: number
  readonly remoteMinStars: number
  readonly remoteRecentActivityDays: number
  readonly remoteTrustPolicy: RemoteTrustPolicy
  readonly remoteTrustedOwners: readonly string[]
  readonly remoteBlockedOwners: readonly string[]
  readonly remoteCacheTtlMs: number
  readonly remoteCacheStaleIfErrorMs: number
  readonly remoteCacheMaxEntries: number
  readonly remoteHealthFailureThreshold: number
  readonly remoteHealthCooldownMs: number
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
  readonly trustLevel?: RemoteTrustLevel
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
  readonly trustLevel: RemoteTrustLevel
  readonly qualityBreakdown: RemoteQualityBreakdown
  readonly qualitySignals: readonly RemoteQualitySignal[]
  readonly qualityWarnings: readonly RemoteQualityWarning[]
  readonly path?: string
  readonly skillFileHash?: string
}

export interface RemoteQualityBreakdown {
  readonly relevance: number
  readonly adoption: number
  readonly repository: number
  readonly freshness: number
  readonly trust: number
  readonly provenance: number
  readonly total: number
}

export type SkillFluxCandidate = RegistryCandidate | CachedCandidate | RemoteCandidate

/** Per-turn provider catalog: metadata-only candidates plus discovery completeness. */
export interface SkillFluxCatalog {
  readonly candidates: readonly SkillFluxCandidate[]
  /** Whether the current discovery is authoritative and may be cached. */
  readonly complete: boolean
}

export interface RemoteSourceHealth {
  readonly provider: RemoteDiscoveryProvider
  readonly consecutiveFailures: number
  readonly cooldownUntil?: number
}

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
  readonly outcome: 'selected' | 'mounted' | 'loaded' | 'budget-skipped' | 'mount-failed' | 'mount-timeout'
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
  readonly trustLevel?: RemoteTrustLevel
  readonly stars?: number
  readonly pushedAt?: string
  readonly discoverySources?: readonly RemoteDiscoveryProvider[]
  /** Pinned repository path proven unique for this Skill name. */
  readonly sourcePath?: string
  /** SHA-256 of the unique pinned source SKILL.md. */
  readonly sourceSkillFileHash?: string
  readonly installedAt: string
  readonly fileCount: number
  readonly totalBytes: number
  readonly contentHash: string
}

export interface CacheEntry {
  readonly manifest: CacheManifest
  readonly directory: string
}
