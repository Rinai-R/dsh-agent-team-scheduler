import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TeamMemberView, TeamTaskView, UpdateTeamTaskRequest } from '@deepseek-ai/dsh-experimental-agent-team'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DECISION_RECORD } from '../src/records.js'
import { describeStatus, runTick, statusText, TickLoop, type TeamFacts, type TickPorts } from '../src/scheduler.js'
import { applyRecord, emptyState, type LiveDispatchState } from '../src/state.js'
import type { DecisionRecord, DispatchItem } from '../src/types.js'

const LEAD = { id: SessionId('lead'), session: {} } as unknown as Agent
const SIGNAL = new AbortController().signal

function view(id: string, extra: Partial<TeamTaskView> = {}): TeamTaskView {
  return {
    id: id as TeamTaskView['id'], revision: 1, subject: `S ${id}`, description: `D ${id}`, status: 'pending',
    blockedBy: [], writeScopes: [`src/${id}`], ready: true, writeScopeWarnings: [], ...extra,
  }
}

function member(name: string, status: TeamMemberView['status'] = 'inactive'): TeamMemberView {
  return { id: SessionId(`${name}-id`), name, role: 'teammate', status, diagnostics: [] }
}

const LEAD_ROW: TeamMemberView = { id: SessionId('lead'), name: 'lead', role: 'lead', status: 'running', diagnostics: [] }

function auto(taskId: string, extra: Partial<DispatchItem> = {}): DispatchItem {
  return { version: 1, taskId, priority: 'P2', deadline: null, dispatch: 'auto', readOnly: false, preferredMember: null, ...extra }
}

interface Setup {
  tasks?: TeamTaskView[]
  members?: TeamMemberView[]
  owners?: Record<string, string>
  items?: DispatchItem[]
  armed?: boolean
  cold?: boolean
  update?: (request: UpdateTeamTaskRequest) => Promise<TeamTaskView>
  send?: () => Promise<{ messageId: string }>
}

function setup(options: Setup = {}) {
  const state: LiveDispatchState = emptyState()
  state.armed = options.armed ?? true
  for (const item of options.items ?? []) state.items[item.taskId] = item
  const tasks = options.tasks ?? []
  const members = [LEAD_ROW, ...(options.members ?? [member('a'), member('b')])]
  const facts: TeamFacts = {
    members: members.filter(m => m.role === 'teammate').map(m => ({ id: m.id, phase: m.status === 'failed' ? 'failed' : m.status === 'provisioning' ? 'provisioning' : 'active' })),
    tasks: tasks.map(t => ({ id: t.id, ownerId: options.owners?.[t.id] })),
  }
  const decisions: DecisionRecord[] = []
  const notices: string[] = []
  const updateTask = vi.fn(async (_lead: Agent, request: UpdateTeamTaskRequest) => {
    if (options.update !== undefined) return options.update(request)
    const current = tasks.find(t => t.id === request.taskId)!
    return { ...current, revision: current.revision + 1, status: request.owner === undefined ? 'pending' as const : 'in_progress' as const }
  })
  const sendMessage = vi.fn(async () => (options.send === undefined ? { messageId: 'm' } : options.send()))
  const ports: TickPorts = {
    config: { maxActive: 2, defaultDispatch: 'manual', requireWriteScopes: true, noticeMaxItems: 20 },
    getLead: () => (options.cold === true ? undefined : LEAD),
    isLead: agent => agent === LEAD,
    armed: () => state.armed,
    state: () => Promise.resolve(state),
    agentTeams: {
      listTasks: () => tasks,
      listMembers: () => members,
      updateTask: updateTask as unknown as TickPorts['agentTeams']['updateTask'],
      sendMessage: sendMessage as unknown as TickPorts['agentTeams']['sendMessage'],
    },
    teamFacts: () => facts,
    appendDecision: (_lead, data) => {
      decisions.push(data)
      applyRecord(state, { type: DECISION_RECORD, seq: decisions.length, data })
      return Promise.resolve()
    },
    notify: (_lead, notice) => { notices.push(notice.text) },
  }
  return { ports, state, decisions, notices, updateTask, sendMessage }
}

const tick = (ports: TickPorts) => runTick(ports, SessionId('lead'), SIGNAL)

describe('runTick gates', () => {
  it('does nothing when the Lead is cold, not a Lead, or not armed', async () => {
    for (const options of [{ cold: true }, { armed: false }]) {
      const s = setup({ ...options, tasks: [view('task-1')], items: [auto('task-1')] })
      const report = await tick(s.ports)
      expect(report.ran).toBe(false)
      expect(s.updateTask).not.toHaveBeenCalled()
      expect(s.sendMessage).not.toHaveBeenCalled()
      expect(s.notices).toEqual([])
    }
    const s = setup({ tasks: [view('task-1')], items: [auto('task-1')] })
    const notLead = await runTick({ ...s.ports, isLead: () => false }, SessionId('lead'), SIGNAL)
    expect(notLead.reason).toBe('not-lead')
    const noFacts = await runTick({ ...s.ports, teamFacts: () => undefined }, SessionId('lead'), SIGNAL)
    expect(noFacts.ran).toBe(false)
  })

  it('ignores tasks that are not enrolled when the default is manual', async () => {
    const s = setup({ tasks: [view('task-1')] })
    await tick(s.ports)
    expect(s.updateTask).not.toHaveBeenCalled()
    expect(s.notices).toEqual([])
  })
})

describe('runTick dispatch', () => {
  it('reassigns with CAS, sends the brief, records assigned → dispatched, and notifies once', async () => {
    const s = setup({ tasks: [view('task-1', { revision: 4 })], items: [auto('task-1')] })
    await tick(s.ports)
    expect(s.updateTask).toHaveBeenCalledWith(LEAD, { taskId: 'task-1', expectedRevision: 4, owner: 'a', action: 'reassign' })
    expect(s.sendMessage).toHaveBeenCalledOnce()
    const sent = (s.sendMessage.mock.calls[0] as unknown[])[1] as { target: string; content: { text: string }[] }
    expect(sent.target).toBe('a')
    expect(sent.content[0]?.text).toMatch(/^Scheduled task task-1: S task-1/u)
    expect(s.decisions.map(d => [d.kind, d.taskId, d.member, d.revision])).toEqual([['assigned', 'task-1', 'a', 5], ['dispatched', 'task-1', 'a', 5]])
    expect(s.notices).toEqual(['Dispatch queue:\n- task-1 → a (dispatched)'])
    expect(s.state.awaitingStart).toEqual({ 'task-1': { revision: 5, memberId: 'a-id' } })
    expect(s.state.unconfirmed).toEqual({})
  })

  it('skips silently on a stale revision or blocked task', async () => {
    for (const code of ['TEAM_TASK_STALE_REVISION', 'TEAM_TASK_BLOCKED']) {
      const s = setup({
        tasks: [view('task-1')], items: [auto('task-1')],
        update: () => Promise.reject(Object.assign(new Error('cas'), { code })),
      })
      await tick(s.ports)
      expect(s.sendMessage).not.toHaveBeenCalled()
      expect(s.decisions).toEqual([])
      expect(s.notices).toEqual([])
    }
  })

  it('reports an unknown assignment outcome without retrying or sending', async () => {
    const s = setup({ tasks: [view('task-1')], items: [auto('task-1')], update: () => Promise.reject(new Error('flush failed')) })
    await tick(s.ports)
    expect(s.sendMessage).not.toHaveBeenCalled()
    expect(s.decisions.map(d => [d.kind, d.reason])).toEqual([['failed', 'assignment outcome unknown: flush failed']])
  })

  it('keeps ownership when the brief delivery throws (it may have been queued) and never compensates', async () => {
    const s = setup({ tasks: [view('task-1')], items: [auto('task-1')], send: () => Promise.reject(new Error('target busy')) })
    await tick(s.ports)
    expect(s.updateTask).toHaveBeenCalledOnce()
    expect(s.decisions.map(d => d.kind)).toEqual(['assigned', 'failed'])
    expect(s.decisions[1]?.reason).toContain('ownership kept, not re-sent')
    expect(s.state.awaitingStart).toEqual({})
    expect(s.state.unconfirmed).toEqual({})
    expect(s.notices[0]).toContain('task-1 needs attention (owner a kept)')
  })

  it('reports a restored unconfirmed assignment once and never re-sends it', async () => {
    const s = setup({ tasks: [view('task-1', { status: 'in_progress', revision: 2 })], owners: { 'task-1': 'a-id' }, members: [member('a', 'running')] })
    s.state.unconfirmed['task-1'] = 'a'
    await tick(s.ports)
    expect(s.sendMessage).not.toHaveBeenCalled()
    expect(s.updateTask).not.toHaveBeenCalled()
    expect(s.decisions.map(d => [d.kind, d.member])).toEqual([['failed', 'a']])
    await tick(s.ports)
    expect(s.decisions).toHaveLength(1)
  })

  it('releases tasks of failed members, reports unknown release outcomes, and skips CAS losses', async () => {
    const tasks = [view('task-1', { status: 'in_progress' }), view('task-2', { status: 'in_progress' }), view('task-3', { status: 'in_progress' })]
    const owners = { 'task-1': 'dead-id', 'task-2': 'dead-id', 'task-3': 'dead-id' }
    const s = setup({
      tasks, owners, members: [member('dead', 'failed')],
      update: (request) => {
        if (request.taskId === 'task-2') return Promise.reject(new Error('io'))
        if (request.taskId === 'task-3') return Promise.reject(Object.assign(new Error('cas'), { code: 'TEAM_TASK_STALE_REVISION' }))
        return Promise.resolve(view('task-1', { revision: 2 }))
      },
    })
    await tick(s.ports)
    expect(s.updateTask.mock.calls.map(c => (c[1] as UpdateTeamTaskRequest).owner)).toEqual([undefined, undefined, undefined])
    expect(s.decisions.map(d => [d.taskId, d.kind])).toEqual([['task-1', 'released'], ['task-2', 'failed']])
  })

  it('reports a stall once per revision, never releases it, and waits for a fresh dispatch to start', async () => {
    const s = setup({ tasks: [view('task-1', { status: 'in_progress', revision: 3 })], owners: { 'task-1': 'a-id' } })
    await tick(s.ports)
    await tick(s.ports)
    expect(s.decisions.map(d => [d.kind, d.revision])).toEqual([['stalled', 3]])
    expect(s.updateTask).not.toHaveBeenCalled()
    const fresh = setup({ tasks: [view('task-1', { status: 'in_progress', revision: 3 })], owners: { 'task-1': 'a-id' } })
    fresh.state.awaitingStart['task-1'] = { revision: 3, memberId: 'a-id' }
    await tick(fresh.ports)
    expect(fresh.decisions).toEqual([])
  })

  it('records a deferred reason once (dedupe) and re-records it when it changes', async () => {
    const tasks = [view('task-1', { status: 'in_progress', writeScopes: ['src'] }), view('task-2', { writeScopes: ['src/x'] })]
    const s = setup({ tasks, owners: { 'task-1': 'a-id' }, members: [member('a', 'running'), member('b')], items: [auto('task-2')] })
    await tick(s.ports)
    await tick(s.ports)
    expect(s.decisions.map(d => [d.kind, d.reason])).toEqual([['deferred', 'overlaps task-1']])
    expect(s.notices).toHaveLength(1)
    s.state.lastDeferred['task-2'] = 'something else'
    await tick(s.ports)
    expect(s.decisions).toHaveLength(2)
  })

  it('honours the WIP override and batches notices', async () => {
    const tasks = ['task-1', 'task-2', 'task-3'].map(id => view(id))
    const s = setup({ tasks, items: tasks.map(t => auto(t.id)), members: [member('a'), member('b'), member('c')] })
    s.state.maxActive = 3
    const report = await tick({ ...s.ports, config: { ...s.ports.config, noticeMaxItems: 2 } })
    expect(report.decisions.filter(d => d.kind === 'dispatched')).toHaveLength(3)
    expect(s.notices).toEqual(['Dispatch queue:\n- task-1 → a (dispatched)\n- task-2 → b (dispatched)\n(1 more)'])
  })
})

describe('dispatch concurrency regressions', () => {
  it('does not retry an uncertain assignment on the next tick', async () => {
    const s = setup({ tasks: [view('task-1')], items: [auto('task-1')], update: () => Promise.reject(new Error('flush failed')) })
    await tick(s.ports)
    await tick(s.ports)
    expect(s.updateTask).toHaveBeenCalledOnce()
    expect(s.state.held['task-1']).toContain('flush failed')
    expect(describeStatus(s.ports, LEAD, s.state).queue).toEqual([])
  })

  it('does not send after the human pauses during assignment', async () => {
    const gate = Promise.withResolvers<TeamTaskView>()
    const s = setup({ tasks: [view('task-1')], items: [auto('task-1')], update: () => gate.promise })
    const running = tick(s.ports)
    await vi.waitFor(() => expect(s.updateTask).toHaveBeenCalledOnce())
    s.state.armed = false
    gate.resolve(view('task-1', { status: 'in_progress', revision: 2 }))
    await running
    expect(s.sendMessage).not.toHaveBeenCalled()
    expect(s.decisions.at(-1)?.reason).toContain('paused after assignment')
  })

  it('stops subsequent assignments when paused during an in-flight send', async () => {
    const gate = Promise.withResolvers<{ messageId: string }>()
    const s = setup({ tasks: [view('task-1'), view('task-2')], items: [auto('task-1'), auto('task-2')], send: () => gate.promise })
    const running = tick(s.ports)
    await vi.waitFor(() => expect(s.sendMessage).toHaveBeenCalledOnce())
    s.state.armed = false
    gate.resolve({ messageId: 'm' })
    await running
    expect(s.updateTask).toHaveBeenCalledOnce()
  })

  it('rechecks later task revisions after awaiting a send', async () => {
    const tasks = [view('task-1'), view('task-2')]
    const s = setup({ tasks, items: [auto('task-1'), auto('task-2')], send: async () => {
      tasks[1] = view('task-2', { revision: 2, writeScopes: ['src/task-1'] })
      return { messageId: 'm' }
    } })
    await tick(s.ports)
    expect(s.updateTask).toHaveBeenCalledOnce()
  })
})

describe('describeStatus', () => {
  it('summarizes queue, WIP, deferrals, and the paused-after-restart state', () => {
    const tasks = [view('task-1', { status: 'in_progress' }), view('task-2'), view('task-3')]
    const s = setup({ tasks, owners: { 'task-1': 'a-id' }, items: [auto('task-3', { priority: 'P0', deadline: '2026-11-01T00:00:00.000Z' }), auto('task-2')] })
    s.state.armed = false
    s.state.armedInLog = true
    s.state.lastDeferred['task-9'] = 'no idle teammate'
    s.state.diagnostics = 1
    const status = describeStatus(s.ports, LEAD, s.state)
    expect(status).toMatchObject({ armed: false, active: 1, limit: 2 })
    expect(status.queue.map(q => q.task_id)).toEqual(['task-3', 'task-2'])
    expect(statusText(status)).toBe([
      'Dispatch is OFF (paused after restart; run /dispatch on to resume). WIP 1/2.',
      'Queue: task-3 (P0, due 2026-11-01T00:00:00.000Z), task-2 (P2).',
      'Last deferred: task-9: no idle teammate.',
      '1 invalid scheduler record(s) skipped.',
    ].join('\n'))
    s.state.items = {}
    expect(statusText(describeStatus({ ...s.ports, teamFacts: () => undefined }, LEAD, s.state))).toContain('Queue: empty.')
  })
})

describe('TickLoop', () => {
  it('debounces, serializes one tick per Lead, reruns after a trigger during a tick, and disposes', async () => {
    let running = 0
    let maxRunning = 0
    const calls: string[] = []
    const gate = Promise.withResolvers<void>()
    const loop = new TickLoop(async (leadId) => {
      calls.push(leadId)
      running += 1
      maxRunning = Math.max(maxRunning, running)
      if (calls.length === 1) await gate.promise
      running -= 1
    }, 5, () => undefined)
    loop.schedule(SessionId('l'))
    loop.schedule(SessionId('l'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toEqual(['l'])
    loop.schedule(SessionId('l'))
    loop.schedule(SessionId('l'))
    gate.resolve()
    await loop.idle()
    expect(calls).toEqual(['l', 'l'])
    expect(maxRunning).toBe(1)
    loop.dispose()
    loop.schedule(SessionId('l'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toHaveLength(2)
  })

  it('reports tick errors instead of throwing, and aborts in-flight ticks on dispose', async () => {
    const errors: unknown[] = []
    let seen: AbortSignal | undefined
    const loop = new TickLoop(async (_id, signal) => {
      seen = signal
      throw new Error('boom')
    }, 0, error => { errors.push(error) })
    loop.schedule(SessionId('l'))
    await loop.idle()
    expect(errors).toHaveLength(1)
    loop.dispose()
    expect(seen?.aborted).toBe(true)
  })
})
