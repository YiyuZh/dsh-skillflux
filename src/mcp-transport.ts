import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { McpError } from './mcp-source.js'
import type { McpTransport } from './mcp-source.js'

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const MAX_FRAME_BYTES = 32 * 1024 * 1024

export interface McpStdioTransportOptions {
  /** Executable to launch (defaults to the current Node executable). */
  readonly command?: string
  /** Arguments for the child process. */
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly requestTimeoutMs?: number
  /** Refuse any response frame larger than this byte count. */
  readonly maxFrameBytes?: number
  readonly log?: (message: string) => void
  /** Test seam; defaults to node:child_process spawn. */
  readonly spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
}

function frame(body: string): string {
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`
}

/**
 * Zero-dependency stdio transport for the MCP Skills extension, speaking the
 * LSP-style Content-Length framed JSON-RPC that MCP stdio servers use. The
 * child process is spawned lazily on the first request and torn down by
 * `close()`. Frames, ids, timeouts, and error codes are bounded and validated.
 */
export class McpStdioTransport implements McpTransport {
  private readonly command: string
  private readonly args: readonly string[]
  private readonly options: SpawnOptions
  private readonly timeoutMs: number
  private readonly maxFrameBytes: number
  private readonly log: (message: string) => void
  private readonly spawnImpl: NonNullable<McpStdioTransportOptions['spawnImpl']>
  private child: ChildProcess | undefined
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private exited = false

  constructor(options: McpStdioTransportOptions = {}) {
    this.command = options.command ?? process.execPath
    this.args = options.args ?? []
    this.options = {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      stdio: ['pipe', 'pipe', 'inherit'],
    }
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES
    this.log = options.log ?? (() => undefined)
    this.spawnImpl = options.spawnImpl ?? spawn
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.exited) return Promise.reject(new McpError(-32000, 'MCP server has exited'))
    this.ensureChild()
    const id = this.nextId
    this.nextId += 1
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    })
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new McpError(-32000, `MCP request ${method} timed out`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child!.stdin!.write(frame(body))
    })
  }

  close(): void {
    if (this.child !== undefined) {
      try {
        this.child.stdin?.end()
      } catch {
        // The child may already be gone.
      }
      this.child.kill()
      this.child = undefined
    }
    for (const pending of this.pending.values()) clearTimeout(pending.timer)
    this.pending.clear()
    this.exited = true
  }

  private ensureChild(): void {
    if (this.child !== undefined) return
    const child = this.spawnImpl(this.command, [...this.args], this.options)
    this.child = child
    child.once('error', error => {
      this.exited = true
      this.rejectAll(new McpError(-32000, `MCP server spawn failed: ${error.message}`))
    })
    child.once('exit', code => {
      this.exited = true
      this.rejectAll(new McpError(-32000, `MCP server exited with code ${code ?? 'unknown'}`))
    })
    child.stdout?.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
      this.drain()
    })
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private drain(): void {
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.buffer.subarray(0, headerEnd).toString('utf8')
      const match = /Content-Length:\s*(\d+)/iu.exec(header)
      if (match === null) {
        this.log('SkillFlux MCP transport received a malformed frame header')
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const length = Number(match[1])
      if (length > this.maxFrameBytes) {
        this.log(`SkillFlux MCP transport refused an oversized frame of ${length} bytes`)
        this.buffer = Buffer.alloc(0)
        return
      }
      const frameEnd = headerEnd + 4 + length
      if (this.buffer.length < frameEnd) return
      const body = this.buffer.subarray(headerEnd + 4, frameEnd).toString('utf8')
      this.buffer = this.buffer.subarray(frameEnd)
      this.settle(body)
    }
  }

  private settle(raw: string): void {
    let message: { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } }
    try {
      message = JSON.parse(raw) as typeof message
    } catch {
      this.log('SkillFlux MCP transport received an unparseable response frame')
      return
    }
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (pending === undefined) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error !== undefined) {
      const code = typeof message.error.code === 'number' ? message.error.code : -32000
      pending.reject(new McpError(code, String(message.error.message ?? 'MCP error')))
    } else {
      pending.resolve(message.result)
    }
  }
}

