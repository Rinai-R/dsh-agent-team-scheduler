/**
 * PURE dispatch policy: candidate selection, ordering, scope overlap, member choice, and
 * stall / failed-owner detection. Works on plain data and imports no dsh runtime value.
 */
import { posix } from 'node:path'
import type {
  DispatchItem,
  DispatchMode,
  DispatchPlan,
  PlannedDeferral,
  PlannedDispatch,
  PolicyMember,
  PolicyTask,
  Priority,
} from './types.js'

/** Priority used for a task without an item record. */
export const DEFAULT_PRIORITY: Priority = 'P2'

const PRIORITY_RANK: Readonly<Record<Priority, number>> = { P0: 0, P1: 1, P2: 2, P3: 3 }

/**
 * Normalize one workspace-relative write scope the way Agent Teams does: backslashes become
 * slashes, then a leading `./` and trailing slashes are removed. Surrounding whitespace is trimmed.
 * @param value - raw scope.
 * @returns the normalized scope (may be empty).
 */
export function normalizeScope(value: string): string {
  const trimmed = value.trim().replaceAll('\\', '/')
  if (trimmed === '') return ''
  const normalized = posix.normalize(trimmed)
  return normalized === '/' ? '/' : normalized.replace(/\/+$/u, '')
}

/**
 * Whether two scopes overlap on path components (equal, or one is a directory prefix of the other).
 * @param left - raw or normalized scope.
 * @param right - raw or normalized scope.
 * @returns true when either contains the other.
 */
export function scopesOverlap(left: string, right: string): boolean {
  const a = normalizeScope(left)
  const b = normalizeScope(right)
  if (a.length === 0 || b.length === 0) return false
  if (a === '.' || b === '.' || a === '/' || b === '/') return true
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

/**
 * Whether any scope of `left` overlaps any scope of `right`.
 * @param left - scopes of one task.
 * @param right - scopes of another task.
 * @returns true on the first overlapping pair.
 */
export function scopeSetsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some(a => right.some(b => scopesOverlap(a, b)))
}

/**
 * Numeric part of a `task-<n>` id, or `Infinity` for other ids.
 * @param id - task id.
 * @returns the task number.
 */
export function taskNumber(id: string): number {
  const match = /^task-(\d+)$/u.exec(id)
  return match === null ? Number.POSITIVE_INFINITY : Number(match[1])
}

/**
 * Effective dispatch mode of one task.
 * @param item - item record, if any.
 * @param defaultDispatch - configured default.
 * @returns `auto` or `manual`.
 */
export function dispatchModeOf(item: DispatchItem | undefined, defaultDispatch: DispatchMode): DispatchMode {
  return item?.dispatch ?? defaultDispatch
}

/**
 * Compare two candidates: priority asc (missing item → P2), deadline asc (null last), task number asc, id.
 * @param a - first task.
 * @param b - second task.
 * @param items - item records by task id.
 * @returns a negative, zero, or positive number.
 */
export function compareCandidates(a: PolicyTask, b: PolicyTask, items: Readonly<Record<string, DispatchItem>>): number {
  const ia = items[a.id]
  const ib = items[b.id]
  const byPriority = PRIORITY_RANK[ia?.priority ?? DEFAULT_PRIORITY] - PRIORITY_RANK[ib?.priority ?? DEFAULT_PRIORITY]
  if (byPriority !== 0) return byPriority
  const da = ia?.deadline ?? null
  const db = ib?.deadline ?? null
  if (da !== db) {
    if (da === null) return 1
    if (db === null) return -1
    const byDeadline = Date.parse(da) - Date.parse(db)
    if (byDeadline !== 0) return byDeadline
  }
  const byNumber = taskNumber(a.id) - taskNumber(b.id)
  if (byNumber !== 0 && !Number.isNaN(byNumber)) return byNumber
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Ordered dispatch candidates: pending, ready, unowned, and effectively `auto`.
 * @param tasks - every task.
 * @param items - item records by task id.
 * @param defaultDispatch - configured default mode.
 * @returns candidates in dispatch order.
 */
export function selectCandidates(
  tasks: readonly PolicyTask[],
  items: Readonly<Record<string, DispatchItem>>,
  defaultDispatch: DispatchMode,
): PolicyTask[] {
  return tasks
    .filter(task => task.status === 'pending' && task.ready && task.ownerId === undefined
      && dispatchModeOf(items[task.id], defaultDispatch) === 'auto')
    .sort((a, b) => compareCandidates(a, b, items))
}

/** Inputs to {@link planTick}. */
export interface PlanInput {
  readonly tasks: readonly PolicyTask[]
  readonly members: readonly PolicyMember[]
  readonly items: Readonly<Record<string, DispatchItem>>
  /** Task id → revision whose stall was already reported. */
  readonly stalled: Readonly<Record<string, number>>
  /** Task id → revision of a dispatch whose owner has not been seen running yet. */
  readonly awaitingStart: Readonly<Record<string, number>>
  /** Effective WIP limit. */
  readonly limit: number
  readonly defaultDispatch: DispatchMode
  readonly requireWriteScopes: boolean
}

/**
 * Plan one tick. Releases tasks owned by failed members, reports stalls once per revision,
 * and assigns ordered candidates to idle teammates while `active < limit`, deferring a
 * candidate whose scopes are missing or overlap a running or just-assigned task, or for which
 * no teammate is idle.
 * @param input - plain board, roster, and scheduler state.
 * @returns the planned releases, stalls, dispatches, and deferrals.
 */
export function planTick(input: PlanInput): DispatchPlan {
  const membersById = new Map(input.members.map(member => [member.id, member]))
  const inProgress = input.tasks.filter(task => task.status === 'in_progress')

  const releases = inProgress.filter(task => task.ownerId !== undefined && membersById.get(task.ownerId)?.status === 'failed')
  const released = new Set(releases.map(task => task.id))
  const running = inProgress.filter(task => !released.has(task.id))

  const stalls: Array<{ task: PolicyTask; member: PolicyMember }> = []
  for (const task of running) {
    const owner = task.ownerId === undefined ? undefined : membersById.get(task.ownerId)
    if (owner?.role !== 'teammate' || owner.status !== 'inactive') continue
    if (input.stalled[task.id] === task.revision) continue
    if (input.awaitingStart[task.id] === task.revision) continue
    stalls.push({ task, member: owner })
  }

  const busyOwners = new Set(running.flatMap(task => (task.ownerId === undefined ? [] : [task.ownerId])))
  let active = running.filter(task => task.ownerId !== undefined && membersById.get(task.ownerId)?.role === 'teammate').length
  const limit = input.limit

  const dispatches: PlannedDispatch[] = []
  const deferrals: PlannedDeferral[] = []
  const assignedThisTick = new Set<string>()
  const occupied: PolicyTask[] = [...running]

  const isIdle = (member: PolicyMember): boolean => member.role === 'teammate' && member.status === 'inactive'
    && member.phase === 'active' && !busyOwners.has(member.id) && !assignedThisTick.has(member.id)

  for (const task of selectCandidates(input.tasks, input.items, input.defaultDispatch)) {
    if (active >= limit) break
    const item = input.items[task.id]
    const readOnly = item?.readOnly ?? false
    if (!readOnly) {
      const scopes = task.writeScopes.map(normalizeScope).filter(scope => scope.length > 0)
      if (input.requireWriteScopes && scopes.length === 0) {
        deferrals.push({ task, reason: 'no write scopes' })
        continue
      }
      const conflict = occupied.find(other => !(input.items[other.id]?.readOnly ?? false)
        && (other.writeScopes.every(scope => normalizeScope(scope) === '') || scopeSetsOverlap(scopes, other.writeScopes)))
      if (conflict !== undefined) {
        deferrals.push({ task, reason: `overlaps ${conflict.id}` })
        continue
      }
    }
    const preferred = item?.preferredMember == null
      ? undefined
      : input.members.find(member => member.name === item.preferredMember && isIdle(member))
    const member = preferred ?? input.members.find(isIdle)
    if (member === undefined) {
      deferrals.push({ task, reason: 'no idle teammate' })
      continue
    }
    dispatches.push({ task, member })
    assignedThisTick.add(member.id)
    occupied.push(task)
    active += 1
  }

  return { releases, stalls, dispatches, deferrals, active, limit }
}

/**
 * Model-facing brief sent to the assigned teammate.
 * @param task - the dispatched task.
 * @param readOnly - whether the task was marked read-only.
 * @returns the brief text.
 */
export function briefText(task: Pick<PolicyTask, 'id' | 'subject' | 'description' | 'writeScopes'>, readOnly = false): string {
  const scopes = task.writeScopes.map(normalizeScope).filter(scope => scope.length > 0)
  const scopeText = readOnly ? 'none (read-only)' : scopes.length === 0 ? 'unspecified (no isolation)' : scopes.join(', ')
  return `Scheduled task ${task.id}: ${task.subject}
${task.description}
Write scopes: ${scopeText}
You are assigned as owner. Work only inside the write scopes above. When finished, mark the task complete with team_task_update and send the result summary to lead with send_message.`
}
