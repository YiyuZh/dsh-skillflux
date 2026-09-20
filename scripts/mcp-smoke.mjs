// Conformance smoke for the bundled stdio MCP transport: spawns the fixture
// MCP Skills server as a real child process, publishes and lazily loads a
// skill end to end, verifies the content-bound cache install, and proves the
// client fails closed against tampered digests and unknown resources.
// No LLM calls and no skill execution.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillFluxService, { McpError, McpSkillsClient, McpStdioTransport } from '../lib/index.js'

const serverPath = fileURLToPath(new URL('./mcp-skills-server.mjs', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'skillflux-mcp-smoke-'))
const disposers = []
const startedAt = Date.now()

async function run(tamper) {
  const home = await mkdtemp(join(root, 'home-'))
  process.env.DSH_HOME = home
  const context = new Context()
  for (const [plugin, config] of [
    [SystemPrompt], [ToolRuntime], [AgentRegistry], [SkillRegistry], [CommandRuntime],
    [SkillFluxService, {
      approvalPolicy: 'automatic',
      usageTracking: false,
      cacheAutoPrune: false,
      remoteDiscovery: 'off',
      routes: [],
    }],
  ]) {
    const fiber = context.plugin(plugin, config)
    await fiber.await()
    disposers.push(fiber.dispose)
  }
  const transport = new McpStdioTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, ...(tamper ? { MCP_SKILLS_TAMPER: '1' } : {}) },
  })
  try {
    const client = new McpSkillsClient(transport)
    context.skillFlux.registerMcpSource('demo-mcp', client)

    await assert.rejects(
      () => client.readResource('skill://missing/SKILL.md'),
      error => error instanceof McpError && error.code === -32602,
    )

    const id = SessionId('skillflux-mcp-smoke')
    const session = Session.create(id, [], { version: 0, id, createdAt: Date.now(), cwd: root })
    const agent = {
      id,
      options: {},
      session,
      status: 'running',
      ctx: context,
      inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
      send() {},
      followup() {},
      steer() {},
      cancel() {},
      inject() { throw new Error('pre-step must not inject') },
      runMaintenance: operation => operation(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    const messages = [createUserMessage({
      content: [{ type: 'text', text: 'Process refunds for this order' }],
      source: { kind: 'user' },
    })]
    const decision = await agentEvents(context, agent).waterfall(
      'agent/pre-step',
      { messages, turn: 1, step: 1, signal: AbortSignal.timeout(60_000) },
      () => Promise.resolve({ kind: 'enter', messages }),
    )
    assert.equal(decision.kind, 'enter')
    const published = context.skillFlux.state(agent).published.candidates
    assert.ok(published.some(candidate => candidate.name === 'refunds' && candidate.origin === 'mcp'))

    const loaded = await context.tools.execute({
      callId: CallId('skillflux-mcp-smoke-load'),
      name: 'skill',
      arguments: { name: 'refunds' },
      agent,
      signal: new AbortController().signal,
    })
    if (tamper) {
      assert.equal(loaded.isError, true)
      return { tamperedRejected: true }
    }
    assert.equal(loaded.isError, false)
    const text = loaded.content.map(block => block.text ?? '').join('\n')
    assert.ok(text.includes('Follow the refund policy'))
    const entry = (await context.skillFlux.listCache())
      .find(cacheEntry => cacheEntry.manifest.origin === 'mcp')
    assert.ok(entry !== undefined)
    return {
      cacheId: entry.manifest.cacheId,
      contentBoundKey: entry.manifest.ref.slice(0, 16),
      loadedBody: text.slice(0, 80),
    }
  } finally {
    transport.close()
    await rm(home, { recursive: true, force: true })
  }
}

try {
  const healthy = await run(false)
  const tampered = await run(true)
  console.log(JSON.stringify({
    transport: 'bundled stdio (Content-Length framed JSON-RPC)',
    healthy,
    tampered,
    elapsedMs: Date.now() - startedAt,
  }, null, 2))
} finally {
  for (const dispose of disposers.reverse()) await dispose()
  await rm(root, { recursive: true, force: true })
}
