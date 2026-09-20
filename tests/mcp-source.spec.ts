import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  MCP_MAX_LIST_PAGES,
  MCP_MAX_RESOURCES_PER_SKILL,
  MCP_MAX_SKILL_BYTES,
  McpError,
  McpSkillsClient,
  assertMcpServerLabel,
  mcpCandidates,
  mcpContentBoundKey,
  mcpFrontmatterEqual,
  mcpRelativePath,
  mcpSkillRoot,
  parseMcpSkillResource,
  validateMcpSkillEntry,
  type McpTransport,
} from '../src/mcp-source.js'

function digestOf(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function resource(uri: string, content: string): { uri: string; digest: string; size: number } {
  return { uri, digest: digestOf(content), size: Buffer.byteLength(content, 'utf8') }
}

function skillEntry(
  name: string,
  description = 'A test skill',
  files: ReadonlyArray<readonly [string, string]> = [],
): Record<string, unknown> {
  const uri = `skill://${name}/SKILL.md`
  const resources = [
    resource(uri, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`),
    ...files.map(([path, content]) => resource(`skill://${name}/${path}`, content)),
  ]
  return { uri, frontmatter: { name, description }, resources }
}

class ScriptedTransport implements McpTransport {
  private readonly calls: Array<{ method: string; params?: unknown }> = []
  constructor(
    private readonly respond: (method: string, params?: unknown) => unknown,
  ) {}

  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params })
    const result = this.respond(method, params)
    if (result instanceof Error) throw result
    return result
  }

  callCount(): number {
    return this.calls.length
  }
}

describe('mcpRelativePath', () => {
  it('maps the SKILL.md and nested files, and refuses escapes', () => {
    const skillUri = 'skill://acme/billing/refunds/SKILL.md'
    expect(mcpRelativePath(skillUri, skillUri)).toBe('SKILL.md')
    expect(mcpRelativePath(skillUri, 'skill://acme/billing/refunds/examples/email.md'))
      .toBe('examples/email.md')
    expect(mcpRelativePath(skillUri, 'skill://acme/billing/refunds/../other.md')).toBeUndefined()
    expect(mcpRelativePath(skillUri, 'skill://acme/billing/other/SKILL.md')).toBeUndefined()
    expect(mcpRelativePath(skillUri, 'skill://acme/billing/refunds')).toBeUndefined()
    expect(mcpRelativePath(skillUri, 'skill://acme/billing/refunds/..')).toBeUndefined()
  })

  it('derives the skill root only from a SKILL.md uri', () => {
    expect(mcpSkillRoot('skill://git-workflow/SKILL.md')).toBe('skill://git-workflow')
    expect(mcpSkillRoot('skill://git-workflow/references/guide.md')).toBeUndefined()
  })
})

describe('validateMcpSkillEntry', () => {
  it('accepts a minimal complete entry', () => {
    const entry = validateMcpSkillEntry(skillEntry('pdf-processing'))
    expect(entry).toMatchObject({
      uri: 'skill://pdf-processing/SKILL.md',
      frontmatter: { name: 'pdf-processing' },
    })
    expect(entry?.resources).toHaveLength(1)
  })

  it('accepts nested skill paths and supporting files', () => {
    const entry = validateMcpSkillEntry(skillEntry(
      'refunds',
      'Process refunds',
      [['examples/email.md', '# Email\n'], ['scripts/run.py', 'print(1)\n']],
    ))
    expect(entry?.resources).toHaveLength(3)
  })

  it('rejects malformed and unsafe entries', () => {
    expect(validateMcpSkillEntry({ uri: 'skill://x', frontmatter: { name: 'x' }, resources: [] })).toBeUndefined()
    expect(validateMcpSkillEntry(skillEntry('Bad Name'))).toBeUndefined()
    expect(validateMcpSkillEntry(skillEntry('x', '', []))).toBeUndefined()
    expect(validateMcpSkillEntry({ ...skillEntry('x'), frontmatter: { name: 'x' } })).toBeUndefined()
    expect(validateMcpSkillEntry({ ...skillEntry('x'), uri: 'skill://other/SKILL.md' })).toBeUndefined()
    expect(validateMcpSkillEntry({ ...skillEntry('x'), resources: 'dynamic' })).toBeUndefined()
    expect(validateMcpSkillEntry({ ...skillEntry('x'), resources: [] })).toBeUndefined()
    expect(validateMcpSkillEntry(skillEntry('x', 'd', [['../escape.md', '']]))).toBeUndefined()
    expect(validateMcpSkillEntry(skillEntry('x', 'd', [['..', '']]))).toBeUndefined()
    expect(validateMcpSkillEntry({
      ...skillEntry('x'),
      resources: [
        ...(skillEntry('x').resources as unknown[]),
        ...(skillEntry('x').resources as unknown[]),
      ],
    })).toBeUndefined()
  })

  it('rejects a resource list missing the SKILL.md entry', () => {
    const entry = skillEntry('x', 'd', [['guide.md', '# Guide\n']])
    const withoutSkillFile = (entry.resources as unknown[]).filter(
      resource => (resource as { uri: string }).uri !== 'skill://x/SKILL.md',
    )
    expect(validateMcpSkillEntry({ ...entry, resources: withoutSkillFile })).toBeUndefined()
  })

  it('enforces the per-skill resource and byte limits', () => {
    const tooMany = Array.from({ length: MCP_MAX_RESOURCES_PER_SKILL + 1 }, (_, index) =>
      resource(`skill://x/file-${index}.md`, ''))
    expect(validateMcpSkillEntry({
      uri: 'skill://x/SKILL.md',
      frontmatter: { name: 'x', description: 'd' },
      resources: tooMany,
    })).toBeUndefined()
    const oversized = [
      { uri: 'skill://x/SKILL.md', digest: digestOf('a'), size: MCP_MAX_SKILL_BYTES },
      { uri: 'skill://x/big.bin', digest: digestOf('b'), size: 1 },
    ]
    expect(validateMcpSkillEntry({
      uri: 'skill://x/SKILL.md',
      frontmatter: { name: 'x', description: 'd' },
      resources: oversized,
    })).toBeUndefined()
  })

  it('rejects invalid digests and sizes', () => {
    expect(parseMcpSkillResource({ uri: 'skill://x/a.md', digest: 'not-a-digest', size: 1 })).toBeUndefined()
    expect(parseMcpSkillResource({ uri: 'skill://x/a.md', digest: digestOf('a'), size: -1 })).toBeUndefined()
    expect(parseMcpSkillResource({ uri: 'skill://x/a.md', digest: digestOf('a'), size: 1.5 })).toBeUndefined()
    expect(parseMcpSkillResource({ uri: 'skill://x/a.md', digest: digestOf('a').toUpperCase(), size: 1 }))
      .toBeUndefined()
  })
})

describe('mcpContentBoundKey and frontmatter equality', () => {
  it('is order independent and changes with any resource', () => {
    const entry = validateMcpSkillEntry(skillEntry('x', 'd', [['a.md', 'a'], ['b.md', 'b']]))!
    const reversed = { ...entry, resources: [...entry.resources].reverse() }
    expect(mcpContentBoundKey(reversed)).toBe(mcpContentBoundKey(entry))
    const changed = {
      ...entry,
      resources: entry.resources.map(resource => resource.uri.endsWith('a.md')
        ? { ...resource, digest: digestOf('different') }
        : resource),
    }
    expect(mcpContentBoundKey(changed)).not.toBe(mcpContentBoundKey(entry))
  })

  it('compares frontmatter field by field', () => {
    expect(mcpFrontmatterEqual(
      { name: 'x', description: 'd', license: 'MIT' },
      { license: 'MIT', description: 'd', name: 'x' },
    )).toBe(true)
    expect(mcpFrontmatterEqual(
      { name: 'x', description: 'd', metadata: { tags: ['a', 'b'] } },
      { name: 'x', description: 'd', metadata: { tags: ['a', 'b'] } },
    )).toBe(true)
    expect(mcpFrontmatterEqual(
      { name: 'x', description: 'd' },
      { name: 'x', description: 'different' },
    )).toBe(false)
    expect(mcpFrontmatterEqual({ name: 'x', description: 'd' }, { name: 'x' })).toBe(false)
    expect(mcpFrontmatterEqual(
      { name: 'x', description: 'd', metadata: { tags: ['a'] } },
      { name: 'x', description: 'd', metadata: { tags: ['b'] } },
    )).toBe(false)
  })
})

describe('mcpCandidates', () => {
  it('assigns unique catalog names and trust levels', () => {
    assertMcpServerLabel('docs-server')
    expect(() => assertMcpServerLabel('bad label')).toThrow('invalid host-assigned MCP server label')
    const refundsA = validateMcpSkillEntry(skillEntry('refunds', 'A'))!
    const refundsB = validateMcpSkillEntry({
      uri: 'skill://acme/billing/refunds/SKILL.md',
      frontmatter: { name: 'refunds', description: 'B' },
      resources: [resource('skill://acme/billing/refunds/SKILL.md', '---\nname: refunds\ndescription: B\n---\n')],
    })!
    const plain = validateMcpSkillEntry(skillEntry('invoice-scan', 'C'))!
    const candidates = mcpCandidates('docs-server', [refundsA, refundsB, plain])
    const names = candidates.map(candidate => candidate.name)
    expect(names).toHaveLength(3)
    expect(new Set(names).size).toBe(3)
    expect(names).toContain('invoice-scan')
    expect(names.filter(name => name === 'refunds' || name.startsWith('refunds-'))).toHaveLength(2)
    expect(names.some(name => name === 'refunds')).toBe(true)
    expect(names.every(name => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name))).toBe(true)
    expect(candidates.every(candidate => candidate.trustLevel === 'community')).toBe(true)
    expect(candidates.every(candidate => candidate.serverLabel === 'docs-server')).toBe(true)
    const trusted = mcpCandidates('docs-server', [plain], { trustedServers: ['DOCS-SERVER'] })
    expect(trusted[0]?.trustLevel).toBe('trusted')
    expect(() => mcpCandidates('bad label', [plain])).toThrow('invalid host-assigned MCP server label')
  })
})

describe('McpSkillsClient', () => {
  it('follows pagination and reports partial listings', () => {
    const entries = Array.from({ length: MCP_MAX_LIST_PAGES + 1 }, (_, index) =>
      skillEntry(`skill-${index}`))
    const transport = new ScriptedTransport((_method, params) => {
      const cursor = (params as { cursor?: number } | undefined)?.cursor ?? 0
      return {
        resultType: 'complete',
        skills: [entries[cursor]],
        nextCursor: cursor + 1 < entries.length ? cursor + 1 : undefined,
      }
    })
    const client = new McpSkillsClient(transport)
    return client.listSkills().then(listing => {
      expect(listing.entries).toHaveLength(MCP_MAX_LIST_PAGES)
      expect(listing.partial).toBe(true)
      expect(transport.callCount()).toBe(MCP_MAX_LIST_PAGES)
    })
  })

  it('drops invalid entries and marks the listing partial', async () => {
    const transport = new ScriptedTransport(() => ({
      resultType: 'complete',
      skills: [skillEntry('good-skill'), { uri: 'skill://bad/SKILL.md' }],
    }))
    const listing = await new McpSkillsClient(transport).listSkills()
    expect(listing.entries.map(entry => entry.frontmatter.name)).toEqual(['good-skill'])
    expect(listing.partial).toBe(true)
  })

  it('rejects a result without resultType complete', async () => {
    const transport = new ScriptedTransport(() => ({ skills: [] }))
    await expect(new McpSkillsClient(transport).listSkills()).rejects.toThrow('incomplete result')
  })

  it('answers skills/get only for the requested uri', async () => {
    const entry = skillEntry('pdf-processing')
    const transport = new ScriptedTransport((method, params) => {
      if (method !== 'skills/get') throw new Error('unexpected method')
      return {
        resultType: 'complete',
        skill: (params as { uri: string }).uri === entry.uri ? entry : entry,
      }
    })
    const client = new McpSkillsClient(transport)
    await expect(client.getSkill('skill://pdf-processing/SKILL.md')).resolves.toMatchObject({
      frontmatter: { name: 'pdf-processing' },
    })
    await expect(client.getSkill('skill://other/SKILL.md')).rejects.toThrow('did not return the requested skill')
  })

  it('decodes text and blob resources and rejects mismatches', async () => {
    const content = '# Invoice\n'
    const textTransport = new ScriptedTransport(() => ({
      resultType: 'complete',
      contents: [{ uri: 'skill://x/invoice.md', mimeType: 'text/markdown', text: content }],
    }))
    await expect(new McpSkillsClient(textTransport).readResource('skill://x/invoice.md'))
      .resolves.toEqual(Buffer.from(content, 'utf8'))

    const blobTransport = new ScriptedTransport(() => ({
      resultType: 'complete',
      contents: [{ uri: 'skill://x/data.bin', blob: Buffer.from([0, 1, 2]).toString('base64') }],
    }))
    await expect(new McpSkillsClient(blobTransport).readResource('skill://x/data.bin'))
      .resolves.toEqual(Buffer.from([0, 1, 2]))

    const missing = new ScriptedTransport(() => ({
      resultType: 'complete',
      contents: [{ uri: 'skill://x/other.md', text: 'other' }],
    }))
    await expect(new McpSkillsClient(missing).readResource('skill://x/invoice.md'))
      .rejects.toThrow('no content matching')
  })

  it('passes JSON-RPC errors through as McpError', async () => {
    const transport = new ScriptedTransport(() => { throw new McpError(-32602, 'unknown uri') })
    await expect(new McpSkillsClient(transport).readResource('skill://x/SKILL.md'))
      .rejects.toMatchObject({ code: -32602 })
  })
})
