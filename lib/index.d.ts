import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { SkillDefinition, SkillSummary } from "@deepseek-ai/dsh-skill";
import { Agent } from "@deepseek-ai/dsh-agent";
//#region src/types.d.ts
type ApprovalPolicy = 'always' | 'session' | 'automatic';
type RemoteDiscovery = 'automatic' | 'on-demand' | 'off';
type CandidateOrigin = 'registry' | 'cache' | 'remote';
type RouterMode = 'lexical' | 'hybrid';
type EmbeddingProvider = 'ollama' | 'openai-compatible';
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
  readonly remoteSearchLimit?: number;
  readonly remoteSearchTimeoutMs?: number;
  readonly catalogDescriptionMaxLength?: number;
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
  readonly routes?: RouteRule[];
}
interface ResolvedSkillFluxConfig {
  readonly maxActiveSkills: number;
  readonly minRouteScore: number;
  readonly approvalPolicy: ApprovalPolicy;
  readonly remoteDiscovery: RemoteDiscovery;
  readonly remoteSearchLimit: number;
  readonly remoteSearchTimeoutMs: number;
  readonly catalogDescriptionMaxLength: number;
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
  readonly routes: readonly RouteRule[];
}
interface EmbeddingRouterStats {
  readonly requests: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly cacheEntries: number;
}
interface RegistryCandidate {
  readonly id: string;
  readonly origin: 'registry';
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly source: string;
  readonly score: number;
  readonly summary: SkillSummary;
}
interface CachedCandidate {
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
}
interface RemoteCandidate {
  readonly id: string;
  readonly origin: 'remote';
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly ref: string;
  readonly score: number;
  readonly skillId: string;
  readonly installs: number;
}
type SkillFluxCandidate = RegistryCandidate | CachedCandidate | RemoteCandidate;
interface MountedSkill {
  readonly name: string;
  readonly origin: CandidateOrigin;
  readonly source: string;
  readonly cacheId?: string;
  readonly definition: SkillDefinition;
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
}): SkillFluxCandidate[];
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
//#region src/cache.d.ts
declare function isLoopbackProxyFailure(error: unknown): boolean;
interface CacheManagerOptions {
  readonly root: string;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly installTimeoutMs: number;
  readonly runInstaller?: SkillInstaller;
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
declare class SkillCache {
  private readonly options;
  readonly root: string;
  private readonly entriesRoot;
  private readonly stagingRoot;
  constructor(options: CacheManagerOptions);
  list(): Promise<CacheEntry[]>;
  get(id: string): Promise<CacheEntry | undefined>;
  find(source: string, ref: string, skillId: string): Promise<CacheEntry | undefined>;
  load(entry: CacheEntry, signal?: AbortSignal): Promise<SkillDefinition>;
  install(candidate: RemoteCandidate, signal?: AbortSignal): Promise<CacheEntry>;
  clean(selector: string, active?: ReadonlySet<string>): Promise<{
    removed: string[];
    skipped: string[];
  }>;
  private read;
}
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
//#region src/remote.d.ts
declare class RemoteDiscoveryClient {
  private readonly searchLimit;
  private readonly timeoutMs;
  constructor(searchLimit: number, timeoutMs: number);
  search(query: string, signal?: AbortSignal): Promise<RemoteCandidate[]>;
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
  private readonly stateByAgent;
  private readonly states;
  private readonly trustedBySession;
  constructor(ctx: Context, config?: SkillFluxConfig);
  discover(agent: Agent, query: string, options?: {
    readonly remote?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<SkillFluxCandidate[]>;
  mount(agent: Agent, candidateId: string, signal?: AbortSignal): Promise<MountedSkill>;
  unmount(agent: Agent, name?: string): void;
  reload(agent: Agent, name: string, signal?: AbortSignal): Promise<MountedSkill>;
  mounted(agent: Agent): readonly MountedSkill[];
  embeddingStats(): EmbeddingRouterStats | undefined;
  listCache(): Promise<CacheEntry[]>;
  cleanCache(selector: string): Promise<{
    removed: string[];
    skipped: string[];
  }>;
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
  private selectLocalCandidates;
  private assertStateCurrent;
  private assertMountCurrent;
  private beginTurn;
  private state;
  private cleanupState;
  private cleanupSession;
  private disposeSession;
  private disposeAgent;
}
//#endregion
export { type ApprovalPolicy, type CacheEntry, type CacheManifest, type CachedCandidate, type CandidateOrigin, type EmbeddingProvider, EmbeddingRouter, type EmbeddingRouterOptions, type EmbeddingRouterStats, type MountedSkill, type RegistryCandidate, type RemoteCandidate, type RemoteDiscovery, RemoteDiscoveryClient, type ResolvedSkillFluxConfig, type RouteRule, type RouterMode, SkillCache, type SkillFluxCandidate, type SkillFluxConfig, SkillFluxService, SkillFluxService as default, inspectSkillDirectory, isLoopbackProxyFailure, name, normalizeText, parseSkillMarkdown, routeScore, selectCandidates, tokenize };
//# sourceMappingURL=index.d.ts.map