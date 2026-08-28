import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { parseSkillMarkdown } from './skill-file.js'
import type { RemoteCandidate } from './types.js'

interface GithubTreeItem {
  readonly path: string
  readonly type: string
}

interface GithubTreeResponse {
  readonly truncated: boolean
  readonly tree: readonly GithubTreeItem[]
}

interface IndexedSkill {
  readonly name: string
  readonly path: string
  readonly skillFileHash: string
}

export interface VerifiedRemoteSkill {
  readonly path: string
  readonly skillFileHash: string
}

export type RemoteCandidateVerifier = (
  candidate: Pick<RemoteCandidate, 'source' | 'ref' | 'skillId' | 'path' | 'skillFileHash'>,
  signal?: AbortSignal,
) => Promise<VerifiedRemoteSkill>

const MAX_REMOTE_SKILL_BYTES = 256 * 1024
const MAX_REPOSITORY_SKILL_FILES = 512
const MAX_REPOSITORY_TREE_ITEMS = 100_000
const MAX_REPOSITORY_PATH_LENGTH = 4_096
const FETCH_CONCURRENCY = 8

function githubToken(): string | undefined {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  return token === undefined || token.length === 0 ? undefined : token
}

function githubHeaders(): Record<string, string> {
  const token = githubToken()
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-skillflux',
    'x-github-api-version': '2022-11-28',
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  }
}

function repositoryUrl(candidate: Pick<RemoteCandidate, 'source'>, suffix: string): string {
  const [owner, repository] = candidate.source.split('/')
  if (owner === undefined || repository === undefined) throw new Error('remote candidate source is not a GitHub repository')
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}${suffix}`
}

function rawUrl(candidate: Pick<RemoteCandidate, 'source' | 'ref'>, path: string): string {
  const source = candidate.source.split('/').map(encodeURIComponent).join('/')
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  return `https://raw.githubusercontent.com/${source}/${candidate.ref}/${encodedPath}`
}

function isTreeItem(value: unknown): value is GithubTreeItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  if (typeof item.path !== 'string' || item.path.length === 0 || item.path.length > MAX_REPOSITORY_PATH_LENGTH
    || item.path.startsWith('/') || item.path.includes('\\') || item.path.includes('\0')
    || item.path.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..')) return false
  return item.type === 'blob' || item.type === 'tree' || item.type === 'commit'
}

async function fetchSkill(
  candidate: Pick<RemoteCandidate, 'source' | 'ref'>,
  path: string,
  signal?: AbortSignal,
): Promise<IndexedSkill | undefined> {
  const response = await fetch(rawUrl(candidate, path), {
    headers: { accept: 'text/plain', 'user-agent': 'dsh-skillflux' },
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`GitHub Skill uniqueness check failed for ${candidate.source}/${path}: HTTP ${response.status}`)
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_REMOTE_SKILL_BYTES) {
    throw new Error(`remote SKILL.md exceeds ${MAX_REMOTE_SKILL_BYTES} bytes during uniqueness check`)
  }
  const raw = await response.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REMOTE_SKILL_BYTES) {
    throw new Error(`remote SKILL.md exceeds ${MAX_REMOTE_SKILL_BYTES} bytes during uniqueness check`)
  }
  try {
    const definition = parseSkillMarkdown(raw, `/skillflux-remote-uniqueness/${path}`)
    return {
      name: definition.name,
      path,
      skillFileHash: createHash('sha256').update(raw).digest('hex'),
    }
  } catch {
    // The pinned installer cannot produce a usable DSH Skill from a document
    // rejected by the same parser, so it is irrelevant to name uniqueness.
    return undefined
  }
}

/**
 * Prove that the pinned repository contains exactly one usable Skill with the
 * requested name before invoking the name-based `skills` installer.
 */
export async function verifyUniqueRemoteSkill(
  candidate: Pick<RemoteCandidate, 'source' | 'ref' | 'skillId' | 'path' | 'skillFileHash'>,
  signal?: AbortSignal,
): Promise<VerifiedRemoteSkill> {
  signal?.throwIfAborted()
  const treeUrl = repositoryUrl(
    candidate,
    `/git/trees/${encodeURIComponent(candidate.ref)}?recursive=1`,
  )
  const response = await fetch(treeUrl, {
    headers: githubHeaders(),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`GitHub Skill uniqueness check failed: HTTP ${response.status}`)
  const payload = await response.json() as Partial<GithubTreeResponse>
  if (payload.truncated !== false || !Array.isArray(payload.tree)
    || payload.tree.length > MAX_REPOSITORY_TREE_ITEMS
    || !payload.tree.every(isTreeItem)) {
    throw new Error('cannot prove remote Skill uniqueness from a truncated or invalid GitHub tree')
  }
  const allPaths = payload.tree.map(item => item.path)
  if (new Set(allPaths).size !== allPaths.length) {
    throw new Error('cannot prove remote Skill uniqueness from a GitHub tree with duplicate paths')
  }
  const paths = payload.tree
    .filter(item => item.type === 'blob')
    .map(item => item.path)
    .filter(path => path === 'SKILL.md' || path.endsWith('/SKILL.md'))
  if (paths.length > MAX_REPOSITORY_SKILL_FILES) {
    throw new Error(`cannot prove remote Skill uniqueness across more than ${MAX_REPOSITORY_SKILL_FILES} SKILL.md files`)
  }

  const indexed: IndexedSkill[] = []
  for (let offset = 0; offset < paths.length; offset += FETCH_CONCURRENCY) {
    const batch = await Promise.all(paths.slice(offset, offset + FETCH_CONCURRENCY)
      .map(async path => await fetchSkill(candidate, path, signal)))
    signal?.throwIfAborted()
    indexed.push(...batch.filter((skill): skill is IndexedSkill => skill !== undefined))
  }
  const matches = indexed.filter(skill => skill.name === candidate.skillId)
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `remote repository does not contain Skill "${candidate.skillId}" at the pinned commit`
      : `remote repository contains ${matches.length} usable Skills named "${candidate.skillId}"; refusing ambiguous install`)
  }
  const match = matches[0]!
  if (candidate.path !== undefined && match.path !== candidate.path) {
    throw new Error(`unique remote Skill path "${match.path}" does not match discovered path "${candidate.path}"`)
  }
  if (candidate.skillFileHash !== undefined && match.skillFileHash !== candidate.skillFileHash) {
    throw new Error('unique remote SKILL.md does not match the GitHub search preview')
  }
  return { path: match.path, skillFileHash: match.skillFileHash }
}
