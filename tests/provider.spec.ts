import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry, { type SkillCandidate, type SkillDefinition, type SkillProviderObservation } from '@deepseek-ai/dsh-skill'
import {
  SkillFluxProvider,
  SkillFluxProviderManager,
  SKILLFLUX_PROVIDER,
  SKILLFLUX_PROVIDER_RANK,
} from '../src/provider.js'
import { candidateId } from '../src/router.js'
import type { SkillFluxCandidate, SkillFluxCatalog } from '../src/types.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function remote(name: string, source: string, score = 90): SkillFluxCandidate {
  const ref = '4'.repeat(40)
  return {
    id: candidateId('remote', source, ref, name),
    origin: 'remote',
    name,
    skillId: name,
    description: `${name} capability`,
    source,
    ref,
    score,
    installs: 0,
    discoverySources: ['github'],
    qualityScore: 70,
    relevanceScore: 100,
    stars: 10,
    forks: 0,
    recentlyActive: true,
    trustedSource: false,
    trustLevel: 'community',
    qualityBreakdown: { relevance: 55, adoption: 0, repository: 5, freshness: 6, trust: 0, provenance: 4, total: 70 },
    qualitySignals: ['content-pinned'],
    qualityWarnings: [],
  }
}

function definition(name: string): SkillDefinition {
  return {
    name,
    description: `${name} capability`,
    invocation: { modelInvocable: true, userInvocable: false },
    source: 'skillflux',
    provider: 'skillflux',
    content: `${name} body`,
  }
}

async function setupRegistry(): Promise<Context> {
  const context = new Context()
  const fiber = context.plugin(SkillRegistry)
  await fiber.await()
  cleanups.push(fiber.dispose)
  return context
}

function fakeAgent(context: Context): Agent {
  const id = SessionId('skillflux-provider-test')
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd: '/workspace' })
  return {
    id, options: {}, session, status: 'running', ctx: context,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    send() {}, followup() {}, steer() {}, cancel() {},
    inject() { throw new Error('must not inject') },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  } satisfies Agent
}

describe('SkillFluxProvider', () => {
  it('lists metadata-only summaries with an immutable locator and an incomplete observation contract', async () => {
    const catalog: SkillFluxCatalog = {
      candidates: [remote('pdf-reader', 'owner/a'), remote('pdf-reader', 'owner/b')],
      complete: false,
    }
    const provider = new SkillFluxProvider({ signal: new AbortController().signal, invalidate: () => undefined }, {
      catalog: () => catalog,
      load: async () => definition('pdf-reader'),
    })
    const observation = await provider.list({}) as SkillProviderObservation
    expect(observation.complete).toBe(false)
    expect(observation.candidates).toHaveLength(1)
    const candidate = observation.candidates[0]!
    expect(candidate.name).toBe('pdf-reader')
    expect(candidate.provider).toBe(SKILLFLUX_PROVIDER)
    expect(candidate.invocation).toEqual({ modelInvocable: true, userInvocable: false })
    expect(candidate.rank).toBeGreaterThanOrEqual(SKILLFLUX_PROVIDER_RANK)
    expect('content' in candidate).toBe(false)
    expect(Object.isFrozen(candidate.locator)).toBe(true)
    expect(Object.isFrozen((candidate.locator as { candidates: readonly unknown[] }).candidates)).toBe(true)
  })

  it('loads through the same-name fallback chain and rejects foreign or stale locators', async () => {
    const catalog: SkillFluxCatalog = {
      candidates: [remote('pdf-reader', 'owner/a'), remote('pdf-reader', 'owner/b')],
      complete: true,
    }
    const load = vi.fn(async (chain: readonly SkillFluxCandidate[]) => definition(chain[0]!.name))
    const provider = new SkillFluxProvider({ signal: new AbortController().signal, invalidate: () => undefined }, {
      catalog: () => catalog,
      load,
    })
    const listed = await provider.list({}) as readonly SkillCandidate[]
    const winner = listed[0]!
    const loaded = await provider.get(winner, {})
    expect(loaded?.content).toBe('pdf-reader body')
    expect(load).toHaveBeenCalledTimes(1)
    expect(load.mock.calls[0]![0]).toHaveLength(2)

    const foreign = { ...winner, provider: 'other' }
    await expect(provider.get(foreign, {})).rejects.toThrow('candidate owned by')
    const stale = { ...winner, locator: { brand: 'unknown' } }
    await expect(provider.get(stale, {})).rejects.toThrow('locator is unknown or expired')
  })

  it('honours the caller and registration signals', async () => {
    const provider = new SkillFluxProvider({ signal: new AbortController().signal, invalidate: () => undefined }, {
      catalog: () => ({ candidates: [remote('pdf-reader', 'owner/a')], complete: true }),
      load: async () => definition('pdf-reader'),
    })
    const signal = new AbortController()
    signal.abort(new Error('caller aborted'))
    await expect(provider.list({ signal: signal.signal })).rejects.toThrow('caller aborted')
  })
})

describe('SkillFluxProviderManager', () => {
  it('registers an agent-scoped provider, resolves lazy loads, invalidates, and disposes', async () => {
    const context = await setupRegistry()
    const agent = fakeAgent(context)
    const candidate = remote('pdf-reader', 'owner/repo')
    let catalogCandidates: SkillFluxCandidate[] = [candidate]
    const warn = vi.fn()
    const load = vi.fn(async () => definition('pdf-reader'))
    const manager = new SkillFluxProviderManager(
      _agent => ({ catalog: () => ({ candidates: catalogCandidates, complete: true }), load }),
      warn,
    )
    expect(manager.register(agent)).toBe(true)

    const snapshot = await context.skills.snapshot({ scope: agent, cwd: '/workspace' })
    expect(snapshot.complete).toBe(true)
    expect(snapshot.skills.map(skill => skill.name)).toEqual(['pdf-reader'])

    const loaded = await manager.load(agent, 'pdf-reader')
    expect(loaded?.content).toBe('pdf-reader body')
    expect(load).toHaveBeenCalledWith([candidate], undefined)

    catalogCandidates = []
    manager.invalidate(agent)
    expect((await context.skills.snapshot({ scope: agent })).skills).toEqual([])

    manager.dispose(agent)
    expect(warn).not.toHaveBeenCalled()
    expect((await context.skills.snapshot({ scope: agent })).skills).toEqual([])
  })

  it('fails open on duplicate registration in one layer', async () => {
    const context = await setupRegistry()
    const first = fakeAgent(context)
    const second = fakeAgent(context)
    const warn = vi.fn()
    const manager = new SkillFluxProviderManager(() => ({ catalog: () => ({ candidates: [], complete: true }), load: async () => definition('x') }), warn)
    expect(manager.register(first)).toBe(true)
    expect(manager.register(second)).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('registration failed open')
  })
})
