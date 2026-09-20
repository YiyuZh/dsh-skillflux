// Fixture MCP Skills extension server over stdio (LSP Content-Length framing)
// for the checked-in conformance smoke. Serves two skills with correct
// sha256 digests; MCP_SKILLS_TAMPER=1 serves a wrong digest to prove the
// client fails closed.
import { createHash } from 'node:crypto'

const tamper = process.env.MCP_SKILLS_TAMPER === '1'

function digest(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

const refundsSkill = `---
name: refunds
description: Process customer refunds per company policy
---

# Refunds

Follow the refund policy and reuse the matching template from \`examples/\`.
`
const refundsEmail = `# Refund email

Use this template when replying to the customer.
`
const dailySkill = `---
name: daily-report
description: Assemble today's operational report from live data
---

# Daily report

Aggregate the metrics into the report template.
`

const refundsUri = 'skill://refunds/SKILL.md'
const emailUri = 'skill://refunds/examples/email.md'
const dailyUri = 'skill://daily-report/SKILL.md'

function resource(uri, content) {
  return {
    uri,
    digest: tamper ? digest(`${content} tampered`) : digest(content),
    size: Buffer.byteLength(content, 'utf8'),
  }
}

function entry(uri, name, description, resources) {
  return { uri, frontmatter: { name, description }, resources }
}

const skills = [
  entry(refundsUri, 'refunds', 'Process customer refunds per company policy', [
    resource(refundsUri, refundsSkill),
    resource(emailUri, refundsEmail),
  ]),
  entry(dailyUri, 'daily-report', "Assemble today's operational report from live data", [
    resource(dailyUri, dailySkill),
  ]),
]

const files = new Map([
  [refundsUri, { mimeType: 'text/markdown', text: refundsSkill }],
  [emailUri, { mimeType: 'text/markdown', text: refundsEmail }],
  [dailyUri, { mimeType: 'text/markdown', text: dailySkill }],
])

const handlers = {
  'skills/list': () => ({ resultType: 'complete', skills, ttlMs: 300_000, cacheScope: 'public' }),
  'skills/get': (params) => {
    const skill = skills.find(item => item.uri === params?.uri)
    if (skill === undefined) throw Object.assign(new Error('unknown skill uri'), { code: -32602 })
    return { resultType: 'complete', skill }
  },
  'resources/read': (params) => {
    const file = files.get(params?.uri)
    if (file === undefined) throw Object.assign(new Error('unknown resource uri'), { code: -32602 })
    return {
      resultType: 'complete',
      contents: [{ uri: params.uri, ...file }],
      ttlMs: 300_000,
      cacheScope: 'public',
    }
  },
}

function respond(message) {
  const body = JSON.stringify(message)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
}

function handle(raw) {
  let message
  try {
    message = JSON.parse(raw)
  } catch {
    return
  }
  const { id, method, params } = message
  const handler = handlers[method]
  if (handler === undefined) {
    respond({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })
    return
  }
  try {
    respond({ jsonrpc: '2.0', id, result: handler(params ?? {}) })
    process.stderr.write(`[mcp-skills-server] ${method}\n`)
  } catch (error) {
    respond({
      jsonrpc: '2.0',
      id,
      error: { code: error?.code ?? -32602, message: String(error?.message ?? error) },
    })
  }
}

let buffer = Buffer.alloc(0)
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const header = buffer.subarray(0, headerEnd).toString('utf8')
    const match = /Content-Length:\s*(\d+)/iu.exec(header)
    if (match === null) {
      process.stderr.write('[mcp-skills-server] malformed frame header\n')
      process.exit(1)
    }
    const length = Number(match[1])
    const frameEnd = headerEnd + 4 + length
    if (buffer.length < frameEnd) return
    const body = buffer.subarray(headerEnd + 4, frameEnd).toString('utf8')
    buffer = buffer.subarray(frameEnd)
    handle(body)
  }
})

process.stderr.write(`[mcp-skills-server] ready${tamper ? ' (tampered digests)' : ''}\n`)

