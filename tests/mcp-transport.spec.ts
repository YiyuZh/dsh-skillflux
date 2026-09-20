import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { McpSkillsClient, McpStdioTransport } from '../src/index.js'
import { McpError } from '../src/mcp-source.js'

const SERVER_PATH = fileURLToPath(new URL('../scripts/mcp-skills-server.mjs', import.meta.url))

interface FakeChild {
  readonly stdin: { write: (chunk: string) => void; end: () => void }
  readonly stdout: EventEmitter
  once: (event: string, listener: (arg?: unknown) => void) => void
  kill: () => void
  emit: (event: string, arg?: unknown) => void
}

function fakeChild(): FakeChild {
  const listeners = new Map<string, Array<(arg?: unknown) => void>>()
  return {
    stdin: { write: () => undefined, end: () => undefined },
    stdout: new EventEmitter(),
    once: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    kill: () => undefined,
    emit: (event, arg) => {
      for (const listener of listeners.get(event) ?? []) listener(arg)
    },
  }
}

function frame(payload: unknown): string {
  const body = JSON.stringify(payload)
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`
}

describe('McpStdioTransport', () => {
  it('round-trips skills/list, skills/get, and resources/read through the fixture server', async () => {
    const transport = new McpStdioTransport({
      command: process.execPath,
      args: [SERVER_PATH],
    })
    const client = new McpSkillsClient(transport)
    try {
      const listing = await client.listSkills()
      expect(listing.entries.map(entry => entry.frontmatter.name)).toEqual(['refunds', 'daily-report'])
      await expect(client.getSkill('skill://refunds/SKILL.md'))
        .resolves.toMatchObject({ frontmatter: { name: 'refunds' } })
      const bytes = await client.readResource('skill://refunds/SKILL.md')
      expect(bytes.toString('utf8')).toContain('Follow the refund policy')
      await expect(client.readResource('skill://missing/SKILL.md'))
        .rejects.toMatchObject({ code: -32602 })
    } finally {
      transport.close()
    }
  })

  it('correlates ids, decodes errors, and ignores unknown responses', async () => {
    let child: FakeChild
    const transport = new McpStdioTransport({
      spawnImpl: (() => {
        child = fakeChild()
        return child as unknown as ChildProcess
      }),
    })
    const pending = transport.request('skills/get', { uri: 'skill://x/SKILL.md' })
    const first = frame({ jsonrpc: '2.0', id: 999, result: { ignored: true } })
    const second = frame({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad uri' } })
    child!.stdout.emit('data', Buffer.from(first))
    child!.stdout.emit('data', Buffer.from(second))
    await expect(pending).rejects.toMatchObject({ code: -32602, message: 'bad uri' })
    transport.close()
  })

  it('times out unanswered requests and rejects pending work when the child exits', async () => {
    let child: FakeChild
    const transport = new McpStdioTransport({
      requestTimeoutMs: 40,
      spawnImpl: (() => {
        child = fakeChild()
        return child as unknown as ChildProcess
      }),
    })
    const timedOut = transport.request('skills/list', {})
    await expect(timedOut).rejects.toMatchObject({ message: expect.stringContaining('timed out') })

    const pending = transport.request('skills/list', {})
    child!.once('exit', () => undefined)
    child!.emit('exit', 1)
    await expect(pending).rejects.toThrow('exited with code 1')
    transport.close()
  })

  it('refuses oversized frames without crashing the reader', async () => {
    let child: FakeChild
    const transport = new McpStdioTransport({
      maxFrameBytes: 200,
      log: () => undefined,
      spawnImpl: (() => {
        child = fakeChild()
        return child as unknown as ChildProcess
      }),
    })
    const pending = transport.request('skills/list', {})
    child!.stdout.emit('data', Buffer.from(`Content-Length: 10000\r\n\r\n`))
    const good = frame({ jsonrpc: '2.0', id: 1, result: { resultType: 'complete', skills: [] } })
    child!.stdout.emit('data', Buffer.from(good))
    await expect(pending).resolves.toMatchObject({ skills: [] })
    transport.close()
  })

  it('fails closed against a server serving tampered digests', async () => {
    const transport = new McpStdioTransport({
      command: process.execPath,
      args: [SERVER_PATH],
      env: { ...process.env, MCP_SKILLS_TAMPER: '1' },
    })
    const client = new McpSkillsClient(transport)
    try {
      const listing = await client.listSkills()
      expect(listing.entries).toHaveLength(2)
      const bytes = await client.readResource('skill://refunds/SKILL.md')
      expect(bytes.toString('utf8')).toContain('Follow the refund policy')
      const entry = listing.entries.find(item => item.frontmatter.name === 'refunds')!
      const realDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      expect(entry.resources[0]?.digest).not.toBe(realDigest)
    } finally {
      transport.close()
    }
  })

  it('is a typed McpError for malformed servers', async () => {
    const error = new McpError(-32601, 'Method not found')
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe(-32601)
  })
})
