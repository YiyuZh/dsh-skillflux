import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillCache } from '../lib/index.js'

const root = await mkdtemp(join(tmpdir(), 'skillflux-cache-governance-smoke-'))

function candidate(name, ref) {
  return {
    id: `remote-${name}`,
    origin: 'remote',
    name,
    description: `${name} smoke-test Skill`,
    source: 'skillflux-smoke/fixtures',
    ref,
    score: 100,
    skillId: name,
    installs: 0,
    discoverySources: ['github'],
    qualityScore: 50,
    relevanceScore: 100,
    stars: 0,
    forks: 0,
    recentlyActive: true,
    trustedSource: false,
  }
}

try {
  const cache = new SkillCache({
    root,
    maxFiles: 10,
    maxBytes: 10_000,
    installTimeoutMs: 5_000,
    runInstaller: async invocation => {
      const skillIndex = invocation.args.indexOf('--skill')
      const name = invocation.args[skillIndex + 1]
      if (typeof name !== 'string') throw new Error('installer invocation omitted --skill')
      const directory = join(invocation.cwd, '.agents', 'skills', name)
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name} smoke-test Skill\n---\nUse ${name}.\n`,
        'utf8',
      )
    },
  })
  const disposable = await cache.install(candidate('disposable', 'a'.repeat(40)))
  const valuable = await cache.install(candidate('valuable', 'b'.repeat(40)))
  if ((await cache.load(valuable)).name !== 'valuable') throw new Error('valuable Skill failed integrity loading')

  const plan = await cache.prune(
    { maxEntries: 1, maxTotalBytes: 10_000, maxIdleMs: 0 },
    [{ source: valuable.manifest.source, name: valuable.manifest.name, cacheId: valuable.manifest.cacheId, mounts: 3, uses: 2, lastUsedAt: Date.now() }],
  )
  if (plan.decisions.length !== 1 || plan.decisions[0]?.cacheId !== disposable.manifest.cacheId) {
    throw new Error(`unexpected governance plan: ${JSON.stringify(plan)}`)
  }
  if ((await cache.list()).map(entry => entry.manifest.name).join(',') !== 'valuable') {
    throw new Error('governance did not retain exactly the valuable Skill')
  }
  process.stdout.write(`SkillFlux cache governance smoke: installed=2 removed=1 retained=valuable bytes=${plan.afterBytes}\n`)
} finally {
  await rm(root, { recursive: true, force: true })
}
