import { describe, expect, it } from 'vitest'
import {
  briefText,
  compareCandidates,
  dispatchModeOf,
  normalizeScope,
  planTick,
  scopeSetsOverlap,
  scopesOverlap,
  selectCandidates,
  taskNumber,
  type PlanInput,
} from '../src/policy.js'
import type { DispatchItem, PolicyMember, PolicyTask } from '../src/types.js'

function task(id: string, extra: Partial<PolicyTask> = {}): PolicyTask {
  return { id, revision: 1, subject: `subject ${id}`, description: `description ${id}`, status: 'pending', ready: true, writeScopes: [`src/${id}`], ...extra }
}

function mate(name: string, extra: Partial<PolicyMember> = {}): PolicyMember {
  return { id: `${name}-id`, name, role: 'teammate', status: 'inactive', phase: 'active', ...extra }
}

const LEAD: PolicyMember = { id: 'lead', name: 'lead', role: 'lead', status: 'running', phase: 'active' }

function item(taskId: string, extra: Partial<DispatchItem> = {}): DispatchItem {
  return { version: 1, taskId, priority: 'P2', deadline: null, dispatch: 'auto', readOnly: false, preferredMember: null, ...extra }
}

function items(...list: DispatchItem[]): Record<string, DispatchItem> {
  return Object.fromEntries(list.map(i => [i.taskId, i]))
}

function plan(partial: Partial<PlanInput>) {
  return planTick({
    tasks: [], members: [LEAD, mate('a'), mate('b')], items: {}, stalled: {}, awaitingStart: {},
    limit: 2, defaultDispatch: 'auto', requireWriteScopes: true, ...partial,
  })
}

describe('normalizeScope', () => {
  it.each([
    ['src', 'src'],
    ['./src', 'src'],
    ['src/', 'src'],
    ['src///', 'src'],
    ['  ./src/a/ ', 'src/a'],
    ['src\\a\\b', 'src/a/b'],
    ['', ''],
    ['./', '.'],
    ['src/../docs//a', 'docs/a'],
    ['/', '/'],
  ])('%j → %j', (raw, normalized) => {
    expect(normalizeScope(raw)).toBe(normalized)
  })
})

describe('scopesOverlap', () => {
  it.each([
    ['src', 'src', true],
    ['src', 'src/a', true],
    ['src/a', 'src', true],
    ['./src/', 'src/a/b.ts', true],
    ['src/a', 'src/ab', false],
    ['src/ab', 'src/a', false],
    ['src/a', 'src/b', false],
    ['.', 'src', true],
    ['/', 'src/a', true],
    ['lib', 'src', false],
    ['', 'src', false],
    ['src', '', false],
    ['src\\a', 'src/a/x', true],
  ])('%j vs %j → %s', (a, b, expected) => {
    expect(scopesOverlap(a, b)).toBe(expected)
  })

  it('compares scope sets pairwise', () => {
    expect(scopeSetsOverlap(['a', 'b'], ['c', 'b/x'])).toBe(true)
    expect(scopeSetsOverlap(['a'], ['c'])).toBe(false)
    expect(scopeSetsOverlap([], ['c'])).toBe(false)
  })
})

describe('ordering and candidates', () => {
  it('parses task numbers', () => {
    expect(taskNumber('task-12')).toBe(12)
    expect(taskNumber('other')).toBe(Number.POSITIVE_INFINITY)
  })

  it('defaults the dispatch mode', () => {
    expect(dispatchModeOf(undefined, 'manual')).toBe('manual')
    expect(dispatchModeOf(undefined, 'auto')).toBe('auto')
    expect(dispatchModeOf(item('t', { dispatch: 'manual' }), 'auto')).toBe('manual')
  })

  it('orders by priority, then deadline (null last), then task number', () => {
    const tasks = ['task-1', 'task-2', 'task-3', 'task-4', 'task-5', 'task-10', 'task-9'].map(id => task(id))
    const map = items(
      item('task-1', { priority: 'P3' }),
      item('task-2', { priority: 'P0' }),
      item('task-3', { priority: 'P1', deadline: '2026-11-02T00:00:00.000Z' }),
      item('task-4', { priority: 'P1', deadline: '2026-11-01T00:00:00.000Z' }),
      item('task-5', { priority: 'P1' }),
    )
    // task-9 / task-10 have no item → P2, ordered numerically
    expect(selectCandidates(tasks, map, 'auto').map(t => t.id)).toEqual(['task-2', 'task-4', 'task-3', 'task-5', 'task-9', 'task-10', 'task-1'])
  })

  it('falls back to id order for non-numbered ids', () => {
    expect(compareCandidates(task('b'), task('a'), {})).toBeGreaterThan(0)
    expect(compareCandidates(task('a'), task('a'), {})).toBe(0)
    expect(compareCandidates(task('task-1'), task('x'), {})).toBeLessThan(0)
  })

  it('selects only pending, ready, unowned, auto tasks', () => {
    const tasks = [
      task('task-1'),
      task('task-2', { ready: false }),
      task('task-3', { status: 'in_progress', ownerId: 'a-id' }),
      task('task-4', { ownerId: 'a-id' }),
      task('task-5', { status: 'completed' }),
      task('task-6'),
      task('task-7'),
    ]
    const map = items(item('task-6', { dispatch: 'manual' }), item('task-7', { dispatch: 'auto' }))
    expect(selectCandidates(tasks, map, 'auto').map(t => t.id)).toEqual(['task-1', 'task-7'])
    expect(selectCandidates(tasks, map, 'manual').map(t => t.id)).toEqual(['task-7'])
  })
})

describe('planTick', () => {
  it('dispatches candidates to idle teammates in roster order up to the limit', () => {
    const result = plan({ tasks: [task('task-1'), task('task-2'), task('task-3')] })
    expect(result.dispatches.map(d => [d.task.id, d.member.name])).toEqual([['task-1', 'a'], ['task-2', 'b']])
    expect(result.deferrals).toEqual([])
    expect(result.active).toBe(2)
    expect(result.limit).toBe(2)
  })

  it('counts existing teammate-owned in_progress tasks against the WIP limit (Lead-owned tasks do not count)', () => {
    const tasks = [
      task('task-1', { status: 'in_progress', ownerId: 'a-id' }),
      task('task-2', { status: 'in_progress', ownerId: 'lead', writeScopes: ['lead-area'] }),
      task('task-3'),
      task('task-4'),
    ]
    const result = plan({ tasks, members: [LEAD, mate('a', { status: 'running' }), mate('b'), mate('c')] })
    expect(result.dispatches.map(d => [d.task.id, d.member.name])).toEqual([['task-3', 'b']])
    expect(result.active).toBe(2)
  })

  it('dispatches nothing when the limit is already reached', () => {
    const tasks = [task('task-1', { status: 'in_progress', ownerId: 'a-id' }), task('task-2')]
    const result = plan({ tasks, members: [LEAD, mate('a', { status: 'running' }), mate('b')], limit: 1 })
    expect(result.dispatches).toEqual([])
    expect(result.deferrals).toEqual([])
  })

  it('defers missing write scopes unless read-only or not required', () => {
    const tasks = [task('task-1', { writeScopes: [] }), task('task-2', { writeScopes: ['  ', ''] }), task('task-3', { writeScopes: [] })]
    const map = items(item('task-3', { readOnly: true }))
    const result = plan({ tasks, items: map, limit: 5 })
    expect(result.deferrals.map(d => [d.task.id, d.reason])).toEqual([['task-1', 'no write scopes'], ['task-2', 'no write scopes']])
    expect(result.dispatches.map(d => d.task.id)).toEqual(['task-3'])
    const relaxed = plan({ tasks, items: map, limit: 5, requireWriteScopes: false })
    // Empty scopes are still unknown isolation: the first may run, later write tasks cannot overlap it.
    expect(relaxed.dispatches.map(d => d.task.id)).toEqual(['task-1', 'task-3'])
    expect(relaxed.deferrals.map(d => d.task.id)).toEqual(['task-2'])
  })

  it('defers overlap with in_progress tasks and with tasks assigned earlier in the same tick', () => {
    const tasks = [
      task('task-1', { status: 'in_progress', ownerId: 'a-id', writeScopes: ['src/api'] }),
      task('task-2', { writeScopes: ['src/api/routes'] }),
      task('task-3', { writeScopes: ['docs'] }),
      task('task-4', { writeScopes: ['./docs/guide/'] }),
      task('task-5', { writeScopes: ['web'] }),
    ]
    const result = plan({ tasks, members: [LEAD, mate('a', { status: 'running' }), mate('b'), mate('c')], limit: 4 })
    expect(result.dispatches.map(d => [d.task.id, d.member.name])).toEqual([['task-3', 'b'], ['task-5', 'c']])
    expect(result.deferrals.map(d => [d.task.id, d.reason])).toEqual([['task-2', 'overlaps task-1'], ['task-4', 'overlaps task-3']])
  })

  it('lets a read-only task bypass the overlap check and not block others', () => {
    const tasks = [
      task('task-1', { status: 'in_progress', ownerId: 'a-id', writeScopes: ['src'] }),
      task('task-2', { writeScopes: ['src'] }),
      task('task-3', { writeScopes: ['src/x'] }),
    ]
    const map = items(item('task-1', { readOnly: true }), item('task-2', { readOnly: true }))
    const result = plan({ tasks, items: map, members: [LEAD, mate('a', { status: 'running' }), mate('b'), mate('c')], limit: 5 })
    expect(result.dispatches.map(d => d.task.id)).toEqual(['task-2', 'task-3'])
  })

  it('prefers the preferred member when idle and otherwise falls back to roster order', () => {
    const tasks = [task('task-1'), task('task-2')]
    const map = items(item('task-1', { preferredMember: 'b' }), item('task-2', { preferredMember: 'b' }))
    const result = plan({ tasks, items: map })
    expect(result.dispatches.map(d => [d.task.id, d.member.name])).toEqual([['task-1', 'b'], ['task-2', 'a']])
    const missing = plan({ tasks: [task('task-1')], items: items(item('task-1', { preferredMember: 'ghost' })) })
    expect(missing.dispatches.map(d => d.member.name)).toEqual(['a'])
  })

  it.each([
    ['running', mate('a', { status: 'running' })],
    ['provisioning', mate('a', { status: 'provisioning', phase: 'provisioning' })],
    ['failed', mate('a', { status: 'failed', phase: 'failed' })],
    ['inactive but not active phase', mate('a', { phase: 'provisioning' })],
  ])('does not treat a %s teammate as idle', (_label, member) => {
    const result = plan({ tasks: [task('task-1')], members: [LEAD, member] })
    expect(result.dispatches).toEqual([])
    expect(result.deferrals.map(d => d.reason)).toEqual(['no idle teammate'])
  })

  it('does not assign to a teammate that already owns in_progress work, nor to the Lead', () => {
    const tasks = [task('task-1', { status: 'in_progress', ownerId: 'a-id', writeScopes: ['x'] }), task('task-2')]
    const result = plan({ tasks, members: [LEAD, mate('a')], limit: 5 })
    expect(result.dispatches).toEqual([])
    expect(result.deferrals.map(d => [d.task.id, d.reason])).toEqual([['task-2', 'no idle teammate']])
  })

  it('releases tasks owned by failed members and frees their WIP and scopes', () => {
    const tasks = [
      task('task-1', { status: 'in_progress', ownerId: 'dead-id', writeScopes: ['src'] }),
      task('task-2', { writeScopes: ['src/a'] }),
    ]
    const members = [LEAD, mate('dead', { status: 'failed', phase: 'failed' }), mate('b')]
    const result = plan({ tasks, members, limit: 1 })
    expect(result.releases.map(t => t.id)).toEqual(['task-1'])
    expect(result.dispatches.map(d => [d.task.id, d.member.name])).toEqual([['task-2', 'b']])
  })

  it('reports a stall once per revision and not while a fresh dispatch awaits its start', () => {
    const tasks = [task('task-1', { status: 'in_progress', ownerId: 'a-id', revision: 3 })]
    expect(plan({ tasks }).stalls.map(s => [s.task.id, s.member.name])).toEqual([['task-1', 'a']])
    expect(plan({ tasks, stalled: { 'task-1': 3 } }).stalls).toEqual([])
    expect(plan({ tasks, stalled: { 'task-1': 2 } }).stalls).toHaveLength(1)
    expect(plan({ tasks, awaitingStart: { 'task-1': 3 } }).stalls).toEqual([])
    const running = plan({ tasks, members: [LEAD, mate('a', { status: 'running' })] })
    expect(running.stalls).toEqual([])
    const leadOwned = plan({ tasks: [task('task-1', { status: 'in_progress', ownerId: 'lead' })] })
    expect(leadOwned.stalls).toEqual([])
  })
})

describe('briefText', () => {
  it('renders the stable brief', () => {
    expect(briefText(task('task-3', { subject: 'Add API', description: 'Implement GET /x.', writeScopes: ['./src/api/', 'tests/api'] }))).toMatchInlineSnapshot(`
      "Scheduled task task-3: Add API
      Implement GET /x.
      Write scopes: src/api, tests/api
      You are assigned as owner. Work only inside the write scopes above. When finished, mark the task complete with team_task_update and send the result summary to lead with send_message."
    `)
  })

  it('renders read-only and empty scopes', () => {
    expect(briefText(task('task-1'), true)).toContain('Write scopes: none (read-only)')
    expect(briefText(task('task-1', { writeScopes: [] }))).toContain('Write scopes: unspecified (no isolation)')
  })
})
