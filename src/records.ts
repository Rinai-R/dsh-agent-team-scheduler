/** Plugin record types, hand-written validators, and append helpers. */
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ControlRecord, DecisionKind, DecisionRecord, DispatchItem, DispatchMode, Priority } from './types.js'

/** Record type of control records (arming, WIP override). */
export const CONTROL_RECORD = 'plugin:dsh-agent-team-scheduler/control'
/** Record type of per-task dispatch metadata. */
export const ITEM_RECORD = 'plugin:dsh-agent-team-scheduler/item'
/** Record type of scheduler decisions. */
export const DECISION_RECORD = 'plugin:dsh-agent-team-scheduler/decision'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:dsh-agent-team-scheduler/control': ControlRecord
    'plugin:dsh-agent-team-scheduler/item': DispatchItem
    'plugin:dsh-agent-team-scheduler/decision': DecisionRecord
  }
}

/** One validated scheduler record read from a log. */
export type SchedulerRecord =
  | { readonly type: typeof CONTROL_RECORD; readonly seq: number; readonly data: ControlRecord }
  | { readonly type: typeof ITEM_RECORD; readonly seq: number; readonly data: DispatchItem }
  | { readonly type: typeof DECISION_RECORD; readonly seq: number; readonly data: DecisionRecord }

const PRIORITIES: readonly Priority[] = ['P0', 'P1', 'P2', 'P3']
const MODES: readonly DispatchMode[] = ['auto', 'manual']
const KINDS: readonly DecisionKind[] = ['assigned', 'dispatched', 'deferred', 'released', 'stalled', 'failed']

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/**
 * Validate control record data.
 * @param data - untrusted record data.
 * @returns the record, or undefined when invalid.
 */
export function parseControl(data: unknown): ControlRecord | undefined {
  if (!isObject(data) || data.version !== 1 || typeof data.armed !== 'boolean' || data.actor !== 'human') return undefined
  if (data.maxActive !== undefined && !isPositiveInteger(data.maxActive)) return undefined
  return { version: 1, armed: data.armed, actor: 'human', ...(data.maxActive === undefined ? {} : { maxActive: data.maxActive }) }
}

/**
 * Validate item record data.
 * @param data - untrusted record data.
 * @returns the record, or undefined when invalid.
 */
export function parseItem(data: unknown): DispatchItem | undefined {
  if (!isObject(data) || data.version !== 1 || typeof data.taskId !== 'string' || data.taskId.length === 0) return undefined
  const { priority, deadline, dispatch, readOnly, preferredMember } = data
  if (typeof priority !== 'string' || !(PRIORITIES as readonly string[]).includes(priority)) return undefined
  if (typeof dispatch !== 'string' || !(MODES as readonly string[]).includes(dispatch)) return undefined
  if (typeof readOnly !== 'boolean' || !isStringOrNull(preferredMember) || !isStringOrNull(deadline)) return undefined
  if (deadline !== null && normalizeDeadline(deadline) !== deadline) return undefined
  return {
    version: 1,
    taskId: data.taskId,
    priority: priority as Priority,
    deadline,
    dispatch: dispatch as DispatchMode,
    readOnly,
    preferredMember,
  }
}

/**
 * Validate decision record data.
 * @param data - untrusted record data.
 * @returns the record, or undefined when invalid.
 */
export function parseDecision(data: unknown): DecisionRecord | undefined {
  if (!isObject(data) || data.version !== 1 || typeof data.taskId !== 'string' || data.taskId.length === 0) return undefined
  if (typeof data.kind !== 'string' || !(KINDS as readonly string[]).includes(data.kind)) return undefined
  if (!isStringOrNull(data.member) || typeof data.reason !== 'string') return undefined
  if (data.revision !== undefined && (typeof data.revision !== 'number' || !Number.isSafeInteger(data.revision))) return undefined
  return {
    version: 1,
    taskId: data.taskId,
    kind: data.kind as DecisionKind,
    member: data.member,
    reason: data.reason,
    ...(data.revision === undefined ? {} : { revision: data.revision }),
  }
}

/**
 * Normalize a deadline to `Date#toISOString`.
 * @param value - any `Date`-parsable string.
 * @returns the ISO string, or undefined when unparsable.
 */
export function normalizeDeadline(value: string): string | undefined {
  const time = Date.parse(value)
  return Number.isNaN(time) ? undefined : new Date(time).toISOString()
}

/** Outcome of reading one event as a scheduler record. */
export type RecordRead = { readonly kind: 'none' } | { readonly kind: 'invalid' } | { readonly kind: 'record'; readonly record: SchedulerRecord }

/**
 * Read one committed event as a scheduler record.
 * @param event - any Session event.
 * @returns `none` for foreign events, `invalid` for our types with bad data, or the record.
 */
export function readSchedulerRecord(event: SessionEvent): RecordRead {
  const record = pluginRecordOf(event)
  if (record === undefined) return { kind: 'none' }
  switch (record.type) {
    case CONTROL_RECORD: {
      const data = parseControl(record.data)
      return data === undefined ? { kind: 'invalid' } : { kind: 'record', record: { type: CONTROL_RECORD, seq: record.seq, data } }
    }
    case ITEM_RECORD: {
      const data = parseItem(record.data)
      return data === undefined ? { kind: 'invalid' } : { kind: 'record', record: { type: ITEM_RECORD, seq: record.seq, data } }
    }
    case DECISION_RECORD: {
      const data = parseDecision(record.data)
      return data === undefined ? { kind: 'invalid' } : { kind: 'record', record: { type: DECISION_RECORD, seq: record.seq, data } }
    }
    default:
      return { kind: 'none' }
  }
}

/**
 * Append one scheduler record to a Session (ignorable, log-only, never model-visible).
 * @param session - the Lead Session.
 * @param record - record type and data.
 * @returns the committed record with its seq.
 */
export function appendSchedulerRecord(
  session: Session,
  record: { readonly type: typeof CONTROL_RECORD; readonly data: ControlRecord }
    | { readonly type: typeof ITEM_RECORD; readonly data: DispatchItem }
    | { readonly type: typeof DECISION_RECORD; readonly data: DecisionRecord },
): SchedulerRecord {
  let seq: SessionSeq
  switch (record.type) {
    case CONTROL_RECORD: seq = appendPluginRecord(session, CONTROL_RECORD, record.data); break
    case ITEM_RECORD: seq = appendPluginRecord(session, ITEM_RECORD, record.data); break
    case DECISION_RECORD: seq = appendPluginRecord(session, DECISION_RECORD, record.data); break
  }
  return { ...record, seq } as SchedulerRecord
}
