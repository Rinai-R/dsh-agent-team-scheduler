/** The human `/dispatch` command: the only way to arm the scheduler. Never starts a model turn. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { LiveDispatchState } from './state.js'
import type { ControlRecord } from './types.js'

/** Dependencies of the command. */
export interface CommandDeps {
  isLead(agent: Agent): boolean
  state(leadId: SessionId, signal: AbortSignal): Promise<LiveDispatchState>
  /** Append one control record to the Lead log and apply it to the cached state. */
  appendControl(lead: Agent, data: ControlRecord): Promise<void>
  /** Render the current status text. */
  status(lead: Agent, state: LiveDispatchState): string
  /** Request a tick. */
  schedule(leadId: SessionId): void
}

/** Parsed `/dispatch` input. */
export type DispatchCommand =
  | { readonly kind: 'on' } | { readonly kind: 'off' } | { readonly kind: 'status' }
  | { readonly kind: 'wip'; readonly value: number }
  | { readonly kind: 'invalid'; readonly text: string }

/** Command input hint. */
export const COMMAND_HINT = 'on | off | status | wip <n>'

/**
 * Parse the raw command input.
 * @param rawInput - text after `/dispatch`.
 * @returns the parsed command.
 */
export function parseDispatchCommand(rawInput: string): DispatchCommand {
  const words = rawInput.trim().split(/\s+/u).filter(word => word.length > 0)
  const [verb, arg, extra] = words
  if (verb === undefined || (verb === 'status' && arg === undefined)) return { kind: 'status' }
  if ((verb === 'on' || verb === 'off') && arg === undefined) return { kind: verb }
  if (verb === 'wip' && arg !== undefined && extra === undefined && /^\d+$/u.test(arg)) {
    const value = Number(arg)
    if (Number.isSafeInteger(value) && value >= 1) return { kind: 'wip', value }
  }
  return { kind: 'invalid', text: `usage: /dispatch ${COMMAND_HINT} (wip takes an integer >= 1)` }
}

/**
 * Handle one `/dispatch` invocation.
 * @param deps - command dependencies.
 * @param agent - exact agent whose UI received the command.
 * @param rawInput - text after the command name.
 * @param signal - UI cancellation.
 * @returns the command result shown to the human.
 */
export async function handleDispatchCommand(deps: CommandDeps, agent: Agent, rawInput: string, signal: AbortSignal): Promise<CommandResult> {
  if (!deps.isLead(agent)) return { kind: 'error', text: '/dispatch is available only in a Team Lead session' }
  const command = parseDispatchCommand(rawInput)
  if (command.kind === 'invalid') return { kind: 'error', text: command.text }
  const state = await deps.state(agent.id, signal)
  switch (command.kind) {
    case 'status':
      return { kind: 'success', text: deps.status(agent, state) }
    case 'on':
    case 'off':
      await deps.appendControl(agent, { version: 1, armed: command.kind === 'on', actor: 'human' })
      deps.schedule(agent.id)
      return { kind: 'success', text: command.kind === 'on' ? 'Dispatch is ON.' : 'Dispatch is OFF. Assigned tasks keep their owners.' }
    case 'wip':
      await deps.appendControl(agent, { version: 1, armed: state.armed, maxActive: command.value, actor: 'human' })
      deps.schedule(agent.id)
      return { kind: 'success', text: `WIP limit set to ${command.value}.` }
  }
}

/**
 * Build the command definition.
 * @param deps - command dependencies.
 * @returns the `/dispatch` definition.
 */
export function dispatchCommand(deps: CommandDeps): CommandDefinition {
  return {
    name: 'dispatch',
    description: 'Agent Team scheduler: arm (on), pause (off), show status, or set the WIP limit (wip <n>).',
    input: { hint: COMMAND_HINT },
    handler: invocation => handleDispatchCommand(deps, invocation.agent, invocation.rawInput, invocation.signal),
  }
}
