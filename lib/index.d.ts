import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { SkillDefinition, SkillSummary } from "@deepseek-ai/dsh-skill";
import { Agent } from "@deepseek-ai/dsh-agent";
import "@deepseek-ai/dsh-session";
//#region src/types.d.ts
type ApprovalPolicy = 'always' | 'session' | 'automatic';
type RemoteDiscovery = 'automatic' | 'on-demand' | 'off';
type RemoteDiscoveryProvider = 'skills.sh' | 'github';
type CandidateOrigin = 'registry' | 'cache' | 'remote';
type RouterMode = 'lexical' | 'hybrid';
type EmbeddingProvider = 'ollama' | 'openai-compatible';
type CandidateSelection = 'rule' | 'lexical' | 'embedding' | 'remote-quality' | 'manual';
interface RouteRule {
  matchAll?: string[];
  matchAny?: string[];
  skills: string[];
}
interface SkillFluxConfig {
  readonly maxActiveSkills?: number;
  readonly minRouteScore?: number;
  readonly approvalPolicy?: ApprovalPolicy;
  readonly remoteDiscovery?: RemoteDiscovery;
  readonly remoteProviders?: RemoteDiscoveryProvider[];
  readonly remoteSearchLimit?: number;
  readonly remoteSearchTimeoutMs?: number;
  readonly remoteMinQualityScore?: number;
  readonly remoteMinStars?: number;
  readonly remoteRecentActivityDays?: number;
  readonly remoteTrustedOwners?: string[];
  readonly remoteCacheTtlMs?: number;
  readonly remoteCacheStaleIfErrorMs?: number;
  readonly remoteCacheMaxEntries?: number;
  readonly cacheAutoPrune?: boolean;
  readonly cacheMaxEntries?: number;
  readonly cacheMaxTotalBytes?: number;
  /** Zero disables idle-time eviction. */
  readonly cacheMaxIdleDays?: number;
  readonly catalogDescriptionMaxLength?: number;
  readonly catalogTokenBudget?: number;
  readonly maxSkillFiles?: number;
  readonly maxSkillBytes?: number;
  readonly installTimeoutMs?: number;
  readonly routerMode?: RouterMode;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly embeddingEndpoint?: string;
  readonly embeddingModel?: string;
  readonly embeddingApiKeyEnv?: string;
  readonly embeddingTimeoutMs?: number;
  readonly embeddingCandidateLimit?: number;
  readonly embeddingCacheSize?: number;
  readonly minEmbeddingSimilarity?: number;
  readonly usageTracking?: boolean;
  readonly usageMaxEntries?: number;
  readonly adaptiveRouting?: boolean;
  readonly adaptiveMaxBoost?: number;
  readonly adaptiveMinUses?: number;
  readonly adaptiveHalfLifeDays?: number;
  readonly routes?: RouteRule[];
}
interface ResolvedSkillFluxConfig {
  readonly maxActiveSkills: number;
  readonly minRouteScore: number;
  readonly approvalPolicy: ApprovalPolicy;
  readonly remoteDiscovery: RemoteDiscovery;
  readonly remoteProviders: readonly RemoteDiscoveryProvider[];
  readonly remoteSearchLimit: number;
  readonly remoteSearchTimeoutMs: number;
  readonly remoteMinQualityScore: number;
  readonly remoteMinStars: number;
  readonly remoteRecentActivityDays: number;
  readonly remoteTrustedOwners: readonly string[];
  readonly remoteCacheTtlMs: number;
  readonly remoteCacheStaleIfErrorMs: number;
  readonly remoteCacheMaxEntries: number;
  readonly cacheAutoPrune: boolean;
  readonly cacheMaxEntries: number;
  readonly cacheMaxTotalBytes: number;
  readonly cacheMaxIdleDays: number;
  readonly catalogDescriptionMaxLength: number;
  readonly catalogTokenBudget: number;
  readonly maxSkillFiles: number;
  readonly maxSkillBytes: number;
  readonly installTimeoutMs: number;
  readonly routerMode: RouterMode;
  readonly embeddingProvider: EmbeddingProvider;
  readonly embeddingEndpoint: string;
  readonly embeddingModel: string;
  readonly embeddingApiKeyEnv: string;
  readonly embeddingTimeoutMs: number;
  readonly embeddingCandidateLimit: number;
  readonly embeddingCacheSize: number;
  readonly minEmbeddingSimilarity: number;
  readonly usageTracking: boolean;
  readonly usageMaxEntries: number;
  readonly adaptiveRouting: boolean;
  readonly adaptiveMaxBoost: number;
  readonly adaptiveMinUses: number;
  readonly adaptiveHalfLifeDays: number;
  readonly routes: readonly RouteRule[];
}
interface EmbeddingRouterStats {
  readonly requests: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly cacheEntries: number;
}
interface RemoteDiscoveryCacheStats {
  readonly enabled: boolean;
  readonly entries: number;
  readonly hits: number;
  readonly misses: number;
  readonly staleHits: number;
  readonly writes: number;
}
interface CandidateRoutingMetadata {
  readonly selection?: CandidateSelection;
  readonly baseScore?: number;
  readonly adaptiveBoost?: number;
}
interface RegistryCandidate extends CandidateRoutingMetadata {
  readonly id: string;
  readonly origin: 'registry';
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly source: string;
  readonly score: number;
  readonly summary: SkillSummary;
}
interface CachedCandidate extends CandidateRoutingMetadata {
  readonly id: string;
  readonly origin: 'cache';
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly source: string;
  readonly ref: string;
  readonly score: number;
  readonly cacheId: string;
  readonly installs?: number;
  readonly qualityScore?: number;
  readonly stars?: number;
  readonly pushedAt?: string;
  readonly discoverySources?: readonly RemoteDiscoveryProvider[];
}
interface RemoteCandidate extends CandidateRoutingMetadata {
  readonly id: string;
  readonly origin: 'remote';
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly ref: string;
  readonly score: number;
  readonly skillId: string;
  readonly installs: number;
  readonly discoverySources: readonly RemoteDiscoveryProvider[];
  readonly qualityScore: number;
  readonly relevanceScore: number;
  readonly stars: number;
  readonly forks: number;
  readonly pushedAt?: string;
  readonly license?: string;
  readonly recentlyActive: boolean;
  readonly trustedSource: boolean;
  readonly path?: string;
  readonly skillFileHash?: string;
}
type SkillFluxCandidate = RegistryCandidate | CachedCandidate | RemoteCandidate;
interface MountedSkill {
  readonly candidateId: string;
  readonly name: string;
  readonly origin: CandidateOrigin;
  readonly source: string;
  readonly cacheId?: string;
  readonly selection: CandidateSelection;
  readonly score: number;
  readonly baseScore?: number;
  readonly adaptiveBoost?: number;
  readonly definition: SkillDefinition;
}
interface RoutingTrace {
  readonly turn?: number;
  readonly candidateId: string;
  readonly name: string;
  readonly origin: CandidateOrigin;
  readonly source: string;
  readonly selection: CandidateSelection;
  readonly outcome: 'selected' | 'mounted' | 'budget-skipped';
  readonly score: number;
  readonly baseScore?: number;
  readonly adaptiveBoost?: number;
}
interface CatalogStats {
  readonly mountedSkills: number;
  readonly estimatedTokens: number;
  readonly budget?: number;
}
interface SkillUsageIdentity {
  readonly candidateId: string;
  readonly name: string;
  readonly origin: CandidateOrigin;
  readonly source: string;
  /** Present for remote and cached mounts after immutable installation. */
  readonly cacheId?: string;
}
interface SkillUsageRecord extends SkillUsageIdentity {
  readonly mounts: number;
  readonly uses: number;
  readonly lastMountedAt?: number;
  readonly lastUsedAt?: number;
}
interface CacheManifest {
  readonly version: 1;
  readonly cacheId: string;
  readonly source: string;
  readonly ref: string;
  readonly skillId: string;
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly installs?: number;
  readonly qualityScore?: number;
  readonly stars?: number;
  readonly pushedAt?: string;
  readonly discoverySources?: readonly RemoteDiscoveryProvider[];
  readonly installedAt: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly contentHash: string;
}
interface CacheEntry {
  readonly manifest: CacheManifest;
  readonly directory: string;
}
//#endregion
//#region src/cache-governance.d.ts
type CachePruneReason = 'idle' | 'entry-limit' | 'byte-limit' | 'entry-and-byte-limit';
interface CacheUsageEvidence {
  readonly source: string;
  readonly name: string;
  /** Exact immutable cache version. Omitted only by legacy usage records. */
  readonly cacheId?: string;
  readonly mounts: number;
  readonly uses: number;
  readonly lastMountedAt?: number;
  readonly lastUsedAt?: number;
}
interface CachePrunePolicy {
  readonly maxEntries: number;
  readonly maxTotalBytes: number;
  /** Zero disables idle-time eviction. */
  readonly maxIdleMs: number;
}
interface CachePruneDecision {
  readonly cacheId: string;
  readonly reason: CachePruneReason;
}
interface CachePrunePlan {
  readonly decisions: readonly CachePruneDecision[];
  readonly protected: readonly string[];
  readonly beforeEntries: number;
  readonly beforeBytes: number;
  readonly afterEntries: number;
  readonly afterBytes: number;
}
declare function planCachePrune(entries: readonly CacheEntry[], evidence: readonly CacheUsageEvidence[], policy: CachePrunePolicy, active?: ReadonlySet<string>, now?: number): CachePrunePlan;
//#endregion
//#region src/cache.d.ts
declare function isLoopbackProxyFailure(error: unknown): boolean;
interface CacheManagerOptions {
  readonly root: string;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly installTimeoutMs: number;
  readonly runInstaller?: SkillInstaller;
  readonly removeLeaseMarker?: (file: string, directory: string) => Promise<void>;
  readonly beforeInstallCommit?: () => Promise<void>;
  readonly beforeLeaseDirectoryRead?: (directory: string) => Promise<void>;
}
interface SkillInstallerInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly env: NodeJS.ProcessEnv;
}
type SkillInstaller = (invocation: SkillInstallerInvocation) => Promise<void>;
interface CacheInventoryStats {
  readonly entries: number;
  readonly totalBytes: number;
  readonly invalidEntries: number;
}
declare class SkillCache {
  private readonly options;
  readonly root: string;
  private readonly entriesRoot;
  private readonly stagingRoot;
  private readonly leasesRoot;
  constructor(options: CacheManagerOptions);
  list(): Promise<CacheEntry[]>;
  get(id: string): Promise<CacheEntry | undefined>;
  find(source: string, ref: string, skillId: string): Promise<CacheEntry | undefined>;
  load(entry: CacheEntry, signal?: AbortSignal): Promise<SkillDefinition>;
  install(candidate: RemoteCandidate, signal?: AbortSignal): Promise<CacheEntry>;
  clean(selector: string, active?: ReadonlySet<string>, signal?: AbortSignal): Promise<{
    removed: string[];
    skipped: string[];
  }>;
  stats(): Promise<CacheInventoryStats>;
  prune(policy: CachePrunePolicy, evidence?: readonly CacheUsageEvidence[], active?: ReadonlySet<string>, now?: number, signal?: AbortSignal): Promise<CachePrunePlan>;
  createActiveLease(cacheId: string): Promise<() => Promise<void>>;
  activeLeaseIds(signal?: AbortSignal): Promise<Set<string>>;
  private read;
}
//#endregion
//#region src/router.d.ts
declare function normalizeText(value: string): string;
declare function tokenize(value: string): Set<string>;
declare function routeScore(query: string, candidate: {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
}): number;
declare function selectCandidates(query: string, candidates: readonly SkillFluxCandidate[], options: {
  readonly limit: number;
  readonly minScore: number;
  readonly routes: readonly RouteRule[];
  readonly boosts?: ReadonlyMap<string, number>;
}): SkillFluxCandidate[];
//#endregion
//#region src/catalog.d.ts
interface SkillCatalogSource {
  readonly kind: 'skill-catalog';
  readonly form: 'catalog';
  readonly update?: true;
  readonly entries: readonly {
    readonly name: string;
    readonly description: string;
  }[];
}
interface SkillFluxCandidatesSource {
  readonly kind: 'skillflux-candidates';
  readonly form: 'catalog';
  readonly update?: true;
  readonly entries: readonly {
    readonly id: string;
    readonly name: string;
    readonly source: string;
    readonly ref: string;
    readonly installs: number;
    readonly discoverySources: readonly string[];
    readonly qualityScore: number;
    readonly relevanceScore: number;
    readonly stars: number;
    readonly recentlyActive: boolean;
    readonly trustedSource: boolean;
  }[];
}
type CatalogItem = Pick<SkillSummary, 'name' | 'description'>;
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'skill-catalog': SkillCatalogSource;
    'skillflux-candidates': SkillFluxCandidatesSource;
  }
}
/**
 * Estimate prompt tokens conservatively without depending on a model-specific
 * tokenizer. Three UTF-8 bytes per token slightly overestimates typical
 * English text while staying close to one token per CJK code point.
 */
declare function estimateTextTokens(value: string): number;
/** Estimate the largest catalog prompt form (the replacement/update form). */
declare function estimateCatalogTokens(skills: readonly CatalogItem[], maxLength: number): number;
//#endregion
//#region src/skill-file.d.ts
interface ParsedSkillFile {
  readonly definition: SkillDefinition;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly contentHash: string;
}
interface TreeLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
}
declare function parseSkillMarkdown(raw: string, directory: string): SkillDefinition;
declare function inspectSkillDirectory(directory: string, limits: TreeLimits, signal?: AbortSignal): Promise<ParsedSkillFile>;
//#endregion
//#region src/embedding.d.ts
interface EmbeddingRouterOptions {
  readonly provider: EmbeddingProvider;
  readonly endpoint: string;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly timeoutMs: number;
  readonly candidateLimit: number;
  readonly cacheSize: number;
  readonly minSimilarity: number;
}
declare class EmbeddingRouter {
  private readonly options;
  private readonly vectors;
  private requests;
  private cacheHits;
  private cacheMisses;
  constructor(options: EmbeddingRouterOptions);
  stats(): EmbeddingRouterStats;
  rank(query: string, candidates: readonly SkillFluxCandidate[], limit: number, signal?: AbortSignal): Promise<SkillFluxCandidate[]>;
  private cached;
  private store;
  private embed;
  private request;
}
//#endregion
//#region src/remote-cache.d.ts
interface RemoteDiscoveryCacheOptions {
  readonly file: string;
  readonly ttlMs: number;
  readonly staleIfErrorMs: number;
  readonly maxEntries: number;
  readonly now?: () => number;
  readonly warn?: (message: string) => void;
}
interface RemoteDiscoveryCacheHit {
  readonly state: 'fresh' | 'stale';
  readonly candidates: readonly RemoteCandidate[];
}
type RemoteDiscoveryCacheState = 'fresh' | 'stale' | 'expired';
declare function remoteDiscoveryCacheState(ageMs: number, ttlMs: number, staleIfErrorMs: number): RemoteDiscoveryCacheState;
declare class RemoteDiscoveryCache {
  private readonly options;
  private readonly now;
  private entries;
  private loadTask;
  private writeQueue;
  private cacheHits;
  private cacheMisses;
  private staleHits;
  private writeCount;
  constructor(options: RemoteDiscoveryCacheOptions);
  get enabled(): boolean;
  get(key: string): Promise<RemoteDiscoveryCacheHit | undefined>;
  put(key: string, candidates: readonly RemoteCandidate[]): Promise<void>;
  recordStaleHit(): void;
  clear(): Promise<number>;
  stats(): Promise<RemoteDiscoveryCacheStats>;
  flush(): Promise<void>;
  private enqueue;
  private load;
  private readDocument;
  private trim;
  private save;
  private serializeWithinLimit;
  private warn;
  private currentTime;
}
//#endregion
//#region src/remote.d.ts
interface RemoteDiscoveryOptions {
  readonly searchLimit: number;
  readonly timeoutMs: number;
  readonly providers?: readonly RemoteDiscoveryProvider[];
  readonly minQualityScore?: number;
  readonly minStars?: number;
  readonly recentActivityDays?: number;
  readonly trustedOwners?: readonly string[];
  readonly githubToken?: string;
  readonly now?: () => number;
  readonly cache?: RemoteDiscoveryCache;
}
interface RemoteQualityInput {
  readonly relevanceScore: number;
  readonly installs: number;
  readonly stars: number;
  readonly forks: number;
  readonly pushedAt?: string;
  readonly recentActivityDays: number;
  readonly trustedSource: boolean;
  readonly organizationOwned: boolean;
  readonly hasLicense: boolean;
  readonly now: number;
}
declare function remoteQualityScore(input: RemoteQualityInput): number;
declare class RemoteDiscoveryClient {
  private readonly options;
  private readonly githubToken;
  private readonly now;
  private readonly cache;
  constructor(searchLimit: number, timeoutMs: number);
  constructor(options: RemoteDiscoveryOptions);
  get githubSearchEnabled(): boolean;
  search(query: string, signal?: AbortSignal): Promise<RemoteCandidate[]>;
  discoveryCacheStats(): Promise<RemoteDiscoveryCacheStats | undefined>;
  clearDiscoveryCache(): Promise<number>;
  private searchLive;
}
//#endregion
//#region src/usage.d.ts
interface UsageStoreOptions {
  readonly file: string;
  readonly maxEntries: number;
  readonly now?: () => number;
  readonly warn?: (message: string) => void;
}
interface AdaptiveUsageOptions {
  readonly maxBoost: number;
  readonly minUses: number;
  readonly halfLifeDays: number;
}
declare class UsageStore {
  private readonly options;
  private readonly now;
  private writeQueue;
  constructor(options: UsageStoreOptions);
  recordMount(identity: SkillUsageIdentity): Promise<void>;
  recordUse(identity: SkillUsageIdentity): Promise<void>;
  list(limit?: number): Promise<SkillUsageRecord[]>;
  cacheEvidence(): Promise<CacheUsageEvidence[]>;
  boosts(candidates: readonly SkillFluxCandidate[], options: AdaptiveUsageOptions): Promise<ReadonlyMap<string, number>>;
  flush(): Promise<void>;
  private enqueue;
  private readLatest;
  private readDocument;
  private trim;
  private save;
  private withFileLock;
  private serializeWithinLimit;
  private warn;
  private currentTime;
}
//#endregion
//#region src/index.d.ts
declare const name = "skillflux";
declare module '@deepseek-ai/cordis' {
  interface Context {
    skillFlux: SkillFluxService;
  }
}
declare class SkillFluxService extends Service {
  static inject: string[];
  static Config: z<SkillFluxConfig>;
  readonly config: ResolvedSkillFluxConfig;
  private readonly runtimeCtx;
  private readonly cache;
  private readonly remote;
  private readonly embedding;
  private readonly usage;
  private readonly usageTasks;
  private cacheLeaseCount;
  private cacheMaintenancePending;
  private readonly cacheLeaseWaiters;
  private readonly cacheIdleWaiters;
  private readonly activeLeaseTasks;
  private readonly pendingActiveLeaseCleanups;
  private readonly cacheProcessLock;
  private cacheMaintenanceQueue;
  private autoPruneTask;
  private autoPruneRequested;
  private readonly stateByAgent;
  private readonly states;
  private readonly trustedBySession;
  private readonly cachePruneSessions;
  constructor(ctx: Context, config?: SkillFluxConfig);
  discover(agent: Agent, query: string, options?: {
    readonly remote?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<SkillFluxCandidate[]>;
  mount(agent: Agent, candidateId: string, signal?: AbortSignal): Promise<MountedSkill>;
  unmount(agent: Agent, name?: string): void;
  reload(agent: Agent, name: string, signal?: AbortSignal): Promise<MountedSkill>;
  mounted(agent: Agent): readonly MountedSkill[];
  catalogStats(agent: Agent): CatalogStats;
  lastRouting(agent: Agent): readonly RoutingTrace[];
  usageRecords(limit?: number): Promise<SkillUsageRecord[]>;
  embeddingStats(): EmbeddingRouterStats | undefined;
  listCache(): Promise<CacheEntry[]>;
  cacheStats(): Promise<CacheInventoryStats>;
  discoveryCacheStats(): Promise<RemoteDiscoveryCacheStats | undefined>;
  clearDiscoveryCache(): Promise<number>;
  cleanCache(selector: string): Promise<{
    removed: string[];
    skipped: string[];
  }>;
  pruneCache(): Promise<CachePrunePlan>;
  private createSkillTool;
  private createSearchTool;
  private createMountTool;
  private registerApprovalGate;
  private registerExplicitInvocation;
  private registerCommand;
  private executeCommand;
  private routeTurn;
  private mountCandidate;
  private assertCapacity;
  private assertCatalogBudget;
  private catalogFitsBudget;
  private selectLocalCandidates;
  private assertStateCurrent;
  private assertMountCurrent;
  private beginTurn;
  private state;
  private cleanupState;
  private rememberRouting;
  private markRoutingOutcome;
  private trackUsage;
  private activeCacheIds;
  private acquireCacheLease;
  private releaseLocalCacheLease;
  private acquireCacheProcessLock;
  private runCacheMaintenance;
  private trackActiveLeaseCleanup;
  private retryPendingActiveLeaseCleanups;
  private retryActiveLeaseCleanup;
  private scheduleAutoPrune;
  private cleanupSession;
  private disposeSession;
  private disposeAgent;
  private scheduleSessionCachePrune;
}
//#endregion
export { type AdaptiveUsageOptions, type ApprovalPolicy, type CacheEntry, type CacheInventoryStats, type CacheManifest, type CachePruneDecision, type CachePrunePlan, type CachePrunePolicy, type CachePruneReason, type CacheUsageEvidence, type CachedCandidate, type CandidateOrigin, type CandidateRoutingMetadata, type CandidateSelection, type CatalogStats, type EmbeddingProvider, EmbeddingRouter, type EmbeddingRouterOptions, type EmbeddingRouterStats, type MountedSkill, type RegistryCandidate, type RemoteCandidate, type RemoteDiscovery, RemoteDiscoveryCache, type RemoteDiscoveryCacheHit, type RemoteDiscoveryCacheOptions, type RemoteDiscoveryCacheState, type RemoteDiscoveryCacheStats, RemoteDiscoveryClient, type RemoteDiscoveryOptions, type RemoteDiscoveryProvider, type RemoteQualityInput, type ResolvedSkillFluxConfig, type RouteRule, type RouterMode, type RoutingTrace, SkillCache, type SkillFluxCandidate, type SkillFluxConfig, SkillFluxService, SkillFluxService as default, type SkillUsageIdentity, type SkillUsageRecord, UsageStore, type UsageStoreOptions, estimateCatalogTokens, estimateTextTokens, inspectSkillDirectory, isLoopbackProxyFailure, name, normalizeText, parseSkillMarkdown, planCachePrune, remoteDiscoveryCacheState, remoteQualityScore, routeScore, selectCandidates, tokenize };
//# sourceMappingURL=index.d.ts.map