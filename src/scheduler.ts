/** Per-Lead tick orchestration (side effects only through injected ports) and the debounced trigger loop. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TeamMemberView, TeamService, TeamTaskView, UpdateTeamTaskRequest } from '@deepseek-ai/dsh-experimental-agent-team'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Notice } from './notices.js'
import { renderNotice } from './notices.js'
import { briefText, DEFAULT_PRIORITY, planTick, selectCandidates } from './policy.js'
import type { LiveDispatchState } from './state.js'
import type { Config, DecisionRecord, PolicyMember, PolicyTask } from './types.js'

/** Durable Team facts not exposed by the views: owner ids and member phases. */
export interface TeamFacts {
  readonly members: readonly { readonly id: string; readonly phase: 'provisioning' | 'active' | 'failed' }[]
  readonly tasks: readonly { readonly id: string; readonly ownerId?: string | undefined }[]
}

/** Side-effect ports of one tick. */
export interface TickPorts {
  readonly config: Pick<Config, 'maxActive' | 'defaultDispatch' | 'requireWriteScopes' | 'noticeMaxItems'>
  getLead(leadId: SessionId): Agent | undefined
  isLead(agent: Agent): boolean
  /** Cheap in-process arming check, before any log read. */
  armed(leadId: SessionId): boolean
  state(leadId: SessionId, signal: AbortSignal): Promise<LiveDispatchState>
  readonly agentTeams: Pick<TeamService, 'listTasks' | 'listMembers' | 'updateTask' | 'sendMessage'>
  teamFacts(lead: Agent): TeamFacts | undefined
  /** Append one decision record to the Lead log and apply it to the cached state. */
  appendDecision(lead: Agent, data: DecisionRecord): Promise<void>
  /** Inject one notice into the Lead (must not start a turn). */
  notify(lead: Agent, notice: Notice): void
}

/** What one tick did. */
export interface TickReport {
  readonly ran: boolean
  readonly reason?: 'cold' | 'not-lead' | 'disarmed'
  readonly decisions: readonly DecisionRecord[]
}

/** Error codes meaning "this CAS attempt definitely did not apply". */
const SKIP_CODES = new Set(['TEAM_TASK_STALE_REVISION', 'TEAM_TASK_BLOCKED', 'TEAM_TASK_ALREADY_CLAIMED', 'TEAM_TASK_INVALID_TRANSITION'])

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build plain policy data from Team views plus durable facts.
 * @param tasks - task views.
 * @param members - roster views.
 * @param facts - owner ids and phases.
 * @returns policy tasks and members.
 */
export function policyInput(tasks: readonly TeamTaskView[], members: readonly TeamMemberView[], facts: TeamFacts): { tasks: PolicyTask[]; members: PolicyMember[] } {
  const owners = new Map(facts.tasks.map(task => [task.id, task.ownerId]))
  const phases = new Map(facts.members.map(member => [member.id, member.phase]))
  return {
    tasks: tasks.map(task => ({
      id: task.id,
      revision: task.revision,
      subject: task.subject,
      description: task.description,
      status: task.status,
      ready: task.ready,
      ownerId: owners.get(task.id),
      writeScopes: task.writeScopes,
    })),
    members: members.map(member => ({
      id: member.id,
      name: member.name,
      role: member.role,
      status: member.status,
      phase: member.role === 'lead' ? 'active' : phases.get(member.id) ?? (member.status === 'failed' ? 'failed' : member.status === 'provisioning' ? 'provisioning' : 'active'),
    })),
  }
}

/**
 * Run one tick for one Lead.
 *
 * Safety rules:
 * - an inactive owner is never treated as completion: stalls are reported, never released;
 * - a brief whose delivery throws may still have been queued by the durable Team mailbox, so
 *   ownership is kept, nothing is retried, and the Lead is told;
 * - an `assigned` decision restored without a confirming `dispatched` / `failed` decision is
 *   reported once and never re-sent;
 * - only tasks owned by a `failed` member (creation failed, it never ran) are released.
 * @param ports - side-effect ports.
 * @param leadId - Lead Session id.
 * @param signal - cancellation (plugin disposal).
 * @returns what the tick did.
 */
export async function runTick(ports: TickPorts, leadId: SessionId, signal: AbortSignal): Promise<TickReport> {
  const lead = ports.getLead(leadId)
  if (lead === undefined) return { ran: false, reason: 'cold', decisions: [] }
  if (!ports.isLead(lead)) return { ran: false, reason: 'not-lead', decisions: [] }
  if (!ports.armed(leadId)) return { ran: false, reason: 'disarmed', decisions: [] }
  const state = await ports.state(leadId, signal)
  if (!state.armed) return { ran: false, reason: 'disarmed', decisions: [] }
  signal.throwIfAborted()
  const facts = ports.teamFacts(lead)
  if (facts === undefined) return { ran: false, reason: 'not-lead', decisions: [] }

  const views = ports.agentTeams.listTasks(lead)
  const viewsById = new Map(views.map(view => [view.id as string, view]))
  const memberViews = ports.agentTeams.listMembers(lead)
  const { tasks, members } = policyInput(views, memberViews, facts)
  const limit = state.maxActive ?? ports.config.maxActive
  const plan = planTick({
    tasks: tasks.map(task => state.held[task.id] === undefined ? task : { ...task, ready: false }),
    members,
    items: state.items,
    stalled: state.stalled,
    awaitingStart: Object.fromEntries(Object.entries(state.awaitingStart).map(([id, entry]) => [id, entry.revision])),
    limit,
    defaultDispatch: ports.config.defaultDispatch,
    requireWriteScopes: ports.config.requireWriteScopes,
  })

  const decisions: DecisionRecord[] = []
  const decide = async (data: Omit<DecisionRecord, 'version'>): Promise<void> => {
    const record: DecisionRecord = { version: 1, ...data }
    await ports.appendDecision(lead, record)
    decisions.push(record)
  }
  const reassign = (request: Omit<UpdateTeamTaskRequest, 'action'>) => ports.agentTeams.updateTask(lead, { ...request, action: 'reassign' })

  for (const [taskId, member] of Object.entries(state.unconfirmed)) {
    await decide({ taskId, kind: 'failed', member: member.length > 0 ? member : null, reason: 'brief delivery was not confirmed before an interruption; not re-sent, check with the owner' })
  }

  for (const task of plan.releases) {
    const view = viewsById.get(task.id)
    if (view === undefined) continue
    const owner = members.find(member => member.id === task.ownerId)
    try {
      await reassign({ taskId: view.id, expectedRevision: view.revision })
    } catch (error) {
      if (SKIP_CODES.has(errorCode(error) ?? '')) continue
      await decide({ taskId: task.id, kind: 'failed', member: owner?.name ?? null, reason: `release outcome unknown: ${errorText(error)}` })
      continue
    }
    await decide({ taskId: task.id, kind: 'released', member: owner?.name ?? null, reason: `owner ${owner?.name ?? task.ownerId ?? '?'} failed` })
  }

  for (const { task, member } of plan.stalls) {
    await decide({
      taskId: task.id,
      kind: 'stalled',
      member: member.name,
      revision: task.revision,
      reason: `owner ${member.name} is inactive but the task is still in_progress (inactive is not completion)`,
    })
  }

  const canDispatch = (): boolean => !signal.aborted && ports.armed(leadId) && state.armed
    && ports.getLead(leadId) === lead && ports.isLead(lead)
  const assignedHere = new Map<string, PolicyTask>()
  for (const { task, member } of plan.dispatches) {
    if (!canDispatch()) break
    // Human edits and other Team operations may have changed the board while an earlier
    // assignment/send was awaited. Revalidate admission against the current board.
    const currentFacts = ports.teamFacts(lead)
    if (currentFacts === undefined) break
    const current = policyInput(ports.agentTeams.listTasks(lead), ports.agentTeams.listMembers(lead), currentFacts)
    const currentTasks = current.tasks.map(value => {
      const latest = assignedHere.get(value.id) ?? value
      return state.held[value.id] === undefined ? latest : { ...latest, ready: false }
    })
    const fresh = planTick({ tasks: currentTasks, members: current.members, items: state.items,
      stalled: state.stalled, awaitingStart: {}, limit: state.maxActive ?? ports.config.maxActive,
      defaultDispatch: ports.config.defaultDispatch, requireWriteScopes: ports.config.requireWriteScopes })
    if (!fresh.dispatches.some(value => value.task.id === task.id && value.task.revision === task.revision
      && value.member.id === member.id)) continue
    const view = viewsById.get(task.id)
    if (view === undefined) continue
    let assigned: TeamTaskView
    try {
      assigned = await reassign({ taskId: view.id, expectedRevision: view.revision, owner: member.name })
    } catch (error) {
      if (SKIP_CODES.has(errorCode(error) ?? '')) continue
      await decide({ taskId: task.id, kind: 'failed', member: member.name, reason: `assignment outcome unknown: ${errorText(error)}` })
      continue
    }
    assignedHere.set(task.id, { ...task, status: 'in_progress', ownerId: member.id, revision: assigned.revision })
    await decide({ taskId: task.id, kind: 'assigned', member: member.name, revision: assigned.revision, reason: 'assigned' })
    if (!canDispatch()) {
      await decide({ taskId: task.id, kind: 'failed', member: member.name, revision: assigned.revision,
        reason: 'dispatch paused after assignment; brief not sent, ownership kept for review' })
      break
    }
    // Set before sending: the owner may start running before sendMessage resolves.
    state.awaitingStart[task.id] = { revision: assigned.revision, memberId: member.id }
    try {
      await ports.agentTeams.sendMessage(lead, {
        target: member.name,
        content: [{ type: 'text', text: briefText(task, state.items[task.id]?.readOnly ?? false) }],
        signal,
      })
    } catch (error) {
      delete state.awaitingStart[task.id]
      await decide({ taskId: task.id, kind: 'failed', member: member.name, revision: assigned.revision, reason: `brief delivery uncertain (${errorText(error)}); ownership kept, not re-sent` })
      continue
    }
    await decide({ taskId: task.id, kind: 'dispatched', member: member.name, revision: assigned.revision, reason: 'brief accepted' })
  }

  for (const { task, reason } of plan.deferrals) {
    if (state.lastDeferred[task.id] === reason) continue
    await decide({ taskId: task.id, kind: 'deferred', member: null, reason })
  }

  const notice = renderNotice(decisions.filter(decision => decision.kind !== 'assigned'), ports.config.noticeMaxItems)
  if (notice !== undefined) ports.notify(lead, notice)
  return { ran: true, decisions }
}

interface LeadLoop {
  timer: ReturnType<typeof setTimeout> | undefined
  running: Promise<void> | undefined
  rerun: boolean
}

/** Debounced, per-Lead serialized tick loop. A trigger during a tick sets `rerun`. */
export class TickLoop {
  readonly #loops = new Map<string, LeadLoop>()
  readonly #controller = new AbortController()
  #disposed = false

  /**
   * @param run - the tick body.
   * @param debounceMs - debounce per Lead.
   * @param onError - receives tick failures (never thrown into listeners).
   */
  constructor(
    private readonly run: (leadId: SessionId, signal: AbortSignal) => Promise<unknown>,
    private readonly debounceMs: number,
    private readonly onError: (error: unknown, leadId: SessionId) => void,
  ) {}

  /**
   * Request a tick for one Lead after the debounce (never synchronously).
   * @param leadId - Lead Session id.
   */
  schedule(leadId: SessionId): void {
    if (this.#disposed) return
    const loop = this.#loops.get(leadId) ?? { timer: undefined, running: undefined, rerun: false }
    this.#loops.set(leadId, loop)
    if (loop.running !== undefined) {
      loop.rerun = true
      return
    }
    if (loop.timer !== undefined) clearTimeout(loop.timer)
    loop.timer = setTimeout(() => {
      loop.timer = undefined
      this.#start(leadId, loop)
    }, this.debounceMs)
  }

  #start(leadId: SessionId, loop: LeadLoop): void {
    if (this.#disposed) return
    loop.rerun = false
    loop.running = (async () => {
      try {
        await this.run(leadId, this.#controller.signal)
      } catch (error) {
        if (!this.#controller.signal.aborted) this.onError(error, leadId)
      } finally {
        loop.running = undefined
        if (loop.rerun && !this.#disposed) this.schedule(leadId)
        else if (loop.timer === undefined) this.#loops.delete(leadId)
      }
    })()
  }

  /**
   * Wait until no tick is pending or running (tests).
   * @returns after quiescence.
   */
  async idle(): Promise<void> {
    while (true) {
      const loops = [...this.#loops.values()]
      if (loops.length === 0) return
      await Promise.all(loops.map(loop => loop.running ?? new Promise(resolve => setTimeout(resolve, Math.max(1, this.debounceMs)))))
    }
  }

  /** Clear timers and abort in-flight ticks. */
  dispose(): void {
    this.#disposed = true
    for (const loop of this.#loops.values()) if (loop.timer !== undefined) clearTimeout(loop.timer)
    this.#loops.clear()
    this.#controller.abort(new Error('dsh-agent-team-scheduler disposed'))
  }
}

/** Read-only snapshot for `/dispatch status` and `team_dispatch_status`. */
export interface DispatchStatus {
  readonly armed: boolean
  /** Armed value of the last control record in the log (a restart pauses dispatch until `/dispatch on`). */
  readonly armedInLog: boolean
  readonly active: number
  readonly limit: number
  readonly queue: readonly { readonly task_id: string; readonly priority: string; readonly deadline: string | null; readonly dispatch: string }[]
  readonly deferred: readonly { readonly task_id: string; readonly reason: string }[]
  readonly diagnostics: number
}

/**
 * Compute the dispatch status of one Lead without side effects.
 * @param ports - the status-relevant ports.
 * @param lead - live Lead Agent.
 * @param state - its dispatch state.
 * @returns the status snapshot.
 */
export function describeStatus(
  ports: Pick<TickPorts, 'config' | 'agentTeams' | 'teamFacts'>,
  lead: Agent,
  state: LiveDispatchState,
): DispatchStatus {
  const facts = ports.teamFacts(lead) ?? { members: [], tasks: [] }
  const { tasks, members } = policyInput(ports.agentTeams.listTasks(lead), ports.agentTeams.listMembers(lead), facts)
  const limit = state.maxActive ?? ports.config.maxActive
  const teammateIds = new Set(members.filter(member => member.role === 'teammate').map(member => member.id))
  const active = tasks.filter(task => task.status === 'in_progress' && task.ownerId !== undefined && teammateIds.has(task.ownerId)).length
  const queue = selectCandidates(tasks.filter(task => state.held[task.id] === undefined), state.items, ports.config.defaultDispatch).map((task) => {
    const item = state.items[task.id]
    return { task_id: task.id, priority: item?.priority ?? DEFAULT_PRIORITY, deadline: item?.deadline ?? null, dispatch: item?.dispatch ?? ports.config.defaultDispatch }
  })
  const deferred = Object.entries({ ...state.lastDeferred, ...state.held }).map(([task_id, reason]) => ({ task_id, reason }))
  return { armed: state.armed, armedInLog: state.armedInLog, active, limit, queue, deferred, diagnostics: state.diagnostics }
}

/**
 * Render a status snapshot as human text.
 * @param status - the snapshot.
 * @returns multi-line text.
 */
export function statusText(status: DispatchStatus): string {
  const lines = [
    `Dispatch is ${status.armed ? 'ON' : 'OFF'}${!status.armed && status.armedInLog ? ' (paused after restart; run /dispatch on to resume)' : ''}. WIP ${status.active}/${status.limit}.`,
    status.queue.length === 0 ? 'Queue: empty.' : `Queue: ${status.queue.map(entry => `${entry.task_id} (${entry.priority}${entry.deadline === null ? '' : `, due ${entry.deadline}`})`).join(', ')}.`,
  ]
  if (status.deferred.length > 0) lines.push(`Last deferred: ${status.deferred.map(entry => `${entry.task_id}: ${entry.reason}`).join('; ')}.`)
  if (status.diagnostics > 0) lines.push(`${status.diagnostics} invalid scheduler record(s) skipped.`)
  return lines.join('\n')
}
