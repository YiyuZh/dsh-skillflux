import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { MountedSkill, RoutingTrace, SkillFluxCandidate, SkillFluxCatalog } from './types.js'

export interface AgentState {
  readonly agent: Agent
  turn?: number
  generation: number
  readonly mountEpochs: Map<string, number>
  readonly active: Map<string, MountedSkill>
  readonly disposers: Map<string, () => void>
  readonly candidates: Map<string, SkillFluxCandidate>
  published: SkillFluxCatalog
  lastRouting: RoutingTrace[]
}

export class ExpiredAgentStateError extends Error {
  constructor() {
    super('SkillFlux mount expired because its turn or agent lifecycle ended')
    this.name = 'ExpiredAgentStateError'
  }
}

export type StateWarning = (message: string) => void

export function skillLookup(agent: Agent, signal?: AbortSignal): { cwd?: string; scope: Agent; signal?: AbortSignal } {
  return {
    ...(agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd }),
    scope: agent,
    ...(signal === undefined ? {} : { signal }),
  }
}

export class TurnStateRegistry {
  private readonly stateByAgent = new WeakMap<Agent, AgentState>()
  private readonly states = new Set<AgentState>()

  constructor(private readonly warn: StateWarning) {}

  state(agent: Agent): AgentState {
    let state = this.stateByAgent.get(agent)
    if (state === undefined) {
      state = {
        agent,
        generation: 0,
        mountEpochs: new Map(),
        active: new Map(),
        disposers: new Map(),
        candidates: new Map(),
        published: { candidates: [], complete: true },
        lastRouting: [],
      }
      this.stateByAgent.set(agent, state)
      this.states.add(state)
    }
    return state
  }

  peek(agent: Agent): AgentState | undefined {
    return this.stateByAgent.get(agent)
  }

  candidate(agent: Agent, candidateId: string): SkillFluxCandidate | undefined {
    return this.stateByAgent.get(agent)?.candidates.get(candidateId)
  }

  active(agent: Agent, name: string): MountedSkill | undefined {
    return this.stateByAgent.get(agent)?.active.get(name)
  }

  mounted(agent: Agent): readonly MountedSkill[] {
    return [...(this.stateByAgent.get(agent)?.active.values() ?? [])]
  }

  lastRouting(agent: Agent): readonly RoutingTrace[] {
    return (this.stateByAgent.get(agent)?.lastRouting ?? []).map(trace => ({ ...trace }))
  }

  beginTurn(agent: Agent, turn: number): AgentState {
    const state = this.state(agent)
    if (state.turn !== turn) {
      this.cleanupState(state, false)
      state.turn = turn
      state.candidates.clear()
      state.published = { candidates: [], complete: true }
      state.lastRouting = []
    }
    return state
  }

  cleanupState(state: AgentState, forget: boolean): void {
    state.generation += 1
    for (const dispose of [...state.disposers.values()].reverse()) {
      try {
        dispose()
      } catch (error: unknown) {
        this.warn(`SkillFlux unmount failed: ${errorMessage(error)}`)
      }
    }
    state.disposers.clear()
    state.active.clear()
    state.mountEpochs.clear()
    state.published = { candidates: [], complete: true }
    if (forget) {
      state.candidates.clear()
      this.states.delete(state)
      this.stateByAgent.delete(state.agent)
    }
  }

  cleanupAll(): void {
    for (const state of this.states) this.cleanupState(state, true)
  }

  cleanupSession(session: Session): void {
    for (const state of this.states) {
      if (state.agent.session !== session) continue
      this.cleanupState(state, false)
      state.candidates.clear()
    }
  }

  disposeSession(session: Session): void {
    for (const state of this.states) {
      if (state.agent.session === session) this.cleanupState(state, true)
    }
  }

  disposeAgent(agent: Agent): Session | undefined {
    const state = this.stateByAgent.get(agent)
    const session = state?.agent.session
    if (state !== undefined) this.cleanupState(state, true)
    this.stateByAgent.delete(agent)
    if (session !== undefined && ![...this.states].some(item => item.agent.session === session)) {
      return session
    }
    return undefined
  }

  assertStateCurrent(state: AgentState, generation: number): void {
    if (state.generation !== generation || this.stateByAgent.get(state.agent) !== state) {
      throw new ExpiredAgentStateError()
    }
  }

  assertMountCurrent(state: AgentState, generation: number, name: string, mountEpoch: number): void {
    this.assertStateCurrent(state, generation)
    if ((state.mountEpochs.get(name) ?? 0) !== mountEpoch) throw new ExpiredAgentStateError()
  }

  rememberRouting(state: AgentState, mounted: MountedSkill): void {
    const trace: RoutingTrace = {
      ...(state.turn === undefined ? {} : { turn: state.turn }),
      candidateId: mounted.candidateId,
      name: mounted.name,
      origin: mounted.origin,
      source: mounted.source,
      selection: mounted.selection,
      outcome: 'mounted',
      score: mounted.score,
      ...(mounted.baseScore === undefined ? {} : { baseScore: mounted.baseScore }),
      ...(mounted.adaptiveBoost === undefined ? {} : { adaptiveBoost: mounted.adaptiveBoost }),
    }
    const index = state.lastRouting.findIndex(item => item.candidateId === trace.candidateId)
    if (index === -1) state.lastRouting.push(trace)
    else state.lastRouting[index] = trace
  }

  markRoutingOutcome(state: AgentState, candidateId: string, outcome: RoutingTrace['outcome']): void {
    const index = state.lastRouting.findIndex(item => item.candidateId === candidateId)
    const trace = state.lastRouting[index]
    if (index !== -1 && trace !== undefined) state.lastRouting[index] = { ...trace, outcome }
  }

  activeCacheIds(): Set<string> {
    const activeIds = new Set<string>()
    for (const state of this.states) {
      for (const item of state.active.values()) if (item.cacheId !== undefined) activeIds.add(item.cacheId)
    }
    return activeIds
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
