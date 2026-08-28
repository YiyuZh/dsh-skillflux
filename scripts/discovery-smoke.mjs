import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteDiscoveryCache, RemoteDiscoveryClient } from '../lib/index.js'

const tokenAvailable = Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN)
if (process.env.SKILLFLUX_REQUIRE_GITHUB === '1') {
  assert(tokenAvailable, 'SKILLFLUX_REQUIRE_GITHUB=1 requires GITHUB_TOKEN or GH_TOKEN')
}

const query = process.env.SKILLFLUX_DISCOVERY_QUERY?.trim()
  || 'analyze PDF documents with OCR and extract tables'
const trustedOwners = (process.env.SKILLFLUX_TRUSTED_OWNERS ?? '')
  .split(',')
  .map(owner => owner.trim())
  .filter(Boolean)
const root = await mkdtemp(join(tmpdir(), 'skillflux-discovery-smoke-'))
try {
  const cache = new RemoteDiscoveryCache({
    file: join(root, 'remote-discovery.json'),
    ttlMs: 60_000,
    staleIfErrorMs: 60_000,
    maxEntries: 5,
  })
  const client = new RemoteDiscoveryClient({
    searchLimit: 5,
    timeoutMs: 60_000,
    providers: tokenAvailable ? ['skills.sh', 'github'] : ['skills.sh'],
    minQualityScore: 35,
    recentActivityDays: 30,
    trustedOwners,
    cache,
  })
  const startedAt = Date.now()
  const candidates = await client.search(query)
  const liveElapsedMs = Date.now() - startedAt
  assert(candidates.length > 0, `no live candidates found for ${JSON.stringify(query)}`)
  for (const candidate of candidates) {
    assert.match(candidate.ref, /^[0-9a-f]{40}$/u)
    assert(candidate.qualityScore >= 35)
    assert(candidate.relevanceScore > 0)
  }

  const cacheStartedAt = Date.now()
  const cached = await client.search(query)
  const cacheElapsedMs = Date.now() - cacheStartedAt
  assert.deepEqual(cached, candidates, 'fresh discovery cache changed the candidate set')
  const cacheStats = await client.discoveryCacheStats()
  assert.equal(cacheStats?.hits, 1)
  assert.equal(cacheStats?.writes, 1)

  console.log(JSON.stringify({
    query,
    liveElapsedMs,
    cacheElapsedMs,
    cacheStats,
    coverage: tokenAvailable ? ['skills.sh', 'github'] : ['skills.sh'],
    candidates: candidates.map(candidate => ({
      name: candidate.name,
      source: candidate.source,
      discoverySources: candidate.discoverySources,
      qualityScore: candidate.qualityScore,
      relevanceScore: candidate.relevanceScore,
      installs: candidate.installs,
      stars: candidate.stars,
      recentlyActive: candidate.recentlyActive,
      trustedSource: candidate.trustedSource,
      ...(candidate.path === undefined ? {} : { path: candidate.path }),
      ref: candidate.ref.slice(0, 12),
    })),
  }, null, 2))
} finally {
  await rm(root, { recursive: true, force: true })
}
