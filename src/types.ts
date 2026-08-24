import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'

export type ApprovalPolicy = 'always' | 'session' | 'automatic'
export type RemoteDiscovery = 'automatic' | 'on-demand' | 'off'
export type CandidateOrigin = 'registry' | 'cache' | 'remote'

export interface RouteRule {
  matchAll?: string[]
  matchAny?: string[]
  skills: string[]
}

export interface SkillFluxConfig {
  readonly maxActiveSkills?: number
  readonly minRouteScore?: number
  readonly approvalPolicy?: ApprovalPolicy
  readonly remoteDiscovery?: RemoteDiscovery
  readonly remoteSearchLimit?: number
  readonly remoteSearchTimeoutMs?: number
  readonly catalogDescriptionMaxLength?: number
  readonly maxSkillFiles?: number
  readonly maxSkillBytes?: number
  readonly installTimeoutMs?: number
  readonly routes?: RouteRule[]
}

export interface ResolvedSkillFluxConfig {
  readonly maxActiveSkills: number
  readonly minRouteScore: number
  readonly approvalPolicy: ApprovalPolicy
  readonly remoteDiscovery: RemoteDiscovery
  readonly remoteSearchLimit: number
  readonly remoteSearchTimeoutMs: number
  readonly catalogDescriptionMaxLength: number
  readonly maxSkillFiles: number
  readonly maxSkillBytes: number
  readonly installTimeoutMs: number
  readonly routes: readonly RouteRule[]
}

export interface RegistryCandidate {
  readonly id: string
  readonly origin: 'registry'
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly source: string
  readonly score: number
  readonly summary: SkillSummary
}

export interface CachedCandidate {
  readonly id: string
  readonly origin: 'cache'
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly source: string
  readonly ref: string
  readonly score: number
  readonly cacheId: string
  readonly installs?: number
}

export interface RemoteCandidate {
  readonly id: string
  readonly origin: 'remote'
  readonly name: string
  readonly description: string
  readonly source: string
  readonly ref: string
  readonly score: number
  readonly skillId: string
  readonly installs: number
}

export type SkillFluxCandidate = RegistryCandidate | CachedCandidate | RemoteCandidate

export interface MountedSkill {
  readonly name: string
  readonly origin: CandidateOrigin
  readonly source: string
  readonly cacheId?: string
  readonly definition: SkillDefinition
}

export interface CacheManifest {
  readonly version: 1
  readonly cacheId: string
  readonly source: string
  readonly ref: string
  readonly skillId: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly installs?: number
  readonly installedAt: string
  readonly fileCount: number
  readonly totalBytes: number
  readonly contentHash: string
}

export interface CacheEntry {
  readonly manifest: CacheManifest
  readonly directory: string
}
