/** Batching and rendering of Lead notices (one notice per tick, injected without starting a turn). */
import { boundContextSummary, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { DecisionKind, DecisionRecord } from './types.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'team-dispatch': { kind: 'team-dispatch' } & ContextFormed
  }
}

/** Message source kind of scheduler notices. */
export const NOTICE_SOURCE_KIND = 'team-dispatch'

/**
 * One human/model-readable decision line.
 * @param decision - a decision.
 * @returns the line.
 */
export function decisionLine(decision: Pick<DecisionRecord, 'taskId' | 'kind' | 'member' | 'reason'>): string {
  const member = decision.member ?? '?'
  switch (decision.kind) {
    case 'dispatched': return `${decision.taskId} → ${member} (dispatched)`
    case 'assigned': return `${decision.taskId} → ${member} (assigned, brief not confirmed)`
    case 'deferred': return `${decision.taskId} deferred: ${decision.reason}`
    case 'released': return `${decision.taskId} released: ${decision.reason}`
    case 'stalled': return `${decision.taskId} stalled: ${decision.reason}`
    case 'failed': return `${decision.taskId} needs attention (owner ${member} kept): ${decision.reason}`
  }
}

/** Rendered notice. */
export interface Notice {
  readonly text: string
  readonly summary: string
}

/**
 * Render one notice from a tick's decisions.
 * @param decisions - decisions in order.
 * @param maxItems - maximum lines before `(n more)`.
 * @returns the notice, or undefined when there is nothing to report.
 */
export function renderNotice(decisions: readonly Pick<DecisionRecord, 'taskId' | 'kind' | 'member' | 'reason'>[], maxItems: number): Notice | undefined {
  if (decisions.length === 0) return undefined
  const shown = decisions.slice(0, Math.max(1, maxItems))
  const lines = shown.map(decision => `- ${decisionLine(decision)}`)
  const hidden = decisions.length - shown.length
  if (hidden > 0) lines.push(`(${hidden} more)`)
  const counts = new Map<DecisionKind, number>()
  for (const decision of decisions) counts.set(decision.kind, (counts.get(decision.kind) ?? 0) + 1)
  const summary = boundContextSummary(`Dispatch: ${[...counts].map(([kind, count]) => `${count} ${kind}`).join(', ')}`)
  return { text: `Dispatch queue:\n${lines.join('\n')}`, summary }
}
