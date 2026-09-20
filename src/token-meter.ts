import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { catalogEntryLine, estimateTextTokens } from './catalog.js'
import type { TokenEstimatorKind } from './types.js'

export interface TokenMeterMeasurement {
  readonly totalTokens: number
  readonly surfaceTokens: number
  readonly surfaceDeltaTokens: number
  readonly baseline: {
    readonly kind: 'none' | 'estimated' | 'usage'
    readonly tokens: number
    readonly usage?: unknown
  }
  readonly nodes: readonly {
    readonly seq: unknown
    readonly tokens: number
    readonly heuristicTokens: number
  }[]
}

/**
 * Structural face of the optional `@deepseek-ai/dsh-token-meter` service. The
 * package is intentionally not a dependency; the Cordis service is resolved at
 * runtime and never required.
 */
export interface TokenMeterLike {
  estimateMessage(message: unknown): number
  measure?(session: unknown, requestHeader?: unknown): TokenMeterMeasurement
}

export interface TokenEstimate {
  readonly tokens: number
  readonly estimator: TokenEstimatorKind
}

/**
 * Resolve the optional token-meter service. Missing, untyped, or throwing
 * lookups resolve to undefined so every consumer can fall back safely.
 */
export function resolveTokenMeter(ctx: Context): TokenMeterLike | undefined {
  try {
    const meter = ctx.get('tokenMeter') as TokenMeterLike | undefined
    if (meter === undefined || typeof meter.estimateMessage !== 'function') return undefined
    return meter
  } catch {
    return undefined
  }
}

/** Price one plain-text segment with the meter, falling back portably. */
export function estimateWithMeter(meter: TokenMeterLike | undefined, text: string): TokenEstimate {
  if (text.length === 0) {
    return { tokens: 0, estimator: meter === undefined ? 'portable' : 'token-meter' }
  }
  if (meter !== undefined) {
    try {
      const tokens = meter.estimateMessage(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
      if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0) {
        return { tokens: Math.ceil(tokens), estimator: 'token-meter' }
      }
    } catch {
      // A failing meter degrades to the portable estimate.
    }
  }
  return { tokens: estimateTextTokens(text), estimator: 'portable' }
}

/**
 * Sum the per-entry rendered catalog lines. The estimator is native only when
 * every line was priced by the meter; any fallback downgrades the label.
 */
export function estimateCatalogEntries(
  meter: TokenMeterLike | undefined,
  skills: readonly { readonly name: string; readonly description: string }[],
  maxLength: number,
): TokenEstimate {
  const estimates = skills.map(skill =>
    estimateWithMeter(meter, catalogEntryLine(skill, maxLength)))
  const tokens = estimates.reduce((total, estimate) => total + estimate.tokens, 0)
  const estimator = meter !== undefined && estimates.every(estimate => estimate.estimator === 'token-meter')
    ? 'token-meter'
    : 'portable'
  return { tokens: Math.min(Number.MAX_SAFE_INTEGER, tokens), estimator }
}

