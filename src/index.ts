/**
 * dsh-agent-team-scheduler: turns the Agent Teams task board into a human-armed dispatch queue.
 * @module dsh-agent-team-scheduler
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-query'
import z from '@deepseek-ai/schemastery'
import { dispatchCommand } from './command.js'
import { NOTICE_SOURCE_KIND } from './notices.js'
import { appendSchedulerRecord, CONTROL_RECORD, DECISION_RECORD, ITEM_RECORD } from './records.js'
import { describeStatus, runTick, statusText, TickLoop, type TickPorts } from './scheduler.js'
import { DispatchStateCache, sessionQueryLogReader } from './state.js'
import { dispatchTools } from './tools.js'
import type { Config as SchedulerConfig } from './types.js'

export type * from './types.js'
export * from './policy.js'
export { CONTROL_RECORD, DECISION_RECORD, ITEM_RECORD, normalizeDeadline, parseControl, parseDecision, parseItem, readSchedulerRecord } from './records.js'
export { applyRecord, DispatchStateCache, emptyState, foldState, type LiveDispatchState } from './state.js'
export { decisionLine, renderNotice, NOTICE_SOURCE_KIND, type Notice } from './notices.js'
export { describeStatus, policyInput, runTick, statusText, TickLoop, type DispatchStatus, type TeamFacts, type TickPorts, type TickReport } from './scheduler.js'
export { COMMAND_HINT, dispatchCommand, handleDispatchCommand, parseDispatchCommand, type CommandDeps } from './command.js'
export { dispatchTools, executeSet, executeStatus, SET_DESCRIPTION, SET_PARAMETERS, SET_TOOL, STATUS_DESCRIPTION, STATUS_TOOL, type ToolDeps } from './tools.js'

/** Cordis plugin name. */
export const name = 'agent-team-scheduler'

/** Services required by the plugin. */
export const inject: string[] = ['agents', 'agentTeams', 'sessionProjections', 'sessionQuery', 'commands', 'tools']

/** Plugin configuration. */
export type Config = SchedulerConfig

/** Loader schema. */
export const Config: z<Config> = z.object({
  maxActive: z.natural().min(1).default(2).description('Maximum in_progress tasks owned by teammates.'),
  defaultDispatch: z.union(['manual', 'auto'] as const).default('manual').description('Dispatch mode of tasks without scheduler metadata.'),
  requireWriteScopes: z.boolean().default(true).description('Defer non-read-only tasks without write scopes.'),
  debounceMs: z.natural().default(200).description('Per-Lead trigger debounce in milliseconds.'),
  noticeMaxItems: z.natural().min(1).default(20).description('Maximum decision lines per Lead notice.'),
}) as z<Config>

/** Defaults applied when `apply` receives a partial config (tests, programmatic use). */
export const DEFAULT_CONFIG: Config = { maxActive: 2, defaultDispatch: 'manual', requireWriteScopes: true, debounceMs: 200, noticeMaxItems: 20 }

/** Handle exposed for tests: wait for pending ticks. */
export interface SchedulerHandle {
  idle(): Promise<void>
}

/**
 * Register the `/dispatch` command, install the tools on every Team member, and drive debounced
 * per-Lead ticks from Team projection changes and agent status changes. Everything is disposed
 * with the plugin.
 * @param ctx - plugin context.
 * @param input - plugin configuration.
 * @returns a handle for tests.
 */
export function apply(ctx: Context, input: Partial<Config> = {}): SchedulerHandle {
  const config: Config = { ...DEFAULT_CONFIG, ...input }
  const logger = ctx.logger('agent-team-scheduler')
  const cache = new DispatchStateCache(sessionQueryLogReader(ctx.sessionQuery))
  const isLead = (agent: Agent): boolean => ctx.agentTeams.tryMembership(agent)?.role === 'lead'
  const leadOf = (agent: Agent): SessionId | undefined => {
    const membership = ctx.agentTeams.tryMembership(agent)
    return membership === undefined ? undefined : membership.root.id
  }

  const ports: TickPorts = {
    config,
    getLead: id => ctx.agents.get(id),
    isLead,
    armed: id => cache.armed(id),
    state: (id, signal) => cache.get(id, signal),
    agentTeams: ctx.agentTeams,
    teamFacts: (lead) => {
      const team = ctx.sessionProjections.stateOf(lead.session, 'agentTeam')
      return team === undefined ? undefined : { members: team.members, tasks: team.tasks }
    },
    appendDecision: async (lead, data) => {
      await cache.apply(lead.id, appendSchedulerRecord(lead.session, { type: DECISION_RECORD, data }))
    },
    notify: (lead, notice) => {
      lead.inject(createUserMessage({
        content: [{ type: 'text', text: notice.text }],
        source: { kind: NOTICE_SOURCE_KIND, form: 'notice', summary: notice.summary },
      }))
    },
  }

  const loop = new TickLoop(
    (leadId, signal) => runTick(ports, leadId, signal),
    config.debounceMs,
    (error, leadId) => { logger.warn(`tick for ${leadId} failed: ${error instanceof Error ? error.message : String(error)}`) },
  )
  const schedule = (leadId: SessionId): void => {
    // Only Leads armed by a human in this process can dispatch, so other sessions never pay for a tick.
    if (cache.armed(leadId)) loop.schedule(leadId)
  }
  const status = (lead: Agent, state: Parameters<typeof describeStatus>[2]) => describeStatus(ports, lead, state)

  ctx.commands.register(dispatchCommand({
    isLead,
    state: (id, signal) => cache.get(id, signal),
    appendControl: async (lead, data) => {
      await cache.apply(lead.id, appendSchedulerRecord(lead.session, { type: CONTROL_RECORD, data }))
    },
    status: (lead, state) => statusText(status(lead, state)),
    schedule,
  }))

  const tools = dispatchTools({
    isLead,
    agentTeams: ctx.agentTeams,
    state: (id, signal) => cache.get(id, signal),
    appendItem: async (lead, data) => {
      await cache.apply(lead.id, appendSchedulerRecord(lead.session, { type: ITEM_RECORD, data }))
    },
    status,
    schedule,
  })
  const installed = new Map<Agent, () => void>()
  const maybeInstall = (agent: Agent): void => {
    if (installed.has(agent) || ctx.agentTeams.tryMembership(agent) === undefined) return
    const disposers = tools.map(tool => agent.ctx.tools.register(tool))
    installed.set(agent, () => { for (const dispose of disposers.reverse()) dispose() })
  }
  for (const agent of ctx.agents.list()) maybeInstall(agent)

  ctx.on('agent/created', ({ agent, source }) => {
    maybeInstall(agent)
    if (source === 'clear') cache.drop(agent.id)
    if (isLead(agent)) schedule(agent.id)
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
    if (ctx.agents.get(agent.id) === undefined) cache.drop(agent.id)
  })
  ctx.on('agent/status', ({ agent, status: agentStatus }) => {
    const leadId = leadOf(agent)
    if (leadId === undefined) return
    if (agentStatus === 'running' && leadId !== agent.id) cache.markStarted(leadId, agent.id)
    schedule(leadId)
  })
  ctx.sessionProjections.onChanged((session, key) => {
    if (key === 'agentTeam') schedule(session.id)
  })
  ctx.effect(() => () => {
    loop.dispose()
    for (const dispose of installed.values()) dispose()
    installed.clear()
    cache.clear()
  }, 'agent-team-scheduler.runtime()')

  return { idle: () => loop.idle() }
}
