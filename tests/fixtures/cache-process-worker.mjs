import { randomUUID } from 'node:crypto'
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { lock } from 'proper-lockfile'

const [mode, root, cacheId] = process.argv.slice(2)
if (root === undefined) throw new Error('cache process worker requires a root')

let release
if (mode === 'lock') {
  await mkdir(root, { recursive: true })
  release = await lock(root, { realpath: false, stale: 10_000, update: 2_000 })
  process.stdout.write('LOCKED\n')
} else if (mode === 'marker' && cacheId !== undefined) {
  const directory = join(root, '.leases', cacheId)
  const leaseId = randomUUID()
  const file = join(directory, `${process.pid}-${leaseId}.json`)
  await mkdir(directory, { recursive: true })
  await writeFile(file, `${JSON.stringify({
    version: 1,
    pid: process.pid,
    instanceId: randomUUID(),
    leaseId,
    createdAt: Date.now(),
  })}\n`, 'utf8')
  const heartbeat = setInterval(() => {
    const now = new Date()
    void utimes(file, now, now).catch(() => undefined)
  }, 30_000)
  heartbeat.unref()
  release = async () => {
    clearInterval(heartbeat)
    await rm(file, { force: true })
    await rm(directory, { recursive: true, force: true })
  }
  process.stdout.write('LEASED\n')
} else {
  throw new Error(`unknown cache process worker mode: ${mode}`)
}

process.stdin.once('data', async () => {
  await release()
  process.stdin.pause()
  process.exitCode = 0
})
process.stdin.resume()
