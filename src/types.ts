/** Types shared by the scheduler modules (types only, no runtime code). */

/** Task priority; P0 dispatches first. */
export type Priority = 'P0' | 'P1' | 'P2' | 'P3'

/** Whether a task is eligible for automatic dispatch. */
export type DispatchMode = 'auto' | 'manual'

/** Plugin configuration. */
export interface Config {
  /** Maximum in_progress tasks owned by teammates (default 2, integer >= 1). */
  maxActive: number
  /** Dispatch mode for tasks without an item record (default `manual`). */
  defaultDispatch: DispatchMode
  /** Defer a non-read-only task whose write scopes are empty (default true). */
  requireWriteScopes: boolean
  /** Trigger debounce per Lead in milliseconds (default 200, >= 0). */
  debounceMs: number
  /** Maximum decision lines in one Lead notice (default 20, integer >= 1). */
  noticeMaxItems: number
}

/** `plugin:dsh-agent-team-scheduler/control` data. */
export interface ControlRecord {
  readonly version: 1
  readonly armed: boolean
  readonly maxActive?: number
  readonly actor: 'human'
}

/** `plugin:dsh-agent-team-scheduler/item` data: per-task dispatch metadata. */
export interface DispatchItem {
  readonly version: 1
  readonly taskId: string
  readonly priority: Priority
  /** Normalized ISO 8601 (`Date#toISOString`), or null. */
  readonly deadline: string | null
  readonly dispatch: DispatchMode
  readonly readOnly: boolean
  readonly preferredMember: string | null
}

/**
 * Decision kinds.
 * - `assigned`: the reassign committed; the brief is not yet confirmed (written before sending).
 * - `dispatched`: the brief was accepted by the Team mailbox.
 * - `deferred`: a candidate was skipped this tick (reason deduplicated).
 * - `released`: a task owned by a failed (never started) member was returned to pending.
 * - `stalled`: the owner is inactive while the task is still in_progress (report only; inactive is not completion).
 * - `failed`: an assignment or brief outcome is unknown; ownership is kept and the Lead must decide.
 */
export type DecisionKind = 'assigned' | 'dispatched' | 'deferred' | 'released' | 'stalled' | 'failed'

/** `plugin:dsh-agent-team-scheduler/decision` data. */
export interface DecisionRecord {
  readonly version: 1
  readonly taskId: string
  readonly kind: DecisionKind
  readonly member: string | null
  readonly reason: string
  /** Task revision the decision observed (used to report a stall once per revision). */
  readonly revision?: number
}

/** Per-Lead scheduler state folded from the Lead log plus our own appends. */
export interface DispatchState {
  /**
   * Whether dispatch is armed in this process. A restart (or a state rebuilt from the log in a new
   * process) starts paused even when the log's last control record armed it.
   */
  armed: boolean
  /** Armed value of the last non-inherited control record in the log. */
  armedInLog: boolean
  /** Override from `/dispatch wip <n>`. */
  maxActive: number | null
  /** By task id; the last item record wins. */
  items: Record<string, DispatchItem>
  /** Task id → last recorded deferred reason (dedupe). */
  lastDeferred: Record<string, string>
  /** Task id → task revision whose stall was already reported. */
  stalled: Record<string, number>
  /**
   * Task id → member name of an `assigned` decision without a later `dispatched` / `failed`
   * decision: the brief outcome is unknown (for example a restart between assign and send). Such
   * tasks are reported once and never re-sent.
   */
  unconfirmed: Record<string, string>
  /** Tasks with uncertain assignment/delivery; cleared only by explicit item re-enrollment. */
  held: Record<string, string>
  /** Number of skipped invalid records. */
  diagnostics: number
}

/** Plain task data consumed by the pure policy. */
export interface PolicyTask {
  readonly id: string
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  readonly ready: boolean
  /** Owner Session id from the durable Team state, when any. */
  readonly ownerId?: string | undefined
  readonly writeScopes: readonly string[]
}

/** Plain member data consumed by the pure policy. */
export interface PolicyMember {
  readonly id: string
  readonly name: string
  readonly role: 'lead' | 'teammate'
  readonly status: 'running' | 'inactive' | 'provisioning' | 'failed'
  /** Durable lifecycle phase; the Lead row is always active. */
  readonly phase: 'provisioning' | 'active' | 'failed'
}

/** One planned dispatch. */
export interface PlannedDispatch {
  readonly task: PolicyTask
  readonly member: PolicyMember
}

/** One planned deferral. */
export interface PlannedDeferral {
  readonly task: PolicyTask
  readonly reason: string
}

/** Result of planning one tick. */
export interface DispatchPlan {
  readonly releases: readonly PolicyTask[]
  readonly stalls: readonly { readonly task: PolicyTask; readonly member: PolicyMember }[]
  readonly dispatches: readonly PlannedDispatch[]
  readonly deferrals: readonly PlannedDeferral[]
  readonly active: number
  readonly limit: number
}
