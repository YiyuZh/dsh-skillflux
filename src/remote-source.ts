import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parseSkillMarkdown } from './skill-file.js'
import type { RemoteCandidate } from './types.js'

interface GithubTreeItem {
  readonly path: string
  readonly type: string
  readonly sha: string
  readonly mode: string
  readonly size?: number
}

interface GithubTreeResponse {
  readonly truncated: boolean
  readonly tree: readonly GithubTreeItem[]
}

interface GithubBlobResponse {
  readonly content: string
  readonly encoding: string
  readonly size: number
  readonly sha: string
}

interface IndexedSkill {
  readonly name: string
  readonly path: string
  readonly skillFileHash: string
}

export interface VerifiedRemoteSkill {
  readonly path: string
  readonly skillFileHash: string
  /** Files are present for the built-in GitHub installer. Optional for custom verifier compatibility. */
  readonly files?: readonly VerifiedRemoteFile[]
}

export interface VerifiedRemoteFile {
  /** Path relative to the directory that contains the unique SKILL.md. */
  readonly path: string
  readonly sha: string
  readonly size: number
}

export interface RemoteSkillMaterializeLimits {
  readonly maxFiles: number
  readonly maxBytes: number
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
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(candidate.source)
  if (match === null) throw new Error('remote candidate source is not a GitHub repository')
  const owner = match[1]!
  const repository = match[2]!
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}${suffix}`
}

function assertPinnedCandidate(candidate: Pick<RemoteCandidate, 'source' | 'ref'>): void {
  repositoryUrl(candidate, '')
  if (!/^[0-9a-f]{40}$/u.test(candidate.ref)) {
    throw new Error('remote candidate is not pinned to an immutable Git commit')
  }
}

function isTreeItem(value: unknown): value is GithubTreeItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  if (typeof item.path !== 'string' || item.path.length === 0 || item.path.length > MAX_REPOSITORY_PATH_LENGTH
    || item.path.startsWith('/') || item.path.includes('\\') || item.path.includes('\0')
    || item.path.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..')
    || typeof item.sha !== 'string' || !/^[0-9a-f]{40}$/u.test(item.sha)) return false
  if (item.type === 'blob') {
    return (item.mode === '100644' || item.mode === '100755' || item.mode === '120000')
      && typeof item.size === 'number' && Number.isSafeInteger(item.size) && item.size >= 0
  }
  if (item.type === 'tree') return item.mode === '040000'
  return item.type === 'commit' && item.mode === '160000'
}

function decodeGithubBlob(payload: Partial<GithubBlobResponse>, expectedSha: string, maxBytes: number): Buffer {
  if (payload.encoding !== 'base64' || typeof payload.content !== 'string'
    || !Number.isSafeInteger(payload.size) || payload.size! < 0 || payload.size! > maxBytes
    || payload.sha !== expectedSha) {
    throw new Error('GitHub Skill download returned an invalid blob')
  }
  const encoded = payload.content.replaceAll(/\s/gu, '')
  if (encoded.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new Error('GitHub Skill download returned invalid base64 content')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length !== payload.size || bytes.length > maxBytes) {
    throw new Error('GitHub Skill download returned an invalid blob size')
  }
  const calculatedSha = createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex')
  if (calculatedSha !== expectedSha) {
    throw new Error('GitHub Skill download does not match its tree blob SHA')
  }
  return bytes
}

async function fetchBlob(
  candidate: Pick<RemoteCandidate, 'source' | 'ref'>,
  path: string,
  sha: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const response = await fetch(repositoryUrl(candidate, `/git/blobs/${sha}`), {
    headers: githubHeaders(),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`GitHub Skill download failed for ${candidate.source}/${path}: HTTP ${response.status}`)
  return decodeGithubBlob(await response.json() as Partial<GithubBlobResponse>, sha, maxBytes)
}

async function fetchSkill(
  candidate: Pick<RemoteCandidate, 'source' | 'ref'>,
  path: string,
  sha: string,
  signal?: AbortSignal,
): Promise<IndexedSkill | undefined> {
  const bytes = await fetchBlob(candidate, path, sha, MAX_REMOTE_SKILL_BYTES, signal)
  try {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const definition = parseSkillMarkdown(raw, `/skillflux-remote-uniqueness/${path}`)
    return {
      name: definition.name,
      path,
      skillFileHash: createHash('sha256').update(bytes).digest('hex'),
    }
  } catch {
    // The pinned installer cannot produce a usable DSH Skill from a document
    // rejected by the same parser, so it is irrelevant to name uniqueness.
    return undefined
  }
}

/**
 * Prove that the pinned repository contains exactly one usable Skill with the
 * requested name and return the immutable blobs in that Skill directory.
 */
export async function verifyUniqueRemoteSkill(
  candidate: Pick<RemoteCandidate, 'source' | 'ref' | 'skillId' | 'path' | 'skillFileHash'>,
  signal?: AbortSignal,
): Promise<VerifiedRemoteSkill> {
  signal?.throwIfAborted()
  assertPinnedCandidate(candidate)
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
  const files = payload.tree
    .filter(item => item.type === 'blob')
    .filter(item => item.path === 'SKILL.md' || item.path.endsWith('/SKILL.md'))
  if (files.length > MAX_REPOSITORY_SKILL_FILES) {
    throw new Error(`cannot prove remote Skill uniqueness across more than ${MAX_REPOSITORY_SKILL_FILES} SKILL.md files`)
  }

  const indexed: IndexedSkill[] = []
  for (let offset = 0; offset < files.length; offset += FETCH_CONCURRENCY) {
    const batch = await Promise.all(files.slice(offset, offset + FETCH_CONCURRENCY)
      .map(async file => await fetchSkill(candidate, file.path, file.sha, signal)))
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
  const separator = match.path.lastIndexOf('/')
  const directory = separator === -1 ? '' : match.path.slice(0, separator + 1)
  const selectedFiles: VerifiedRemoteFile[] = []
  for (const file of payload.tree) {
    if (file.type !== 'blob' || !file.path.startsWith(directory)) continue
    if (directory.length > 0 && file.path.length === directory.length) continue
    const selectedPath = directory.length === 0 ? file.path : file.path.slice(directory.length)
    // Symlinks can escape the selected directory when interpreted by other
    // tools, so the built-in installer accepts regular Git blobs only.
    if (file.mode === '120000') {
      throw new Error(`remote Skill directory contains unsupported symbolic link "${selectedPath}"`)
    }
    selectedFiles.push({ path: selectedPath, sha: file.sha, size: file.size! })
  }
  if (!selectedFiles.some(file => file.path === 'SKILL.md' && file.sha === files.find(file => file.path === match.path)?.sha)) {
    throw new Error('unique remote SKILL.md is not a regular file in its Skill directory')
  }
  return { path: match.path, skillFileHash: match.skillFileHash, files: selectedFiles }
}

function assertMaterializeTarget(root: string, target: string): void {
  const pathFromRoot = relative(resolve(root), resolve(target))
  if (pathFromRoot === '' || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new Error(`refusing to materialize a remote Skill outside its destination: ${target}`)
  }
}

/** Download only the files already bound to the verified tree and blob SHAs. */
export async function materializeVerifiedRemoteSkill(
  candidate: Pick<RemoteCandidate, 'source' | 'ref'>,
  verified: VerifiedRemoteSkill,
  destination: string,
  limits: RemoteSkillMaterializeLimits,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  assertPinnedCandidate(candidate)
  const files = verified.files
  if (files === undefined || files.length === 0 || files.length > limits.maxFiles) {
    throw new Error(`remote Skill exceeds the ${limits.maxFiles}-file installation limit`)
  }
  let declaredBytes = 0
  for (const file of files) {
    const segments = file.path.split('/')
    if (file.path.length === 0 || file.path.length > MAX_REPOSITORY_PATH_LENGTH
      || file.path.startsWith('/') || file.path.includes('\\') || file.path.includes('\0')
      || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..'
        || /[<>:"|?*]/u.test(segment) || [...segment].some(character => character.charCodeAt(0) < 0x20)
        || /[. ]$/u.test(segment)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))
      || !/^[0-9a-f]{40}$/u.test(file.sha)
      || !Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error('verified remote Skill contains invalid file metadata')
    }
    declaredBytes += file.size
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > limits.maxBytes) {
      throw new Error(`remote Skill exceeds the ${limits.maxBytes}-byte installation limit`)
    }
  }
  if (new Set(files.map(file => file.path)).size !== files.length) {
    throw new Error('verified remote Skill contains duplicate file paths')
  }
  await mkdir(destination, { recursive: true })
  for (let offset = 0; offset < files.length; offset += FETCH_CONCURRENCY) {
    const batch = files.slice(offset, offset + FETCH_CONCURRENCY)
    const downloaded = await Promise.all(batch.map(async file => ({
      file,
      bytes: await fetchBlob(candidate, file.path, file.sha, Math.min(file.size, limits.maxBytes), signal),
    })))
    signal?.throwIfAborted()
    await Promise.all(downloaded.map(async ({ file, bytes }) => {
      if (bytes.length !== file.size) throw new Error(`remote Skill file size changed for "${file.path}"`)
      const target = join(destination, ...file.path.split('/'))
      assertMaterializeTarget(destination, target)
      await mkdir(resolve(target, '..'), { recursive: true })
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 })
    }))
    signal?.throwIfAborted()
  }
}
