import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { candidateId, routeScore, tokenize } from './router.js'
import { RemoteDiscoveryCache } from './remote-cache.js'
import { parseSkillMarkdown } from './skill-file.js'
import type { RemoteCandidate, RemoteDiscoveryCacheStats, RemoteDiscoveryProvider } from './types.js'

interface SkillsSearchItem {
  readonly skillId: string
  readonly name: string
  readonly installs: number
  readonly source: string
}

interface SkillsSearchResponse {
  readonly skills: readonly SkillsSearchItem[]
}

interface GithubCodeSearchItem {
  readonly path: string
  readonly repository: { readonly full_name: string; readonly private: boolean }
}

interface GithubCodeSearchResponse {
  readonly items: readonly GithubCodeSearchItem[]
}

interface GithubRepositoryResponse {
  readonly private: boolean
  readonly stargazers_count: number
  readonly forks_count: number
  readonly pushed_at: string | null
  readonly archived: boolean
  readonly disabled: boolean
  readonly owner: { readonly type: string }
  readonly license: { readonly spdx_id: string | null } | null
}

interface GithubGraphqlRepository {
  readonly isPrivate: boolean
  readonly stargazerCount: number
  readonly forkCount: number
  readonly pushedAt: string | null
  readonly isArchived: boolean
  readonly isDisabled: boolean
  readonly owner: { readonly __typename: string }
  readonly licenseInfo: { readonly spdxId: string | null } | null
  readonly defaultBranchRef: { readonly target: { readonly oid: string } } | null
}

interface RepositorySnapshot {
  readonly ref: string
  readonly stars: number
  readonly forks: number
  readonly pushedAt?: string
  readonly archived: boolean
  readonly disabled: boolean
  readonly private: boolean
  readonly organizationOwned: boolean
  readonly license?: string
}

interface CandidateSeed {
  readonly source: string
  readonly skillId: string
  readonly name: string
  readonly description: string
  readonly installs: number
  readonly discoverySources: readonly RemoteDiscoveryProvider[]
  readonly path?: string
  readonly skillFileHash?: string
}

export interface RemoteDiscoveryOptions {
  readonly searchLimit: number
  readonly timeoutMs: number
  readonly providers?: readonly RemoteDiscoveryProvider[]
  readonly minQualityScore?: number
  readonly minStars?: number
  readonly recentActivityDays?: number
  readonly trustedOwners?: readonly string[]
  readonly githubToken?: string
  readonly now?: () => number
  readonly cache?: RemoteDiscoveryCache
}

export interface RemoteQualityInput {
  readonly relevanceScore: number
  readonly installs: number
  readonly stars: number
  readonly forks: number
  readonly pushedAt?: string
  readonly recentActivityDays: number
  readonly trustedSource: boolean
  readonly organizationOwned: boolean
  readonly hasLicense: boolean
  readonly now: number
}

const GITHUB_SOURCE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const MAX_REMOTE_SKILL_BYTES = 256 * 1024

function boundedQuery(query: string): string {
  return query.normalize('NFKC').replaceAll(/\s+/gu, ' ').trim().slice(0, 128)
}

interface RemoteSearchResult {
  readonly candidates: RemoteCandidate[]
  readonly degraded: boolean
}

function discoveryCacheKey(
  query: string,
  options: Required<Omit<RemoteDiscoveryOptions, 'githubToken' | 'now' | 'cache'>>,
  githubSearchEnabled: boolean,
): string {
  return createHash('sha256').update(JSON.stringify({
    query,
    searchLimit: options.searchLimit,
    providers: options.providers,
    minQualityScore: options.minQualityScore,
    minStars: options.minStars,
    recentActivityDays: options.recentActivityDays,
    trustedOwners: options.trustedOwners,
    githubSearchEnabled,
  })).digest('hex')
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout])
}

function configuredGithubToken(explicit?: string): string | undefined {
  const token = explicit ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  return token === undefined || token.length === 0 ? undefined : token
}

function githubHeaders(token?: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-skillflux',
    'x-github-api-version': '2022-11-28',
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  }
}

function isSearchItem(value: unknown): value is SkillsSearchItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return typeof item.skillId === 'string'
    && SKILL_NAME.test(item.skillId)
    && typeof item.name === 'string'
    && item.name.trim().length > 0
    && item.name.length <= 4_096
    && typeof item.installs === 'number'
    && Number.isSafeInteger(item.installs)
    && item.installs >= 0
    && typeof item.source === 'string'
    && GITHUB_SOURCE.test(item.source)
}

function isSkillPath(path: string): boolean {
  if (path.length === 0 || path.length > 512 || path.startsWith('/') || path.includes('\\')) return false
  const segments = path.split('/')
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
    && segments.at(-1)?.toLocaleLowerCase('en-US') === 'skill.md'
}

function isGithubCodeSearchItem(value: unknown): value is GithubCodeSearchItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  if (typeof item.path !== 'string' || !isSkillPath(item.path)) return false
  if (typeof item.repository !== 'object' || item.repository === null) return false
  const repository = item.repository as Record<string, unknown>
  return typeof repository.full_name === 'string'
    && GITHUB_SOURCE.test(repository.full_name)
    && repository.private === false
}

function isRepositoryResponse(value: unknown): value is GithubRepositoryResponse {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  const owner = item.owner
  const license = item.license
  return typeof item.stargazers_count === 'number'
    && Number.isSafeInteger(item.stargazers_count)
    && item.stargazers_count >= 0
    && typeof item.forks_count === 'number'
    && Number.isSafeInteger(item.forks_count)
    && item.forks_count >= 0
    && (typeof item.pushed_at === 'string' || item.pushed_at === null)
    && typeof item.archived === 'boolean'
    && typeof item.disabled === 'boolean'
    && typeof item.private === 'boolean'
    && typeof owner === 'object'
    && owner !== null
    && typeof (owner as Record<string, unknown>).type === 'string'
    && (license === null || (typeof license === 'object'
      && typeof (license as Record<string, unknown>).spdx_id !== 'undefined'))
}

function logarithmicPoints(value: number, multiplier: number, maximum: number): number {
  return Math.min(maximum, Math.round(Math.log10(value + 1) * multiplier))
}

function activityAgeDays(pushedAt: string | undefined, now: number): number | undefined {
  if (pushedAt === undefined) return undefined
  const pushed = Date.parse(pushedAt)
  if (!Number.isFinite(pushed)) return undefined
  return Math.max(0, (now - pushed) / 86_400_000)
}

export function remoteQualityScore(input: RemoteQualityInput): number {
  const relevance = input.relevanceScore >= 100
    ? 55
    : Math.min(50, Math.max(0, input.relevanceScore * 2))
  const adoption = logarithmicPoints(input.installs, 4, 15)
  const repository = logarithmicPoints(input.stars, 4, 15) + logarithmicPoints(input.forks, 2, 5)
  const age = activityAgeDays(input.pushedAt, input.now)
  const freshness = age === undefined
    ? 0
    : age <= input.recentActivityDays
      ? 10
      : age <= input.recentActivityDays * 3
        ? 6
        : age <= 365
          ? 3
          : 0
  const trust = (input.trustedSource ? 10 : 0) + (input.organizationOwned ? 3 : 0) + (input.hasLicense ? 2 : 0)
  return Math.min(100, relevance + adoption + repository + freshness + trust)
}

function graphqlRepository(value: unknown): GithubGraphqlRepository | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const item = value as Record<string, unknown>
  const owner = item.owner
  const license = item.licenseInfo
  const branch = item.defaultBranchRef
  if (typeof item.stargazerCount !== 'number' || !Number.isSafeInteger(item.stargazerCount)
    || typeof item.forkCount !== 'number' || !Number.isSafeInteger(item.forkCount)
    || (typeof item.pushedAt !== 'string' && item.pushedAt !== null)
    || typeof item.isArchived !== 'boolean'
    || typeof item.isDisabled !== 'boolean'
    || typeof item.isPrivate !== 'boolean'
    || typeof owner !== 'object' || owner === null
    || typeof (owner as Record<string, unknown>).__typename !== 'string'
    || (license !== null && (typeof license !== 'object' || license === null
      || (typeof (license as Record<string, unknown>).spdxId !== 'string'
        && (license as Record<string, unknown>).spdxId !== null)))
    || (branch !== null && (typeof branch !== 'object' || branch === null))) return undefined
  if (branch !== null) {
    const target = (branch as Record<string, unknown>).target
    if (typeof target !== 'object' || target === null
      || typeof (target as Record<string, unknown>).oid !== 'string') return undefined
  }
  return item as unknown as GithubGraphqlRepository
}

function snapshotFromGraphql(value: unknown): RepositorySnapshot | undefined {
  const repository = graphqlRepository(value)
  const ref = repository?.defaultBranchRef?.target.oid
  if (repository === undefined || ref === undefined || !/^[0-9a-f]{40}$/u.test(ref)) return undefined
  const license = repository.licenseInfo?.spdxId
  return {
    ref,
    stars: repository.stargazerCount,
    forks: repository.forkCount,
    ...(repository.pushedAt === null ? {} : { pushedAt: repository.pushedAt }),
    archived: repository.isArchived,
    disabled: repository.isDisabled,
    private: repository.isPrivate,
    organizationOwned: repository.owner.__typename === 'Organization',
    ...(typeof license !== 'string' || license === 'NOASSERTION' ? {} : { license }),
  }
}

async function resolveRepositoryRest(
  source: string,
  signal: AbortSignal,
  token?: string,
): Promise<RepositorySnapshot> {
  const [owner, repo] = source.split('/')
  if (owner === undefined || repo === undefined) throw new Error(`invalid GitHub source "${source}"`)
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const headers = githubHeaders(token)
  const [repositoryResponse, headResponse] = await Promise.all([
    fetch(base, { headers, signal }),
    fetch(`${base}/commits/HEAD`, { headers, signal }),
  ])
  if (!repositoryResponse.ok) throw new Error(`GitHub repository lookup failed for ${source}: HTTP ${repositoryResponse.status}`)
  if (!headResponse.ok) throw new Error(`GitHub HEAD lookup failed for ${source}: HTTP ${headResponse.status}`)
  const repository = await repositoryResponse.json() as unknown
  const head = await headResponse.json() as { sha?: unknown }
  if (!isRepositoryResponse(repository)) throw new Error(`GitHub returned invalid repository metadata for ${source}`)
  if (typeof head.sha !== 'string' || !/^[0-9a-f]{40}$/u.test(head.sha)) {
    throw new Error(`GitHub returned an invalid HEAD for ${source}`)
  }
  const license = repository.license?.spdx_id
  return {
    ref: head.sha,
    stars: repository.stargazers_count,
    forks: repository.forks_count,
    ...(repository.pushed_at === null ? {} : { pushedAt: repository.pushed_at }),
    archived: repository.archived,
    disabled: repository.disabled,
    private: repository.private,
    organizationOwned: repository.owner.type === 'Organization',
    ...(typeof license !== 'string' || license === 'NOASSERTION' ? {} : { license }),
  }
}

async function resolveRepositories(
  sources: readonly string[],
  signal: AbortSignal,
  token?: string,
): Promise<Map<string, RepositorySnapshot>> {
  if (sources.length === 0) return new Map()
  if (token === undefined) {
    const results = await Promise.allSettled(sources.map(async source => ({
      source,
      snapshot: await resolveRepositoryRest(source, signal),
    })))
    signal.throwIfAborted()
    return new Map(results.flatMap(result => result.status === 'fulfilled'
      ? [[result.value.source, result.value.snapshot] as const]
      : []))
  }
  const fields = sources.map((source, index) => {
    const [owner, name] = source.split('/')
    return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {`
      + ' stargazerCount forkCount pushedAt isArchived isDisabled isPrivate owner { __typename }'
      + ' licenseInfo { spdxId } defaultBranchRef { target { ... on Commit { oid } } } }'
  }).join('\n')
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...githubHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ query: `query SkillFluxRepositories {\n${fields}\n}` }),
    signal,
  })
  if (!response.ok) throw new Error(`GitHub repository enrichment failed: HTTP ${response.status}`)
  const payload = await response.json() as { data?: unknown }
  if (typeof payload.data !== 'object' || payload.data === null) {
    throw new Error('GitHub repository enrichment returned an invalid response')
  }
  const data = payload.data as Record<string, unknown>
  const snapshots = new Map<string, RepositorySnapshot>()
  for (const [index, source] of sources.entries()) {
    const snapshot = snapshotFromGraphql(data[`r${index}`])
    if (snapshot !== undefined) snapshots.set(source, snapshot)
  }
  return snapshots
}

async function searchSkillsSh(query: string, limit: number, signal: AbortSignal): Promise<CandidateSeed[]> {
  const url = new URL('https://skills.sh/api/search')
  url.searchParams.set('q', query)
  url.searchParams.set('limit', String(limit))
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-skillflux' },
    signal,
  })
  if (!response.ok) throw new Error(`skills.sh search failed: HTTP ${response.status}`)
  const payload = await response.json() as Partial<SkillsSearchResponse>
  if (!Array.isArray(payload.skills)) throw new Error('skills.sh returned an invalid response')
  return payload.skills.filter(isSearchItem).slice(0, limit).map(item => ({
    source: item.source,
    skillId: item.skillId,
    name: item.skillId,
    description: item.name,
    installs: item.installs,
    discoverySources: ['skills.sh'],
  }))
}

function githubSearchTerms(query: string): string {
  return [...tokenize(query)]
    .filter(token => token.length > 1)
    .slice(0, 6)
    .join(' ')
}

async function searchGithub(
  query: string,
  limit: number,
  signal: AbortSignal,
  token: string,
): Promise<GithubCodeSearchItem[]> {
  const terms = githubSearchTerms(query)
  if (terms.length === 0) return []
  const url = new URL('https://api.github.com/search/code')
  url.searchParams.set('q', `filename:SKILL.md ${terms}`)
  url.searchParams.set('per_page', String(limit))
  const response = await fetch(url, { headers: githubHeaders(token), signal })
  if (!response.ok) throw new Error(`GitHub Skill search failed: HTTP ${response.status}`)
  const payload = await response.json() as Partial<GithubCodeSearchResponse>
  if (!Array.isArray(payload.items)) throw new Error('GitHub Skill search returned an invalid response')
  return payload.items.filter(isGithubCodeSearchItem).slice(0, limit)
}

function rawGithubUrl(source: string, ref: string, path: string): string {
  const sourcePath = source.split('/').map(encodeURIComponent).join('/')
  const skillPath = path.split('/').map(encodeURIComponent).join('/')
  return `https://raw.githubusercontent.com/${sourcePath}/${ref}/${skillPath}`
}

async function githubSeed(
  hit: GithubCodeSearchItem,
  snapshot: RepositorySnapshot,
  signal: AbortSignal,
): Promise<CandidateSeed> {
  const response = await fetch(rawGithubUrl(hit.repository.full_name, snapshot.ref, hit.path), {
    headers: { accept: 'text/plain', 'user-agent': 'dsh-skillflux' },
    signal,
  })
  if (!response.ok) throw new Error(`GitHub Skill fetch failed for ${hit.repository.full_name}/${hit.path}: HTTP ${response.status}`)
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_REMOTE_SKILL_BYTES) {
    throw new Error(`remote SKILL.md exceeds ${MAX_REMOTE_SKILL_BYTES} bytes`)
  }
  const raw = await response.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REMOTE_SKILL_BYTES) {
    throw new Error(`remote SKILL.md exceeds ${MAX_REMOTE_SKILL_BYTES} bytes`)
  }
  const definition = parseSkillMarkdown(raw, '/skillflux-remote-preview')
  if (definition.description.length > 4_096) throw new Error('remote Skill description exceeds 4096 characters')
  return {
    source: hit.repository.full_name,
    skillId: definition.name,
    name: definition.name,
    description: definition.description,
    installs: 0,
    discoverySources: ['github'],
    path: hit.path,
    skillFileHash: createHash('sha256').update(raw).digest('hex'),
  }
}

function mergeSeeds(seeds: readonly CandidateSeed[], refBySource: ReadonlyMap<string, RepositorySnapshot>): CandidateSeed[] {
  const merged = new Map<string, CandidateSeed>()
  for (const seed of seeds) {
    const ref = refBySource.get(seed.source)?.ref
    if (ref === undefined) continue
    const key = `${seed.source}\0${ref}\0${seed.skillId}`
    const prior = merged.get(key)
    if (prior === undefined) {
      merged.set(key, seed)
      continue
    }
    const discoverySources = [...new Set([...prior.discoverySources, ...seed.discoverySources])]
    merged.set(key, {
      ...prior,
      description: seed.discoverySources.includes('github') ? seed.description : prior.description,
      installs: Math.max(prior.installs, seed.installs),
      discoverySources,
      ...(prior.path === undefined && seed.path !== undefined ? { path: seed.path } : {}),
      ...(prior.skillFileHash === undefined && seed.skillFileHash !== undefined
        ? { skillFileHash: seed.skillFileHash }
        : {}),
    })
  }
  return [...merged.values()]
}

export class RemoteDiscoveryClient {
  private readonly options: Required<Omit<RemoteDiscoveryOptions, 'githubToken' | 'now' | 'cache'>>
  private readonly githubToken: string | undefined
  private readonly now: () => number
  private readonly cache: RemoteDiscoveryCache | undefined

  constructor(searchLimit: number, timeoutMs: number)
  constructor(options: RemoteDiscoveryOptions)
  constructor(searchLimitOrOptions: number | RemoteDiscoveryOptions, timeoutMs?: number) {
    const options: RemoteDiscoveryOptions = typeof searchLimitOrOptions === 'number'
      ? { searchLimit: searchLimitOrOptions, timeoutMs: timeoutMs ?? 8_000 }
      : searchLimitOrOptions
    this.options = {
      searchLimit: options.searchLimit,
      timeoutMs: options.timeoutMs,
      providers: options.providers ?? ['skills.sh', 'github'],
      minQualityScore: options.minQualityScore ?? 0,
      minStars: options.minStars ?? 0,
      recentActivityDays: options.recentActivityDays ?? 30,
      trustedOwners: options.trustedOwners ?? [],
    }
    this.githubToken = configuredGithubToken(options.githubToken)
    this.now = options.now ?? Date.now
    this.cache = options.cache
  }

  get githubSearchEnabled(): boolean {
    return this.options.providers.includes('github') && this.githubToken !== undefined
  }

  async search(query: string, signal?: AbortSignal): Promise<RemoteCandidate[]> {
    const normalized = boundedQuery(query)
    if (normalized.length === 0) return []
    signal?.throwIfAborted()
    const key = discoveryCacheKey(normalized, this.options, this.githubSearchEnabled)
    const cached = await this.cache?.get(key)
    signal?.throwIfAborted()
    if (cached?.state === 'fresh') return [...cached.candidates]
    const operationSignal = timeoutSignal(signal, this.options.timeoutMs)
    try {
      const live = await this.searchLive(normalized, operationSignal)
      if (cached?.state === 'stale' && live.degraded && live.candidates.length === 0) {
        this.cache?.recordStaleHit()
        return [...cached.candidates]
      }
      if (!live.degraded || (cached === undefined && live.candidates.length > 0)) {
        await this.cache?.put(key, live.candidates)
      }
      return live.candidates
    } catch (error: unknown) {
      signal?.throwIfAborted()
      if (cached?.state === 'stale') {
        this.cache?.recordStaleHit()
        return [...cached.candidates]
      }
      throw error
    }
  }

  async discoveryCacheStats(): Promise<RemoteDiscoveryCacheStats | undefined> {
    return await this.cache?.stats()
  }

  async clearDiscoveryCache(): Promise<number> {
    return await this.cache?.clear() ?? 0
  }

  private async searchLive(normalized: string, operationSignal: AbortSignal): Promise<RemoteSearchResult> {
    const poolLimit = this.githubToken === undefined
      ? this.options.searchLimit
      : Math.min(20, Math.max(this.options.searchLimit, this.options.searchLimit * 2))
    const providerTasks: Array<Promise<{
      provider: RemoteDiscoveryProvider
      value: CandidateSeed[] | GithubCodeSearchItem[]
    }>> = []
    if (this.options.providers.includes('skills.sh')) {
      providerTasks.push(searchSkillsSh(normalized, poolLimit, operationSignal)
        .then(value => ({ provider: 'skills.sh' as const, value })))
    }
    if (this.options.providers.includes('github') && this.githubToken !== undefined) {
      providerTasks.push(searchGithub(normalized, poolLimit, operationSignal, this.githubToken)
        .then(value => ({ provider: 'github' as const, value })))
    }
    if (providerTasks.length === 0) {
      if (this.options.providers.length === 1 && this.options.providers[0] === 'github') {
        throw new Error('GitHub Skill search requires GITHUB_TOKEN or GH_TOKEN')
      }
      return { candidates: [], degraded: false }
    }
    const providerResults = await Promise.allSettled(providerTasks)
    operationSignal.throwIfAborted()
    const fulfilled = providerResults.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    let degraded = providerResults.some(result => result.status === 'rejected')
    if (fulfilled.length === 0) {
      const rejected = providerResults.find(result => result.status === 'rejected')
      throw rejected?.reason instanceof Error ? rejected.reason : new Error('remote Skill discovery failed')
    }
    const skillsSeeds = fulfilled.flatMap(result => result.provider === 'skills.sh'
      ? result.value as CandidateSeed[]
      : [])
    const githubHits = fulfilled.flatMap(result => result.provider === 'github'
      ? result.value as GithubCodeSearchItem[]
      : [])
    const sources = [...new Set([
      ...skillsSeeds.map(seed => seed.source),
      ...githubHits.map(hit => hit.repository.full_name),
    ])]
    const snapshots = await resolveRepositories(sources, operationSignal, this.githubToken)
    if (snapshots.size < sources.length) degraded = true
    operationSignal.throwIfAborted()
    const githubSeeds = await Promise.allSettled(githubHits.map(async hit => {
      const snapshot = snapshots.get(hit.repository.full_name)
      if (snapshot === undefined) throw new Error('repository metadata unavailable')
      return await githubSeed(hit, snapshot, operationSignal)
    }))
    if (githubSeeds.some(result => result.status === 'rejected')) degraded = true
    operationSignal.throwIfAborted()
    const seeds = mergeSeeds([
      ...skillsSeeds,
      ...githubSeeds.flatMap(result => result.status === 'fulfilled' ? [result.value] : []),
    ], snapshots)
    const trustedOwners = new Set(this.options.trustedOwners.map(owner => owner.toLocaleLowerCase('en-US')))
    const now = this.now()
    const candidates = seeds.flatMap((seed): RemoteCandidate[] => {
      const snapshot = snapshots.get(seed.source)
      if (snapshot === undefined || snapshot.archived || snapshot.disabled || snapshot.private
        || snapshot.stars < this.options.minStars) return []
      const relevanceScore = routeScore(normalized, { name: seed.name, description: seed.description })
      if (relevanceScore === 0) return []
      const owner = seed.source.split('/')[0]?.toLocaleLowerCase('en-US') ?? ''
      const trustedSource = trustedOwners.has(owner)
      const qualityScore = remoteQualityScore({
        relevanceScore,
        installs: seed.installs,
        stars: snapshot.stars,
        forks: snapshot.forks,
        ...(snapshot.pushedAt === undefined ? {} : { pushedAt: snapshot.pushedAt }),
        recentActivityDays: this.options.recentActivityDays,
        trustedSource,
        organizationOwned: snapshot.organizationOwned,
        hasLicense: snapshot.license !== undefined,
        now,
      })
      if (qualityScore < this.options.minQualityScore) return []
      const age = activityAgeDays(snapshot.pushedAt, now)
      return [{
        id: candidateId('remote', seed.source, snapshot.ref, seed.skillId),
        origin: 'remote',
        name: seed.name,
        description: seed.description,
        source: seed.source,
        ref: snapshot.ref,
        score: qualityScore,
        selection: 'remote-quality',
        baseScore: relevanceScore,
        adaptiveBoost: 0,
        skillId: seed.skillId,
        installs: seed.installs,
        discoverySources: seed.discoverySources,
        qualityScore,
        relevanceScore,
        stars: snapshot.stars,
        forks: snapshot.forks,
        ...(snapshot.pushedAt === undefined ? {} : { pushedAt: snapshot.pushedAt }),
        ...(snapshot.license === undefined ? {} : { license: snapshot.license }),
        recentlyActive: age !== undefined && age <= this.options.recentActivityDays,
        trustedSource,
        ...(seed.path === undefined ? {} : { path: seed.path }),
        ...(seed.skillFileHash === undefined ? {} : { skillFileHash: seed.skillFileHash }),
      }]
    })
    candidates.sort((left, right) => right.qualityScore - left.qualityScore
      || right.relevanceScore - left.relevanceScore
      || Number(right.trustedSource) - Number(left.trustedSource)
      || Number(right.recentlyActive) - Number(left.recentlyActive)
      || right.installs - left.installs
      || right.stars - left.stars
      || `${left.source}/${left.name}`.localeCompare(`${right.source}/${right.name}`, 'en'))
    return { candidates: candidates.slice(0, this.options.searchLimit), degraded }
  }
}
