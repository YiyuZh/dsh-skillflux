import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillFluxService from '../lib/index.js'

// Development-only live protocol test, run from a clone with dev dependencies.
// No LLM calls and no execution of downloaded Skill scripts.
const task = process.env.SKILLFLUX_DISCOVERY_QUERY?.trim()
  || 'analyze PDF documents with OCR and extract tables'
const failFirst = process.env.SKILLFLUX_SMOKE_FAIL_FIRST === '1'
const root = await mkdtemp(join(tmpdir(), 'skillflux-runtime-smoke-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = root
const disposers = []
try {
  if (process.env.SKILLFLUX_REQUIRE_GITHUB === '1') {
    assert(process.env.GITHUB_TOKEN || process.env.GH_TOKEN, 'GitHub token is required for this run')
  }
  const context = new Context()
  for (const [plugin, config] of [
    [SystemPrompt], [ToolRuntime], [AgentRegistry], [SkillRegistry], [CommandRuntime],
    [SkillFluxService, {
      approvalPolicy: 'automatic', usageTracking: false, cacheAutoPrune: false,
      remoteDiscovery: 'automatic', remoteSearchLimit: 5, remoteAutoMountLimit: 3,
      remoteSearchTimeoutMs: 60_000, installTimeoutMs: 120_000,
    }],
  ]) {
    const fiber = context.plugin(plugin, config)
    await fiber.await()
    disposers.push(fiber.dispose)
  }
  const id = SessionId('skillflux-runtime-smoke')
  const session = Session.create(id, [], { version: 0, id, createdAt: Date.now(), cwd: root })
  const agent = {
    id, options: {}, session, status: 'running', ctx: context,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    send() {}, followup() {}, steer() {}, cancel() {},
    inject() { throw new Error('pre-step must not inject') },
    runMaintenance: operation => operation(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  let injectedFailures = 0
  const installationFailures = []
  const install = context.skillFlux.cache.install.bind(context.skillFlux.cache)
  context.skillFlux.cache.install = async (...args) => {
    try {
      if (failFirst && injectedFailures === 0) {
        injectedFailures += 1
        throw new Error('controlled smoke-test failure of first remote candidate')
      }
      return await install(...args)
    } catch (error) {
      installationFailures.push({
        source: args[0].source, skill: args[0].name,
        error: error instanceof Error ? error.message : String(error),
        code: error?.cause?.code,
      })
      throw error
    }
  }
  const messages = [createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } })]
  const signal = AbortSignal.timeout(180_000)
  const startedAt = Date.now()
  const decision = await agentEvents(context, agent).waterfall(
    'agent/pre-step', { messages, turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter', messages }),
  )
  assert.equal(decision.kind, 'enter')
  const traces = context.skillFlux.lastRouting(agent)
  console.log(JSON.stringify({ task, injectedFailures, installationFailures, elapsedMs: Date.now() - startedAt, traces }, null, 2))
  const mounted = context.skillFlux.mounted(agent)
  assert.equal(mounted.length, 1, 'live candidates did not yield one installable Skill; see traces/provider errors')
  if (failFirst) {
    assert.equal(injectedFailures, 1)
    assert.equal(traces[0]?.outcome, 'mount-failed')
    assert.equal(traces.at(-1)?.outcome, 'mounted')
  }
  const result = await context.tools.execute({
    callId: CallId('runtime-smoke-read-skill'), name: 'skill', arguments: { name: mounted[0].name }, agent, signal,
  })
  assert(mounted[0].definition.content.length > 0)
  const encodedInstructions = JSON.stringify(mounted[0].definition.content).slice(1, -1)
  assert(JSON.stringify(result).includes(encodedInstructions), 'skill tool did not deliver mounted instructions')
  context.emit(scopeTarget(session, undefined), 'session/event', session, {
    type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } },
  })
  assert.equal(context.skillFlux.mounted(agent).length, 0)
  assert.equal((await context.skills.snapshot({ scope: agent })).skills.length, 0)
  console.log(JSON.stringify({ source: mounted[0].source, skill: mounted[0].name, instructionsDelivered: true, unmounted: true }))
} finally {
  try {
    for (const dispose of disposers.reverse()) await dispose()
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
}
