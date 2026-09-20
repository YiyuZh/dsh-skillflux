import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
import type { ApprovalPolicy, RemoteCandidate, SkillFluxCandidate, SkillFluxCatalog } from '../src/types.js'

type Result = 'ok' | 'verify-fail' | 'install-fail'
interface FallbackCase {
  id: string
  policy: ApprovalPolicy
  limit?: number
  results: Result[]
  published: number[]
  attempts: number[]
  outcomes: string[]
  loaded: number[]
  remaining: number[]
}
const corpus = JSON.parse(await readFile(new URL('../evals/remote-fallback-cases.json', import.meta.url), 'utf8')) as {
  version: number
  cases: FallbackCase[]
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.unstubAllEnvs()
})

async function fixture(results: Result[], config: SkillFluxConfig = {}) {
  const root = await mkdtemp(join(tmpdir(), 'skillflux-fallback-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('DSH_HOME', root)
  const context = new Context()
  for (const plugin of [SystemPrompt, ToolRuntime, AgentRegistry, SkillRegistry, CommandRuntime]) {
    const fiber = context.plugin(plugin)
    await fiber.await()
    cleanups.push(fiber.dispose)
  }
  const fiber = context.plugin(SkillFluxService, {
    routes: [], usageTracking: false, cacheAutoPrune: false,
    remoteDiscovery: 'automatic', approvalPolicy: 'automatic', ...config,
  })
  await fiber.await()
  cleanups.push(fiber.dispose)
  const id = SessionId('remote-fallback')
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd: root })
  const agent = {
    id, options: {}, session, status: 'running', ctx: context,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    send() {}, followup() {}, steer() {}, cancel() {},
    inject() { throw new Error('must not inject during routing') },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  } satisfies Agent
  const candidates: RemoteCandidate[] = results.map((_, index) => {
    const source = `owner/repo-${index}`
    const ref = String(index + 1).repeat(40)
    return {
      id: candidateId('remote', source, ref, 'pdf-reader'),
      name: 'pdf-reader', skillId: 'pdf-reader', origin: 'remote', source, ref,
      description: 'Read PDF tables', score: 90 - index, installs: 0,
      selection: 'remote-quality', discoverySources: ['github'], qualityScore: 70,
      relevanceScore: 100, stars: 10, forks: 0, recentlyActive: true,
      trustedSource: false, trustLevel: 'community',
      qualityBreakdown: { relevance: 55, adoption: 0, repository: 5, freshness: 6, trust: 0, provenance: 4, total: 70 },
      qualitySignals: ['content-pinned'], qualityWarnings: [],
    }
  })
  const markdown = candidates.map(candidate => `---\nname: pdf-reader\ndescription: ${candidate.description}\n---\nRead tables with ${candidate.source}.\n`)
  const internals = context.skillFlux as unknown as {
    cache: SkillCache
    remote: { search: (query: string, signal?: AbortSignal) => Promise<RemoteCandidate[]> }
    state: (agent: Agent) => { candidates: Map<string, SkillFluxCandidate>; published: SkillFluxCatalog }
  }
  const attempts: number[] = []
  let installing = -1
  const verify = vi.fn<RemoteCandidateVerifier>(async (candidate, _signal) => {
    installing = candidates.findIndex(item => item.source === candidate.source && item.ref === candidate.ref)
    attempts.push(installing)
    if (results[installing] === 'verify-fail') throw new Error('pinned source is not uniquely installable')
    return { path: 'skills/pdf-reader/SKILL.md', skillFileHash: createHash('sha256').update(markdown[installing]!).digest('hex') }
  })
  internals.cache = new SkillCache({
    root: internals.cache.root, maxFiles: 10, maxBytes: 100_000,
    installTimeoutMs: context.skillFlux.config.installTimeoutMs,
    verifyCandidate: verify,
    runInstaller: async invocation => {
      if (results[installing] === 'install-fail') throw new Error('archive unavailable')
      const directory = join(invocation.cwd, '.agents', 'skills', 'pdf-reader')
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'SKILL.md'), markdown[installing]!)
    },
  })
  vi.spyOn(internals.remote, 'search').mockResolvedValue(candidates)
  const messages = [createUserMessage({ content: [{ type: 'text', text: 'Read the tables in this PDF' }], source: { kind: 'user' } })]
  const propose = (signal = new AbortController().signal) => agentEvents(context, agent).waterfall(
    'agent/pre-step', { messages, turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages }),
  )
  const callSkill = (name = 'pdf-reader', signal = new AbortController().signal) => context.tools.execute({
    callId: CallId(`lazy-load-${name}`),
    name: 'skill',
    arguments: { name },
    agent,
    signal,
  })
  const endTurn = () => context.emit(scopeTarget(session, undefined), 'session/event', session, {
    type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } },
  })
  return { context, agent, candidates, attempts, internals, verify, markdown, propose, callSkill, endTurn }
}

describe('automatic remote fallback evaluation', () => {
  it('has valid and uniquely identified corpus cases', () => {
    expect(corpus.version).toBe(2)
    expect(corpus.cases.length).toBeGreaterThanOrEqual(8)
    expect(new Set(corpus.cases.map(item => item.id)).size).toBe(corpus.cases.length)
    for (const item of corpus.cases) {
      expect(['always', 'session', 'automatic']).toContain(item.policy)
      for (const result of item.results) expect(['ok', 'verify-fail', 'install-fail']).toContain(result)
      for (const index of [...item.published, ...item.attempts, ...item.loaded, ...item.remaining]) {
        expect(Number.isInteger(index) && index >= 0 && index < item.results.length).toBe(true)
      }
    }
  })

  it.each(corpus.cases)('$id', async testCase => {
    const f = await fixture(testCase.results, {
      approvalPolicy: testCase.policy,
      ...(testCase.limit === undefined ? {} : { remoteAutoMountLimit: testCase.limit }),
    })
    const result = await f.propose()
    expect(result.kind).toBe('enter')
    expect(f.attempts).toEqual([])
    expect(f.context.skillFlux.mounted(f.agent)).toEqual([])
    expect(f.internals.state(f.agent).published.candidates.map(candidate => candidate.id))
      .toEqual(testCase.published.map(index => f.candidates[index]!.id))
    expect([...f.internals.state(f.agent).candidates.keys()])
      .toEqual(f.candidates.map(candidate => candidate.id))
    if (result.kind === 'enter') {
      const text = JSON.stringify(result.messages)
      for (const candidate of f.candidates) expect(text).toContain(candidate.id)
      if (testCase.published.length > 0) expect(text).toContain('pdf-reader')
    }
    if (testCase.attempts.length > 0) {
      const loaded = await f.callSkill()
      expect(f.attempts).toEqual(testCase.attempts)
      expect(f.context.skillFlux.lastRouting(f.agent).map(trace => trace.outcome)).toEqual(testCase.outcomes)
      expect([...f.internals.state(f.agent).candidates.keys()])
        .toEqual(testCase.remaining.map(index => f.candidates[index]!.id))
      if (testCase.loaded.length > 0) {
        expect(loaded.isError).toBe(false)
        expect(JSON.stringify(loaded)).toContain(f.candidates[testCase.loaded[0]!]!.source)
      } else {
        expect(loaded.isError).toBe(true)
      }
      f.endTurn()
      expect(f.context.skillFlux.mounted(f.agent)).toEqual([])
      expect((await f.agent.ctx.skills.snapshot()).skills).toEqual([])
    }
    const status = await f.context.commands.execute(f.agent, '/skillflux explain', [], new AbortController().signal)
    for (const outcome of testCase.outcomes) expect(status?.result.text).toContain(outcome)
  })

  it('validates the attempt cap', async () => {
    for (const remoteAutoMountLimit of [0, 6, 1.5]) {
      await expect(fixture([], { remoteAutoMountLimit })).rejects.toThrow('remoteAutoMountLimit')
    }
  })

  it('publishes an incomplete observation when remote discovery fails', async () => {
    const f = await fixture(['ok'])
    vi.spyOn(f.internals.remote, 'search').mockRejectedValueOnce(new Error('search backend down'))
    const result = await f.propose()
    expect(result.kind).toBe('enter')
    expect(f.internals.state(f.agent).published).toMatchObject({ candidates: [], complete: false })
    const snapshot = await f.agent.ctx.skills.snapshot({ scope: f.agent, cwd: f.agent.session.header.cwd })
    expect(snapshot.complete).toBe(false)
  })

  it('allows an explicit new search to retry a failed candidate without silently mounting another', async () => {
    const f = await fixture(['ok', 'ok'], { remoteAutoMountLimit: 1 })
    f.verify.mockRejectedValueOnce(new Error('temporary source failure'))
    await f.propose()
    await expect(f.callSkill()).resolves.toMatchObject({ isError: true })
    await expect(f.context.skillFlux.mount(f.agent, f.candidates[0]!.id)).rejects.toThrow('unknown or expired')
    await f.context.tools.execute({
      callId: CallId('retry-remote-search'), name: 'skillflux_search', arguments: { query: 'PDF', remote: true },
      agent: f.agent, signal: new AbortController().signal,
    })
    await f.context.skillFlux.mount(f.agent, f.candidates[0]!.id)
    expect(f.context.skillFlux.mounted(f.agent).map(item => item.candidateId)).toEqual([f.candidates[0]!.id])
    expect(f.verify).toHaveBeenCalledTimes(2)
  })

  it('does not weaken current owner policy while falling back', async () => {
    const f = await fixture(['ok', 'ok'], { remoteBlockedOwners: ['blocked'] })
    f.candidates[0] = { ...f.candidates[0]!, source: 'blocked/repo' }
    await f.propose()
    expect(f.internals.state(f.agent).published.candidates.map(item => item.id)).toEqual([f.candidates[1]!.id])
    const loaded = await f.callSkill()
    expect(f.attempts).toEqual([1])
    expect(loaded.isError).toBe(false)
    expect(f.context.skillFlux.lastRouting(f.agent).map(item => item.outcome)).toEqual(['loaded'])
  })

  it('propagates explicit cancellation without falling back', async () => {
    const f = await fixture(['ok', 'ok'])
    const controller = new AbortController()
    f.verify.mockImplementationOnce(async () => {
      controller.abort(new Error('user cancelled'))
      throw controller.signal.reason
    })
    await f.propose()
    const cancelled = await f.callSkill('pdf-reader', controller.signal)
    expect(cancelled.isError).toBe(true)
    expect(cancelled.error?.message).toContain('user cancelled')
    expect(f.verify).toHaveBeenCalledTimes(1)
    expect(f.context.skillFlux.mounted(f.agent)).toEqual([])
  })

  it('stops stale fallback after turn cleanup even when the installer reports a generic error', async () => {
    const f = await fixture(['ok', 'ok'])
    f.verify.mockImplementationOnce(async () => {
      f.endTurn()
      throw new Error('archive failed after turn end')
    })
    await f.propose()
    const stale = await f.callSkill()
    expect(stale.isError).toBe(true)
    expect(stale.error?.message).toContain('SkillFlux mount expired')
    expect(f.verify).toHaveBeenCalledTimes(1)
    expect(f.context.skillFlux.mounted(f.agent)).toEqual([])
    expect(f.context.skillFlux.lastRouting(f.agent)).toEqual([])
  })

  it('shares one deadline and never starts a fallback after it expires', async () => {
    const f = await fixture(['verify-fail', 'ok', 'ok'], { installTimeoutMs: 1_000 })
    const deadline = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal)
    f.verify.mockImplementationOnce(async () => { throw new Error('first candidate failed quickly') })
    f.verify.mockImplementationOnce(async (_candidate, signal) => {
      expect(signal?.aborted).toBe(false)
      deadline.abort(new DOMException('shared install deadline expired', 'TimeoutError'))
      return await new Promise(() => undefined)
    })
    await f.propose()
    const timedOut = await f.callSkill()
    expect(timedOut.isError).toBe(true)
    expect(timedOut.error?.message).toContain('shared install deadline expired')
    expect(f.verify).toHaveBeenCalledTimes(2)
    expect(f.context.skillFlux.lastRouting(f.agent).map(item => item.outcome)).toEqual(['mount-failed', 'mount-timeout'])
    expect([...f.internals.state(f.agent).candidates.keys()]).toEqual([f.candidates[2]!.id])
    expect(f.context.skillFlux.mounted(f.agent)).toEqual([])
    expect(await f.internals.cache.list()).toEqual([])
  })

  it('does not remount the same name after explicit unmount during a failed attempt', async () => {
    const f = await fixture(['ok', 'ok'])
    f.verify.mockImplementationOnce(async () => {
      f.context.skillFlux.unmount(f.agent, 'pdf-reader')
      throw new Error('source failed after named unmount')
    })
    await f.propose()
    const unmounted = await f.callSkill()
    expect(unmounted.isError).toBe(true)
    expect(unmounted.error?.message).toContain('SkillFlux mount expired')
    expect(f.verify).toHaveBeenCalledTimes(1)
    expect(f.context.skillFlux.mounted(f.agent)).toEqual([])
    expect(f.context.skillFlux.lastRouting(f.agent)).toEqual([])
  })

  it('respects an unmount for a candidate that has not been attempted yet', async () => {
    const f = await fixture(['ok', 'ok'])
    const candidate = f.candidates[1]!
    f.candidates[1] = {
      ...candidate, name: 'other-reader', skillId: 'other-reader',
      id: candidateId('remote', candidate.source, candidate.ref, 'other-reader'),
    }
    f.verify.mockImplementationOnce(async () => {
      f.context.skillFlux.unmount(f.agent, 'other-reader')
      throw new Error('first candidate failed after future candidate was unmounted')
    })
    await f.propose()
    const respected = await f.callSkill('pdf-reader')
    expect(respected.isError).toBe(true)
    expect(respected.error?.message).toContain('first candidate failed after future candidate was unmounted')
    expect(f.verify).toHaveBeenCalledTimes(1)
    expect(f.context.skillFlux.mounted(f.agent)).toEqual([])
    expect(f.context.skillFlux.lastRouting(f.agent).map(item => item.outcome)).toEqual(['mount-failed'])
  })
})
