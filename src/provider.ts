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
  /** The current turn catalog: metadata-only candidates plus discovery completeness. */
  catalog(): SkillFluxCatalog
  /** Lazily download, verify, and load the body through a same-name fallback chain. */
  load(candidates: readonly SkillFluxCandidate[], signal?: AbortSignal): Promise<SkillDefinition>
}

export interface SkillFluxLocator {
  readonly brand: 'skillflux'
  /** Ordered same-name candidates; the first entry is the listed winner. */
  readonly candidates: readonly SkillFluxCandidate[]
}

function locatorFor(candidates: readonly SkillFluxCandidate[]): SkillFluxLocator {
  return Object.freeze({
    brand: 'skillflux',
    candidates: Object.freeze(candidates.map(candidate => Object.freeze({ ...candidate }))),
  })
}

function readLocator(candidate: SkillCandidate): readonly SkillFluxCandidate[] | undefined {
  const locator = candidate.locator as Partial<SkillFluxLocator> | undefined
  if (typeof locator !== 'object' || locator === null || locator.brand !== 'skillflux') return undefined
  const chain = locator.candidates
  if (!Array.isArray(chain) || chain.length === 0) return undefined
  const winner = chain[0]
  if (typeof winner !== 'object' || winner === null || winner.name !== candidate.name) return undefined
  return chain as readonly SkillFluxCandidate[]
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
    const catalog = this.host.catalog()
    const groups = new Map<string, SkillFluxCandidate[]>()
    for (const candidate of catalog.candidates) {
      const chain = groups.get(candidate.name) ?? []
      chain.push(candidate)
      groups.set(candidate.name, chain)
    }
    const candidates = [...groups.values()].map((chain, rank) => this.summary(chain, rank))
    return catalog.complete ? candidates : { candidates, complete: false }
  }

  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    options.signal?.throwIfAborted()
    this.control.signal.throwIfAborted()
    if (candidate.provider !== this.name) {
      throw new Error(`SkillFlux provider received a candidate owned by "${candidate.provider}"`)
    }
    const chain = readLocator(candidate)
    if (chain === undefined) throw new Error('SkillFlux candidate locator is unknown or expired')
    return await this.host.load(chain, options.signal)
  }

  private summary(chain: readonly SkillFluxCandidate[], rank: number): SkillCandidate {
    const candidate = chain[0]!
    return {
      name: candidate.name,
      description: candidate.description,
      invocation: { modelInvocable: true, userInvocable: false },
      source: SKILLFLUX_PROVIDER,
      provider: this.name,
      rank: SKILLFLUX_PROVIDER_RANK + rank,
      locator: locatorFor(chain),
    }
  }
}

export interface SkillFluxProviderHandle {
  invalidate(): void
  dispose(): void
}

export class SkillFluxProviderManager {
  private readonly handles = new WeakMap<Agent, SkillFluxProviderHandle>()
  private readonly active = new Set<SkillFluxProviderHandle>()

  constructor(
    private readonly host: (agent: Agent) => SkillFluxProviderHost,
    private readonly warn: (message: string) => void,
  ) {}

  /** Register one agent-scoped provider if absent. Fails open on registration errors. */
  register(agent: Agent): boolean {
    if (this.handles.has(agent)) return true
    let control: SkillProviderControl | undefined
    try {
      const dispose = agent.ctx.skills.registerProvider(registration => {
        control = registration
        return new SkillFluxProvider(registration, this.host(agent))
      })
      if (control === undefined) {
        dispose()
        throw new Error('SkillFlux provider registration did not produce a provider')
      }
      let disposed = false
      const handle: SkillFluxProviderHandle = {
        invalidate: () => { control?.invalidate() },
        dispose: () => {
          if (disposed) return
          disposed = true
          this.active.delete(handle)
          this.handles.delete(agent)
          dispose()
        },
      }
      this.handles.set(agent, handle)
      this.active.add(handle)
      return true
    } catch (error: unknown) {
      this.warn(`SkillFlux provider registration failed open: ${errorMessage(error)}`)
      return false
    }
  }

  invalidate(agent: Agent): void {
    this.handles.get(agent)?.invalidate()
  }

  /**
   * Resolve and lazily load one published name directly. The registry merges
   * runtime entries above provider candidates, so a same-name runtime entry
   * would otherwise shadow the provider's own get() for the filtered tool.
   */
  async load(agent: Agent, name: string, signal?: AbortSignal): Promise<SkillDefinition | undefined> {
    if (!this.handles.has(agent)) return undefined
    const host = this.host(agent)
    const chain = host.catalog().candidates.filter(candidate => candidate.name === name)
    if (chain.length === 0) return undefined
    return await host.load(chain, signal)
  }

  dispose(agent: Agent): void {
    this.handles.get(agent)?.dispose()
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
