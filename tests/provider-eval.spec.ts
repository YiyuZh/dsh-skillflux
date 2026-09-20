import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillFluxService, { SkillCache, type RemoteCandidateVerifier, type SkillFluxConfig } from '../src/index.js'
import { candidateId } from '../src/router.js'
import type { ApprovalPolicy, RemoteCandidate, SkillFluxCatalog } from '../src/types.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.unstubAllEnvs()
})

function remoteCandidate(name: string, source: string, skillId: string, score = 90): RemoteCandidate {
  const ref = '4'.repeat(40)
  return {
    id: candidateId('remote', source, ref, skillId),
    name, skillId, origin: 'remote', source, ref,
    description: `${name} capability`, score, installs: 0,
    selection: 'remote-quality', discoverySources: ['github'], qualityScore: 70,
    relevanceScore: 100, stars: 10, forks: 0, recentlyActive: true,
    trustedSource: false, trustLevel: 'community',
    qualityBreakdown: { relevance: 55, adoption: 0, repository: 5, freshness: 6, trust: 0, provenance: 4, total: 70 },
    qualitySignals: ['content-pinned'], qualityWarnings: [],
  }
}

function fakeAgent(context: Context, label: string): Agent {
  const id = SessionId(`skillflux-provider-eval-${label}`)
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd: '/workspace' })
  return {
    id, options: {}, session, status: 'running', ctx: context,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    send() {}, followup() {}, steer() {}, cancel() {},
    inject() { throw new Error('must not inject during routing') },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  } satisfies Agent
}

async function boot(context: Context, config: SkillFluxConfig): Promise<void> {
  const fiber = context.plugin(SkillFluxService, {
    routes: [], usageTracking: false, cacheAutoPrune: false,
    remoteDiscovery: 'automatic', approvalPolicy: 'automatic',
    remoteSearchLimit: 5, remoteAutoMountLimit: 3,
    ...config,
  })
  await fiber.await()
  cleanups.push(fiber.dispose)
}

interface FixtureOptions {
  approvalPolicy?: ApprovalPolicy
  candidates?: RemoteCandidate[]
  runInstaller?: NonNullable<ConstructorParameters<typeof SkillCache>[0]['runInstaller']>
}

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'skillflux-provider-eval-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('DSH_HOME', root)
  const context = new Context()
  for (const plugin of [SystemPrompt, ToolRuntime, AgentRegistry, SkillRegistry, CommandRuntime]) {
    const fiber = context.plugin(plugin)
    await fiber.await()
    cleanups.push(fiber.dispose)
  }
  await boot(context, { approvalPolicy: options.approvalPolicy ?? 'automatic' })
  const agent = fakeAgent(context, 'single')
  const candidates: RemoteCandidate[] = options.candidates ?? [
    remoteCandidate('pdf-reader', 'owner/repo', 'pdf-reader'),
  ]
  const markdown = candidates.map(candidate => `---\nname: ${candidate.name}\ndescription: ${candidate.description}\n---\nInstructions from ${candidate.source}.\n`)
  const internals = context.skillFlux as unknown as {
    cache: SkillCache
    remote: { searchWithStatus: (query: string, signal?: AbortSignal) => Promise<{ candidates: RemoteCandidate[]; complete: boolean }> }
    state: (target: Agent) => { candidates: Map<string, RemoteCandidate>; published: SkillFluxCatalog }
    trustedBySession: WeakMap<Session, Set<string>>
  }
  const attempts: number[] = []
  let installing = -1
  const verify = vi.fn<RemoteCandidateVerifier>(async (candidate) => {
    installing = candidates.findIndex(item => item.source === candidate.source && item.ref === candidate.ref)
    attempts.push(installing)
    return { path: `skills/${candidate.skillId}/SKILL.md`, skillFileHash: createHash('sha256').update(markdown[installing]!).digest('hex') }
  })
  internals.cache = new SkillCache({
    root: internals.cache.root, maxFiles: 10, maxBytes: 100_000,
    installTimeoutMs: context.skillFlux.config.installTimeoutMs,
    verifyCandidate: verify,
    runInstaller: options.runInstaller ?? (async invocation => {
      const skillIndex = invocation.args.indexOf('--skill')
      const name = invocation.args[skillIndex + 1]
      if (typeof name !== 'string') throw new Error('installer invocation omitted --skill')
      const directory = join(invocation.cwd, '.agents', 'skills', name)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'SKILL.md'), markdown[installing]!)
    }),
  })
  vi.spyOn(internals.remote, 'searchWithStatus').mockResolvedValue({ candidates, complete: true })
  const propose = (target: Agent, task: string, turn = 1) => {
    const messages = [createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } })]
    return agentEvents(context, target).waterfall(
      'agent/pre-step', { messages, turn, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages }),
    )
  }
  const callSkill = (target: Agent, name: string, signal = new AbortController().signal) => context.tools.execute({
    callId: CallId(`lazy-${name}`), name: 'skill', arguments: { name }, agent: target, signal,
  })
  const endTurn = () => context.emit(scopeTarget(agent.session, undefined), 'session/event', agent.session, {
    type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } },
  })
  return { context, agent, candidates, attempts, internals, verify, markdown, propose, callSkill, endTurn }
}

describe('provider-native lazy runtime evaluation', () => {
  it('defers download until the model loads the skill and verifies exactly once', async () => {
    const f = await fixture()
    await f.propose(f.agent, 'Read the tables in this PDF')
    expect(f.verify).not.toHaveBeenCalled()
    expect(f.context.skillFlux.mounted(f.agent)).toEqual([])

    const first = await f.callSkill(f.agent, 'pdf-reader')
    expect(first.isError).toBe(false)
    expect(JSON.stringify(first)).toContain('owner/repo')
    expect(f.verify).toHaveBeenCalledTimes(1)

    const second = await f.callSkill(f.agent, 'pdf-reader')
    expect(second.isError).toBe(false)
    expect(f.verify).toHaveBeenCalledTimes(1)
  })

  it('isolates published catalogs across concurrent agents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillflux-provider-concurrent-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    vi.stubEnv('DSH_HOME', root)
    const context = new Context()
    for (const plugin of [SystemPrompt, ToolRuntime, AgentRegistry, SkillRegistry, CommandRuntime]) {
      const fiber = context.plugin(plugin)
      await fiber.await()
      cleanups.push(fiber.dispose)
    }
    await boot(context, {})
    const first = fakeAgent(context, 'first')
    const second = fakeAgent(context, 'second')
    const pdf = remoteCandidate('pdf-reader', 'owner/pdf', 'pdf-reader')
    const sheets = remoteCandidate('sheet-helper', 'owner/sheets', 'sheet-helper')
    const remote = (context.skillFlux as unknown as {
      remote: { searchWithStatus: (query: string) => Promise<{ candidates: RemoteCandidate[]; complete: boolean }> }
    }).remote
    vi.spyOn(remote, 'searchWithStatus').mockImplementation(async query =>
      query.includes('spreadsheet')
        ? { candidates: [sheets], complete: true }
        : { candidates: [pdf], complete: true })
    const propose = (target: Agent, task: string) => {
      const messages = [createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } })]
      return agentEvents(context, target).waterfall(
        'agent/pre-step', { messages, turn: 1, step: 1, signal: new AbortController().signal },
        () => Promise.resolve({ kind: 'enter' as const, messages }),
      )
    }
    await propose(first, 'Read this PDF document')
    await propose(second, 'Analyze this spreadsheet workbook')
    const firstCatalog = await context.skills.snapshot({ scope: first, cwd: first.session.header.cwd })
    const secondCatalog = await context.skills.snapshot({ scope: second, cwd: second.session.header.cwd })
    expect(firstCatalog.skills.map(skill => skill.name)).toEqual(['pdf-reader'])
    expect(secondCatalog.skills.map(skill => skill.name)).toEqual(['sheet-helper'])
  })

  it('fails closed under the always approval policy without an approval channel', async () => {
    const f = await fixture({ approvalPolicy: 'always' })
    await f.propose(f.agent, 'Read the tables in this PDF')
    const denied = await f.callSkill(f.agent, 'pdf-reader')
    expect(denied.isError).toBe(true)
    expect(String(denied.error?.message)).toContain('Install remote skill')
    expect(f.verify).not.toHaveBeenCalled()
  })

  it('honours session-level trust after a previous approval', async () => {
    const f = await fixture({ approvalPolicy: 'session' })
    f.internals.trustedBySession.set(f.agent.session, new Set(['owner/repo']))
    await f.propose(f.agent, 'Read the tables in this PDF')
    const loaded = await f.callSkill(f.agent, 'pdf-reader')
    expect(loaded.isError).toBe(false)
    expect(f.verify).toHaveBeenCalledTimes(1)
  })

  it('recovers from a corrupt top candidate through the same-name chain', async () => {
    const bad = remoteCandidate('pdf-reader', 'owner/bad', 'pdf-reader', 95)
    const good = remoteCandidate('pdf-reader', 'owner/good', 'pdf-reader', 90)
    const goodMarkdown = `---\nname: ${good.name}\ndescription: ${good.description}\n---\nInstructions from ${good.source}.\n`
    let installAttempts = 0
    const f = await fixture({
      candidates: [bad, good],
      runInstaller: async invocation => {
        installAttempts += 1
        const skillIndex = invocation.args.indexOf('--skill')
        const name = invocation.args[skillIndex + 1]
        if (typeof name !== 'string') throw new Error('installer invocation omitted --skill')
        if (installAttempts === 1) throw new Error('archive unavailable')
        const directory = join(invocation.cwd, '.agents', 'skills', name)
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'SKILL.md'), goodMarkdown)
      },
    })
    await f.propose(f.agent, 'Read the tables in this PDF')
    const loaded = await f.callSkill(f.agent, 'pdf-reader')
    expect(loaded.isError).toBe(false)
    expect(JSON.stringify(loaded)).toContain('owner/good')
    expect(f.attempts).toEqual([0, 1])
    expect(f.context.skillFlux.lastRouting(f.agent).map(trace => trace.outcome))
      .toEqual(['mount-failed', 'loaded'])
  })

  it('propagates caller cancellation during a lazy download', async () => {
    const f = await fixture()
    const controller = new AbortController()
    f.verify.mockImplementationOnce(async () => {
      controller.abort(new Error('user cancelled'))
      throw controller.signal.reason
    })
    await f.propose(f.agent, 'Read the tables in this PDF')
    const cancelled = await f.callSkill(f.agent, 'pdf-reader', controller.signal)
    expect(cancelled.isError).toBe(true)
    expect(String(cancelled.error?.message)).toContain('user cancelled')
    expect(f.verify).toHaveBeenCalledTimes(1)
    expect(f.context.skillFlux.mounted(f.agent)).toEqual([])
  })

  it('releases the provider catalog at turn end', async () => {
    const f = await fixture()
    await f.propose(f.agent, 'Read the tables in this PDF')
    expect((await f.agent.ctx.skills.snapshot({ scope: f.agent })).skills.map(skill => skill.name))
      .toEqual(['pdf-reader'])
    f.endTurn()
    expect((await f.agent.ctx.skills.snapshot({ scope: f.agent })).skills).toEqual([])
    const late = await f.callSkill(f.agent, 'pdf-reader')
    expect(late.isError).toBe(true)
    expect(String(late.error?.message)).toContain('not mounted')
  })
})
