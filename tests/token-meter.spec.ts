import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillFluxService, { UsageStore, estimateTextTokens } from '../src/index.js'
import {
  estimateCatalogEntries,
  estimateWithMeter,
  resolveTokenMeter,
  type TokenMeterLike,
} from '../src/token-meter.js'
import type { SkillFluxConfig, SkillUsageIdentity } from '../src/types.js'

const disposers: Array<() => Promise<void>> = []
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const IDENTITY: SkillUsageIdentity = {
  candidateId: '1'.repeat(24),
  name: 'pdf-reader',
  origin: 'registry',
  source: 'runtime',
}

describe('token estimation', () => {
  it('falls back to the portable estimate with exact parity', () => {
    const text = 'Read PDF documents and extract text'
    expect(estimateWithMeter(undefined, text)).toEqual({
      tokens: estimateTextTokens(text),
      estimator: 'portable',
    })
    expect(estimateWithMeter(undefined, '')).toEqual({ tokens: 0, estimator: 'portable' })
  })

  it('uses a healthy meter and degrades on invalid or throwing meters', () => {
    const meter: TokenMeterLike = { estimateMessage: () => 42.4 }
    expect(estimateWithMeter(meter, 'anything')).toEqual({ tokens: 43, estimator: 'token-meter' })
    expect(estimateWithMeter(meter, '')).toEqual({ tokens: 0, estimator: 'token-meter' })
    expect(estimateWithMeter({ estimateMessage: () => Number.NaN }, 'x').estimator).toBe('portable')
    expect(estimateWithMeter({ estimateMessage: () => -1 }, 'x').estimator).toBe('portable')
    expect(estimateWithMeter({
      estimateMessage: () => { throw new Error('meter down') },
    }, 'x').estimator).toBe('portable')
  })

  it('sums per-entry catalog lines and reports a downgraded estimator on any fallback', () => {
    const skills = [
      { name: 'pdf-reader', description: 'Read PDF documents' },
      { name: 'calendar-agent', description: 'Manage calendar meetings' },
    ]
    const native = estimateCatalogEntries({ estimateMessage: () => 10 }, skills, 160)
    expect(native.tokens).toBe(20)
    expect(native.estimator).toBe('token-meter')
    const portable = estimateCatalogEntries(undefined, skills, 160)
    expect(portable.estimator).toBe('portable')
    expect(portable.tokens).toBe(skills.reduce(
      (total, skill) => total + estimateTextTokens(`- \`${skill.name}\`: ${skill.description}`),
      0,
    ))
  })
})

describe('resolveTokenMeter', () => {
  it('resolves only a mounted service with a callable estimateMessage', () => {
    const context = new Context()
    expect(resolveTokenMeter(context)).toBeUndefined()
    const meter: TokenMeterLike = { estimateMessage: () => 1 }
    const dispose = context.provide('tokenMeter', meter)
    try {
      expect(resolveTokenMeter(context)).toBe(meter)
    } finally {
      dispose()
    }
    expect(resolveTokenMeter(context)).toBeUndefined()
    context.provide('tokenMeter', { estimateMessage: 3 })
    expect(resolveTokenMeter(context)).toBeUndefined()
  })
})

describe('UsageStore token telemetry', () => {
  it('merges bounded token counts and stays backward compatible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillflux-token-usage-'))
    roots.push(root)
    const file = join(root, 'usage.json')
    const store = new UsageStore({ file, maxEntries: 100, now: () => 1_000 })
    await store.recordMount(IDENTITY)
    await store.recordTelemetry(IDENTITY, {
      loadedBodyTokens: 7,
      catalogFootprintTokens: 33,
      estimator: 'token-meter',
    })
    await store.recordTelemetry(IDENTITY, { loadedBodyTokens: 5 })
    expect((await store.list())[0]).toMatchObject({
      mounts: 1,
      loadedBodyTokens: 5,
      totalLoadedBodyTokens: 12,
      catalogFootprintTokens: 33,
      lastLoadedAt: 1_000,
      tokenEstimator: 'token-meter',
    })

    // A v1 document written before telemetry fields existed still loads.
    await writeFile(file, JSON.stringify({
      version: 1,
      records: [{ ...IDENTITY, mounts: 2, uses: 3 }],
    }), 'utf8')
    const legacy = new UsageStore({ file, maxEntries: 100 })
    expect((await legacy.list())[0]).toEqual({ ...IDENTITY, mounts: 2, uses: 3 })

    await expect(store.recordTelemetry(
      IDENTITY,
      { estimator: 'unknown' } as unknown as { estimator: 'portable' },
    ))
      .rejects.toThrow('invalid token estimator kind')
    await expect(store.recordTelemetry(IDENTITY, { loadedBodyTokens: -1 }))
      .rejects.toThrow('invalid loaded body token estimate')
  })
})

async function mount(context: Context, plugin: Parameters<Context['plugin']>[0], config?: unknown): Promise<void> {
  const fiber = config === undefined ? context.plugin(plugin) : context.plugin(plugin, config)
  await fiber.await()
  disposers.push(fiber.dispose)
}

async function setup(
  overrides: SkillFluxConfig = {},
  provideMeter?: TokenMeterLike,
): Promise<Context> {
  if (process.env.DSH_HOME === undefined) {
    const root = await mkdtemp(join(tmpdir(), 'skillflux-token-service-home-'))
    roots.push(root)
    vi.stubEnv('DSH_HOME', root)
  }
  const context = new Context()
  await mount(context, SystemPrompt)
  await mount(context, ToolRuntime)
  await mount(context, AgentRegistry)
  await mount(context, SkillRegistry)
  await mount(context, CommandRuntime)
  if (provideMeter !== undefined) {
    const disposeMeter = context.provide('tokenMeter', provideMeter)
    disposers.push(async () => { disposeMeter() })
  }
  await mount(context, SkillFluxService, {
    maxActiveSkills: 3,
    remoteDiscovery: 'off',
    approvalPolicy: 'automatic',
    usageTracking: true,
    routes: [],
    ...overrides,
  })
  return context
}

function fakeAgent(ctx: Context = new Context()): Agent {
  const id = SessionId('skillflux-token-meter-test')
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

describe('SkillFlux token telemetry integration', () => {
  it('records portable estimates and never persists skill bodies', async () => {
    const context = await setup()
    context.skills.register({
      name: 'pdf-reader',
      description: 'Read PDF documents',
      source: 'runtime',
      content: 'PRIVATE TELEMETRY BODY',
    })
    const agent = fakeAgent(context)
    const user = createUserMessage({
      content: [{ type: 'text', text: 'Read this PDF document' }],
      source: { kind: 'user' },
    })
    await propose(context, agent, [user])
    expect(await context.skillFlux.usageRecords()).toMatchObject([{
      name: 'pdf-reader',
      tokenEstimator: 'portable',
    }])
    const record = (await context.skillFlux.usageRecords())[0]!
    expect(record.totalLoadedBodyTokens).toBeGreaterThan(0)
    const status = await context.commands.execute(agent, '/skillflux status', [], new AbortController().signal)
    expect(status?.result.text).toContain('Token telemetry: portable fallback')
    const usage = await context.commands.execute(agent, '/skillflux usage', [], new AbortController().signal)
    expect(usage?.result.text).toContain('body tokens')
    const raw = await readFile(join(process.env.DSH_HOME!, 'storages', 'skillflux', 'usage.json'), 'utf8')
    expect(raw).not.toContain('PRIVATE TELEMETRY BODY')
  })

  it('uses the native token-meter when one is mounted', async () => {
    const meter: TokenMeterLike = { estimateMessage: () => 10 }
    const context = await setup({}, meter)
    context.skills.register({
      name: 'pdf-reader',
      description: 'Read PDF documents',
      source: 'runtime',
      content: 'Native meter body.',
    })
    const agent = fakeAgent(context)
    const user = createUserMessage({
      content: [{ type: 'text', text: 'Read this PDF document' }],
      source: { kind: 'user' },
    })
    await propose(context, agent, [user])
    expect(await context.skillFlux.usageRecords()).toMatchObject([{
      name: 'pdf-reader',
      tokenEstimator: 'token-meter',
      loadedBodyTokens: 10,
      totalLoadedBodyTokens: 10,
      catalogFootprintTokens: 10,
    }])
    const status = await context.commands.execute(agent, '/skillflux status', [], new AbortController().signal)
    expect(status?.result.text).toContain('Token telemetry: native token-meter')
  })
})
