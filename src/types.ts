import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'

export type ApprovalPolicy = 'always' | 'session' | 'automatic'
export type RemoteDiscovery = 'automatic' | 'on-demand' | 'off'
export type RemoteDiscoveryProvider = 'skills.sh' | 'github' | 'registry-index'
export type RemoteTrustPolicy = 'open' | 'community' | 'corroborated' | 'trusted'
export type RemoteTrustLevel = 'unverified' | 'community' | 'corroborated' | 'trusted'
export type RegistryTier = 'official' | 'verified' | 'community' | 'unreviewed'
export type RegistryDiscovery = 'off' | 'automatic'
export type RemoteQualitySignal =
  | 'trusted-owner'
  | 'cross-source'
  | 'content-pinned'
  | 'recent-activity'
  | 'declared-license'
  | 'organization-owned'
  | 'market-adoption'
  | 'repository-adoption'
  | 'ecosystem-official'
  | 'ecosystem-verified'
  | 'ecosystem-community'
export type RemoteQualityWarning =
  | 'single-source'
  | 'content-not-previewed'
  | 'activity-unknown'
  | 'stale-activity'
  | 'license-missing'
  | 'low-adoption'
  | 'ecosystem-unreviewed'
export type CandidateOrigin = 'registry' | 'cache' | 'remote' | 'mcp'
export type RouterMode = 'lexical' | 'hybrid'
export type EmbeddingProvider = 'ollama' | 'openai-compatible'
export type McpDiscovery = 'automatic' | 'off'
export type CandidateSelection = 'rule' | 'lexical' | 'embedding' | 'remote-quality' | 'manual'
export type TokenEstimatorKind = 'token-meter' | 'portable'

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
  /** Federated ecosystem-index ingestion; experimental and off by default. */
  readonly registryDiscovery?: RegistryDiscovery
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
  readonly mcpDiscovery?: McpDiscovery
  /** Host-assigned MCP server labels whose skills may carry `trusted` evidence. */
  readonly mcpTrustedServers?: string[]
  /** Host-assigned MCP server labels whose skills are always refused. */
  readonly mcpBlockedServers?: string[]
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
  readonly registryDiscovery: RegistryDiscovery
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
  readonly mcpDiscovery: McpDiscovery
  readonly mcpTrustedServers: readonly string[]
  readonly mcpBlockedServers: readonly string[]
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

/** One digest-bound file of an MCP-served skill. */
export interface McpSkillResource {
  /** Resource URI of the file, `sha256:{hex}` digest, and raw byte length. */
  readonly uri: string
  readonly digest: string
  readonly size: number
}

/** The required fields of an MCP Skill frontmatter, with passthrough extras. */
export interface McpSkillFrontmatter {
  readonly name: string
  readonly description: string
  readonly [key: string]: unknown
}

/** A validated `skills/list` or `skills/get` entry with an array `resources` set. */
export interface McpSkillEntry {
  /** Resource URI of the skill's SKILL.md. */
  readonly uri: string
  /** The SKILL.md frontmatter rendered verbatim as a JSON object. */
  readonly frontmatter: Readonly<McpSkillFrontmatter>
  /** Complete, digest-bound enumeration of every file in the skill. */
  readonly resources: readonly McpSkillResource[]
}

export interface McpCandidate extends CandidateRoutingMetadata {
  readonly id: string
  readonly origin: 'mcp'
  /** Catalog name; disambiguated with path segments when a listing collides. */
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  /** Host-assigned server label; the origin half of the skill identity. */
  readonly source: string
  readonly serverLabel: string
  /** Resource URI of the skill's SKILL.md. */
  readonly skillUri: string
  /** One-way fingerprint of the sorted `[uri, digest, size]` set. */
  readonly contentBoundKey: string
  readonly frontmatter: Readonly<McpSkillFrontmatter>
  readonly resources: readonly McpSkillResource[]
  readonly score: number
  readonly trustLevel: RemoteTrustLevel
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

export type SkillFluxCandidate = RegistryCandidate | CachedCandidate | RemoteCandidate | McpCandidate

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
  /** Estimated catalog footprint tokens at the most recent mount. */
  readonly catalogFootprintTokens?: number
  /** Estimated tokens of the SKILL.md body at the most recent load. */
  readonly loadedBodyTokens?: number
  /** Sum of every recorded loaded-body estimate. */
  readonly totalLoadedBodyTokens?: number
  readonly lastLoadedAt?: number
  /** Estimator that produced the token fields: native token-meter or portable. */
  readonly tokenEstimator?: TokenEstimatorKind
}

export interface CacheManifest {
  readonly version: 1
  /** `github` is implied when absent for manifests written before v0.4. */
  readonly origin?: 'github' | 'mcp'
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
  /** Present only for MCP-origin installations; carries the content-bound set. */
  readonly mcp?: {
    readonly serverLabel: string
    readonly skillUri: string
    readonly contentBoundKey: string
    readonly frontmatter: Readonly<McpSkillFrontmatter>
    readonly resources: readonly McpSkillResource[]
  }
  readonly installedAt: string
  readonly fileCount: number
  readonly totalBytes: number
  readonly contentHash: string
}

export interface CacheEntry {
  readonly manifest: CacheManifest
  readonly directory: string
}
