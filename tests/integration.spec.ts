import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Commands from '@deepseek-ai/dsh-commands'
import TeamService from '@deepseek-ai/dsh-experimental-agent-team'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Scheduler from '../src/index.js'
import { readSchedulerRecord } from '../src/records.js'
import { RoutingMockAdapter, textResponse, toolCallResponse } from './support/mock-adapter.js'
import { TestSessionQuery } from './support/test-session-query.js'

const signal = new AbortController().signal
const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('scheduler in a real Team composition', () => {
  it('enrolls via a model tool, dispatches via human command, respects scopes and pauses on reload', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    const root = mkdtempSync(join(tmpdir(), 'dsh-scheduler-it-'))
    roots.push(root)
    await ctx.plugin(Jsonl, { root })
    await ctx.plugin(TestSessionQuery)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Subagents)
    await ctx.plugin(Spawn, { providerName: 'spawn' })
    await ctx.plugin(TeamService, {})
    if (ctx.get('commands') === undefined) await ctx.plugin(Commands)
    let plugin = await ctx.plugin(Scheduler, { ...Scheduler.DEFAULT_CONFIG, debounceMs: 5 })
    let enroll: string | undefined
    const requests: Array<{ sessionId: string | undefined; text: string }> = []
    const adapter = new RoutingMockAdapter(options => {
      const text = JSON.stringify(options.messages)
      requests.push({ sessionId: options.sessionId, text })
      if (options.sessionId === 'lead' && enroll !== undefined) {
        const task = enroll
        enroll = undefined
        return toolCallResponse(`enroll-${task}`, 'team_dispatch_set', { task_id: task, dispatch: 'auto' })
      }
      return textResponse(options.sessionId === 'lead' ? 'LEAD DONE' : 'WORKER DONE')
    })
    ctx.llm.registerAdapter(['mock'], adapter)
    const lead = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
    for (const name of ['worker-a', 'worker-b']) {
      const started = await ctx.agentTeams.spawnTeammate(lead, {
        name, description: name, context: 'fresh', provider: 'spawn', signal,
        prompt: [{ type: 'text', text: `Initial ${name}` }],
      })
      await vi.waitFor(() => expect(ctx.agents.get(started.member.id)).toBeUndefined())
    }
    await lead.whenIdle()
    const first = await ctx.agentTeams.createTask(lead, { subject: 'First', description: 'Implement A', writeScopes: ['src/a'] })
    const overlap = await ctx.agentTeams.createTask(lead, { subject: 'Overlap', description: 'Implement overlapping B', writeScopes: ['src/a/b'] })
    const disjoint = await ctx.agentTeams.createTask(lead, { subject: 'Disjoint', description: 'Implement C', writeScopes: ['src/c'] })
    const blocked = await ctx.agentTeams.createTask(lead, { subject: 'Blocked', description: 'Wait for A', blockedBy: [first.id], writeScopes: ['src/d'] })
    for (const task of [first, overlap, disjoint, blocked]) {
      enroll = task.id
      await lead.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `Enroll ${task.id}` }] }))
      await lead.whenIdle()
    }
    expect(ctx.agentTeams.listTasks(lead).every(task => task.status === 'pending')).toBe(true)
    expect(ctx.tools.get('team_dispatch_set', lead)).toBeDefined()
    const on = await ctx.commands.execute(lead, '/dispatch on', [], signal)
    expect(on?.result.kind).toBe('success')
    await vi.waitFor(() => {
      expect(ctx.agentTeams.getTask(lead, first.id).status).toBe('in_progress')
      expect(ctx.agentTeams.getTask(lead, disjoint.id).status).toBe('in_progress')
    }, { timeout: 10_000 })
    expect(ctx.agentTeams.getTask(lead, overlap.id).status).toBe('pending')
    expect(ctx.agentTeams.getTask(lead, blocked.id).status).toBe('pending')
    await vi.waitFor(() => expect(requests.filter(request => request.sessionId !== 'lead' && request.text.includes('Scheduled task')).length).toBeGreaterThanOrEqual(2))
    await vi.waitFor(() => expect(ctx.agentTeams.listMembers(lead).filter(row => row.role === 'teammate').every(row => row.status === 'inactive')).toBe(true))
    await lead.whenIdle()
    const status = await ctx.commands.execute(lead, '/dispatch status', [], signal)
    expect(status?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('WIP 2/2') })
    // Completing a task while paused must not dispatch its newly-ready dependent.
    await ctx.commands.execute(lead, '/dispatch off', [], signal)
    const current = ctx.agentTeams.getTask(lead, first.id)
    await ctx.agentTeams.updateTask(lead, { taskId: current.id, expectedRevision: current.revision, action: 'complete' })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(ctx.agentTeams.getTask(lead, blocked.id).status).toBe('pending')
    // Durable decision records exist independently of whether the idle Lead consumes notices.
    const observation = await ctx.sessionQuery.observeSession(lead.id, { projectionMode: 'none' })
    try {
      const records = observation.events.map(readSchedulerRecord)
      expect(records.some(record => record.kind === 'record' && record.record.type.endsWith('/decision') && 'kind' in record.record.data && record.record.data.kind === 'dispatched')).toBe(true)
    } finally { observation[Symbol.dispose]() }
    // Arm with capacity occupied; unloading removes tools/command and cancels pending ticks.
    await ctx.commands.execute(lead, '/dispatch wip 1', [], signal)
    await ctx.commands.execute(lead, '/dispatch on', [], signal)
    await plugin.dispose()
    expect(ctx.tools.get('team_dispatch_set', lead)).toBeUndefined()
    expect(ctx.commands.find(lead, 'dispatch')).toBeUndefined()
    plugin = await ctx.plugin(Scheduler, { ...Scheduler.DEFAULT_CONFIG, debounceMs: 5 })
    const restored = await ctx.commands.execute(lead, '/dispatch status', [], signal)
    expect(restored?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('Dispatch is OFF') })
    expect(restored?.result).toMatchObject({ text: expect.stringContaining('paused after restart') })
    await plugin.dispose()
  }, 20_000)
})
