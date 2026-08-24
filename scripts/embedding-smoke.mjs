import { EmbeddingRouter } from '../lib/index.js'

const endpoint = process.env.SKILLFLUX_EMBEDDING_ENDPOINT ?? 'http://127.0.0.1:11434/api/embed'
const model = process.env.SKILLFLUX_EMBEDDING_MODEL ?? 'embeddinggemma'
const provider = process.env.SKILLFLUX_EMBEDDING_PROVIDER ?? 'ollama'
if (provider !== 'ollama' && provider !== 'openai-compatible') {
  throw new Error('SKILLFLUX_EMBEDDING_PROVIDER must be ollama or openai-compatible')
}

function candidate(name, description) {
  return {
    id: name,
    origin: 'cache',
    name,
    description,
    source: 'skillflux/live-smoke',
    ref: 'a'.repeat(40),
    cacheId: name.padEnd(24, '0').slice(0, 24),
    score: 0,
  }
}

const router = new EmbeddingRouter({
  provider,
  endpoint,
  model,
  apiKeyEnv: 'SKILLFLUX_EMBEDDING_API_KEY',
  timeoutMs: 30_000,
  candidateLimit: 16,
  cacheSize: 32,
  minSimilarity: 0.25,
})

const selected = await router.rank('请把扫描发票里的表格提取成可以分析的数据', [
  candidate('ocr-reader', 'Extract text from scanned images and photographs using OCR.'),
  candidate('spreadsheet-analyst', 'Analyze tables, spreadsheets, and structured business data.'),
  candidate('calendar-agent', 'Schedule meetings and manage calendar events.'),
  candidate('web-performance', 'Diagnose browser loading and interaction performance.'),
], 2)

const names = new Set(selected.map(item => item.name))
if (!names.has('ocr-reader') || !names.has('spreadsheet-analyst')) {
  throw new Error(`embedding smoke selected unexpected skills: ${selected.map(item => item.name).join(', ') || 'none'}`)
}

console.log(JSON.stringify({
  endpoint,
  model,
  selected: selected.map(({ name, score }) => ({ name, score })),
  stats: router.stats(),
}, null, 2))
