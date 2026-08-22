import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { Session, SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillFluxService, { type SkillFluxConfig } from '../src/index.js'
import { candidateId } from '../src/router.js'
import type { CacheEntry } from '../src/types.js'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

async function mount(context: Context, plugin: Parameters<Context['plugin']>[0], config?: unknown): Promise<void> {
  const fiber = config === undefined ? context.plugin(plugin) : context.plugin(plugin, config)
  await fiber.await()
  disposers.push(fiber.dispose)
}

async function setup(overrides: SkillFluxConfig = {}): Promise<Context> {
  const context = new Context()
  await mount(context, SystemPrompt)
  await mount(context, ToolRuntime)
  await mount(context, AgentRegistry)
  await mount(context, SkillRegistry)
  await mount(context, CommandRuntime)
  await mount(context, SkillFluxService, {
    maxActiveSkills: 3,
    remoteDiscovery: 'off',
    routes: [{ matchAny: ['pdf'], skills: ['skill-1', 'skill-2', 'skill-3', 'skill-4'] }],
    ...overrides,
  })
  return context
}

function fakeAgent(ctx: Context = new Context()): Agent {
  const id = SessionId('skillflux-service-test')
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

async function propose(context: Context, agent: Agent, messages: UserMessage[], turn = 1) {
  const signal = new AbortController().signal
  return await agentEvents(context, agent).waterfall(
    'agent/pre-step',
    { messages, turn, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages }),
  )
}

describe('SkillFlux service', () => {
  it('virtualizes a large registry to the configured active catalog', async () => {
    const context = await setup()
    for (let index = 0; index < 100; index += 1) {
      context.skills.register({
        name: `skill-${index}`,
        description: `Capability ${index}`,
        source: 'runtime',
        content: `Instructions ${index}`,
      })
    }
    const agent = fakeAgent(context)
    const user = createUserMessage({ content: [{ type: 'text', text: 'Handle this PDF' }], source: { kind: 'user' } })
    const decision = await propose(context, agent, [user])
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    const catalog = decision.messages.find(message => message.source.kind === 'skill-catalog')
    expect(catalog).toBeDefined()
    if (catalog === undefined) return
    const entries = (catalog.source as { entries?: unknown }).entries
    expect(entries).toEqual([
      { name: 'skill-1', description: 'Capability 1' },
      { name: 'skill-2', description: 'Capability 2' },
      { name: 'skill-3', description: 'Capability 3' },
    ])
    expect(context.tools.schemas().map(tool => tool.name)).toEqual(['skill', 'skillflux_search', 'skillflux_mount'])

    const loaded = await context.tools.execute({
      callId: CallId('skillflux-load'),
      name: 'skill',
      arguments: { name: 'skill-1' },
      agent,
      signal: new AbortController().signal,
    })
    expect(loaded.isError).toBe(false)
    expect(loaded.content[0]).toMatchObject({ type: 'text' })
    expect((loaded.content[0] as { text?: string }).text).toContain('Instructions 1')

    expect(context.skillFlux.mounted(agent).map(skill => skill.name)).toEqual([
      'skill-1',
      'skill-2',
      'skill-3',
    ])
    context.emit(scopeTarget(agent.session, undefined), 'session/event', agent.session, {
      type: 'turn/end',
      seq: 1,
      time: 1,
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    expect(context.skillFlux.mounted(agent)).toEqual([])

    const denied = await context.tools.execute({
      callId: CallId('skillflux-load-after-unmount'),
      name: 'skill',
      arguments: { name: 'skill-1' },
      agent,
      signal: new AbortController().signal,
    })
    expect(denied.isError).toBe(true)
    expect(denied.error?.message).toContain('not mounted')
  })

  it('keeps explicit user skill invocation compatible outside the routed catalog', async () => {
    const context = await setup()
    context.skills.register({
      name: 'manual-skill',
      description: 'Only invoked explicitly',
      source: 'runtime',
      content: 'Manual instructions.',
    })
    const agent = fakeAgent(context)
    const user = createUserMessage({
      content: [{ type: 'text', text: 'Please use /manual-skill now' }],
      source: { kind: 'user' },
    })
    const decision = await propose(context, agent, [user])
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    const invocation = decision.messages.find(message => message.source.kind === 'skill-invocation')
    expect(invocation).toBeDefined()
    if (invocation === undefined) return
    expect(invocation.content[0]).toMatchObject({ type: 'text' })
    expect((invocation.content[0] as { text?: string }).text).toContain('Manual instructions.')
    expect(context.skillFlux.mounted(agent)).toEqual([])
    expect(decision.messages.some(message => message.source.kind === 'skill-catalog')).toBe(false)
  })

  it('does not let a user-only registry skill shadow a model-invocable cached skill', async () => {
    const context = await setup({ routes: [] })
    context.skills.register({
      name: 'pdf-reader',
      description: 'Only invoked explicitly',
      invocation: { modelInvocable: false, userInvocable: true },
      source: 'runtime',
      content: 'Manual-only instructions.',
    })
    const cached: CacheEntry = {
      directory: '/cache/pdf-reader',
      manifest: {
        version: 1,
        cacheId: 'a'.repeat(24),
        source: 'cached/repo',
        ref: 'b'.repeat(40),
        skillId: 'pdf-reader',
        name: 'pdf-reader',
        description: 'Read and analyze PDF documents',
        installedAt: '2026-08-22T00:00:00.000Z',
        fileCount: 1,
        totalBytes: 10,
        contentHash: 'c'.repeat(64),
      },
    }
    const cache = (context.skillFlux as unknown as {
      cache: {
        list: () => Promise<CacheEntry[]>
        get: (id: string) => Promise<CacheEntry | undefined>
        load: (item: CacheEntry) => Promise<SkillDefinition>
      }
    }).cache
    cache.list = async () => [cached]
    cache.get = async id => id === cached.manifest.cacheId ? cached : undefined
    cache.load = async item => ({
      name: 'pdf-reader',
      description: 'Read and analyze PDF documents',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'runtime',
      provider: 'skillflux-cache',
      resourceBase: { kind: 'directory', path: item.directory },
      path: `${item.directory}/SKILL.md`,
      content: 'Cached PDF instructions.',
    })

    const agent = fakeAgent(context)
    const user = createUserMessage({
      content: [{ type: 'text', text: 'Read this PDF document' }],
      source: { kind: 'user' },
    })
    const decision = await propose(context, agent, [user])
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(context.skillFlux.mounted(agent)).toMatchObject([
      { name: 'pdf-reader', origin: 'cache', source: 'cached/repo' },
    ])
    const catalog = decision.messages.find(message => message.source.kind === 'skill-catalog')
    expect(catalog).toBeDefined()
    if (catalog === undefined) return
    expect((catalog.source as { entries?: unknown }).entries).toEqual([
      { name: 'pdf-reader', description: 'Read and analyze PDF documents' },
    ])

    const explicit = createUserMessage({
      content: [{ type: 'text', text: 'Use /pdf-reader now' }],
      source: { kind: 'user' },
    })
    const explicitDecision = await propose(context, fakeAgent(context), [explicit], 2)
    expect(explicitDecision.kind).toBe('enter')
    if (explicitDecision.kind !== 'enter') return
    const invocation = explicitDecision.messages.find(message => message.source.kind === 'skill-invocation')
    expect(invocation).toBeDefined()
    if (invocation === undefined) return
    expect((invocation.content[0] as { text?: string }).text).toContain('Manual-only instructions.')
  })

  it('still routes a model-only skill when slash syntax cannot invoke it directly', async () => {
    const context = await setup({ routes: [] })
    context.skills.register({
      name: 'model-only',
      description: 'Model-only capability',
      invocation: { modelInvocable: true, userInvocable: false },
      source: 'runtime',
      content: 'Model-only instructions.',
    })
    const agent = fakeAgent(context)
    const user = createUserMessage({
      content: [{ type: 'text', text: 'Please use /model-only now' }],
      source: { kind: 'user' },
    })
    const decision = await propose(context, agent, [user])
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.messages.some(message => message.source.kind === 'skill-invocation')).toBe(false)
    expect(context.skillFlux.mounted(agent).map(skill => skill.name)).toEqual(['model-only'])
    const catalog = decision.messages.find(message => message.source.kind === 'skill-catalog')
    expect(catalog).toBeDefined()
    if (catalog === undefined) return
    expect((catalog.source as { entries?: unknown }).entries).toEqual([
      { name: 'model-only', description: 'Model-only capability' },
    ])
  })

  it('enforces maxActiveSkills across repeated search and mount calls', async () => {
    const context = await setup({
      maxActiveSkills: 1,
      routes: [{ matchAny: ['pdf'], skills: ['first-skill'] }],
    })
    for (const name of ['first-skill', 'second-skill']) {
      context.skills.register({ name, description: `${name} capability`, source: 'runtime', content: `${name} instructions` })
    }
    const agent = fakeAgent(context)
    const user = createUserMessage({ content: [{ type: 'text', text: 'Handle this PDF' }], source: { kind: 'user' } })
    await propose(context, agent, [user])
    const search = await context.tools.execute({
      callId: CallId('skillflux-search-second'),
      name: 'skillflux_search',
      arguments: { query: 'second-skill', remote: false },
      agent,
      signal: new AbortController().signal,
    })
    expect(search.isError).toBe(false)
    const result = await context.tools.execute({
      callId: CallId('skillflux-mount-over-limit'),
      name: 'skillflux_mount',
      arguments: { candidateId: candidateId('registry', 'runtime', '', 'second-skill') },
      agent,
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('turn limit is reached')
    expect(context.skillFlux.mounted(agent).map(skill => skill.name)).toEqual(['first-skill'])
    context.emit(scopeTarget(agent.session, undefined), 'session/event', agent.session, {
      type: 'turn/end',
      seq: 1,
      time: 1,
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    await expect(context.skillFlux.mount(agent, candidateId('registry', 'runtime', '', 'second-skill')))
      .rejects.toThrow('unknown or expired')
  })

  it('skips a corrupt cache candidate and mounts the next usable candidate', async () => {
    const context = await setup({ routes: [] })
    const entry = (id: string, name: string, source: string): CacheEntry => ({
      directory: `/cache/${id}`,
      manifest: {
        version: 1,
        cacheId: id,
        source,
        ref: 'a'.repeat(40),
        skillId: name,
        name,
        description: 'Handle PDF documents',
        installedAt: '2026-08-21T00:00:00.000Z',
        fileCount: 1,
        totalBytes: 10,
        contentHash: 'b'.repeat(64),
      },
    })
    const bad = entry('a'.repeat(24), 'pdf-cache', 'new/repo')
    const good = entry('b'.repeat(24), 'pdf-cache', 'old/repo')
    const entries = new Map([[bad.manifest.cacheId, bad], [good.manifest.cacheId, good]])
    const cache = (context.skillFlux as unknown as {
      cache: {
        list: () => Promise<CacheEntry[]>
        get: (id: string) => Promise<CacheEntry | undefined>
        load: (item: CacheEntry) => Promise<SkillDefinition>
      }
    }).cache
    cache.list = async () => [bad, good]
    cache.get = async id => entries.get(id)
    cache.load = async item => {
      if (item.manifest.cacheId === bad.manifest.cacheId) throw new Error('cached skill contents no longer match')
      return {
        name: 'pdf-cache',
        description: 'Handle PDF documents',
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'runtime',
        provider: 'skillflux-cache',
        resourceBase: { kind: 'directory', path: item.directory },
        path: `${item.directory}/SKILL.md`,
        content: 'Good cached instructions.',
      }
    }
    const agent = fakeAgent(context)
    const user = createUserMessage({ content: [{ type: 'text', text: 'Handle PDF documents' }], source: { kind: 'user' } })
    await propose(context, agent, [user])
    expect(context.skillFlux.mounted(agent).map(skill => `${skill.name}:${skill.source}`)).toEqual(['pdf-cache:old/repo'])
  })
})
