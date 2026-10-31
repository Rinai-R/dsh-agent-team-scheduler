/**
 * Per-Lead in-memory DispatchState: folded once from the Lead log (via `sessionQuery`), then
 * kept current by applying our own appended records.
 */
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { CONTROL_RECORD, DECISION_RECORD, ITEM_RECORD, readSchedulerRecord, type SchedulerRecord } from './records.js'
import type { DispatchState } from './types.js'

/** Live scheduler state plus in-memory-only dispatch bookkeeping. */
export interface LiveDispatchState extends DispatchState {
  /** Task id → task revision of our dispatch whose owner has not been seen running yet. */
  awaitingStart: Record<string, { readonly revision: number; readonly memberId: string }>
}

/**
 * Empty state.
 * @returns a fresh, unarmed state.
 */
export function emptyState(): LiveDispatchState {
  return { armed: false, armedInLog: false, maxActive: null, items: {}, lastDeferred: {}, stalled: {}, unconfirmed: {}, held: {}, diagnostics: 0, awaitingStart: {} }
}

/** How a record reaches the state. */
export type RecordOrigin = 'live' | 'restored' | 'inherited'

/**
 * Apply one validated record to a state (mutates `state`).
 * - Every scheduler record inside the fork-inherited prefix is ignored: a forked root has its own
 *   Team whose task ids restart at `task-1`, so ancestor items/decisions must not leak into it, and a
 *   forked root is never armed.
 * - Restored control records update `armedInLog` and the WIP override but never arm: dispatch
 *   pauses on restart until a human runs `/dispatch on` again.
 * @param state - state to update.
 * @param record - validated record.
 * @param origin - `live` for our own fresh append, `restored` for a folded own record, `inherited` for the fork prefix.
 */
export function applyRecord(state: LiveDispatchState, record: SchedulerRecord, origin: RecordOrigin = 'live'): void {
  // Team task ids restart at task-1 in a forked root, so no inherited scheduler record may apply.
  if (origin === 'inherited') return
  switch (record.type) {
    case CONTROL_RECORD:
      state.armedInLog = record.data.armed
      if (origin === 'live') state.armed = record.data.armed
      if (record.data.maxActive !== undefined) state.maxActive = record.data.maxActive
      return
    case ITEM_RECORD:
      state.items[record.data.taskId] = record.data
      delete state.held[record.data.taskId]
      return
    case DECISION_RECORD: {
      const { taskId, kind, reason, revision, member } = record.data
      switch (kind) {
        case 'deferred':
          state.lastDeferred[taskId] = reason
          return
        case 'stalled':
          if (revision !== undefined) state.stalled[taskId] = revision
          return
        case 'assigned':
          delete state.lastDeferred[taskId]
          state.unconfirmed[taskId] = member ?? ''
          return
        case 'failed':
          state.held[taskId] = reason
          delete state.lastDeferred[taskId]
          delete state.unconfirmed[taskId]
          return
        case 'dispatched':
        case 'released':
          delete state.lastDeferred[taskId]
          delete state.unconfirmed[taskId]
          return
      }
      return
    }
  }
}

/**
 * Pure fold of a Lead log into a DispatchState, in seq order.
 * @param events - complete Lead log.
 * @param inheritedEventCount - length of the fork-inherited prefix.
 * @returns the folded state; invalid scheduler records are counted in `diagnostics`.
 */
export function foldState(events: readonly SessionEvent[], inheritedEventCount: number): LiveDispatchState {
  const state = emptyState()
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const read = readSchedulerRecord(event)
    if (read.kind === 'invalid') state.diagnostics += 1
    else if (read.kind === 'record') applyRecord(state, read.record, event.seq < inheritedEventCount ? 'inherited' : 'restored')
  }
  return state
}

/** Reads one Lead log. */
export type LeadLogReader = (leadId: SessionId, signal?: AbortSignal) => Promise<{ events: readonly SessionEvent[]; inheritedEventCount: number }>

/**
 * Reader over `sessionQuery.observeSession(..., { projectionMode: 'none' })`; disposes the lease.
 * @param sessionQuery - the Session query service.
 * @returns a Lead log reader.
 */
export function sessionQueryLogReader(sessionQuery: Pick<SessionQueryEngine, 'observeSession'>): LeadLogReader {
  return async (leadId, signal) => {
    const observation = await sessionQuery.observeSession(leadId, signal === undefined ? { projectionMode: 'none' } : { signal, projectionMode: 'none' })
    try {
      return { events: observation.events, inheritedEventCount: observation.inheritedEventCount }
    } finally {
      observation[Symbol.dispose]()
    }
  }
}

/** Lazily built per-Lead state cache. */
export class DispatchStateCache {
  readonly #entries = new Map<string, Promise<LiveDispatchState>>()
  /** Arming decided by a human in this process; survives cache drops (Lead cold/clear), not restarts. */
  readonly #armed = new Map<string, boolean>()

  /** @param read - Lead log reader. */
  constructor(private readonly read: LeadLogReader) {}

  /**
   * The state of one Lead, folding its log on first use.
   * @param leadId - Lead Session id.
   * @param signal - optional cancellation for the first read.
   * @returns the live state object (mutated in place by {@link apply}).
   */
  get(leadId: SessionId, signal?: AbortSignal): Promise<LiveDispatchState> {
    const cached = this.#entries.get(leadId)
    if (cached !== undefined) return cached
    const building = this.read(leadId, signal).then((log) => {
      const state = foldState(log.events, log.inheritedEventCount)
      state.armed = this.#armed.get(leadId) ?? false
      return state
    })
    this.#entries.set(leadId, building)
    building.catch(() => { if (this.#entries.get(leadId) === building) this.#entries.delete(leadId) })
    return building
  }

  /**
   * Apply one record we just appended to the cached state, if built.
   * @param leadId - Lead Session id.
   * @param record - the committed record.
   */
  async apply(leadId: SessionId, record: SchedulerRecord): Promise<void> {
    if (record.type === CONTROL_RECORD) this.#armed.set(leadId, record.data.armed)
    const entry = this.#entries.get(leadId)
    if (entry === undefined) return
    applyRecord(await entry, record, 'live')
  }

  /**
   * Whether a human armed this Lead in this process (no log read).
   * @param leadId - Lead Session id.
   * @returns the in-process arming.
   */
  armed(leadId: string): boolean {
    return this.#armed.get(leadId) ?? false
  }

  /**
   * Record that a teammate started running: its fresh dispatches no longer await a start, so a
   * later inactive status can be reported as a stall.
   * @param leadId - Lead Session id.
   * @param memberId - teammate Session id.
   */
  markStarted(leadId: string, memberId: string): void {
    void this.#entries.get(leadId)?.then((state) => {
      for (const [taskId, entry] of Object.entries(state.awaitingStart)) {
        if (entry.memberId === memberId) delete state.awaitingStart[taskId]
      }
    }, () => undefined)
  }

  /**
   * Drop one Lead's cached state; the next {@link get} rebuilds it from the log.
   * @param leadId - Lead Session id.
   */
  drop(leadId: string): void {
    this.#entries.delete(leadId)
  }

  /** Drop every cached state and in-process arming (plugin disposal). */
  clear(): void {
    this.#entries.clear()
    this.#armed.clear()
  }

  /**
   * Whether a Lead's state is cached.
   * @param leadId - Lead Session id.
   * @returns true when cached.
   */
  has(leadId: string): boolean {
    return this.#entries.has(leadId)
  }
}
