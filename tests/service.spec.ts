import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { Session, SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { LockOptions } from 'proper-lockfile'
import SkillFluxService, { estimateCatalogTokens, UsageStore, type SkillFluxConfig } from '../src/index.js'
import PublishedSkillFluxService from '../lib/index.js'
import { candidateId } from '../src/router.js'
import type { CacheEntry, RemoteCandidate, SkillFluxCandidate } from '../src/types.js'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'

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

async function setup(
  overrides: SkillFluxConfig = {},
  plugin: Parameters<Context['plugin']>[0] = SkillFluxService,
): Promise<Context> {
  if (process.env.DSH_HOME === undefined) {
    const root = await mkdtemp(join(tmpdir(), 'skillflux-service-home-'))
    roots.push(root)
    vi.stubEnv('DSH_HOME', root)
  }
  const context = new Context()
  await mount(context, SystemPrompt)
  await mount(context, ToolRuntime)
  await mount(context, AgentRegistry)
  await mount(context, SkillRegistry)
  await mount(context, CommandRuntime)
  await mount(context, plugin, {
    maxActiveSkills: 3,
    remoteDiscovery: 'off',
    usageTracking: false,
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
  it('rejects adaptive routing when local usage tracking is disabled', async () => {
    await expect(setup({ usageTracking: false, adaptiveRouting: true })).rejects.toThrow(
      'adaptiveRouting requires usageTracking',
    )
  })

  it('rejects an invalid nonzero catalog token budget', async () => {
    await expect(setup({ catalogTokenBudget: 63 })).rejects.toThrow(
      'catalogTokenBudget must be an integer greater than or equal to 64',
    )
  })

  it('validates and normalizes remote quality discovery configuration', async () => {
    const context = await setup({
      remoteProviders: ['github', 'github'],
      remoteMinQualityScore: 60,
      remoteMinStars: 25,
      remoteRecentActivityDays: 30,
      remoteTrustedOwners: ['Anthropics', 'openai'],
      remoteCacheTtlMs: 60_000,
      remoteCacheStaleIfErrorMs: 600_000,
      remoteCacheMaxEntries: 25,
    })
    expect(context.skillFlux.config).toMatchObject({
      remoteProviders: ['github'],
      remoteMinQualityScore: 60,
      remoteMinStars: 25,
      remoteRecentActivityDays: 30,
      remoteTrustedOwners: ['anthropics', 'openai'],
      remoteCacheTtlMs: 60_000,
      remoteCacheStaleIfErrorMs: 600_000,
      remoteCacheMaxEntries: 25,
    })
    await expect(setup({ remoteProviders: [] })).rejects.toThrow('remoteProviders must contain at least one')
    await expect(setup({ remoteMinQualityScore: 101 })).rejects.toThrow('remoteMinQualityScore')
    await expect(setup({ remoteTrustedOwners: ['bad/owner'] })).rejects.toThrow('invalid GitHub owner')
    await expect(setup({ remoteCacheTtlMs: -1 })).rejects.toThrow('remoteCacheTtlMs')
    await expect(setup({ remoteCacheMaxEntries: 1_001 })).rejects.toThrow('remoteCacheMaxEntries')
  })

  it('reports and clears the persistent remote discovery cache', async () => {
    const context = await setup()
    const agent = fakeAgent(context)
    const status = await context.commands.execute(
      agent,
      '/skillflux discovery-cache status',
      [],
      new AbortController().signal,
    )
    expect(status?.result.text).toContain('enabled, 0/100 entries')
    const cleaned = await context.commands.execute(
      agent,
      '/skillflux discovery-cache clean',
      [],
      new AbortController().signal,
    )
    expect(cleaned?.result.text).toBe('Removed 0 remote discovery cache entries.')
  })

  it('validates and reports installed cache governance configuration', async () => {
    const context = await setup({
      cacheAutoPrune: false,
      cacheMaxEntries: 25,
      cacheMaxTotalBytes: 1_048_576,
      cacheMaxIdleDays: 0,
    })
    expect(context.skillFlux.config).toMatchObject({
      cacheAutoPrune: false,
      cacheMaxEntries: 25,
      cacheMaxTotalBytes: 1_048_576,
      cacheMaxIdleDays: 0,
    })
    const agent = fakeAgent(context)
    const status = await context.commands.execute(agent, '/skillflux status', [], new AbortController().signal)
    expect(status?.result.text).toContain('Installed Skill cache: 0/25 entries, 0/1048576 bytes; auto prune off; idle limit off.')
    const pruned = await context.commands.execute(agent, '/skillflux cache prune', [], new AbortController().signal)
    expect(pruned?.result.text).toBe('SkillFlux cache prune removed 0 entries; 0 entries and 0 bytes remain.')
    await expect(setup({ cacheMaxEntries: 0 })).rejects.toThrow('cacheMaxEntries')
    await expect(setup({ cacheMaxTotalBytes: 0 })).rejects.toThrow('cacheMaxTotalBytes')
    await expect(setup({ cacheMaxIdleDays: -1 })).rejects.toThrow('cacheMaxIdleDays')
  })

  it('serializes cache maintenance against in-flight cache loads', async () => {
    const context = await setup()
    const internals = context.skillFlux as unknown as {
      cache: { prune: (...args: unknown[]) => Promise<unknown> }
      acquireCacheLease: () => Promise<() => Promise<void>>
      pruneCache: () => Promise<unknown>
    }
    const emptyPlan = {
      decisions: [], protected: [], beforeEntries: 0, beforeBytes: 0, afterEntries: 0, afterBytes: 0,
    }
    const releaseLoad = await internals.acquireCacheLease()
    const prune = vi.spyOn(internals.cache, 'prune').mockResolvedValue(emptyPlan)
    const waitingPrune = internals.pruneCache()
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(prune).not.toHaveBeenCalled()
    await releaseLoad()
    await waitingPrune
    expect(prune).toHaveBeenCalledOnce()

    let finishMaintenance: (() => void) | undefined
    prune.mockImplementation(async () => await new Promise(resolve => {
      finishMaintenance = () => { resolve(emptyPlan) }
    }))
    const activePrune = internals.pruneCache()
    await vi.waitFor(() => { expect(finishMaintenance).toBeDefined() })
    let leaseAcquired = false
    const waitingLease = internals.acquireCacheLease().then(release => {
      leaseAcquired = true
      return release
    })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(leaseAcquired).toBe(false)
    finishMaintenance?.()
    await activePrune
    const releaseWaitingLoad = await waitingLease
    expect(leaseAcquired).toBe(true)
    await releaseWaitingLoad()
  })

  it('serializes cache operations across service instances sharing DSH_HOME', async () => {
    const first = await setup()
    const second = await setup()
    const firstInternals = first.skillFlux as unknown as { acquireCacheLease: () => Promise<() => Promise<void>> }
    const secondInternals = second.skillFlux as unknown as { acquireCacheLease: () => Promise<() => Promise<void>> }
    const releaseFirst = await firstInternals.acquireCacheLease()
    let secondAcquired = false
    const waitingSecond = secondInternals.acquireCacheLease().then(release => {
      secondAcquired = true
      return release
    })
    await new Promise(resolve => { setTimeout(resolve, 50) })
    expect(secondAcquired).toBe(false)
    await releaseFirst()
    const releaseSecond = await waitingSecond
    expect(secondAcquired).toBe(true)
    await releaseSecond()
  })

  it('makes the real Service lease wait for a child process holding the cache lock', async () => {
    const context = await setup()
    const cacheRoot = join(process.env.DSH_HOME!, 'cache', 'skillflux')
    const child = spawn(process.execPath, [
      fileURLToPath(new URL('./fixtures/cache-process-worker.mjs', import.meta.url)),
      'lock',
      cacheRoot,
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    const exited = once(child, 'exit')
    try {
      child.stdout.setEncoding('utf8')
      await new Promise<void>((resolve, reject) => {
        let output = ''
        const timeout = setTimeout(() => { reject(new Error(`child lock did not start: ${output}`)) }, 5_000)
        child.stdout.on('data', chunk => {
          output += String(chunk)
          if (!output.includes('LOCKED')) return
          clearTimeout(timeout)
          resolve()
        })
        child.once('error', error => {
          clearTimeout(timeout)
          reject(error)
        })
      })
      const internals = context.skillFlux as unknown as {
        acquireCacheLease: () => Promise<() => Promise<void>>
      }
      let acquired = false
      const waiting = internals.acquireCacheLease().then(release => {
        acquired = true
        return release
      })
      await new Promise(resolve => { setTimeout(resolve, 100) })
      expect(acquired).toBe(false)
      child.stdin.end('\n')
      await exited
      const release = await waiting
      expect(acquired).toBe(true)
      await release()
    } finally {
      if (!child.killed) child.kill()
    }
  })

  it('turns a compromised process lock into a maintenance failure without throwing from its callback', async () => {
    const context = await setup({ cacheAutoPrune: false })
    let compromise: ((error: Error) => unknown) | undefined
    let markPruneStarted!: () => void
    const pruneStarted = new Promise<void>(resolve => { markPruneStarted = resolve })
    const internals = context.skillFlux as unknown as {
      cacheProcessLock: (file: string, options?: LockOptions) => Promise<() => Promise<void>>
      cache: { prune: (...args: unknown[]) => Promise<unknown> }
      pruneCache: () => Promise<unknown>
    }
    internals.cacheProcessLock = async (_file, options) => {
      compromise = options?.onCompromised
      return async () => undefined
    }
    internals.cache.prune = async (...args) => {
      const signal = args[4] as AbortSignal
      markPruneStarted()
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
      })
      throw new Error('unreachable')
    }
    const pending = internals.pruneCache()
    await pruneStarted
    expect(() => { compromise?.(new Error('lock heartbeat lost')) }).not.toThrow()
    await expect(pending).rejects.toThrow('lock heartbeat lost')
  })

  it('retries an abandoned active-marker cleanup before the next maintenance run', async () => {
    const context = await setup({ cacheAutoPrune: false })
    let attempts = 0
    const cleanup = vi.fn(async () => {
      attempts += 1
      if (attempts <= 3) throw new Error('marker is temporarily busy')
    })
    const emptyPlan = {
      decisions: [], protected: [], beforeEntries: 0, beforeBytes: 0, afterEntries: 0, afterBytes: 0,
    }
    const internals = context.skillFlux as unknown as {
      pendingActiveLeaseCleanups: Set<() => Promise<void>>
      trackActiveLeaseCleanup: (operation: () => Promise<void>) => Promise<void>
      cache: { prune: (...args: unknown[]) => Promise<unknown> }
      pruneCache: () => Promise<unknown>
    }
    await internals.trackActiveLeaseCleanup(cleanup)
    expect(cleanup).toHaveBeenCalledTimes(3)
    expect(internals.pendingActiveLeaseCleanups.size).toBe(1)
    internals.cache.prune = async () => emptyPlan
    await internals.pruneCache()
    expect(cleanup).toHaveBeenCalledTimes(4)
    expect(internals.pendingActiveLeaseCleanups.size).toBe(0)
  })

  it('automatically governs after a remote mount and again after turn cleanup', async () => {
    const context = await setup({ cacheAutoPrune: true })
    const agent = fakeAgent(context)
    const ref = 'd'.repeat(40)
    const cacheId = 'e'.repeat(24)
    const candidate: RemoteCandidate = {
      id: candidateId('remote', 'owner/auto', ref, 'auto-skill'),
      origin: 'remote',
      name: 'auto-skill',
      description: 'Automatic governance fixture',
      source: 'owner/auto',
      ref,
      score: 100,
      skillId: 'auto-skill',
      installs: 0,
      discoverySources: ['github'],
      qualityScore: 50,
      relevanceScore: 100,
      stars: 0,
      forks: 0,
      recentlyActive: true,
      trustedSource: false,
    }
    const entry: CacheEntry = {
      directory: '/cache/auto-skill',
      manifest: {
        version: 1,
        cacheId,
        source: candidate.source,
        ref,
        skillId: candidate.skillId,
        name: candidate.name,
        description: candidate.description,
        installedAt: new Date().toISOString(),
        fileCount: 1,
        totalBytes: 100,
        contentHash: 'f'.repeat(64),
      },
    }
    const definition: SkillDefinition = {
      name: candidate.name,
      description: candidate.description,
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'runtime',
      provider: 'skillflux-cache',
      content: 'AUTO BODY',
    }
    const internals = context.skillFlux as unknown as {
      cache: {
        install: () => Promise<CacheEntry>
        load: () => Promise<SkillDefinition>
        createActiveLease: () => Promise<() => Promise<void>>
        prune: () => Promise<unknown>
      }
      state: (target: Agent) => { candidates: Map<string, SkillFluxCandidate> }
    }
    vi.spyOn(internals.cache, 'install').mockResolvedValue(entry)
    vi.spyOn(internals.cache, 'load').mockResolvedValue(definition)
    vi.spyOn(internals.cache, 'createActiveLease').mockResolvedValue(async () => undefined)
    const prune = vi.spyOn(internals.cache, 'prune').mockResolvedValue({
      decisions: [], protected: [cacheId], beforeEntries: 1, beforeBytes: 100, afterEntries: 1, afterBytes: 100,
    })
    internals.state(agent).candidates.set(candidate.id, candidate)
    await context.skillFlux.mount(agent, candidate.id)
    await vi.waitFor(() => { expect(prune).toHaveBeenCalledTimes(1) })

    context.emit(scopeTarget(agent.session, undefined), 'session/event', agent.session, {
      type: 'turn/end',
      seq: 1,
      time: 1,
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    await vi.waitFor(() => { expect(prune).toHaveBeenCalledTimes(2) })
  })

  it('does not schedule automatic governance when it is disabled', async () => {
    const context = await setup({ cacheAutoPrune: false })
    const internals = context.skillFlux as unknown as {
      scheduleAutoPrune: () => void
      cache: { prune: () => Promise<unknown> }
    }
    const prune = vi.spyOn(internals.cache, 'prune')
    internals.scheduleAutoPrune()
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(prune).not.toHaveBeenCalled()
  })

  it('schedules post-cleanup governance when an agent is disposed without turn/end', async () => {
    const context = await setup({ cacheAutoPrune: true })
    const agent = fakeAgent(context)
    const internals = context.skillFlux as unknown as {
      state: (target: Agent) => unknown
      disposeAgent: (target: Agent) => void
      cachePruneSessions: WeakSet<Session>
      scheduleAutoPrune: () => void
    }
    internals.state(agent)
    internals.cachePruneSessions.add(agent.session)
    const schedule = vi.spyOn(internals, 'scheduleAutoPrune').mockImplementation(() => undefined)
    internals.disposeAgent(agent)
    expect(schedule).toHaveBeenCalledOnce()
    expect(internals.cachePruneSessions.has(agent.session)).toBe(false)
  })

  it('rejects a mount disposed while its process lock is being released', async () => {
    const context = await setup({ routes: [] })
    const agent = fakeAgent(context)
    const ref = '4'.repeat(40)
    const cacheId = '5'.repeat(24)
    const candidate: SkillFluxCandidate = {
      id: candidateId('cache', 'owner/release-race', ref, 'release-race'),
      origin: 'cache',
      name: 'release-race',
      description: 'Release lifecycle fixture',
      source: 'owner/release-race',
      ref,
      score: 100,
      cacheId,
    }
    const entry: CacheEntry = {
      directory: '/cache/release-race',
      manifest: {
        version: 1,
        cacheId,
        source: candidate.source,
        ref,
        skillId: candidate.name,
        name: candidate.name,
        description: candidate.description,
        installedAt: '2026-08-22T00:00:00.000Z',
        fileCount: 1,
        totalBytes: 10,
        contentHash: '6'.repeat(64),
      },
    }
    let finishRelease!: () => void
    let markReleaseStarted!: () => void
    const releaseStarted = new Promise<void>(resolve => { markReleaseStarted = resolve })
    const releaseGate = new Promise<void>(resolve => { finishRelease = resolve })
    let releaseCalled = false
    const internals = context.skillFlux as unknown as {
      state: (target: Agent) => { candidates: Map<string, SkillFluxCandidate> }
      disposeAgent: (target: Agent) => void
      acquireCacheLease: () => Promise<() => Promise<void>>
      cache: {
        get: () => Promise<CacheEntry>
        load: () => Promise<SkillDefinition>
        createActiveLease: () => Promise<() => Promise<void>>
      }
    }
    internals.state(agent).candidates.set(candidate.id, candidate)
    internals.cache.get = async () => entry
    internals.cache.load = async () => ({
      name: candidate.name,
      description: candidate.description,
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'runtime',
      provider: 'skillflux-cache',
      content: 'RELEASE BODY',
    })
    internals.cache.createActiveLease = async () => async () => undefined
    internals.acquireCacheLease = async () => async () => {
      if (releaseCalled) return
      releaseCalled = true
      markReleaseStarted()
      await releaseGate
    }
    const pending = context.skillFlux.mount(agent, candidate.id)
    await releaseStarted
    internals.disposeAgent(agent)
    finishRelease()
    await expect(pending).rejects.toThrow('lifecycle ended')
  })

  it('rolls back a mounted Skill when only its signal aborts during process-lock release', async () => {
    const context = await setup({ routes: [], usageTracking: true })
    const agent = fakeAgent(context)
    const ref = '7'.repeat(40)
    const cacheId = '8'.repeat(24)
    const candidate: SkillFluxCandidate = {
      id: candidateId('cache', 'owner/abort-race', ref, 'abort-race'),
      origin: 'cache',
      name: 'abort-race',
      description: 'Abort lifecycle fixture',
      source: 'owner/abort-race',
      ref,
      score: 100,
      cacheId,
    }
    const entry: CacheEntry = {
      directory: '/cache/abort-race',
      manifest: {
        version: 1,
        cacheId,
        source: candidate.source,
        ref,
        skillId: candidate.name,
        name: candidate.name,
        description: candidate.description,
        installedAt: '2026-08-22T00:00:00.000Z',
        fileCount: 1,
        totalBytes: 10,
        contentHash: '9'.repeat(64),
      },
    }
    let finishRelease!: () => void
    let markReleaseStarted!: () => void
    const releaseStarted = new Promise<void>(resolve => { markReleaseStarted = resolve })
    const releaseGate = new Promise<void>(resolve => { finishRelease = resolve })
    let releaseCalled = false
    const releaseMarker = vi.fn(async () => undefined)
    const internals = context.skillFlux as unknown as {
      state: (target: Agent) => { candidates: Map<string, SkillFluxCandidate> }
      acquireCacheLease: () => Promise<() => Promise<void>>
      cache: {
        get: () => Promise<CacheEntry>
        load: () => Promise<SkillDefinition>
        createActiveLease: () => Promise<() => Promise<void>>
      }
    }
    internals.state(agent).candidates.set(candidate.id, candidate)
    internals.cache.get = async () => entry
    internals.cache.load = async () => ({
      name: candidate.name,
      description: candidate.description,
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'runtime',
      provider: 'skillflux-cache',
      content: 'ABORT BODY',
    })
    internals.cache.createActiveLease = async () => releaseMarker
    internals.acquireCacheLease = async () => async () => {
      if (releaseCalled) return
      releaseCalled = true
      markReleaseStarted()
      await releaseGate
    }
    const controller = new AbortController()
    const pending = context.skillFlux.mount(agent, candidate.id, controller.signal)
    await releaseStarted
    controller.abort()
    finishRelease()
    await expect(pending).rejects.toThrow()
    expect(context.skillFlux.mounted(agent)).toEqual([])
    expect(context.skillFlux.lastRouting(agent)).toEqual([])
    await expect(context.skills.get(candidate.name, { scope: agent })).resolves.toBeUndefined()
    expect(releaseMarker).toHaveBeenCalledOnce()
    expect(await context.skillFlux.usageRecords()).toEqual([])
  })

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

  it('rolls back a persistent cache lease when lifecycle ends during lease creation', async () => {
    const context = await setup({ routes: [] })
    const cached: CacheEntry = {
      directory: '/cache/lease-race',
      manifest: {
        version: 1,
        cacheId: '1'.repeat(24),
        source: 'cached/repo',
        ref: '2'.repeat(40),
        skillId: 'lease-race',
        name: 'lease-race',
        description: 'Lease lifecycle fixture',
        installedAt: '2026-08-22T00:00:00.000Z',
        fileCount: 1,
        totalBytes: 10,
        contentHash: '3'.repeat(64),
      },
    }
    let finishLease!: (release: () => Promise<void>) => void
    let markLeaseStarted!: () => void
    const leaseStarted = new Promise<void>(resolve => { markLeaseStarted = resolve })
    const leaseResult = new Promise<() => Promise<void>>(resolve => { finishLease = resolve })
    let releaseAttempts = 0
    const releaseMarker = vi.fn(async () => {
      releaseAttempts += 1
      if (releaseAttempts <= 3) throw new Error('lease marker is busy')
    })
    const internals = context.skillFlux as unknown as {
      pendingActiveLeaseCleanups: Set<() => Promise<void>>
      cache: {
        list: () => Promise<CacheEntry[]>
        get: () => Promise<CacheEntry>
        load: () => Promise<SkillDefinition>
        createActiveLease: () => Promise<() => Promise<void>>
        prune: () => Promise<unknown>
      }
    }
    const cache = internals.cache
    cache.list = async () => [cached]
    cache.get = async () => cached
    cache.load = async () => ({
      name: cached.manifest.name,
      description: cached.manifest.description,
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'runtime',
      provider: 'skillflux-cache',
      content: 'LEASE BODY',
    })
    cache.createActiveLease = async () => {
      markLeaseStarted()
      return await leaseResult
    }
    const agent = fakeAgent(context)
    await context.tools.execute({
      callId: CallId('skillflux-search-lease-race'),
      name: 'skillflux_search',
      arguments: { query: 'lease-race', remote: false },
      agent,
      signal: new AbortController().signal,
    })
    const register = vi.spyOn(context.skills, 'register')
    const pending = context.skillFlux.mount(
      agent,
      candidateId('cache', cached.manifest.source, cached.manifest.ref, cached.manifest.skillId),
    )
    await leaseStarted
    ;(context.skillFlux as unknown as { disposeAgent: (disposed: Agent) => void }).disposeAgent(agent)
    finishLease(releaseMarker)
    await expect(pending).rejects.toThrow('lifecycle ended')
    expect(releaseMarker).toHaveBeenCalledTimes(3)
    expect(internals.pendingActiveLeaseCleanups.size).toBe(1)
    expect(register).not.toHaveBeenCalled()
    cache.prune = async () => ({
      decisions: [], protected: [], beforeEntries: 0, beforeBytes: 0, afterEntries: 0, afterBytes: 0,
    })
    await context.skillFlux.pruneCache()
    expect(releaseMarker).toHaveBeenCalledTimes(4)
    expect(internals.pendingActiveLeaseCleanups.size).toBe(0)
  })

  it('queues marker cleanup retries when runtime Skill registration fails', async () => {
    const context = await setup({ routes: [] })
    const agent = fakeAgent(context)
    const ref = '3'.repeat(40)
    const cacheId = '4'.repeat(24)
    const candidate: SkillFluxCandidate = {
      id: candidateId('cache', 'cached/register-failure', ref, 'register-failure'),
      origin: 'cache',
      name: 'register-failure',
      description: 'Registration failure fixture',
      source: 'cached/register-failure',
      ref,
      cacheId,
      score: 10,
    }
    const entry: CacheEntry = {
      directory: '/cache/register-failure',
      manifest: {
        version: 1,
        cacheId,
        source: candidate.source,
        ref,
        skillId: candidate.name,
        name: candidate.name,
        description: candidate.description,
        installedAt: '2026-08-22T00:00:00.000Z',
        fileCount: 1,
        totalBytes: 10,
        contentHash: '5'.repeat(64),
      },
    }
    let releaseAttempts = 0
    const releaseMarker = vi.fn(async () => {
      releaseAttempts += 1
      if (releaseAttempts <= 3) throw new Error('lease marker is busy')
    })
    const internals = context.skillFlux as unknown as {
      state: (target: Agent) => { candidates: Map<string, SkillFluxCandidate> }
      pendingActiveLeaseCleanups: Set<() => Promise<void>>
      cache: {
        get: () => Promise<CacheEntry>
        load: () => Promise<SkillDefinition>
        createActiveLease: () => Promise<() => Promise<void>>
        prune: () => Promise<unknown>
      }
    }
    internals.state(agent).candidates.set(candidate.id, candidate)
    internals.cache.get = async () => entry
    internals.cache.load = async () => ({
      name: candidate.name,
      description: candidate.description,
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'runtime',
      provider: 'skillflux-cache',
      content: 'REGISTER FAILURE BODY',
    })
    internals.cache.createActiveLease = async () => releaseMarker
    vi.spyOn(context.skills, 'register').mockImplementation(() => { throw new Error('registration failed') })
    await expect(context.skillFlux.mount(agent, candidate.id)).rejects.toThrow('registration failed')
    expect(releaseMarker).toHaveBeenCalledTimes(3)
    expect(internals.pendingActiveLeaseCleanups.size).toBe(1)
    internals.cache.prune = async () => ({
      decisions: [], protected: [], beforeEntries: 0, beforeBytes: 0, afterEntries: 0, afterBytes: 0,
    })
    await context.skillFlux.pruneCache()
    expect(releaseMarker).toHaveBeenCalledTimes(4)
    expect(internals.pendingActiveLeaseCleanups.size).toBe(0)
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

  it('keeps a detached explanation of the latest routing decision after turn cleanup', async () => {
    const context = await setup({ maxActiveSkills: 1, routes: [] })
    context.skills.register({
      name: 'pdf-reader',
      description: 'Read PDF documents',
      source: 'runtime',
      content: 'PDF instructions.',
    })
    const agent = fakeAgent(context)
    const user = createUserMessage({
      content: [{ type: 'text', text: 'Read this PDF document' }],
      source: { kind: 'user' },
    })
    await propose(context, agent, [user])
    const trace = context.skillFlux.lastRouting(agent)
    expect(trace).toMatchObject([{
      name: 'pdf-reader',
      selection: 'lexical',
      outcome: 'mounted',
      adaptiveBoost: 0,
      origin: 'registry',
    }])
    expect(trace[0]?.baseScore).toBeGreaterThanOrEqual(8)
    ;(trace[0] as unknown as { name: string }).name = 'changed'
    expect(context.skillFlux.lastRouting(agent)[0]?.name).toBe('pdf-reader')
    const explained = await context.commands.execute(
      agent,
      '/skillflux explain',
      [],
      new AbortController().signal,
    )
    expect(explained?.result).toMatchObject({ kind: 'success' })
    expect(explained?.result.text).toContain('pdf-reader [lexical, mounted]')
    const usage = await context.commands.execute(
      agent,
      '/skillflux usage',
      [],
      new AbortController().signal,
    )
    expect(usage?.result.text).toBe('SkillFlux usage tracking is disabled.')

    context.emit(scopeTarget(agent.session, undefined), 'session/event', agent.session, {
      type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } },
    })
    expect(context.skillFlux.mounted(agent)).toEqual([])
    expect(context.skillFlux.lastRouting(agent)[0]?.name).toBe('pdf-reader')
  })

  it('persists only bounded candidate usage metadata after successful loads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillflux-service-usage-'))
    roots.push(root)
    vi.stubEnv('DSH_HOME', root)
    const context = await setup({ maxActiveSkills: 1, routes: [], usageTracking: true })
    context.skills.register({
      name: 'pdf-reader',
      description: 'Read PDF documents',
      source: 'runtime',
      content: 'PRIVATE SKILL INSTRUCTIONS',
    })
    const agent = fakeAgent(context)
    const task = 'PRIVATE USER TASK: read this PDF'
    const user = createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } })
    await propose(context, agent, [user])
    expect(await context.skillFlux.usageRecords()).toMatchObject([{ mounts: 1, uses: 0, name: 'pdf-reader' }])

    const loaded = await context.tools.execute({
      callId: CallId('skillflux-usage-load'),
      name: 'skill',
      arguments: { name: 'pdf-reader' },
      agent,
      signal: new AbortController().signal,
    })
    expect(loaded.isError).toBe(false)
    expect(await context.skillFlux.usageRecords()).toMatchObject([{ mounts: 1, uses: 1, name: 'pdf-reader' }])
    const raw = await readFile(join(root, 'storages', 'skillflux', 'usage.json'), 'utf8')
    expect(raw).not.toContain(task)
    expect(raw).not.toContain('PRIVATE SKILL INSTRUCTIONS')

    const usage = await context.commands.execute(agent, '/skillflux usage', [], new AbortController().signal)
    expect(usage?.result.text).toContain('uses 1, mounts 1')
  })

  it('enforces an opt-in catalog token budget and explains skipped candidates', async () => {
    const descriptions = [
      { name: 'first-skill', description: 'Analyze PDF documents' },
      { name: 'second-skill', description: 'Analyze PDF documents' },
    ]
    const oneSkillBudget = estimateCatalogTokens(descriptions.slice(0, 1), 160)
    expect(estimateCatalogTokens(descriptions, 160)).toBeGreaterThan(oneSkillBudget)
    const context = await setup({
      maxActiveSkills: 3,
      routes: [],
      usageTracking: false,
      catalogTokenBudget: oneSkillBudget,
    })
    for (const skill of descriptions) {
      context.skills.register({
        ...skill,
        whenToUse: 'Analyze PDF documents',
        source: 'runtime',
        content: `${skill.name} instructions`,
      })
    }
    const agent = fakeAgent(context)
    const user = createUserMessage({
      content: [{ type: 'text', text: 'Analyze this PDF document' }],
      source: { kind: 'user' },
    })
    await propose(context, agent, [user])

    expect(context.skillFlux.mounted(agent).map(skill => skill.name)).toEqual(['first-skill'])
    expect(context.skillFlux.catalogStats(agent)).toEqual({
      mountedSkills: 1,
      estimatedTokens: oneSkillBudget,
      budget: oneSkillBudget,
    })
    expect(context.skillFlux.lastRouting(agent)).toMatchObject([
      { name: 'first-skill', outcome: 'mounted' },
      { name: 'second-skill', outcome: 'budget-skipped' },
    ])
    const status = await context.commands.execute(agent, '/skillflux status', [], new AbortController().signal)
    expect(status?.result.text).toContain(`~${oneSkillBudget} estimated tokens; budget ${oneSkillBudget}`)

    await context.tools.execute({
      callId: CallId('skillflux-budget-search'),
      name: 'skillflux_search',
      arguments: { query: 'second-skill', remote: false },
      agent,
      signal: new AbortController().signal,
    })
    await expect(context.skillFlux.mount(
      agent,
      candidateId('registry', 'runtime', '', 'second-skill'),
    )).rejects.toThrow('exceeds token budget')
  })

  it('applies persisted adaptive history only to lexically relevant candidates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillflux-service-adaptive-'))
    roots.push(root)
    vi.stubEnv('DSH_HOME', root)
    const experiencedId = candidateId('registry', 'runtime', '', 'second-skill')
    const store = new UsageStore({
      file: join(root, 'storages', 'skillflux', 'usage.json'),
      maxEntries: 100,
    })
    const experienced = {
      candidateId: experiencedId,
      name: 'second-skill',
      origin: 'registry' as const,
      source: 'runtime',
    }
    await store.recordUse(experienced)
    await store.recordUse(experienced)

    const context = await setup({
      maxActiveSkills: 1,
      routes: [],
      usageTracking: true,
      adaptiveRouting: true,
      minRouteScore: 8,
    })
    for (const name of ['first-skill', 'second-skill']) {
      context.skills.register({
        name,
        description: 'Analyze PDF documents',
        whenToUse: 'Analyze PDF documents',
        source: 'runtime',
        content: `${name} instructions`,
      })
    }
    context.skills.register({
      name: 'frequent-travel',
      description: 'Book airline tickets',
      source: 'runtime',
      content: 'Travel instructions',
    })
    const agent = fakeAgent(context)
    const user = createUserMessage({
      content: [{ type: 'text', text: 'Analyze this PDF document' }],
      source: { kind: 'user' },
    })
    await propose(context, agent, [user])
    expect(context.skillFlux.mounted(agent).map(skill => skill.name)).toEqual(['second-skill'])
    expect(context.skillFlux.lastRouting(agent)[0]).toMatchObject({
      name: 'second-skill', selection: 'lexical', outcome: 'mounted', adaptiveBoost: 2,
    })
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
