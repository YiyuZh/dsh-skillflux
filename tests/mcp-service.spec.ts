import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillFluxService, { McpSkillsClient, type SkillFluxConfig } from '../src/index.js'
import { candidateGovernanceReason } from '../src/approval.js'
import type { McpTransport } from '../src/mcp-source.js'
import type { McpCandidate, SkillFluxCandidate } from '../src/types.js'

const disposers: Array<() => Promise<void>> = []
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function mount(context: Context, plugin: Parameters<Context['plugin']>[0], config?: unknown): Promise<void> {
  const fiber = config === undefined ? context.plugin(plugin) : context.plugin(plugin, config)
  await fiber.await()
  disposers.push(fiber.dispose)
}

async function setup(overrides: SkillFluxConfig = {}): Promise<Context> {
  if (process.env.DSH_HOME === undefined) {
    const root = await mkdtemp(join(tmpdir(), 'skillflux-mcp-service-home-'))
    roots.push(root)
    vi.stubEnv('DSH_HOME', root)
  }
  const context = new Context()
  await mount(context, SystemPrompt)
  await mount(context, ToolRuntime)
  await mount(context, AgentRegistry)
  await mount(context, SkillRegistry)
  await mount(context, CommandRuntime)
  await mount(context, SkillFluxService, {
    maxActiveSkills: 3,
    remoteDiscovery: 'off',
    approvalPolicy: 'automatic',
    usageTracking: false,
    routes: [],
    ...overrides,
  })
  return context
}

function fakeAgent(ctx: Context = new Context()): Agent {
  const id = SessionId('skillflux-mcp-service-test')
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd: '/workspace' })
  return {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    status: 'running',
    ctx,
    send() {},
    followup() {},
    steer() {},
    inject() { throw new Error('pre-step routing must not call agent.inject') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

async function propose(
  context: Context,
  agent: Agent,
  messages: UserMessage[],
  turn = 1,
  signal = new AbortController().signal,
) {
  return await agentEvents(context, agent).waterfall(
    'agent/pre-step',
    { messages, turn, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages }),
  )
}

const SKILL_CONTENT = `---
name: refunds
description: Process customer refunds per company policy
---

# Refunds

Follow the refund policy.
`

class FakeMcpServerTransport implements McpTransport {
  readonly requestedUris: string[] = []
  constructor(
    private readonly skills: ReadonlyArray<Record<string, unknown>>,
    private readonly contents: Record<string, string>,
    private readonly fail?: 'list' | 'read',
  ) {}

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.fail === 'list' && method === 'skills/list') throw new Error('server down')
    if (method === 'skills/list') {
      return { resultType: 'complete', skills: [...this.skills] }
    }
    if (method === 'skills/get') {
      const uri = (params as { uri: string }).uri
      const skill = this.skills.find(item => item.uri === uri)
      if (skill === undefined) throw new Error('unknown skill')
      return { resultType: 'complete', skill }
    }
    if (method === 'resources/read') {
      const uri = (params as { uri: string }).uri
      this.requestedUris.push(uri)
      const text = this.contents[uri]
      if (text === undefined) throw new Error('unknown resource')
      return {
        resultType: 'complete',
        contents: [{ uri, mimeType: 'text/markdown', text }],
      }
    }
    throw new Error(`unexpected method ${method}`)
  }
}

function validRefundsEntry(): Record<string, unknown> {
  const uri = 'skill://refunds/SKILL.md'
  return {
    uri,
    frontmatter: { name: 'refunds', description: 'Process customer refunds per company policy' },
    resources: [{
      uri,
      digest: `sha256:${createHash('sha256').update(SKILL_CONTENT).digest('hex')}`,
      size: Buffer.byteLength(SKILL_CONTENT, 'utf8'),
    }],
  }
}

describe('SkillFlux MCP source integration', () => {
  it('reports registered MCP sources in status', async () => {
    const context = await setup()
    context.skillFlux.registerMcpSource(
      'docs-server',
      new McpSkillsClient(new FakeMcpServerTransport([validRefundsEntry()], {})),
    )
    const agent = fakeAgent(context)
    const status = await context.commands.execute(agent, '/skillflux status', [], new AbortController().signal)
    expect(status?.result.text).toContain('MCP sources: docs-server; discovery automatic')
  })

  it('discovers and mounts an MCP skill end to end', async () => {
    const context = await setup()
    const transport = new FakeMcpServerTransport(
      [validRefundsEntry()],
      { 'skill://refunds/SKILL.md': SKILL_CONTENT },
    )
    context.skillFlux.registerMcpSource('docs-server', new McpSkillsClient(transport))
    const agent = fakeAgent(context)
    const candidates = await context.skillFlux.discover(agent, 'refunds')
    const mcp = candidates.find((candidate): candidate is McpCandidate => candidate.origin === 'mcp')
    expect(mcp).toMatchObject({
      name: 'refunds',
      serverLabel: 'docs-server',
      trustLevel: 'community',
    })
    const internals = context.skillFlux as unknown as {
      state: (target: Agent) => { candidates: Map<string, SkillFluxCandidate> }
    }
    internals.state(agent).candidates.set(mcp!.id, mcp!)
    const mounted = await context.skillFlux.mount(agent, mcp!.id)
    expect(mounted).toMatchObject({ origin: 'mcp', source: 'docs-server', name: 'refunds' })
    expect(mounted.definition.content).toContain('Follow the refund policy.')
    expect(transport.requestedUris).toContain('skill://refunds/SKILL.md')

    context.skillFlux.unregisterMcpSource('docs-server')
    const after = await context.skillFlux.discover(fakeAgent(context), 'refunds')
    expect(after.some(candidate => candidate.origin === 'mcp')).toBe(false)
  })

  it('publishes MCP candidates for lazy activation during automatic routing', async () => {
    const context = await setup()
    const transport = new FakeMcpServerTransport(
      [validRefundsEntry()],
      { 'skill://refunds/SKILL.md': SKILL_CONTENT },
    )
    context.skillFlux.registerMcpSource('docs-server', new McpSkillsClient(transport))
    const agent = fakeAgent(context)
    const user = createUserMessage({
      content: [{ type: 'text', text: 'Process refunds for this order' }],
      source: { kind: 'user' },
    })
    await propose(context, agent, [user])
    const internals = context.skillFlux as unknown as {
      state: (target: Agent) => { published: { candidates: readonly SkillFluxCandidate[] } }
    }
    expect(internals.state(agent).published.candidates).toMatchObject([
      { name: 'refunds', origin: 'mcp', source: 'docs-server' },
    ])
    const loaded = await context.tools.execute({
      callId: CallId('skillflux-mcp-load'),
      name: 'skill',
      arguments: { name: 'refunds' },
      agent,
      signal: new AbortController().signal,
    })
    expect(loaded.isError).toBe(false)
    expect((loaded.content[0] as { text?: string }).text).toContain('Follow the refund policy.')
    expect(context.skillFlux.mounted(agent)).toEqual([])
  })

  it('fails open when a registered MCP source cannot be listed', async () => {
    const context = await setup()
    context.skillFlux.registerMcpSource(
      'flaky-server',
      new McpSkillsClient(new FakeMcpServerTransport([validRefundsEntry()], {}, 'list')),
    )
    const agent = fakeAgent(context)
    const candidates = await context.skillFlux.discover(agent, 'refunds')
    expect(candidates.some(candidate => candidate.origin === 'mcp')).toBe(false)
    const user = createUserMessage({
      content: [{ type: 'text', text: 'Process refunds for this order' }],
      source: { kind: 'user' },
    })
    await propose(context, agent, [user])
    const internals = context.skillFlux as unknown as {
      state: (target: Agent) => { published: { complete: boolean } }
    }
    expect(internals.state(agent).published.complete).toBe(false)
  })

  it('applies blocked-server and trust policy governance to MCP candidates', async () => {
    const context = await setup({ mcpBlockedServers: ['evil-server'] })
    context.skillFlux.registerMcpSource(
      'evil-server',
      new McpSkillsClient(new FakeMcpServerTransport([validRefundsEntry()], {})),
    )
    const agent = fakeAgent(context)
    const candidates = await context.skillFlux.discover(agent, 'refunds')
    expect(candidates.some(candidate => candidate.origin === 'mcp')).toBe(false)

    const candidate: McpCandidate = {
      id: 'mcp-id',
      origin: 'mcp',
      name: 'refunds',
      description: 'd',
      source: 'evil-server',
      serverLabel: 'evil-server',
      skillUri: 'skill://refunds/SKILL.md',
      contentBoundKey: '1'.repeat(64),
      frontmatter: { name: 'refunds', description: 'd' },
      resources: [],
      score: 0,
      trustLevel: 'community',
    }
    expect(candidateGovernanceReason(candidate, context.skillFlux.config))
      .toContain('blocked by mcpBlockedServers')

    const strict = await setup({ remoteTrustPolicy: 'trusted' })
    expect(candidateGovernanceReason(candidate, strict.skillFlux.config))
      .toContain('does not satisfy remoteTrustPolicy')
    const trustedCandidate = { ...candidate, serverLabel: 'docs-server', source: 'docs-server' }
    const trusting = await setup({ remoteTrustPolicy: 'trusted', mcpTrustedServers: ['docs-server'] })
    expect(candidateGovernanceReason(trustedCandidate, trusting.skillFlux.config)).toBeUndefined()
  })

  it('restores content-bound MCP skills from the installed cache after restart', async () => {
    const context = await setup()
    const transport = new FakeMcpServerTransport(
      [validRefundsEntry()],
      { 'skill://refunds/SKILL.md': SKILL_CONTENT },
    )
    context.skillFlux.registerMcpSource('docs-server', new McpSkillsClient(transport))
    const agent = fakeAgent(context)
    const candidates = await context.skillFlux.discover(agent, 'refunds')
    const mcp = candidates.find((candidate): candidate is McpCandidate => candidate.origin === 'mcp')!
    const internals = context.skillFlux as unknown as {
      state: (target: Agent) => { candidates: Map<string, SkillFluxCandidate> }
    }
    internals.state(agent).candidates.set(mcp.id, mcp)
    await context.skillFlux.mount(agent, mcp.id)

    // A new service instance shares DSH_HOME but has no registered source.
    const restarted = await setup()
    const restartAgent = fakeAgent(restarted)
    const restored = await restarted.skillFlux.discover(restartAgent, 'refunds')
    const cached = restored.find((candidate): candidate is McpCandidate => candidate.origin === 'mcp')
    expect(cached).toMatchObject({ serverLabel: 'docs-server', name: 'refunds' })
    const restartInternals = restarted.skillFlux as unknown as {
      state: (target: Agent) => { candidates: Map<string, SkillFluxCandidate> }
    }
    restartInternals.state(restartAgent).candidates.set(cached!.id, cached!)
    const mounted = await restarted.skillFlux.mount(restartAgent, cached!.id)
    expect(mounted.definition.content).toContain('Follow the refund policy.')
    expect(transport.requestedUris).toHaveLength(1)

    const blockedRestart = await setup({ mcpBlockedServers: ['docs-server'] })
    const blocked = await blockedRestart.skillFlux.discover(fakeAgent(blockedRestart), 'refunds')
    expect(blocked.some(candidate => candidate.origin === 'mcp')).toBe(false)
  })

  it('persists bounded usage metadata for MCP mounts', async () => {
    const context = await setup({ usageTracking: true })
    const transport = new FakeMcpServerTransport(
      [validRefundsEntry()],
      { 'skill://refunds/SKILL.md': SKILL_CONTENT },
    )
    context.skillFlux.registerMcpSource('docs-server', new McpSkillsClient(transport))
    const agent = fakeAgent(context)
    const candidates = await context.skillFlux.discover(agent, 'refunds')
    const mcp = candidates.find((candidate): candidate is McpCandidate => candidate.origin === 'mcp')!
    const internals = context.skillFlux as unknown as {
      state: (target: Agent) => { candidates: Map<string, SkillFluxCandidate> }
    }
    internals.state(agent).candidates.set(mcp.id, mcp)
    await context.skillFlux.mount(agent, mcp.id)
    expect(await context.skillFlux.usageRecords()).toMatchObject([{
      name: 'refunds',
      origin: 'mcp',
      source: 'docs-server',
      mounts: 1,
    }])
  })
})
