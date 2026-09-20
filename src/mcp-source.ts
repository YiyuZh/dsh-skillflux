import { createHash } from 'node:crypto'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { candidateId } from './router.js'
import type { McpCandidate, McpSkillEntry, McpSkillResource } from './types.js'

export const MCP_SKILLS_EXTENSION = 'io.modelcontextprotocol/skills'
export const MCP_MAX_RESOURCES_PER_SKILL = 512
export const MCP_MAX_SKILL_BYTES = 16 * 1024 * 1024
export const MCP_MAX_LIST_PAGES = 10
export const MCP_MAX_URI_LENGTH = 4_096
const MCP_SERVER_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const MCP_DIGEST = /^sha256:[0-9a-f]{64}$/u
const SKILL_FILE_SUFFIX = '/SKILL.md'

/**
 * Transport-agnostic JSON-RPC client for the MCP Skills extension
 * (`io.modelcontextprotocol/skills`). The transport only moves requests and
 * results; every response is validated and every retrieved byte is verified
 * against the entry digest before it is considered skill content.
 *
 * This adapter performs discovery and loading only. It never executes skill
 * content and never opens a general MCP dispatch sandbox.
 */
export interface McpTransport {
  /**
   * Issue one JSON-RPC request and resolve with its `result`, or reject with
   * an `McpError` carrying the JSON-RPC error code, or any other Error.
   */
  request(method: string, params?: unknown): Promise<unknown>
}

export class McpError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
    this.name = 'McpError'
  }
}

/** Fetch the raw bytes for one verified resource URI. */
export type McpResourceReader = (uri: string, signal?: AbortSignal) => Promise<Buffer>

export function assertMcpServerLabel(label: string): void {
  if (!MCP_SERVER_LABEL.test(label)) {
    throw new Error(`invalid host-assigned MCP server label "${label}"`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeUri(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MCP_MAX_URI_LENGTH
    && !value.includes('\\')
    && !value.includes('\0')
}

/** The skill's root URI: its SKILL.md URI with the `/SKILL.md` suffix removed. */
export function mcpSkillRoot(skillUri: string): string | undefined {
  if (!skillUri.endsWith(SKILL_FILE_SUFFIX)) return undefined
  const root = skillUri.slice(0, -SKILL_FILE_SUFFIX.length)
  return root.length === 0 ? undefined : root
}

/**
 * Map a resource URI to its path relative to the skill directory root, or
 * undefined when the URI is outside the skill's directory or unsafe.
 */
export function mcpRelativePath(skillUri: string, resourceUri: string): string | undefined {
  if (resourceUri === skillUri) return 'SKILL.md'
  const root = mcpSkillRoot(skillUri)
  if (root === undefined) return undefined
  const prefix = `${root}/`
  if (!resourceUri.startsWith(prefix)) return undefined
  const relativePath = resourceUri.slice(prefix.length)
  const segments = relativePath.split('/')
  if (relativePath.length === 0 || relativePath.endsWith('/')
    || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..'
      || /[<>:"|?*\0\\]/u.test(segment) || [...segment].some(character => character.charCodeAt(0) < 0x20))) {
    return undefined
  }
  return relativePath
}

export function parseMcpSkillResource(value: unknown): McpSkillResource | undefined {
  if (!isRecord(value)) return undefined
  if (!isSafeUri(value.uri)) return undefined
  if (typeof value.digest !== 'string' || !MCP_DIGEST.test(value.digest)) return undefined
  if (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0) return undefined
  return { uri: value.uri, digest: value.digest, size: value.size }
}

/**
 * Validate one `Skill` entry per SEP-2640 and the stable skills.mdx. Entries
 * whose `resources` is `"dynamic"` cannot be content-bound and are refused.
 */
export function validateMcpSkillEntry(value: unknown): McpSkillEntry | undefined {
  if (!isRecord(value)) return undefined
  if (!isSafeUri(value.uri) || mcpSkillRoot(value.uri) === undefined) return undefined
  const frontmatter = value.frontmatter
  if (!isRecord(frontmatter)) return undefined
  const name = frontmatter.name
  const description = frontmatter.description
  if (typeof name !== 'string' || !isSkillName(name)) return undefined
  if (typeof description !== 'string' || description.trim().length === 0) return undefined
  const root = mcpSkillRoot(value.uri)!
  const finalSegment = root.split('/').at(-1)
  if (finalSegment !== name) return undefined
  if (!Array.isArray(value.resources)) return undefined
  if (value.resources.length === 0 || value.resources.length > MCP_MAX_RESOURCES_PER_SKILL) return undefined
  const resources: McpSkillResource[] = []
  const seen = new Set<string>()
  let totalBytes = 0
  let hasSkillFile = false
  for (const item of value.resources) {
    const resource = parseMcpSkillResource(item)
    if (resource === undefined || seen.has(resource.uri)) return undefined
    if (mcpRelativePath(value.uri, resource.uri) === undefined) return undefined
    seen.add(resource.uri)
    if (resource.uri === value.uri) hasSkillFile = true
    totalBytes += resource.size
    if (totalBytes > MCP_MAX_SKILL_BYTES) return undefined
    resources.push(resource)
  }
  if (!hasSkillFile) return undefined
  return {
    uri: value.uri,
    frontmatter: { ...frontmatter, name, description },
    resources: [...resources].sort((left, right) => left.uri.localeCompare(right.uri, 'en')),
  }
}

/** One-way fingerprint of the content-bound set: sorted `[uri, digest, size]`. */
export function mcpContentBoundKey(entry: Pick<McpSkillEntry, 'resources'>): string {
  return createHash('sha256')
    .update([...entry.resources]
      .sort((left, right) => left.uri.localeCompare(right.uri, 'en'))
      .map(resource => JSON.stringify([resource.uri, resource.digest, resource.size]))
      .join('\n'))
    .digest('hex')
}

/** Field-by-field JSON equality for the frontmatter verification requirement. */
export function mcpFrontmatterEqual(parsed: unknown, expected: unknown): boolean {
  if (parsed === expected) return true
  if (typeof parsed !== typeof expected) return false
  if (typeof parsed !== 'object' || parsed === null) return false
  if (Array.isArray(parsed) !== Array.isArray(expected)) return false
  if (Array.isArray(parsed)) {
    const other = expected as unknown[]
    if (parsed.length !== other.length) return false
    return parsed.every((item, index) => mcpFrontmatterEqual(item, other[index]))
  }
  const left = parsed as Record<string, unknown>
  const right = expected as Record<string, unknown>
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length
    || leftKeys.some((key, index) => key !== rightKeys[index])) return false
  return leftKeys.every(key => mcpFrontmatterEqual(left[key], right[key]))
}

function slugSegment(segment: string): string {
  return segment
    .toLocaleLowerCase('en-US')
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
}

/**
 * Resolve a catalog name for one entry. Names are unique within a listing;
 * colliding names are disambiguated with their distinguishing path segments,
 * and a short URI hash guarantees the result stays unique and valid.
 */
function resolvedMcpName(entry: McpSkillEntry, taken: Set<string>): string {
  const base = entry.frontmatter.name
  const uriHash = createHash('sha256').update(entry.uri).digest('hex').slice(0, 6)
  const slug = (mcpSkillRoot(entry.uri) ?? '')
    .split('/')
    .slice(0, -1)
    .map(slugSegment)
    .filter(segment => segment.length > 0)
    .join('-')
  if (!taken.has(base)) {
    taken.add(base)
    return base
  }
  let name = slug.length === 0 ? `${base}-${uriHash}` : `${base}-${slug}-${uriHash}`
  let suffix = 0
  while (taken.has(name)) {
    suffix += 1
    name = `${base}-${slug.length === 0 ? '' : `${slug}-`}${uriHash}-${suffix}`
  }
  taken.add(name)
  return name
}

export interface McpCandidateOptions {
  /** Host-assigned labels whose skills may carry `trusted` evidence. */
  readonly trustedServers?: readonly string[]
}

/** Build governed candidates for one host-assigned server label. */
export function mcpCandidates(
  serverLabel: string,
  entries: readonly McpSkillEntry[],
  options: McpCandidateOptions = {},
): McpCandidate[] {
  assertMcpServerLabel(serverLabel)
  const trusted = new Set((options.trustedServers ?? [])
    .map(label => label.toLocaleLowerCase('en-US')))
  const unique = new Map<string, McpSkillEntry>()
  for (const entry of entries) if (!unique.has(entry.uri)) unique.set(entry.uri, entry)
  const ordered = [...unique.values()]
    .sort((left, right) => left.frontmatter.name.localeCompare(right.frontmatter.name, 'en')
      || left.uri.localeCompare(right.uri, 'en'))
  const taken = new Set<string>()
  const trustedLabel = trusted.has(serverLabel.toLocaleLowerCase('en-US'))
  return ordered.map((entry): McpCandidate => {
    const name = resolvedMcpName(entry, taken)
    const contentBoundKey = mcpContentBoundKey(entry)
    const whenToUse = entry.frontmatter.whenToUse
    return {
      id: candidateId('mcp', serverLabel, contentBoundKey, entry.frontmatter.name),
      origin: 'mcp',
      name,
      description: entry.frontmatter.description.trim(),
      ...(typeof whenToUse === 'string' && whenToUse.trim().length > 0
        ? { whenToUse: whenToUse.trim() }
        : {}),
      source: serverLabel,
      serverLabel,
      skillUri: entry.uri,
      contentBoundKey,
      frontmatter: entry.frontmatter,
      resources: entry.resources,
      score: 0,
      trustLevel: trustedLabel ? 'trusted' : 'community',
    }
  })
}

export interface McpSkillListing {
  readonly entries: McpSkillEntry[]
  /** True when pagination was truncated or any entry was invalid and dropped. */
  readonly partial: boolean
}

interface ListSkillsResult {
  readonly skills: unknown[]
  readonly nextCursor?: unknown
}

interface ReadResourceContent {
  readonly uri?: unknown
  readonly text?: unknown
  readonly blob?: unknown
}

interface ReadResourceResult {
  readonly contents: unknown[]
}

function completeResult(value: unknown, method: string): Record<string, unknown> {
  if (!isRecord(value) || value.resultType !== 'complete') {
    throw new Error(`MCP ${method} returned an incomplete result`)
  }
  return value
}

export class McpSkillsClient {
  constructor(private readonly transport: McpTransport) {}

  /**
   * Enumerate a server's skills through `skills/list`, following pagination
   * up to `MCP_MAX_LIST_PAGES`. Invalid entries are dropped and reported via
   * `partial`; this never weakens the entry validation at load time.
   */
  async listSkills(signal?: AbortSignal): Promise<McpSkillListing> {
    signal?.throwIfAborted()
    const entries: McpSkillEntry[] = []
    let cursor: unknown
    let partial = false
    for (let page = 0; page < MCP_MAX_LIST_PAGES; page += 1) {
      signal?.throwIfAborted()
      const result = await this.transport.request(
        'skills/list',
        cursor === undefined ? {} : { cursor },
      )
      signal?.throwIfAborted()
      const payload = completeResult(result, 'skills/list') as unknown as ListSkillsResult
      if (!Array.isArray(payload.skills)) {
        throw new Error('MCP skills/list returned an invalid skills array')
      }
      for (const item of payload.skills) {
        const entry = validateMcpSkillEntry(item)
        if (entry === undefined) {
          partial = true
          continue
        }
        entries.push(entry)
      }
      cursor = payload.nextCursor
      if (cursor === undefined) break
      if (page === MCP_MAX_LIST_PAGES - 1) partial = true
    }
    return { entries, partial }
  }

  /** Fetch and validate one skill entry by its SKILL.md URI. */
  async getSkill(uri: string, signal?: AbortSignal): Promise<McpSkillEntry> {
    signal?.throwIfAborted()
    if (!isSafeUri(uri)) throw new Error(`invalid MCP skill uri "${uri}"`)
    const result = await this.transport.request('skills/get', { uri })
    signal?.throwIfAborted()
    const payload = completeResult(result, 'skills/get') as unknown as { skill?: unknown }
    const entry = validateMcpSkillEntry(payload.skill)
    if (entry === undefined || entry.uri !== uri) {
      throw new Error(`MCP skills/get did not return the requested skill "${uri}"`)
    }
    return entry
  }

  /**
   * Read one resource through `resources/read` and return its raw bytes.
   * Digest and size verification happens at the cache/install boundary.
   */
  async readResource(uri: string, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted()
    if (!isSafeUri(uri)) throw new Error(`invalid MCP resource uri "${uri}"`)
    const result = await this.transport.request('resources/read', { uri })
    signal?.throwIfAborted()
    const payload = completeResult(result, 'resources/read') as unknown as ReadResourceResult
    if (!Array.isArray(payload.contents) || payload.contents.length === 0) {
      throw new Error(`MCP resources/read returned no content for "${uri}"`)
    }
    const contents = payload.contents.filter((item): item is ReadResourceContent => isRecord(item))
    const match = contents.find(item => item.uri === uri)
      ?? (contents.length === 1 && contents[0]?.uri === undefined ? contents[0] : undefined)
    if (match === undefined) {
      throw new Error(`MCP resources/read returned no content matching "${uri}"`)
    }
    if (typeof match.text === 'string') return Buffer.from(match.text, 'utf8')
    if (typeof match.blob === 'string') {
      const encoded = match.blob.replaceAll(/\s/gu, '')
      if (encoded.length % 4 !== 0
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
        throw new Error(`MCP resources/read returned invalid base64 content for "${uri}"`)
      }
      return Buffer.from(encoded, 'base64')
    }
    throw new Error(`MCP resources/read returned no decodable content for "${uri}"`)
  }
}
