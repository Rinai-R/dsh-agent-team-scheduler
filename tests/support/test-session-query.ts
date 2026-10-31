/**
 * Minimal concrete Session query for integration tests, adapted from the DeepSeek Harness
 * monorepo `packages/experimental/agent-team/tests/test-session-query.ts` (MIT). Live sessions
 * are read from `ctx.sessions`; cold sessions through a short-lived persistence read handle.
 */
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type { SessionObservation, SessionObservationOptions } from '@deepseek-ai/dsh-session-query'

/** Counts observations so tests can assert every lease is released. */
export const observationStats = { opened: 0, disposed: 0 }

function cut(
  source: 'live' | 'prepared',
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
  events: readonly SessionEvent[],
): SessionObservation {
  const lease = (): SessionObservation => {
    observationStats.opened += 1
    return {
      source,
      header,
      inheritedEventCount,
      events,
      cursor: events.at(-1)?.seq ?? -1,
      retain: lease,
      [Symbol.dispose]: () => { observationStats.disposed += 1 },
    }
  }
  return lease()
}

/** Session query implementation whose search faces are outside these tests. */
export class TestSessionQuery extends SessionQueryEngine {
  static override inject = ['sessions', 'sessionPersistence']

  /** Track which path served each observation. */
  static readonly sources: Array<'live' | 'prepared'> = []

  override async observeSession(sessionId: SessionId, options: SessionObservationOptions = {}): Promise<SessionObservation> {
    const live = this.ctx.sessions.get(sessionId)
    if (live !== undefined) {
      TestSessionQuery.sources.push('live')
      return cut('live', live.header, live.inheritedEventCount, live.snapshotEvents())
    }
    const signal = options.signal === undefined ? {} : { signal: options.signal }
    const handle = await this.ctx.sessionPersistence.open(sessionId, 'read', signal)
    try {
      TestSessionQuery.sources.push('prepared')
      return cut('prepared', handle.header, handle.inheritedEventCount, (await handle.read(0, undefined, signal)).events)
    } finally {
      await handle.close()
    }
  }

  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}
