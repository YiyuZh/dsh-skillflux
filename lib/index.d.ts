import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { SkillDefinition, SkillSummary } from "@deepseek-ai/dsh-skill";
import { ChildProcess, SpawnOptions } from "node:child_process";
import { Agent } from "@deepseek-ai/dsh-agent";
import "@deepseek-ai/dsh-session";
//#region src/types.d.ts
type ApprovalPolicy = 'always' | 'session' | 'automatic';
type RemoteDiscovery = 'automatic' | 'on-demand' | 'off';
type RemoteDiscoveryProvider = 'skills.sh' | 'github' | 'registry-index';
type RemoteTrustPolicy = 'open' | 'community' | 'corroborated' | 'trusted';
type RemoteTrustLevel = 'unverified' | 'community' | 'corroborated' | 'trusted';
type RegistryTier = 'official' | 'verified' | 'community' | 'unreviewed';
type RegistryDiscovery = 'off' | 'automatic';
type RemoteQualitySignal = 'trusted-owner' | 'cross-source' | 'content-pinned' | 'recent-activity' | 'declared-license' | 'organization-owned' | 'market-adoption' | 'repository-adoption' | 'ecosystem-official' | 'ecosystem-verified' | 'ecosystem-community';
type RemoteQualityWarning = 'single-source' | 'content-not-previewed' | 'activity-unknown' | 'stale-activity' | 'license-missing' | 'low-adoption' | 'ecosystem-unreviewed';
type CandidateOrigin = 'registry' | 'cache' | 'remote' | 'mcp';
type RouterMode = 'lexical' | 'hybrid';
type EmbeddingProvider = 'ollama' | 'openai-compatible';
type McpDiscovery = 'automatic' | 'off';
type CandidateSelection = 'rule' | 'lexical' | 'embedding' | 'remote-quality' | 'manual';
type TokenEstimatorKind = 'token-meter' | 'portable';
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
  /** Maximum ranked candidates attempted per automatic remote mount sequence. */
  readonly remoteAutoMountLimit?: number;
  readonly remoteSearchTimeoutMs?: number;
  readonly remoteMinQualityScore?: number;
  readonly remoteMinStars?: number;
  readonly remoteRecentActivityDays?: number;
  readonly remoteTrustPolicy?: RemoteTrustPolicy;
  readonly remoteTrustedOwners?: string[];
  readonly remoteBlockedOwners?: string[];
  readonly remoteCacheTtlMs?: number;
  readonly remoteCacheStaleIfErrorMs?: number;
  readonly remoteCacheMaxEntries?: number;
  /** Consecutive provider failures that trigger a cooldown. */
  readonly remoteHealthFailureThreshold?: number;
  /** How long a repeatedly failing source stays skipped. */
  readonly remoteHealthCooldownMs?: number;
  /** Federated ecosystem-index ingestion; experimental and off by default. */
  readonly registryDiscovery?: RegistryDiscovery;
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
  readonly mcpDiscovery?: McpDiscovery;
  /** Host-assigned MCP server labels whose skills may carry `trusted` evidence. */
  readonly mcpTrustedServers?: string[];
  /** Host-assigned MCP server labels whose skills are always refused. */
  readonly mcpBlockedServers?: string[];
  readonly routes?: RouteRule[];
}
interface ResolvedSkillFluxConfig {
  readonly maxActiveSkills: number;
  readonly minRouteScore: number;
  readonly approvalPolicy: ApprovalPolicy;
  readonly remoteDiscovery: RemoteDiscovery;
  readonly remoteProviders: readonly RemoteDiscoveryProvider[];
  readonly remoteSearchLimit: number;
  readonly remoteAutoMountLimit: number;
  readonly remoteSearchTimeoutMs: number;
  readonly remoteMinQualityScore: number;
  readonly remoteMinStars: number;
  readonly remoteRecentActivityDays: number;
  readonly remoteTrustPolicy: RemoteTrustPolicy;
  readonly remoteTrustedOwners: readonly string[];
  readonly remoteBlockedOwners: readonly string[];
  readonly remoteCacheTtlMs: number;
  readonly remoteCacheStaleIfErrorMs: number;
  readonly remoteCacheMaxEntries: number;
  readonly remoteHealthFailureThreshold: number;
  readonly remoteHealthCooldownMs: number;
  readonly registryDiscovery: RegistryDiscovery;
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
  readonly mcpDiscovery: McpDiscovery;
  readonly mcpTrustedServers: readonly string[];
  readonly mcpBlockedServers: readonly string[];
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
  readonly trustLevel?: RemoteTrustLevel;
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
  readonly trustLevel: RemoteTrustLevel;
  readonly qualityBreakdown: RemoteQualityBreakdown;
  readonly qualitySignals: readonly RemoteQualitySignal[];
  readonly qualityWarnings: readonly RemoteQualityWarning[];
  readonly path?: string;
  readonly skillFileHash?: string;
}
/** One digest-bound file of an MCP-served skill. */
interface McpSkillResource {
  /** Resource URI of the file, `sha256:{hex}` digest, and raw byte length. */
  readonly uri: string;
  readonly digest: string;
  readonly size: number;
}
/** The required fields of an MCP Skill frontmatter, with passthrough extras. */
interface McpSkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly [key: string]: unknown;
}
/** A validated `skills/list` or `skills/get` entry with an array `resources` set. */
interface McpSkillEntry {
  /** Resource URI of the skill's SKILL.md. */
  readonly uri: string;
  /** The SKILL.md frontmatter rendered verbatim as a JSON object. */
  readonly frontmatter: Readonly<McpSkillFrontmatter>;
  /** Complete, digest-bound enumeration of every file in the skill. */
  readonly resources: readonly McpSkillResource[];
}
interface McpCandidate extends CandidateRoutingMetadata {
  readonly id: string;
  readonly origin: 'mcp';
  /** Catalog name; disambiguated with path segments when a listing collides. */
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  /** Host-assigned server label; the origin half of the skill identity. */
  readonly source: string;
  readonly serverLabel: string;
  /** Resource URI of the skill's SKILL.md. */
  readonly skillUri: string;
  /** One-way fingerprint of the sorted `[uri, digest, size]` set. */
  readonly contentBoundKey: string;
  readonly frontmatter: Readonly<McpSkillFrontmatter>;
  readonly resources: readonly McpSkillResource[];
  readonly score: number;
  readonly trustLevel: RemoteTrustLevel;
}
interface RemoteQualityBreakdown {
  readonly relevance: number;
  readonly adoption: number;
  readonly repository: number;
  readonly freshness: number;
  readonly trust: number;
  readonly provenance: number;
  readonly total: number;
}
type SkillFluxCandidate = RegistryCandidate | CachedCandidate | RemoteCandidate | McpCandidate;
/** Per-turn provider catalog: metadata-only candidates plus discovery completeness. */
interface SkillFluxCatalog {
  readonly candidates: readonly SkillFluxCandidate[];
  /** Whether the current discovery is authoritative and may be cached. */
  readonly complete: boolean;
}
interface RemoteSourceHealth {
  readonly provider: RemoteDiscoveryProvider;
  readonly consecutiveFailures: number;
  readonly cooldownUntil?: number;
}
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
  readonly outcome: 'selected' | 'mounted' | 'loaded' | 'budget-skipped' | 'mount-failed' | 'mount-timeout';
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
  /** Estimated catalog footprint tokens at the most recent mount. */
  readonly catalogFootprintTokens?: number;
  /** Estimated tokens of the SKILL.md body at the most recent load. */
  readonly loadedBodyTokens?: number;
  /** Sum of every recorded loaded-body estimate. */
  readonly totalLoadedBodyTokens?: number;
  readonly lastLoadedAt?: number;
  /** Estimator that produced the token fields: native token-meter or portable. */
  readonly tokenEstimator?: TokenEstimatorKind;
}
interface CacheManifest {
  readonly version: 1;
  /** `github` is implied when absent for manifests written before v0.4. */
  readonly origin?: 'github' | 'mcp';
  readonly cacheId: string;
  readonly source: string;
  readonly ref: string;
  readonly skillId: string;
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly installs?: number;
  readonly qualityScore?: number;
  readonly trustLevel?: RemoteTrustLevel;
  readonly stars?: number;
  readonly pushedAt?: string;
  readonly discoverySources?: readonly RemoteDiscoveryProvider[];
  /** Pinned repository path proven unique for this Skill name. */
  readonly sourcePath?: string;
  /** SHA-256 of the unique pinned source SKILL.md. */
  readonly sourceSkillFileHash?: string;
  /** Present only for MCP-origin installations; carries the content-bound set. */
  readonly mcp?: {
    readonly serverLabel: string;
    readonly skillUri: string;
    readonly contentBoundKey: string;
    readonly frontmatter: Readonly<McpSkillFrontmatter>;
    readonly resources: readonly McpSkillResource[];
  };
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
//#region src/remote-source.d.ts
interface VerifiedRemoteSkill {
  readonly path: string;
  readonly skillFileHash: string;
  /** Files are present for the built-in GitHub installer. Optional for custom verifier compatibility. */
  readonly files?: readonly VerifiedRemoteFile[];
}
interface VerifiedRemoteFile {
  /** Path relative to the directory that contains the unique SKILL.md. */
  readonly path: string;
  readonly sha: string;
  readonly size: number;
}
type RemoteCandidateVerifier = (candidate: Pick<RemoteCandidate, 'source' | 'ref' | 'skillId' | 'path' | 'skillFileHash'>, signal?: AbortSignal) => Promise<VerifiedRemoteSkill>;
/**
 * Prove that the pinned repository contains exactly one usable Skill with the
 * requested name and return the immutable blobs in that Skill directory.
 */
declare function verifyUniqueRemoteSkill(candidate: Pick<RemoteCandidate, 'source' | 'ref' | 'skillId' | 'path' | 'skillFileHash'>, signal?: AbortSignal): Promise<VerifiedRemoteSkill>;
//#endregion
//#region src/mcp-source.d.ts
declare const MCP_SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
declare const MCP_MAX_RESOURCES_PER_SKILL = 512;
declare const MCP_MAX_SKILL_BYTES: number;
declare const MCP_MAX_LIST_PAGES = 10;
/**
 * Transport-agnostic JSON-RPC client for the MCP Skills extension
 * (`io.modelcontextprotocol/skills`). The transport only moves requests and
 * results; every response is validated and every retrieved byte is verified
 * against the entry digest before it is considered skill content.
 *
 * This adapter performs discovery and loading only. It never executes skill
 * content and never opens a general MCP dispatch sandbox.
 */
interface McpTransport {
  /**
   * Issue one JSON-RPC request and resolve with its `result`, or reject with
   * an `McpError` carrying the JSON-RPC error code, or any other Error.
   */
  request(method: string, params?: unknown): Promise<unknown>;
}
declare class McpError extends Error {
  readonly code: number;
  constructor(code: number, message: string);
}
/** Fetch the raw bytes for one verified resource URI. */
type McpResourceReader = (uri: string, signal?: AbortSignal) => Promise<Buffer>;
declare function assertMcpServerLabel(label: string): void;
/** The skill's root URI: its SKILL.md URI with the `/SKILL.md` suffix removed. */
declare function mcpSkillRoot(skillUri: string): string | undefined;
/**
 * Map a resource URI to its path relative to the skill directory root, or
 * undefined when the URI is outside the skill's directory or unsafe.
 */
declare function mcpRelativePath(skillUri: string, resourceUri: string): string | undefined;
declare function parseMcpSkillResource(value: unknown): McpSkillResource | undefined;
/**
 * Validate one `Skill` entry per SEP-2640 and the stable skills.mdx. Entries
 * whose `resources` is `"dynamic"` cannot be content-bound and are refused.
 */
declare function validateMcpSkillEntry(value: unknown): McpSkillEntry | undefined;
/** One-way fingerprint of the content-bound set: sorted `[uri, digest, size]`. */
declare function mcpContentBoundKey(entry: Pick<McpSkillEntry, 'resources'>): string;
/** Field-by-field JSON equality for the frontmatter verification requirement. */
declare function mcpFrontmatterEqual(parsed: unknown, expected: unknown): boolean;
interface McpCandidateOptions {
  /** Host-assigned labels whose skills may carry `trusted` evidence. */
  readonly trustedServers?: readonly string[];
}
/** Build governed candidates for one host-assigned server label. */
declare function mcpCandidates(serverLabel: string, entries: readonly McpSkillEntry[], options?: McpCandidateOptions): McpCandidate[];
interface McpSkillListing {
  readonly entries: McpSkillEntry[];
  /** True when pagination was truncated or any entry was invalid and dropped. */
  readonly partial: boolean;
}
declare class McpSkillsClient {
  private readonly transport;
  constructor(transport: McpTransport);
  /**
   * Enumerate a server's skills through `skills/list`, following pagination
   * up to `MCP_MAX_LIST_PAGES`. Invalid entries are dropped and reported via
   * `partial`; this never weakens the entry validation at load time.
   */
  listSkills(signal?: AbortSignal): Promise<McpSkillListing>;
  /** Fetch and validate one skill entry by its SKILL.md URI. */
  getSkill(uri: string, signal?: AbortSignal): Promise<McpSkillEntry>;
  /**
   * Read one resource through `resources/read` and return its raw bytes.
   * Digest and size verification happens at the cache/install boundary.
   */
  readResource(uri: string, signal?: AbortSignal): Promise<Buffer>;
}
//#endregion
//#region src/cache.d.ts
declare function isLoopbackProxyFailure(error: unknown): boolean;
interface CacheManagerOptions {
  readonly root: string;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly installTimeoutMs: number;
  readonly runInstaller?: SkillInstaller;
  readonly verifyCandidate?: RemoteCandidateVerifier;
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
  /**
   * Download, digest-verify, and materialize an MCP-served skill bound to its
   * content set. The cache id encodes the host-assigned server label, the
   * SKILL.md URI, and the content-bound key, so a changed `resources` set
   * lands at a fresh directory and never overwrites an approved snapshot.
   */
  installMcp(candidate: McpCandidate, readResource: McpResourceReader, signal?: AbortSignal): Promise<CacheEntry>;
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
//#region src/registry-source.d.ts
declare const REGISTRY_MAX_ENTRIES = 1000;
declare const REGISTRY_MAX_DESCRIPTION_LENGTH = 4096;
/** One validated entry from a federated ecosystem index. */
interface RegistryIndexEntry {
  readonly name: string;
  readonly description: string;
  /** Public GitHub repository, e.g. `owner/repo`. */
  readonly source: string;
  /** Immutable 40-character commit that the entry is pinned to. */
  readonly ref: string;
  /** Advisory ecosystem tier; evidence, never a trust grant. */
  readonly tier: RegistryTier;
  readonly installs?: number;
  readonly license?: string;
  readonly whenToUse?: string;
}
/**
 * Transport for one federated ecosystem index. Entries are advisory: they
 * flow into the same immutable-commit, evidence, and approval pipeline as
 * every other remote candidate.
 */
interface RegistryIndexTransport {
  list(signal?: AbortSignal): Promise<{
    entries: readonly unknown[];
    partial: boolean;
  }>;
}
declare function validateRegistryIndexEntry(value: unknown): RegistryIndexEntry | undefined;
interface RegistryIndexListing {
  readonly entries: RegistryIndexEntry[];
  /** True when the index reported truncation or any entry was invalid. */
  readonly partial: boolean;
}
/** Validate and bound one index listing; invalid entries are dropped. */
declare class RegistryIndexClient {
  private readonly transport;
  constructor(transport: RegistryIndexTransport);
  listEntries(signal?: AbortSignal): Promise<RegistryIndexListing>;
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
    readonly trustLevel: string;
    readonly qualitySignals: readonly string[];
    readonly qualityWarnings: readonly string[];
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
//#region src/remote-governance.d.ts
interface RemoteEvidenceInput {
  readonly relevanceScore: number;
  readonly installs: number;
  readonly stars: number;
  readonly forks: number;
  readonly pushedAt?: string;
  readonly recentActivityDays: number;
  readonly trustedSource: boolean;
  readonly organizationOwned: boolean;
  readonly hasLicense: boolean;
  readonly discoverySourceCount?: number;
  readonly contentPinned?: boolean;
  /** Advisory ecosystem tier; evidence, never a trust grant. */
  readonly registryTier?: RegistryTier;
  readonly now: number;
}
interface RemoteQualityEvidence {
  readonly trustLevel: RemoteTrustLevel;
  readonly breakdown: RemoteQualityBreakdown;
  readonly signals: readonly RemoteQualitySignal[];
  readonly warnings: readonly RemoteQualityWarning[];
}
declare function remoteQualityEvidence(input: RemoteEvidenceInput): RemoteQualityEvidence;
declare function remoteTrustPolicyAllows(level: RemoteTrustLevel, policy: RemoteTrustPolicy): boolean;
declare function compareRemoteTrust(left: RemoteTrustLevel, right: RemoteTrustLevel): number;
declare function compareRemoteCandidates(left: RemoteCandidate, right: RemoteCandidate): number;
declare function deduplicateRemoteCandidates(candidates: readonly RemoteCandidate[]): RemoteCandidate[];
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
interface RegistryDiscoveryPort {
  listSeeds(signal?: AbortSignal): Promise<{
    seeds: RegistryIndexEntry[];
    partial: boolean;
  }>;
}
interface RemoteDiscoveryOptions {
  readonly searchLimit: number;
  readonly timeoutMs: number;
  readonly providers?: readonly RemoteDiscoveryProvider[];
  readonly minQualityScore?: number;
  readonly minStars?: number;
  readonly recentActivityDays?: number;
  readonly trustPolicy?: RemoteTrustPolicy;
  readonly trustedOwners?: readonly string[];
  readonly blockedOwners?: readonly string[];
  readonly githubToken?: string;
  readonly now?: () => number;
  readonly cache?: RemoteDiscoveryCache;
  readonly healthFailureThreshold?: number;
  readonly healthCooldownMs?: number;
  readonly registryDiscovery?: 'off' | 'automatic';
  readonly registry?: RegistryDiscoveryPort;
}
interface RemoteQualityInput extends RemoteEvidenceInput {}
interface RemoteSearchObservation {
  readonly candidates: RemoteCandidate[];
  /** True when discovery completed without provider failures or stale fallback. */
  readonly complete: boolean;
}
declare function remoteQualityScore(input: RemoteQualityInput): number;
declare class RemoteDiscoveryClient {
  private readonly options;
  private readonly githubToken;
  private readonly now;
  private readonly cache;
  private readonly health;
  constructor(searchLimit: number, timeoutMs: number);
  constructor(options: RemoteDiscoveryOptions);
  get githubSearchEnabled(): boolean;
  search(query: string, signal?: AbortSignal): Promise<RemoteCandidate[]>;
  searchWithStatus(query: string, signal?: AbortSignal): Promise<RemoteSearchObservation>;
  remoteSourceHealth(): RemoteSourceHealth[];
  private providerAvailable;
  private recordHealth;
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
interface SkillUsageTelemetry {
  readonly loadedBodyTokens?: number;
  readonly catalogFootprintTokens?: number;
  readonly estimator?: TokenEstimatorKind;
}
declare class UsageStore {
  private readonly options;
  private readonly now;
  private writeQueue;
  constructor(options: UsageStoreOptions);
  recordMount(identity: SkillUsageIdentity): Promise<void>;
  recordUse(identity: SkillUsageIdentity): Promise<void>;
  /**
   * Merge bounded token telemetry into a usage record. Only token counts are
   * stored; skill bodies and task text never reach the usage document.
   */
  recordTelemetry(identity: SkillUsageIdentity, telemetry: SkillUsageTelemetry): Promise<void>;
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
//#region src/mcp-transport.d.ts
interface McpStdioTransportOptions {
  /** Executable to launch (defaults to the current Node executable). */
  readonly command?: string;
  /** Arguments for the child process. */
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  /** Refuse any response frame larger than this byte count. */
  readonly maxFrameBytes?: number;
  readonly log?: (message: string) => void;
  /** Test seam; defaults to node:child_process spawn. */
  readonly spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}
/**
 * Zero-dependency stdio transport for the MCP Skills extension, speaking the
 * LSP-style Content-Length framed JSON-RPC that MCP stdio servers use. The
 * child process is spawned lazily on the first request and torn down by
 * `close()`. Frames, ids, timeouts, and error codes are bounded and validated.
 */
declare class McpStdioTransport implements McpTransport {
  private readonly command;
  private readonly args;
  private readonly options;
  private readonly timeoutMs;
  private readonly maxFrameBytes;
  private readonly log;
  private readonly spawnImpl;
  private child;
  private buffer;
  private nextId;
  private readonly pending;
  private exited;
  constructor(options?: McpStdioTransportOptions);
  request(method: string, params?: unknown): Promise<unknown>;
  close(): void;
  private ensureChild;
  private rejectAll;
  private drain;
  private settle;
}
//#endregion
//#region src/token-meter.d.ts
interface TokenMeterMeasurement {
  readonly totalTokens: number;
  readonly surfaceTokens: number;
  readonly surfaceDeltaTokens: number;
  readonly baseline: {
    readonly kind: 'none' | 'estimated' | 'usage';
    readonly tokens: number;
    readonly usage?: unknown;
  };
  readonly nodes: readonly {
    readonly seq: unknown;
    readonly tokens: number;
    readonly heuristicTokens: number;
  }[];
}
/**
 * Structural face of the optional `@deepseek-ai/dsh-token-meter` service. The
 * package is intentionally not a dependency; the Cordis service is resolved at
 * runtime and never required.
 */
interface TokenMeterLike {
  estimateMessage(message: unknown): number;
  measure?(session: unknown, requestHeader?: unknown): TokenMeterMeasurement;
}
interface TokenEstimate {
  readonly tokens: number;
  readonly estimator: TokenEstimatorKind;
}
/**
 * Resolve the optional token-meter service. Missing, untyped, or throwing
 * lookups resolve to undefined so every consumer can fall back safely.
 */
declare function resolveTokenMeter(ctx: Context): TokenMeterLike | undefined;
/** Price one plain-text segment with the meter, falling back portably. */
declare function estimateWithMeter(meter: TokenMeterLike | undefined, text: string): TokenEstimate;
/**
 * Sum the per-entry rendered catalog lines. The estimator is native only when
 * every line was priced by the meter; any fallback downgrades the label.
 */
declare function estimateCatalogEntries(meter: TokenMeterLike | undefined, skills: readonly {
  readonly name: string;
  readonly description: string;
}[], maxLength: number): TokenEstimate;
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
  private readonly turnStates;
  private readonly discovery;
  private readonly providers;
  private readonly mcpSources;
  private readonly registryIndexes;
  private readonly trustedBySession;
  private readonly cachePruneSessions;
  constructor(ctx: Context, config?: SkillFluxConfig);
  private get discoveryHost();
  private get activationHost();
  private recordMountTelemetry;
  private get approvalHost();
  /**
   * Register one MCP Skills source under a host-assigned label. The label is
   * the origin half of every skill identity; it never comes from the server's
   * self-reported name. Registering the same label replaces the prior client.
   */
  registerMcpSource(label: string, client: McpSkillsClient): void;
  unregisterMcpSource(label: string): void;
  mcpSourceLabels(): readonly string[];
  /**
   * Register one federated ecosystem index under a host-assigned label. Index
   * entries are advisory: they join the existing immutable-commit, evidence,
   * and approval pipeline and never grant trust by themselves.
   */
  registerRegistryIndex(label: string, transport: RegistryIndexTransport): void;
  unregisterRegistryIndex(label: string): void;
  registryIndexLabels(): readonly string[];
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
  private registerExplicitInvocation;
  private registerCommand;
  private executeCommand;
  private routeTurn;
  private mountCandidate;
  private assertCapacity;
  private assertCatalogBudget;
  private catalogFitsBudget;
  private catalogSkills;
  private assertStateCurrent;
  private assertMountCurrent;
  private beginTurn;
  private state;
  private cleanupState;
  private rememberRouting;
  private markRoutingOutcome;
  private recordRoutingOutcome;
  private candidate;
  private publishedCandidate;
  private readMcpResource;
  /**
   * List every registered MCP source, validate its entries, and build scored
   * candidates. A failing source is skipped with a warning and marks the
   * observation non-authoritative; it never fails the whole discovery pass.
   */
  private listMcpCandidates;
  /**
   * Fetch MCP candidates for one turn, apply the catalog budget, and register
   * them for lazy mount. A listing failure keeps local and remote candidates
   * usable and only marks the published observation non-authoritative.
   */
  private collectMcpCandidates;
  private skillDefinition;
  private loadProviderBody;
  private loadOne;
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
export { type AdaptiveUsageOptions, type ApprovalPolicy, type CacheEntry, type CacheInventoryStats, type CacheManifest, type CachePruneDecision, type CachePrunePlan, type CachePrunePolicy, type CachePruneReason, type CacheUsageEvidence, type CachedCandidate, type CandidateOrigin, type CandidateRoutingMetadata, type CandidateSelection, type CatalogStats, type EmbeddingProvider, EmbeddingRouter, type EmbeddingRouterOptions, type EmbeddingRouterStats, MCP_MAX_LIST_PAGES, MCP_MAX_RESOURCES_PER_SKILL, MCP_MAX_SKILL_BYTES, MCP_SKILLS_EXTENSION, type McpCandidate, type McpCandidateOptions, type McpDiscovery, McpError, type McpResourceReader, type McpSkillEntry, type McpSkillFrontmatter, type McpSkillListing, type McpSkillResource, McpSkillsClient, McpStdioTransport, type McpStdioTransportOptions, type McpTransport, type MountedSkill, REGISTRY_MAX_DESCRIPTION_LENGTH, REGISTRY_MAX_ENTRIES, type RegistryCandidate, type RegistryDiscovery, RegistryIndexClient, type RegistryIndexEntry, type RegistryIndexListing, type RegistryIndexTransport, type RegistryTier, type RemoteCandidate, type RemoteCandidateVerifier, type RemoteDiscovery, RemoteDiscoveryCache, type RemoteDiscoveryCacheHit, type RemoteDiscoveryCacheOptions, type RemoteDiscoveryCacheState, type RemoteDiscoveryCacheStats, RemoteDiscoveryClient, type RemoteDiscoveryOptions, type RemoteDiscoveryProvider, type RemoteEvidenceInput, type RemoteQualityBreakdown, type RemoteQualityEvidence, type RemoteQualityInput, type RemoteQualitySignal, type RemoteQualityWarning, type RemoteSourceHealth, type RemoteTrustLevel, type RemoteTrustPolicy, type ResolvedSkillFluxConfig, type RouteRule, type RouterMode, type RoutingTrace, SkillCache, type SkillFluxCandidate, type SkillFluxCatalog, type SkillFluxConfig, SkillFluxService, SkillFluxService as default, type SkillUsageIdentity, type SkillUsageRecord, type TokenEstimate, type TokenEstimatorKind, type TokenMeterLike, type TokenMeterMeasurement, UsageStore, type UsageStoreOptions, type VerifiedRemoteSkill, assertMcpServerLabel, compareRemoteCandidates, compareRemoteTrust, deduplicateRemoteCandidates, estimateCatalogEntries, estimateCatalogTokens, estimateTextTokens, estimateWithMeter, inspectSkillDirectory, isLoopbackProxyFailure, mcpCandidates, mcpContentBoundKey, mcpFrontmatterEqual, mcpRelativePath, mcpSkillRoot, name, normalizeText, parseMcpSkillResource, parseSkillMarkdown, planCachePrune, remoteDiscoveryCacheState, remoteQualityEvidence, remoteQualityScore, remoteTrustPolicyAllows, resolveTokenMeter, routeScore, selectCandidates, tokenize, validateMcpSkillEntry, validateRegistryIndexEntry, verifyUniqueRemoteSkill };
//# sourceMappingURL=index.d.ts.map