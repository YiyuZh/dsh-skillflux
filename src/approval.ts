import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { remoteTrustPolicyAllows } from './remote-governance.js'
import type {
  CachedCandidate,
  McpCandidate,
  RemoteCandidate,
  RemoteTrustLevel,
  ResolvedSkillFluxConfig,
  SkillFluxCandidate,
} from './types.js'

export const MOUNT_TOOL = 'skillflux_mount'
const SKILL_TOOL = 'skill'

export interface ApprovalHost {
  readonly config: ResolvedSkillFluxConfig
  readonly trustedBySession: WeakMap<Session, Set<string>>
  candidate(agent: Agent, candidateId: string): SkillFluxCandidate | undefined
  /** The published lazy candidate behind a `skill` call, when one exists. */
  publishedCandidate(agent: Agent, name: string): SkillFluxCandidate | undefined
}

function repositoryOwner(source: string): string {
  return source.split('/')[0]?.toLocaleLowerCase('en-US') ?? ''
}

/**
 * Re-evaluate persisted evidence against the current owner configuration.
 * Legacy cache manifests are treated as community evidence because their
 * immutable commit and complete installed-directory hash are still known.
 */
export function currentCandidateTrust(
  candidate: CachedCandidate | RemoteCandidate | McpCandidate,
  config: ResolvedSkillFluxConfig,
): RemoteTrustLevel {
  if (candidate.origin === 'mcp') {
    return config.mcpTrustedServers.includes(candidate.serverLabel.toLocaleLowerCase('en-US'))
      ? 'trusted'
      : 'community'
  }
  const owner = repositoryOwner(candidate.source)
  if (config.remoteTrustedOwners.includes(owner)) return 'trusted'
  const sources = new Set(candidate.discoverySources ?? [])
  const contentPinned = candidate.origin === 'cache' || candidate.skillFileHash !== undefined
  // Legacy cache entries have no label, but they still have an immutable ref
  // and installed-directory hash. Keep the documented conservative fallback.
  if (candidate.origin === 'cache' && candidate.trustLevel === undefined) return 'community'
  if (candidate.trustLevel === 'corroborated') return 'corroborated'
  if (candidate.trustLevel === 'community') return 'community'
  // An explicit persisted `unverified` label may come from an `open` install.
  // Once installed, pinned-source and complete-directory verification establish
  // the same minimum provenance used for community evidence.
  return sources.size >= 2 && contentPinned
    ? 'corroborated'
    : contentPinned
      ? 'community'
      : 'unverified'
}

export function candidateGovernanceReason(
  candidate: SkillFluxCandidate,
  config: ResolvedSkillFluxConfig,
): string | undefined {
  if (candidate.origin === 'registry') return undefined
  if (candidate.origin === 'mcp') {
    const label = candidate.serverLabel.toLocaleLowerCase('en-US')
    if (config.mcpBlockedServers.includes(label)) {
      return `MCP server "${candidate.serverLabel}" is blocked by mcpBlockedServers`
    }
    const trustLevel = currentCandidateTrust(candidate, config)
    if (!remoteTrustPolicyAllows(trustLevel, config.remoteTrustPolicy)) {
      return `MCP candidate evidence level "${trustLevel}" does not satisfy remoteTrustPolicy "${config.remoteTrustPolicy}"`
    }
    return undefined
  }
  const owner = repositoryOwner(candidate.source)
  if (config.remoteBlockedOwners.includes(owner)) {
    return `repository owner "${owner}" is blocked by remoteBlockedOwners`
  }
  const trustLevel = currentCandidateTrust(candidate, config)
  if (!remoteTrustPolicyAllows(trustLevel, config.remoteTrustPolicy)) {
    return `candidate evidence level "${trustLevel}" does not satisfy remoteTrustPolicy "${config.remoteTrustPolicy}"`
  }
  return undefined
}

export function registerApprovalGate(ctx: Context, host: ApprovalHost): void {
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.name === MOUNT_TOOL) {
      const downstream = await next()
      if (downstream.kind !== 'allow') return downstream
      const agent = exec.agent
      const id = (exec.arguments as { candidateId?: unknown }).candidateId
      if (agent === undefined || typeof id !== 'string') return { kind: 'deny', reason: 'invalid SkillFlux mount request' }
      const candidate = host.candidate(agent, id)
      if (candidate === undefined) return { kind: 'deny', reason: 'SkillFlux candidate id is unknown or expired' }
      const governanceReason = candidateGovernanceReason(candidate, host.config)
      if (governanceReason !== undefined) return { kind: 'deny', reason: `SkillFlux mount denied: ${governanceReason}` }
      if ((candidate.origin !== 'remote' && candidate.origin !== 'mcp')
        || host.config.approvalPolicy === 'automatic') return downstream
      const trusted = host.trustedBySession.get(agent.session)
      if (host.config.approvalPolicy === 'session' && trusted?.has(candidate.source) === true) return downstream
      return {
        kind: 'ask',
        reason: candidate.origin === 'remote'
          ? `Install remote skill ${candidate.skillId} from ${candidate.source} at immutable commit ${candidate.ref}?`
          : `Load MCP skill ${candidate.name} from server ${candidate.source} at content-bound digests ${candidate.contentBoundKey.slice(0, 12)}?`,
      }
    }
    if (exec.name !== SKILL_TOOL) return await next()
    const downstream = await next()
    if (downstream.kind !== 'allow') return downstream
    const agent = exec.agent
    if (agent === undefined) return downstream
    const name = (exec.arguments as { name?: unknown }).name
    if (typeof name !== 'string' || !isSkillName(name)) return downstream
    const candidate = host.publishedCandidate(agent, name)
    if (candidate === undefined) return downstream
    const governanceReason = candidateGovernanceReason(candidate, host.config)
    if (governanceReason !== undefined) return { kind: 'deny', reason: `SkillFlux mount denied: ${governanceReason}` }
    if ((candidate.origin !== 'remote' && candidate.origin !== 'mcp')
      || host.config.approvalPolicy === 'automatic') return downstream
    const trusted = host.trustedBySession.get(agent.session)
    if (host.config.approvalPolicy === 'session' && trusted?.has(candidate.source) === true) return downstream
    return {
      kind: 'ask',
      reason: candidate.origin === 'remote'
        ? `Install remote skill ${candidate.skillId} from ${candidate.source} at immutable commit ${candidate.ref}?`
        : `Load MCP skill ${candidate.name} from server ${candidate.source} at content-bound digests ${candidate.contentBoundKey.slice(0, 12)}?`,
    }
  })
}
