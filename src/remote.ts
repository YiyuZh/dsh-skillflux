import { candidateId } from './router.js'
import type { RemoteCandidate } from './types.js'

interface SkillsSearchItem {
  readonly skillId: string
  readonly name: string
  readonly installs: number
  readonly source: string
}

interface SkillsSearchResponse {
  readonly skills: readonly SkillsSearchItem[]
}

function boundedQuery(query: string): string {
  return query.normalize('NFKC').replaceAll(/\s+/gu, ' ').trim().slice(0, 128)
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout])
}

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-skillflux',
    'x-github-api-version': '2022-11-28',
    ...(token === undefined || token.length === 0 ? {} : { authorization: `Bearer ${token}` }),
  }
}

function isSearchItem(value: unknown): value is SkillsSearchItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return typeof item.skillId === 'string'
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(item.skillId)
    && typeof item.name === 'string'
    && typeof item.installs === 'number'
    && Number.isSafeInteger(item.installs)
    && item.installs >= 0
    && typeof item.source === 'string'
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(item.source)
}

async function resolveHead(source: string, signal: AbortSignal): Promise<string> {
  const [owner, repo] = source.split('/')
  if (owner === undefined || repo === undefined) throw new Error(`invalid GitHub source "${source}"`)
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/HEAD`,
    { headers: githubHeaders(), signal },
  )
  if (!response.ok) throw new Error(`GitHub HEAD lookup failed for ${source}: HTTP ${response.status}`)
  const body = await response.json() as { sha?: unknown }
  if (typeof body.sha !== 'string' || !/^[0-9a-f]{40}$/u.test(body.sha)) {
    throw new Error(`GitHub returned an invalid HEAD for ${source}`)
  }
  return body.sha
}

export class RemoteDiscoveryClient {
  constructor(
    private readonly searchLimit: number,
    private readonly timeoutMs: number,
  ) {}

  async search(query: string, signal?: AbortSignal): Promise<RemoteCandidate[]> {
    const normalized = boundedQuery(query)
    if (normalized.length === 0) return []
    const operationSignal = timeoutSignal(signal, this.timeoutMs)
    const url = new URL('https://skills.sh/api/search')
    url.searchParams.set('q', normalized)
    url.searchParams.set('limit', String(this.searchLimit))
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-skillflux' },
      signal: operationSignal,
    })
    if (!response.ok) throw new Error(`skills.sh search failed: HTTP ${response.status}`)
    const payload = await response.json() as Partial<SkillsSearchResponse>
    if (!Array.isArray(payload.skills)) throw new Error('skills.sh returned an invalid response')
    const items = payload.skills.filter(isSearchItem).slice(0, this.searchLimit)
    const resolved = await Promise.allSettled(items.map(async (item): Promise<RemoteCandidate> => {
      const ref = await resolveHead(item.source, operationSignal)
      return {
        id: candidateId('remote', item.source, ref, item.skillId),
        origin: 'remote',
        name: item.name,
        description: `${item.name} from ${item.source} (${item.installs} installs)`,
        source: item.source,
        ref,
        score: 0,
        skillId: item.skillId,
        installs: item.installs,
      }
    }))
    return resolved.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  }
}
