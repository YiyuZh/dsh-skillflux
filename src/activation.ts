import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { isModelInvocable, type SkillDefinition } from '@deepseek-ai/dsh-skill'
import { candidateGovernanceReason } from './approval.js'
import type { SkillCache } from './cache.js'
import { cacheCandidates } from './router.js'
import { ExpiredAgentStateError, skillLookup, type AgentState } from './state.js'
import type { UsageStore } from './usage.js'
import type {
  CacheEntry,
  MountedSkill,
  ResolvedSkillFluxConfig,
  SkillFluxCandidate,
  SkillUsageIdentity,
} from './types.js'

export interface CacheProcessLockRelease {
  (): Promise<void>
  readonly signal: AbortSignal
}

export interface ActivationHost {
  readonly config: ResolvedSkillFluxConfig
  readonly cache: SkillCache
  readonly runtimeCtx: Context
  readonly usage: UsageStore | undefined
  readonly trustedBySession: WeakMap<Session, Set<string>>
  readonly cachePruneSessions: WeakSet<Session>
  mcpReader(serverLabel: string, uri: string, signal?: AbortSignal): Promise<Buffer>
  trackUsage(operation: Promise<void> | undefined): void
  acquireCacheLease(): Promise<CacheProcessLockRelease>
  trackActiveLeaseCleanup(operation: () => Promise<void>): Promise<void>
  assertCapacity(state: AgentState, name: string): void
  assertCatalogBudget(state: AgentState, skill: Pick<SkillDefinition, 'name' | 'description'>): void
  assertMountCurrent(state: AgentState, generation: number, name: string, mountEpoch: number): void
  rememberRouting(state: AgentState, mounted: MountedSkill): void
  recordMountTelemetry(state: AgentState, mounted: MountedSkill): void
  scheduleAutoPrune(): void
}

export function usageIdentity(mounted: MountedSkill): SkillUsageIdentity {
  return {
    candidateId: mounted.candidateId,
    name: mounted.name,
    origin: mounted.origin,
    source: mounted.source,
    ...(mounted.cacheId === undefined ? {} : { cacheId: mounted.cacheId }),
  }
}

export async function activateCandidate(
  host: ActivationHost,
  state: AgentState,
  candidate: SkillFluxCandidate,
  signal?: AbortSignal,
  expectedGeneration = state.generation,
  expectedMountEpoch = state.mountEpochs.get(candidate.name) ?? 0,
): Promise<MountedSkill> {
  signal?.throwIfAborted()
  host.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch)
  const governanceReason = candidateGovernanceReason(candidate, host.config)
  if (governanceReason !== undefined) throw new Error(`SkillFlux mount denied: ${governanceReason}`)
  const current = state.active.get(candidate.name)
  if (current !== undefined) return current
  host.assertCapacity(state, candidate.name)
  host.assertCatalogBudget(state, candidate)
  const lookup = skillLookup(state.agent, signal)
  if (candidate.origin === 'registry') {
    const definition = await host.runtimeCtx.skills.get(candidate.name, lookup)
    signal?.throwIfAborted()
    host.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch)
    if (definition === undefined) throw new Error(`skill "${candidate.name}" is no longer available`)
    if (definition.source !== candidate.summary.source || definition.provider !== candidate.summary.provider) {
      throw new Error(`skill candidate "${candidate.name}" expired because its provider changed; search again`)
    }
    if (!isModelInvocable(definition)) throw new Error(`skill "${candidate.name}" is no longer model-invocable`)
    const raced = state.active.get(definition.name)
    if (raced !== undefined) return raced
    host.assertCapacity(state, definition.name)
    host.assertCatalogBudget(state, definition)
    const mounted: MountedSkill = {
      candidateId: candidate.id,
      name: candidate.name,
      origin: 'registry',
      source: definition.source,
      selection: candidate.selection ?? 'manual',
      score: candidate.score,
      ...(candidate.baseScore === undefined ? {} : { baseScore: candidate.baseScore }),
      ...(candidate.adaptiveBoost === undefined ? {} : { adaptiveBoost: candidate.adaptiveBoost }),
      definition,
    }
    state.active.set(candidate.name, mounted)
    host.rememberRouting(state, mounted)
    host.trackUsage(host.usage?.recordMount(usageIdentity(mounted)))
    host.recordMountTelemetry(state, mounted)
    return mounted
  }

  const releaseLease = await host.acquireCacheLease()
  const cacheSignal = releaseLease.signal === undefined
    ? signal
    : signal === undefined
      ? releaseLease.signal
      : AbortSignal.any([signal, releaseLease.signal])
  try {
    let entry: CacheEntry
    if (candidate.origin === 'cache') {
      const cached = await host.cache.get(candidate.cacheId)
      cacheSignal?.throwIfAborted()
      host.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch)
      if (cached === undefined) throw new Error(`cache entry "${candidate.cacheId}" no longer exists`)
      const currentCachedCandidate = cacheCandidates([cached])[0]
      if (currentCachedCandidate === undefined) throw new Error(`cache entry "${candidate.cacheId}" is invalid`)
      const currentGovernanceReason = candidateGovernanceReason(currentCachedCandidate, host.config)
      if (currentGovernanceReason !== undefined) {
        throw new Error(`SkillFlux mount denied: ${currentGovernanceReason}`)
      }
      entry = cached
    } else if (candidate.origin === 'mcp') {
      entry = await host.cache.installMcp(
        candidate,
        (uri, readSignal) => host.mcpReader(candidate.serverLabel, uri, readSignal),
        cacheSignal,
      )
      cacheSignal?.throwIfAborted()
      host.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch)
    } else {
      entry = await host.cache.install(candidate, cacheSignal)
      cacheSignal?.throwIfAborted()
      host.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch)
    }
    const definition = await host.cache.load(entry, cacheSignal)
    cacheSignal?.throwIfAborted()
    host.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch)
    if (!isModelInvocable(definition)) throw new Error(`skill "${definition.name}" is not model-invocable`)
    const raced = state.active.get(definition.name)
    if (raced !== undefined) {
      await releaseLease()
      cacheSignal?.throwIfAborted()
      host.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch)
      if (state.active.get(raced.name) !== raced) throw new ExpiredAgentStateError()
      return raced
    }
    host.assertCapacity(state, definition.name)
    host.assertCatalogBudget(state, definition)
    host.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch)
    const releaseActiveLease = await host.cache.createActiveLease(entry.manifest.cacheId)
    try {
      cacheSignal?.throwIfAborted()
      host.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch)
    } catch (error: unknown) {
      await host.trackActiveLeaseCleanup(releaseActiveLease)
      throw error
    }
    let dispose: () => void
    try {
      dispose = host.runtimeCtx.skills.register({
        name: definition.name,
        description: definition.description,
        ...(definition.whenToUse === undefined ? {} : { whenToUse: definition.whenToUse }),
        invocation: definition.invocation,
        source: 'runtime',
        provider: 'skillflux-cache',
        ...(definition.resourceBase === undefined ? {} : { resourceBase: definition.resourceBase }),
        ...(definition.path === undefined ? {} : { path: definition.path }),
        ...(definition.metadata === undefined ? {} : { metadata: definition.metadata }),
        content: definition.content,
      })
    } catch (error: unknown) {
      await host.trackActiveLeaseCleanup(releaseActiveLease)
      throw error
    }
    let activeCleanupTask: Promise<void> | undefined
    let runtimeDisposed = false
    const disposeMounted = () => {
      if (runtimeDisposed) return
      runtimeDisposed = true
      try {
        dispose()
      } finally {
        activeCleanupTask = host.trackActiveLeaseCleanup(releaseActiveLease)
      }
    }
    state.disposers.set(definition.name, disposeMounted)
    const mounted: MountedSkill = {
      candidateId: candidate.id,
      name: definition.name,
      origin: candidate.origin,
      source: candidate.source,
      cacheId: entry.manifest.cacheId,
      selection: candidate.selection ?? 'manual',
      score: candidate.score,
      ...(candidate.baseScore === undefined ? {} : { baseScore: candidate.baseScore }),
      ...(candidate.adaptiveBoost === undefined ? {} : { adaptiveBoost: candidate.adaptiveBoost }),
      definition,
    }
    state.active.set(definition.name, mounted)
    try {
      await releaseLease()
      cacheSignal?.throwIfAborted()
      host.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch)
      if (state.active.get(mounted.name) !== mounted) throw new ExpiredAgentStateError()
    } catch (error: unknown) {
      if (state.active.get(mounted.name) === mounted) {
        state.active.delete(mounted.name)
        if (state.disposers.get(mounted.name) === disposeMounted) state.disposers.delete(mounted.name)
        try {
          disposeMounted()
        } catch (disposeError: unknown) {
          host.runtimeCtx.logger.warn(`SkillFlux cancelled mount rollback failed: ${errorMessage(disposeError)}`)
        }
        if (activeCleanupTask !== undefined) await activeCleanupTask
      }
      throw error
    }
    host.rememberRouting(state, mounted)
    host.trackUsage(host.usage?.recordMount(usageIdentity(mounted)))
    host.recordMountTelemetry(state, mounted)
    if (candidate.origin === 'remote' || candidate.origin === 'mcp') {
      host.cachePruneSessions.add(state.agent.session)
      host.scheduleAutoPrune()
      if (host.config.approvalPolicy === 'session') {
        let trusted = host.trustedBySession.get(state.agent.session)
        if (trusted === undefined) {
          trusted = new Set()
          host.trustedBySession.set(state.agent.session, trusted)
        }
        trusted.add(candidate.source)
      }
    }
    return mounted
  } finally {
    await releaseLease()
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
