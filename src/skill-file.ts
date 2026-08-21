import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { SkillDefinition, SkillInvocationPolicy } from '@deepseek-ai/dsh-skill'
import { isSkillName } from '@deepseek-ai/dsh-skill'

export interface ParsedSkillFile {
  readonly definition: SkillDefinition
  readonly fileCount: number
  readonly totalBytes: number
  readonly contentHash: string
}

interface TreeLimits {
  readonly maxFiles: number
  readonly maxBytes: number
}

function parseBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (value === true || value === 1 || value === '1' || value === 'true') return true
  if (value === false || value === 0 || value === '0' || value === 'false') return false
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

function frontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (match === null) throw new Error('SKILL.md is missing YAML frontmatter')
  const parsed = parseYaml(match[1] ?? '') as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('SKILL.md frontmatter must be an object')
  }
  return { data: parsed as Record<string, unknown>, body: raw.slice(match[0].length).trim() }
}

export function parseSkillMarkdown(raw: string, directory: string): SkillDefinition {
  const parsed = frontmatter(raw)
  const name = parsed.data.name
  const description = parsed.data.description
  if (typeof name !== 'string' || !isSkillName(name)) throw new Error(`invalid skill name "${String(name)}"`)
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error('frontmatter requires a non-empty description')
  }
  for (const legacy of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) {
    if (Object.hasOwn(parsed.data, legacy)) throw new Error(`unsupported legacy frontmatter field "${legacy}"`)
  }
  const invocation: SkillInvocationPolicy = {
    modelInvocable: parseBoolean(parsed.data, 'disable-model-invocation') !== true,
    userInvocable: parseBoolean(parsed.data, 'user-invocable') !== false,
  }
  const whenToUse = parsed.data.whenToUse
  if (whenToUse !== undefined && (typeof whenToUse !== 'string' || whenToUse.trim().length === 0)) {
    throw new Error('frontmatter field "whenToUse" must be a non-empty string')
  }
  const metadata = parsed.data.metadata
  if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))) {
    throw new Error('frontmatter field "metadata" must be an object')
  }
  return {
    name,
    description: description.trim(),
    ...(typeof whenToUse === 'string' ? { whenToUse: whenToUse.trim() } : {}),
    invocation,
    source: 'runtime',
    provider: 'skillflux-cache',
    resourceBase: { kind: 'directory', path: directory },
    path: join(directory, 'SKILL.md'),
    ...(metadata === undefined ? {} : { metadata: metadata as Readonly<Record<string, unknown>> }),
    content: parsed.body,
  }
}

export async function inspectSkillDirectory(directory: string, limits: TreeLimits): Promise<ParsedSkillFile> {
  let fileCount = 0
  let totalBytes = 0
  const hash = createHash('sha256')
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const path = join(current, entry.name)
      const relativePath = relative(directory, path).replaceAll('\\', '/')
      if (relativePath === '.skillflux.json') continue
      const stats = await lstat(path)
      if (stats.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${relativePath}`)
      if (stats.isDirectory()) {
        await visit(path)
        continue
      }
      if (!stats.isFile()) throw new Error(`unsupported filesystem entry: ${relativePath}`)
      fileCount += 1
      totalBytes += stats.size
      if (fileCount > limits.maxFiles) throw new Error(`skill exceeds ${limits.maxFiles} files`)
      if (totalBytes > limits.maxBytes) throw new Error(`skill exceeds ${limits.maxBytes} bytes`)
      const content = await readFile(path)
      hash.update(relativePath).update('\0').update(content).update('\0')
    }
  }
  await visit(directory)
  const skillPath = join(directory, 'SKILL.md')
  const raw = await readFile(skillPath, 'utf8')
  return {
    definition: parseSkillMarkdown(raw, directory),
    fileCount,
    totalBytes,
    contentHash: hash.digest('hex'),
  }
}
