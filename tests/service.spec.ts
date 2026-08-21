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
import SkillFluxService from '../src/index.js'

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

async function mount(context: Context, plugin: Parameters<Context['plugin']>[0], config?: unknown): Promise<void> {
  const fiber = config === undefined ? context.plugin(plugin) : context.plugin(plugin, config)
  await fiber.await()
  disposers.push(fiber.dispose)
}

async function setup(): Promise<Context> {
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
  })
  return context
}

function fakeAgent(): Agent {
  const id = SessionId('skillflux-service-test')
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd: '/workspace' })
  return {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    status: 'running',
    ctx: new Context(),
    send() {},
    followup() {},
    steer() {},
    inject() { throw new Error('pre-step routing must not call agent.inject') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

async function propose(context: Context, agent: Agent, messages: UserMessage[]) {
  const signal = new AbortController().signal
  return await agentEvents(context, agent).waterfall(
    'agent/pre-step',
    { messages, turn: 1, step: 1, signal },
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
    const agent = fakeAgent()
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
    const agent = fakeAgent()
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
  })
})
