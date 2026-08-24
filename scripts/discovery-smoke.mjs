import assert from 'node:assert/strict'
import { RemoteDiscoveryClient } from '../lib/index.js'

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
const client = new RemoteDiscoveryClient({
  searchLimit: 5,
  timeoutMs: 60_000,
  providers: tokenAvailable ? ['skills.sh', 'github'] : ['skills.sh'],
  minQualityScore: 35,
  recentActivityDays: 30,
  trustedOwners,
})
const startedAt = Date.now()
const candidates = await client.search(query)
assert(candidates.length > 0, `no live candidates found for ${JSON.stringify(query)}`)
for (const candidate of candidates) {
  assert.match(candidate.ref, /^[0-9a-f]{40}$/u)
  assert(candidate.qualityScore >= 35)
  assert(candidate.relevanceScore > 0)
}

console.log(JSON.stringify({
  query,
  elapsedMs: Date.now() - startedAt,
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
