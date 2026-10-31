import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { renderNotice, decisionLine } from '../src/notices.js'
import { CONTROL_RECORD, DECISION_RECORD, ITEM_RECORD, normalizeDeadline, parseControl, parseDecision, parseItem, readSchedulerRecord } from '../src/records.js'
import { applyRecord, DispatchStateCache, foldState } from '../src/state.js'
import type { DecisionRecord } from '../src/types.js'

function rec(type: string, seq: number, data: unknown, ignorable = true): SessionEvent {
  return { type, seq, time: 0, data, ...(ignorable ? { ignorable: true } : {}) } as unknown as SessionEvent
}

const ITEM = { version: 1, taskId: 'task-1', priority: 'P1', deadline: null, dispatch: 'auto', readOnly: false, preferredMember: 'a' }

describe('record validators', () => {
  it('accepts valid records', () => {
    expect(parseControl({ version: 1, armed: true, actor: 'human' })).toEqual({ version: 1, armed: true, actor: 'human' })
    expect(parseControl({ version: 1, armed: false, actor: 'human', maxActive: 3 })).toMatchObject({ maxActive: 3 })
    expect(parseItem(ITEM)).toEqual(ITEM)
    expect(parseItem({ ...ITEM, deadline: '2026-11-01T00:00:00.000Z' })).toMatchObject({ deadline: '2026-11-01T00:00:00.000Z' })
    expect(parseDecision({ version: 1, taskId: 't', kind: 'stalled', member: 'a', reason: 'r', revision: 4 })).toMatchObject({ revision: 4 })
    expect(parseDecision({ version: 1, taskId: 't', kind: 'assigned', member: null, reason: '' })).toBeDefined()
  })

  it.each([
    ['control version', () => parseControl({ version: 2, armed: true, actor: 'human' })],
    ['control actor', () => parseControl({ version: 1, armed: true, actor: 'model' })],
    ['control armed', () => parseControl({ version: 1, armed: 'yes', actor: 'human' })],
    ['control wip', () => parseControl({ version: 1, armed: true, actor: 'human', maxActive: 0 })],
    ['control array', () => parseControl([])],
    ['item priority', () => parseItem({ ...ITEM, priority: 'P9' })],
    ['item dispatch', () => parseItem({ ...ITEM, dispatch: 'maybe' })],
    ['item task id', () => parseItem({ ...ITEM, taskId: '' })],
    ['item deadline not normalized', () => parseItem({ ...ITEM, deadline: '2026-11-01' })],
    ['item readOnly', () => parseItem({ ...ITEM, readOnly: 1 })],
    ['item preferred', () => parseItem({ ...ITEM, preferredMember: 3 })],
    ['decision kind', () => parseDecision({ version: 1, taskId: 't', kind: 'exploded', member: null, reason: '' })],
    ['decision revision', () => parseDecision({ version: 1, taskId: 't', kind: 'stalled', member: null, reason: '', revision: 1.5 })],
    ['decision member', () => parseDecision({ version: 1, taskId: 't', kind: 'stalled', member: 1, reason: '' })],
    ['null', () => parseDecision(null)],
  ])('rejects %s', (_label, parse) => {
    expect(parse()).toBeUndefined()
  })

  it('normalizes deadlines', () => {
    expect(normalizeDeadline('2026-11-01')).toBe('2026-11-01T00:00:00.000Z')
    expect(normalizeDeadline('2026-11-01T08:00:00+08:00')).toBe('2026-11-01T00:00:00.000Z')
    expect(normalizeDeadline('soon')).toBeUndefined()
  })

  it('classifies events', () => {
    expect(readSchedulerRecord(rec('turn/end', 0, {}, false)).kind).toBe('none')
    expect(readSchedulerRecord(rec('plugin:someone/else', 0, {})).kind).toBe('none')
    expect(readSchedulerRecord(rec(ITEM_RECORD, 0, { bad: true })).kind).toBe('invalid')
    expect(readSchedulerRecord(rec(ITEM_RECORD, 2, ITEM))).toEqual({ kind: 'record', record: { type: ITEM_RECORD, seq: 2, data: ITEM } })
  })
})

describe('foldState', () => {
  it('folds records in seq order, last item wins, and counts invalid records', () => {
    const state = foldState([
      rec(ITEM_RECORD, 3, { ...ITEM, priority: 'P0' }),
      rec(ITEM_RECORD, 1, ITEM),
      rec(CONTROL_RECORD, 2, { version: 1, armed: true, actor: 'human', maxActive: 4 }),
      rec(DECISION_RECORD, 4, { version: 1, taskId: 'task-2', kind: 'deferred', member: null, reason: 'overlaps task-1' }),
      rec(DECISION_RECORD, 5, { version: 1, taskId: 'task-3', kind: 'stalled', member: 'a', reason: 'x', revision: 7 }),
      rec(DECISION_RECORD, 6, { version: 1, taskId: 'task-4', kind: 'assigned', member: 'b', reason: 'assigned', revision: 2 }),
      rec(DECISION_RECORD, 7, { version: 1, taskId: 'task-5', kind: 'assigned', member: 'a', reason: 'assigned' }),
      rec(DECISION_RECORD, 8, { version: 1, taskId: 'task-5', kind: 'dispatched', member: 'a', reason: 'brief accepted' }),
      rec(DECISION_RECORD, 9, { nope: 1 }),
      rec(CONTROL_RECORD, 10, { version: 1, armed: 'x' }),
    ], 0)
    expect(state.items['task-1']?.priority).toBe('P0')
    expect(state.maxActive).toBe(4)
    expect(state.lastDeferred).toEqual({ 'task-2': 'overlaps task-1' })
    expect(state.stalled).toEqual({ 'task-3': 7 })
    expect(state.unconfirmed).toEqual({ 'task-4': 'b' })
    expect(state.diagnostics).toBe(2)
  })

  it('restores arming as paused: armedInLog only, never armed', () => {
    const state = foldState([rec(CONTROL_RECORD, 0, { version: 1, armed: true, actor: 'human' })], 0)
    expect(state.armedInLog).toBe(true)
    expect(state.armed).toBe(false)
  })

  it('ignores EVERY inherited scheduler record (fork ancestry task-id collision)', () => {
    // An ancestor Team enrolled its own task-1 with a preferred member and armed dispatch.
    const ancestor = [
      rec(CONTROL_RECORD, 0, { version: 1, armed: true, actor: 'human', maxActive: 9 }),
      rec(ITEM_RECORD, 1, { ...ITEM, preferredMember: 'old-mate' }),
      rec(DECISION_RECORD, 2, { version: 1, taskId: 'task-1', kind: 'deferred', member: null, reason: 'overlaps task-2' }),
      rec(DECISION_RECORD, 3, { version: 1, taskId: 'task-1', kind: 'assigned', member: 'old-mate', reason: 'assigned' }),
    ]
    // The forked root creates its own, unrelated task-1.
    const state = foldState([...ancestor, rec('turn/end', 4, {}, false)], 4)
    expect(state.items).toEqual({})
    expect(state.armedInLog).toBe(false)
    expect(state.maxActive).toBeNull()
    expect(state.lastDeferred).toEqual({})
    expect(state.unconfirmed).toEqual({})
    const own = foldState([...ancestor, rec(ITEM_RECORD, 4, { ...ITEM, preferredMember: null })], 4)
    expect(own.items['task-1']?.preferredMember).toBeNull()
  })

  it('applies live control records as armed and clears deferral on dispatch', () => {
    const state = foldState([], 0)
    applyRecord(state, { type: CONTROL_RECORD, seq: 0, data: { version: 1, armed: true, actor: 'human' } })
    expect(state.armed).toBe(true)
    applyRecord(state, { type: DECISION_RECORD, seq: 1, data: { version: 1, taskId: 't', kind: 'deferred', member: null, reason: 'r' } })
    applyRecord(state, { type: DECISION_RECORD, seq: 2, data: { version: 1, taskId: 't', kind: 'released', member: null, reason: 'r' } })
    expect(state.lastDeferred).toEqual({})
    applyRecord(state, { type: DECISION_RECORD, seq: 3, data: { version: 1, taskId: 't', kind: 'stalled', member: null, reason: 'r' } })
    expect(state.stalled).toEqual({})
  })
})

describe('DispatchStateCache', () => {
  it('builds once, keeps in-process arming across drops, and resets on clear', async () => {
    let reads = 0
    const cache = new DispatchStateCache(() => {
      reads += 1
      return Promise.resolve({ events: [rec(CONTROL_RECORD, 0, { version: 1, armed: true, actor: 'human' })], inheritedEventCount: 0 })
    })
    const lead = 'lead' as never
    const [a, b] = await Promise.all([cache.get(lead), cache.get(lead)])
    expect(a).toBe(b)
    expect(reads).toBe(1)
    expect(a.armed).toBe(false)
    expect(cache.armed(lead)).toBe(false)
    await cache.apply(lead, { type: CONTROL_RECORD, seq: 1, data: { version: 1, armed: true, actor: 'human' } })
    expect(a.armed).toBe(true)
    cache.drop(lead)
    expect(cache.has(lead)).toBe(false)
    const rebuilt = await cache.get(lead)
    expect(reads).toBe(2)
    expect(rebuilt.armed).toBe(true)
    rebuilt.awaitingStart['task-1'] = { revision: 2, memberId: 'm' }
    rebuilt.awaitingStart['task-2'] = { revision: 2, memberId: 'n' }
    cache.markStarted(lead, 'm')
    await Promise.resolve()
    await Promise.resolve()
    expect(Object.keys(rebuilt.awaitingStart)).toEqual(['task-2'])
    cache.clear()
    expect(cache.armed(lead)).toBe(false)
  })

  it('records arming applied before the state was built', async () => {
    const cache = new DispatchStateCache(() => Promise.resolve({ events: [], inheritedEventCount: 0 }))
    await cache.apply('l' as never, { type: CONTROL_RECORD, seq: 0, data: { version: 1, armed: true, actor: 'human' } })
    expect((await cache.get('l' as never)).armed).toBe(true)
  })

  it('forgets a failed build', async () => {
    let fail = true
    const cache = new DispatchStateCache(() => (fail ? Promise.reject(new Error('io')) : Promise.resolve({ events: [], inheritedEventCount: 0 })))
    await expect(cache.get('l' as never)).rejects.toThrow('io')
    await Promise.resolve()
    fail = false
    await expect(cache.get('l' as never)).resolves.toMatchObject({ armed: false })
  })
})

describe('notices', () => {
  const d = (kind: DecisionRecord['kind'], taskId: string, member: string | null, reason: string) => ({ taskId, kind, member, reason })

  it('renders each decision kind', () => {
    expect(decisionLine(d('dispatched', 'task-3', 'api-dev', 'brief accepted'))).toBe('task-3 → api-dev (dispatched)')
    expect(decisionLine(d('assigned', 'task-3', 'api-dev', 'assigned'))).toBe('task-3 → api-dev (assigned, brief not confirmed)')
    expect(decisionLine(d('deferred', 'task-5', null, 'overlaps task-3'))).toBe('task-5 deferred: overlaps task-3')
    expect(decisionLine(d('released', 'task-2', 'x', 'owner x failed'))).toBe('task-2 released: owner x failed')
    expect(decisionLine(d('stalled', 'task-4', 'b', 'owner b is inactive'))).toBe('task-4 stalled: owner b is inactive')
    expect(decisionLine(d('failed', 'task-6', null, 'boom'))).toBe('task-6 needs attention (owner ? kept): boom')
  })

  it('batches lines with an overflow marker and a bounded summary', () => {
    expect(renderNotice([], 20)).toBeUndefined()
    const decisions = [d('dispatched', 'task-1', 'a', ''), d('deferred', 'task-2', null, 'no idle teammate'), d('deferred', 'task-3', null, 'no write scopes')]
    expect(renderNotice(decisions, 2)).toEqual({
      text: 'Dispatch queue:\n- task-1 → a (dispatched)\n- task-2 deferred: no idle teammate\n(1 more)',
      summary: 'Dispatch: 1 dispatched, 2 deferred',
    })
    expect(renderNotice(decisions, 20)?.text).not.toContain('more')
  })
})
