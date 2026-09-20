import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
  SkillProviderObservation,
} from '@deepseek-ai/dsh-skill'
import type { SkillFluxCandidate, SkillFluxCatalog } from './types.js'

export const SKILLFLUX_PROVIDER = 'skillflux'
/**
 * Provider candidates rank above the registry's runtime entries (rank 250) so
 * an existing runtime contribution keeps winning duplicate names for generic
 * registry consumers, while SkillFlux's own filtered tool still resolves the
 * published candidate through the manager's direct load.
 */
export const SKILLFLUX_PROVIDER_RANK = 300

export interface SkillFluxProviderHost {
  /** The published turn catalog for one lookup scope; the scope is the agent. */
  catalog(scope: unknown): SkillFluxCatalog
  /** Lazily download, verify, and load the body through a same-name fallback chain. */
  load(agent: Agent, candidates: readonly SkillFluxCandidate[], signal?: AbortSignal): Promise<SkillDefinition>
}

export interface SkillFluxLocator {
  readonly brand: 'skillflux'
  /** The agent whose turn published the candidates; carries lazy-load ownership. */
  readonly agent: Agent
  /** Ordered same-name candidates; the first entry is the listed winner. */
  readonly candidates: readonly SkillFluxCandidate[]
}

function locatorFor(agent: Agent, candidates: readonly SkillFluxCandidate[]): SkillFluxLocator {
  return Object.freeze({
    brand: 'skillflux',
    agent,
    candidates: Object.freeze(candidates.map(candidate => Object.freeze({ ...candidate }))),
  })
}

function readLocator(candidate: SkillCandidate): SkillFluxLocator | undefined {
  const locator = candidate.locator as Partial<SkillFluxLocator> | undefined
  if (typeof locator !== 'object' || locator === null || locator.brand !== 'skillflux') return undefined
  if (typeof locator.agent !== 'object' || locator.agent === null) return undefined
  const chain = locator.candidates
  if (!Array.isArray(chain) || chain.length === 0) return undefined
  const winner = chain[0]
  if (typeof winner !== 'object' || winner === null || winner.name !== candidate.name) return undefined
  return locator as SkillFluxLocator
}

export class SkillFluxProvider implements SkillProvider {
  readonly name = SKILLFLUX_PROVIDER

  constructor(
    private readonly control: SkillProviderControl,
    private readonly host: SkillFluxProviderHost,
  ) {}

  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[] | SkillProviderObservation> {
    options.signal?.throwIfAborted()
    this.control.signal.throwIfAborted()
    // The registry borrows the full view options through to the provider; the
    // agent is its own scope key. Agent-scoped catalogs resolve from this
    // runtime scope because a host-mounted provider cannot register per agent.
    const scope = (options as { scope?: unknown }).scope
    const catalog = this.host.catalog(scope)
    const groups = new Map<string, SkillFluxCandidate[]>()
    for (const candidate of catalog.candidates) {
      const chain = groups.get(candidate.name) ?? []
      chain.push(candidate)
      groups.set(candidate.name, chain)
    }
    const candidates = [...groups.values()].map((chain, rank) => this.summary(scope, chain, rank))
    return catalog.complete ? candidates : { candidates, complete: false }
  }

  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    options.signal?.throwIfAborted()
    this.control.signal.throwIfAborted()
    if (candidate.provider !== this.name) {
      throw new Error(`SkillFlux provider received a candidate owned by "${candidate.provider}"`)
    }
    const locator = readLocator(candidate)
    if (locator === undefined) throw new Error('SkillFlux candidate locator is unknown or expired')
    return await this.host.load(locator.agent, locator.candidates, options.signal)
  }

  private summary(scope: unknown, chain: readonly SkillFluxCandidate[], rank: number): SkillCandidate {
    const candidate = chain[0]!
    return {
      name: candidate.name,
      description: candidate.description,
      invocation: { modelInvocable: true, userInvocable: false },
      source: SKILLFLUX_PROVIDER,
      provider: this.name,
      rank: SKILLFLUX_PROVIDER_RANK + rank,
      locator: locatorFor(scope as Agent, chain),
    }
  }
}

export interface SkillProviderRegistry {
  registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void
}

export class SkillFluxProviderManager {
  private control: SkillProviderControl | undefined
  private registered = false

  constructor(
    private readonly host: SkillFluxProviderHost,
    private readonly warn: (message: string) => void,
  ) {}

  /**
   * Register one host-level provider. Agent isolation lives in list(), where
   * the registry passes the viewing agent as the runtime scope; a scoped
   * agent context does not expose `ctx.skills` for per-agent registration.
   * Fails open on registration errors.
   */
  install(skills: SkillProviderRegistry): boolean {
    if (this.registered) return true
    try {
      skills.registerProvider(control => {
        this.control = control
        return new SkillFluxProvider(control, this.host)
      })
      this.registered = true
      return true
    } catch (error: unknown) {
      this.warn(`SkillFlux provider registration failed open: ${errorMessage(error)}`)
      return false
    }
  }

  invalidate(): void {
    this.control?.invalidate()
  }

  /**
   * Resolve and lazily load one published name directly. The registry merges
   * runtime entries above provider candidates, so a same-name runtime entry
   * would otherwise shadow the provider's own get() for the filtered tool.
   */
  async load(agent: Agent, name: string, signal?: AbortSignal): Promise<SkillDefinition | undefined> {
    const chain = this.host.catalog(agent).candidates.filter(candidate => candidate.name === name)
    if (chain.length === 0) return undefined
    return await this.host.load(agent, chain, signal)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
