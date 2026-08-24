import { afterEach, describe, expect, it, vi } from 'vitest'
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
import PublishedSkillFluxService from '../lib/index.js'
import { candidateId } from '../src/router.js'
import type { CacheEntry, SkillFluxCandidate } from '../src/types.js'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

async function mount(context: Context, plugin: Parameters<Context['plugin']>[0], config?: unknown): Promise<void> {
  const fiber = config === undefined ? context.plugin(plugin) : context.plugin(plugin, config)
  await fiber.await()
  disposers.push(fiber.dispose)
}

async function setup(
  overrides: SkillFluxConfig = {},
  plugin: Parameters<Context['plugin']>[0] = SkillFluxService,
): Promise<Context> {
  const context = new Context()
  await mount(context, SystemPrompt)
  await mount(context, ToolRuntime)
  await mount(context, AgentRegistry)
  await mount(context, SkillRegistry)
  await mount(context, CommandRuntime)
  await mount(context, plugin, {
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

  it('rejects incomplete discovery before publishing partial candidates', async () => {
    const context = await setup({ routes: [] })
    const agent = fakeAgent(context)
    vi.spyOn(context.skills, 'snapshot').mockResolvedValueOnce({
      complete: false,
      skills: [{
        name: 'partial-skill',
        description: 'Transient partial result',
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'partial-provider',
        provider: 'partial-provider',
      }],
    })
    const cache = (context.skillFlux as unknown as { cache: { list: ReturnType<typeof vi.fn> } }).cache
    cache.list = vi.fn(async () => [])
    await expect(context.skillFlux.discover(agent, 'partial-skill')).rejects.toThrow('discovery is incomplete')
    expect(cache.list).not.toHaveBeenCalled()
  })

  it('does not publish a mount after its agent state is disposed', async () => {
    const context = await setup({ routes: [] })
    const cached: CacheEntry = {
      directory: '/cache/late-skill',
      manifest: {
        version: 1,
        cacheId: 'd'.repeat(24),
        source: 'cached/repo',
        ref: 'e'.repeat(40),
        skillId: 'late-skill',
        name: 'late-skill',
        description: 'Late lifecycle skill',
        installedAt: '2026-08-22T00:00:00.000Z',
        fileCount: 1,
        totalBytes: 10,
        contentHash: 'f'.repeat(64),
      },
    }
    let releaseLoad!: (definition: SkillDefinition) => void
    let markLoadStarted!: () => void
    const loadStarted = new Promise<void>(resolve => { markLoadStarted = resolve })
    const loadResult = new Promise<SkillDefinition>(resolve => { releaseLoad = resolve })
    const cache = (context.skillFlux as unknown as {
      cache: {
        list: () => Promise<CacheEntry[]>
        get: (id: string) => Promise<CacheEntry | undefined>
        load: (item: CacheEntry, signal?: AbortSignal) => Promise<SkillDefinition>
      }
    }).cache
    cache.list = async () => [cached]
    cache.get = async id => id === cached.manifest.cacheId ? cached : undefined
    cache.load = async () => {
      markLoadStarted()
      return await loadResult
    }
    const agent = fakeAgent(context)
    const search = await context.tools.execute({
      callId: CallId('skillflux-search-late'),
      name: 'skillflux_search',
      arguments: { query: 'late-skill', remote: false },
      agent,
      signal: new AbortController().signal,
    })
    expect(search.isError).toBe(false)
    const register = vi.spyOn(context.skills, 'register')
    const pending = context.skillFlux.mount(agent, candidateId('cache', 'cached/repo', cached.manifest.ref, 'late-skill'))
    await loadStarted
    ;(context.skillFlux as unknown as { disposeAgent: (disposed: Agent) => void }).disposeAgent(agent)
    releaseLoad({
      name: 'late-skill',
      description: 'Late lifecycle skill',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'runtime',
      provider: 'skillflux-cache',
      content: 'Late instructions.',
    })
    await expect(pending).rejects.toThrow('lifecycle ended')
    expect(register).not.toHaveBeenCalled()
    expect(context.skillFlux.mounted(agent)).toEqual([])
  })

  it('propagates pre-step cancellation instead of failing open', async () => {
    const context = await setup({ routes: [] })
    const agent = fakeAgent(context)
    const controller = new AbortController()
    const reason = new Error('cancelled routing')
    vi.spyOn(context.skills, 'snapshot').mockImplementationOnce(async () => {
      controller.abort(reason)
      throw reason
    })
    const user = createUserMessage({ content: [{ type: 'text', text: 'Read this PDF' }], source: { kind: 'user' } })
    await expect(propose(context, agent, [user], 1, controller.signal)).rejects.toThrow('cancelled routing')
  })

  it('does not let stale routing remount a skill after turn cleanup', async () => {
    const context = await setup({
      routes: [{ matchAny: ['pdf'], skills: ['pdf-reader'] }],
    })
    context.skills.register({
      name: 'pdf-reader',
      description: 'Read PDF documents',
      source: 'runtime',
      content: 'PDF instructions.',
    })
    const originalSnapshot = context.skills.snapshot.bind(context.skills)
    let releaseSnapshot!: () => void
    let markSnapshotStarted!: () => void
    const snapshotStarted = new Promise<void>(resolve => { markSnapshotStarted = resolve })
    const snapshotGate = new Promise<void>(resolve => { releaseSnapshot = resolve })
    vi.spyOn(context.skills, 'snapshot').mockImplementationOnce(async options => {
      markSnapshotStarted()
      await snapshotGate
      return await originalSnapshot(options)
    })
    const agent = fakeAgent(context)
    const user = createUserMessage({ content: [{ type: 'text', text: 'Read this PDF' }], source: { kind: 'user' } })
    const pending = propose(context, agent, [user])
    await snapshotStarted
    context.emit(scopeTarget(agent.session, undefined), 'session/event', agent.session, {
      type: 'turn/end',
      seq: 1,
      time: 1,
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    releaseSnapshot()
    await pending
    expect(context.skillFlux.mounted(agent)).toEqual([])
  })

  it('invalidates an in-flight named mount when unmounted', async () => {
    const context = await setup({ routes: [] })
    const cached: CacheEntry = {
      directory: '/cache/pending-skill',
      manifest: {
        version: 1,
        cacheId: '1'.repeat(24),
        source: 'cached/repo',
        ref: '2'.repeat(40),
        skillId: 'pending-skill',
        name: 'pending-skill',
        description: 'Pending lifecycle skill',
        installedAt: '2026-08-22T00:00:00.000Z',
        fileCount: 1,
        totalBytes: 10,
        contentHash: '3'.repeat(64),
      },
    }
    let releaseLoad!: (definition: SkillDefinition) => void
    let markLoadStarted!: () => void
    const loadStarted = new Promise<void>(resolve => { markLoadStarted = resolve })
    const loadResult = new Promise<SkillDefinition>(resolve => { releaseLoad = resolve })
    const cache = (context.skillFlux as unknown as {
      cache: {
        list: () => Promise<CacheEntry[]>
        get: (id: string) => Promise<CacheEntry | undefined>
        load: (item: CacheEntry, signal?: AbortSignal) => Promise<SkillDefinition>
      }
    }).cache
    cache.list = async () => [cached]
    cache.get = async id => id === cached.manifest.cacheId ? cached : undefined
    cache.load = async () => {
      markLoadStarted()
      return await loadResult
    }
    const agent = fakeAgent(context)
    await context.tools.execute({
      callId: CallId('skillflux-search-pending'),
      name: 'skillflux_search',
      arguments: { query: 'pending-skill', remote: false },
      agent,
      signal: new AbortController().signal,
    })
    const register = vi.spyOn(context.skills, 'register')
    const pending = context.skillFlux.mount(agent, candidateId('cache', 'cached/repo', cached.manifest.ref, 'pending-skill'))
    await loadStarted
    context.skillFlux.unmount(agent, 'pending-skill')
    releaseLoad({
      name: 'pending-skill',
      description: 'Pending lifecycle skill',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'runtime',
      provider: 'skillflux-cache',
      content: 'Pending instructions.',
    })
    await expect(pending).rejects.toThrow('lifecycle ended')
    expect(register).not.toHaveBeenCalled()
    expect(context.skillFlux.mounted(agent)).toEqual([])
  })

  it('mounts the exact cached candidate even when a same-name registry skill appears later', async () => {
    const context = await setup({ routes: [] })
    const cached: CacheEntry = {
      directory: '/cache/exact-skill',
      manifest: {
        version: 1,
        cacheId: '4'.repeat(24),
        source: 'expected/repo',
        ref: '5'.repeat(40),
        skillId: 'exact-skill',
        name: 'exact-skill',
        description: 'Exact cached capability',
        installedAt: '2026-08-22T00:00:00.000Z',
        fileCount: 1,
        totalBytes: 10,
        contentHash: '6'.repeat(64),
      },
    }
    const cache = (context.skillFlux as unknown as {
      cache: {
        list: () => Promise<CacheEntry[]>
        get: (id: string) => Promise<CacheEntry | undefined>
        load: (item: CacheEntry, signal?: AbortSignal) => Promise<SkillDefinition>
      }
    }).cache
    cache.list = async () => [cached]
    cache.get = async id => id === cached.manifest.cacheId ? cached : undefined
    cache.load = async () => ({
      name: 'exact-skill',
      description: 'Exact cached capability',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'runtime',
      provider: 'skillflux-cache',
      content: 'CACHED BODY',
    })
    const agent = fakeAgent(context)
    await context.tools.execute({
      callId: CallId('skillflux-search-exact'),
      name: 'skillflux_search',
      arguments: { query: 'exact-skill', remote: false },
      agent,
      signal: new AbortController().signal,
    })
    context.skills.register({
      name: 'exact-skill',
      description: 'Later local capability',
      source: 'runtime',
      content: 'LOCAL BODY',
    })
    const mounted = await context.skillFlux.mount(
      agent,
      candidateId('cache', 'expected/repo', cached.manifest.ref, 'exact-skill'),
    )
    expect(mounted).toMatchObject({ origin: 'cache', source: 'expected/repo' })
    expect(mounted.definition.content).toBe('CACHED BODY')
  })

  it('cancels reload when the named skill is unmounted during discovery', async () => {
    const context = await setup({ routes: [] })
    const agent = fakeAgent(context)
    let releaseDiscovery!: (candidates: SkillFluxCandidate[]) => void
    let markDiscoveryStarted!: () => void
    const discoveryStarted = new Promise<void>(resolve => { markDiscoveryStarted = resolve })
    const discoveryResult = new Promise<SkillFluxCandidate[]>(resolve => { releaseDiscovery = resolve })
    vi.spyOn(context.skillFlux, 'discover').mockImplementationOnce(async () => {
      markDiscoveryStarted()
      return await discoveryResult
    })
    const pending = context.skillFlux.reload(agent, 'reload-skill')
    await discoveryStarted
    context.skillFlux.unmount(agent, 'reload-skill')
    releaseDiscovery([{
      id: 'reload-skill',
      origin: 'registry',
      name: 'reload-skill',
      description: 'Reload capability',
      source: 'runtime',
      score: 100,
      summary: {
        name: 'reload-skill',
        description: 'Reload capability',
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'runtime',
        provider: 'runtime',
      },
    }])
    await expect(pending).rejects.toThrow('lifecycle ended')
    expect(context.skillFlux.mounted(agent)).toEqual([])
  })

  it('expires a registry candidate when its provider identity changes before mount', async () => {
    const context = await setup({ routes: [] })
    const disposeFirst = context.skills.register({
      name: 'moving-skill',
      description: 'Moving capability',
      source: 'provider-a',
      content: 'BODY A',
    })
    const agent = fakeAgent(context)
    await context.tools.execute({
      callId: CallId('skillflux-search-moving'),
      name: 'skillflux_search',
      arguments: { query: 'moving-skill', remote: false },
      agent,
      signal: new AbortController().signal,
    })
    disposeFirst()
    context.skills.register({
      name: 'moving-skill',
      description: 'Moving capability',
      source: 'provider-b',
      content: 'BODY B',
    })
    await expect(context.skillFlux.mount(
      agent,
      candidateId('registry', 'provider-a', '', 'moving-skill'),
    )).rejects.toThrow('provider changed; search again')
    expect(context.skillFlux.mounted(agent)).toEqual([])
  })

  it('ships the provider identity guard through the package entry', async () => {
    const context = await setup({ routes: [] }, PublishedSkillFluxService)
    const disposeFirst = context.skills.register({
      name: 'published-moving-skill',
      description: 'Published moving capability',
      source: 'provider-a',
      content: 'BODY A',
    })
    const agent = fakeAgent(context)
    await context.tools.execute({
      callId: CallId('skillflux-search-published-moving'),
      name: 'skillflux_search',
      arguments: { query: 'published-moving-skill', remote: false },
      agent,
      signal: new AbortController().signal,
    })
    disposeFirst()
    context.skills.register({
      name: 'published-moving-skill',
      description: 'Published moving capability',
      source: 'provider-b',
      content: 'BODY B',
    })
    await expect(context.skillFlux.mount(
      agent,
      candidateId('registry', 'provider-a', '', 'published-moving-skill'),
    )).rejects.toThrow('provider changed; search again')
    expect(context.skillFlux.mounted(agent)).toEqual([])
  })

  it('uses embeddings only to fill lexical routing gaps', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { input: string[] }
      return new Response(JSON.stringify({
        embeddings: request.input.map(text => {
          if (text.includes('calendar')) return [0, 1]
          return [1, 0]
        }),
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const context = await setup({
      maxActiveSkills: 1,
      routes: [],
      routerMode: 'hybrid',
      embeddingCandidateLimit: 8,
    })
    context.skills.register({
      name: 'ocr-reader',
      description: 'Extract printed words from images',
      source: 'runtime',
      content: 'OCR instructions.',
    })
    context.skills.register({
      name: 'calendar-agent',
      description: 'Manage calendar meetings and events',
      source: 'runtime',
      content: 'Calendar instructions.',
    })
    const agent = fakeAgent(context)
    const user = createUserMessage({
      content: [{ type: 'text', text: 'Make this scanned receipt searchable' }],
      source: { kind: 'user' },
    })
    await propose(context, agent, [user])
    expect(context.skillFlux.mounted(agent).map(skill => skill.name)).toEqual(['ocr-reader'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(context.skillFlux.embeddingStats()).toMatchObject({ requests: 1, cacheEntries: 3 })
  })

  it('does not call embeddings when lexical routing already fills the catalog', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const context = await setup({
      maxActiveSkills: 1,
      routes: [],
      routerMode: 'hybrid',
    })
    context.skills.register({
      name: 'pdf-reader',
      description: 'Read PDF documents',
      source: 'runtime',
      content: 'PDF instructions.',
    })
    const agent = fakeAgent(context)
    const user = createUserMessage({
      content: [{ type: 'text', text: 'Read this PDF' }],
      source: { kind: 'user' },
    })
    await propose(context, agent, [user])
    expect(context.skillFlux.mounted(agent).map(skill => skill.name)).toEqual(['pdf-reader'])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails open to lexical routing when the embedding endpoint is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })))
    const context = await setup({ routes: [], routerMode: 'hybrid' })
    context.skills.register({
      name: 'ocr-reader',
      description: 'Extract printed words from images',
      source: 'runtime',
      content: 'OCR instructions.',
    })
    const agent = fakeAgent(context)
    const user = createUserMessage({
      content: [{ type: 'text', text: 'Make this scanned receipt searchable' }],
      source: { kind: 'user' },
    })
    await expect(propose(context, agent, [user])).resolves.toMatchObject({ kind: 'enter' })
    expect(context.skillFlux.mounted(agent)).toEqual([])
  })
})
