import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const generated = ['lib/index.js', 'lib/index.d.ts', 'lib/index.d.ts.map']
const diff = spawnSync('git', ['diff', '--exit-code', '--', ...generated], {
  cwd: repositoryRoot,
  stdio: 'inherit',
})
if (diff.error !== undefined) throw diff.error
if (diff.status !== 0) process.exit(diff.status ?? 1)

const normalize = value => value.replaceAll('\r\n', '\n')
const normalizeSource = value => value.replaceAll('\\', '/')
const mapPath = resolve(repositoryRoot, 'lib/index.js.map')

async function verifySources(sourceMap, label) {
  if (!Array.isArray(sourceMap.sources)
    || !Array.isArray(sourceMap.sourcesContent)
    || sourceMap.sources.length === 0
    || sourceMap.sources.length !== sourceMap.sourcesContent.length) {
    throw new Error(`${label} lib/index.js.map does not contain a complete sourcesContent table`)
  }
  for (const [index, source] of sourceMap.sources.entries()) {
    if (typeof source !== 'string' || typeof sourceMap.sourcesContent[index] !== 'string') {
      throw new Error(`${label} lib/index.js.map has an invalid source at index ${index}`)
    }
    const sourcePath = resolve(dirname(mapPath), source)
    const current = normalize(await readFile(sourcePath, 'utf8'))
    if (normalize(sourceMap.sourcesContent[index]) !== current) {
      throw new Error(`${label} lib/index.js.map embeds stale source content for ${source}`)
    }
  }
  return sourceMap.sources.map(normalizeSource)
}

const committedMap = spawnSync('git', ['show', ':lib/index.js.map'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  maxBuffer: 2 * 1024 * 1024,
})
if (committedMap.error !== undefined) throw committedMap.error
if (committedMap.status !== 0) throw new Error(committedMap.stderr.trim() || 'cannot read committed lib/index.js.map')

const committedSources = await verifySources(JSON.parse(committedMap.stdout), 'Committed')
const builtSources = await verifySources(JSON.parse(await readFile(mapPath, 'utf8')), 'Built')
if (JSON.stringify(committedSources) !== JSON.stringify(builtSources)) {
  throw new Error('Committed lib/index.js.map sources do not match the current build')
}
console.log(`Generated package entry is current; verified ${builtSources.length} sourcemap sources.`)
