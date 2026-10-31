/** Model tools `team_dispatch_set` / `team_dispatch_status` (installed for every member; Lead-only at execute). */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamTaskId, type TeamService } from '@deepseek-ai/dsh-experimental-agent-team'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool, type InferValue, type ToolDefinition, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { DEFAULT_PRIORITY } from './policy.js'
import { normalizeDeadline } from './records.js'
import type { DispatchStatus } from './scheduler.js'
import type { LiveDispatchState } from './state.js'
import type { DispatchItem, DispatchMode, Priority } from './types.js'

/** Name of the item tool. */
export const SET_TOOL = 'team_dispatch_set'
/** Name of the status tool. */
export const STATUS_TOOL = 'team_dispatch_status'

const ARMING_NOTE = 'Only a human can start or stop dispatching (/dispatch on|off); this tool cannot.'

/** Model-facing description of `team_dispatch_set`. */
export const SET_DESCRIPTION = `Enroll or update one shared task for the Team scheduler: priority (P0 first), deadline, dispatch mode (auto = the scheduler may assign it to an idle teammate when it is ready, its write scopes do not overlap running work, and the WIP limit allows), read-only flag, and preferred teammate. Only the Team Lead may call this tool. ${ARMING_NOTE}`

/** Model-facing description of `team_dispatch_status`. */
export const STATUS_DESCRIPTION = `Show whether the Team scheduler is on, the WIP count and limit, the ordered dispatch queue, and the last deferred reasons. Only the Team Lead may call this tool. ${ARMING_NOTE}`

/** `team_dispatch_set` parameters. */
export const SET_PARAMETERS = {
  task_id: { type: 'string', required: true, description: 'Shared task id, for example task-3.' },
  priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'], description: 'P0 is dispatched first. Defaults to the current value or P2.' },
  deadline: { type: 'string', description: 'ISO 8601 date or date-time used to order equal priorities; empty string clears it.' },
  dispatch: { type: 'string', enum: ['auto', 'manual'], description: 'auto lets the scheduler assign the task; manual leaves it to the Lead.' },
  read_only: { type: 'boolean', description: 'True when the task writes no files; it then bypasses the write-scope checks.' },
  preferred_member: { type: 'string', description: 'Teammate name tried first when idle; empty string clears it.' },
} as const

const ITEM_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    task_id: { type: 'string', required: true },
    priority: { type: 'string', required: true, enum: ['P0', 'P1', 'P2', 'P3'] },
    deadline: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    dispatch: { type: 'string', required: true, enum: ['auto', 'manual'] },
    read_only: { type: 'boolean', required: true },
    preferred_member: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  },
} as const satisfies ValueSchemaSpec

const STATUS_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    armed: { type: 'boolean', required: true },
    active: { type: 'integer', required: true },
    limit: { type: 'integer', required: true },
    queue: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          priority: { type: 'string', required: true },
          deadline: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          dispatch: { type: 'string', required: true },
        },
      },
    },
    deferred: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { task_id: { type: 'string', required: true }, reason: { type: 'string', required: true } },
      },
    },
  },
} as const satisfies ValueSchemaSpec

/** `team_dispatch_set` result. */
export type ItemValue = InferValue<typeof ITEM_VALUE_SCHEMA>
/** `team_dispatch_status` result. */
export type StatusValue = InferValue<typeof STATUS_VALUE_SCHEMA>

/** `team_dispatch_set` arguments after schema validation. */
export interface SetArgs {
  readonly task_id: string
  readonly priority?: Priority | undefined
  readonly deadline?: string | undefined
  readonly dispatch?: DispatchMode | undefined
  readonly read_only?: boolean | undefined
  readonly preferred_member?: string | undefined
}

/** Dependencies of the tools. */
export interface ToolDeps {
  isLead(agent: Agent): boolean
  readonly agentTeams: Pick<TeamService, 'getTask'>
  state(leadId: SessionId, signal: AbortSignal): Promise<LiveDispatchState>
  appendItem(lead: Agent, data: DispatchItem): Promise<void>
  status(lead: Agent, state: LiveDispatchState): DispatchStatus
  schedule(leadId: SessionId): void
}

/** Raised for invalid tool calls. */
export class DispatchToolError extends Error {
  override readonly name = 'DispatchToolError'
  /**
   * @param message - model-facing reason.
   * @param code - stable reason.
   */
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

function requireLead(deps: Pick<ToolDeps, 'isLead'>, agent: Agent | undefined, tool: string): Agent {
  if (agent === undefined) throw new DispatchToolError(`${tool} requires a calling Agent`, 'DISPATCH_NO_CALLER')
  if (!deps.isLead(agent)) throw new DispatchToolError(`only the Team Lead can use ${tool}`, 'TEAM_LEAD_REQUIRED')
  return agent
}

function itemValue(item: DispatchItem): ItemValue {
  return { task_id: item.taskId, priority: item.priority, deadline: item.deadline, dispatch: item.dispatch, read_only: item.readOnly, preferred_member: item.preferredMember }
}

/**
 * Execute `team_dispatch_set`: validate the task, merge with the current item, append the record.
 * @param deps - tool dependencies.
 * @param args - validated arguments.
 * @param exec - calling Agent and cancellation.
 * @returns the merged item.
 */
export async function executeSet(deps: ToolDeps, args: SetArgs, exec: { readonly agent?: Agent | undefined; readonly signal: AbortSignal }): Promise<ItemValue> {
  const lead = requireLead(deps, exec.agent, SET_TOOL)
  const task = deps.agentTeams.getTask(lead, TeamTaskId(args.task_id))
  if (task.status === 'deleted') throw new DispatchToolError(`task ${args.task_id} is deleted`, 'DISPATCH_TASK_DELETED')
  let deadline: string | null | undefined
  if (args.deadline !== undefined) {
    if (args.deadline.trim() === '') deadline = null
    else {
      deadline = normalizeDeadline(args.deadline)
      if (deadline === undefined) throw new DispatchToolError(`deadline ${JSON.stringify(args.deadline)} is not a valid ISO 8601 date`, 'DISPATCH_INVALID_DEADLINE')
    }
  }
  const state = await deps.state(lead.id, exec.signal)
  const current = state.items[task.id]
  const preferred = args.preferred_member === undefined ? undefined : args.preferred_member.trim() === '' ? null : args.preferred_member.trim()
  const item: DispatchItem = {
    version: 1,
    taskId: task.id,
    priority: args.priority ?? current?.priority ?? DEFAULT_PRIORITY,
    deadline: deadline === undefined ? current?.deadline ?? null : deadline,
    dispatch: args.dispatch ?? current?.dispatch ?? 'auto',
    readOnly: args.read_only ?? current?.readOnly ?? false,
    preferredMember: preferred === undefined ? current?.preferredMember ?? null : preferred,
  }
  await deps.appendItem(lead, item)
  deps.schedule(lead.id)
  return itemValue(item)
}

/**
 * Execute `team_dispatch_status`.
 * @param deps - tool dependencies.
 * @param exec - calling Agent and cancellation.
 * @returns the status value.
 */
export async function executeStatus(deps: ToolDeps, exec: { readonly agent?: Agent | undefined; readonly signal: AbortSignal }): Promise<StatusValue> {
  const lead = requireLead(deps, exec.agent, STATUS_TOOL)
  const status = deps.status(lead, await deps.state(lead.id, exec.signal))
  return {
    armed: status.armed,
    active: status.active,
    limit: status.limit,
    queue: status.queue.map(entry => ({ ...entry })),
    deferred: status.deferred.map(entry => ({ ...entry })),
  }
}

const render = (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]

/**
 * Build both tool definitions (identical for every member).
 * @param deps - tool dependencies.
 * @returns `[team_dispatch_set, team_dispatch_status]`.
 */
export function dispatchTools(deps: ToolDeps): ToolDefinition[] {
  return [
    defineTool({
      name: SET_TOOL,
      description: SET_DESCRIPTION,
      parameters: SET_PARAMETERS,
      output: { schema: ITEM_VALUE_SCHEMA, render },
      execute: (args, exec) => executeSet(deps, args, exec),
    }),
    defineTool({
      name: STATUS_TOOL,
      description: STATUS_DESCRIPTION,
      parameters: {},
      output: { schema: STATUS_VALUE_SCHEMA, render },
      execute: (_args, exec) => executeStatus(deps, exec),
    }),
  ]
}
