import { describe, expect, it } from 'vitest'

import { failureNotice, runNotices, sendNotice } from '../ops/notify'
import { emptyStandbyState, standbyDecision, watchdog } from '../ops/standby'

import type { TWorkflowRun } from '../ops/github'
import type { TRunSummary } from '../run/run'

const NOW = new Date('2026-10-14T20:00:00Z')
const minutesAgo = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString()

function ciRun(startedMinutesAgo: number, status: string, conclusion: string | null): TWorkflowRun {
  const at = minutesAgo(startedMinutesAgo)
  return { id: startedMinutesAgo, status, conclusion, event: 'schedule', created_at: at, run_started_at: at, updated_at: at, html_url: '' }
}

const baseSummary: TRunSummary = {
  upcoming: { changed: false, date: null, consentItems: null },
  discovered: [],
  resolved: [],
  meetings: [],
  pendingSummaries: 0,
  startedAt: NOW.toISOString(),
  dryRun: false,
  changedFiles: [],
  publishedChanged: false,
  commit: null,
  pushed: false,
  deployed: false,
  legistarRequests: 15,
  llm: { status: 'disabled' },
}

describe('alerts for a run', () => {
  it('announces a posted agenda, and stays quiet for routine checks', () => {
    const posted = runNotices({ ...baseSummary, meetings: [{ key: '2026-10-14', eventId: 5825, items: 87, diff: null, unchanged: false, final: false }] })
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({ title: 'October 14, 2026 agenda posted', priority: 'default' })
    expect(posted[0].message).toContain('87 consent items')
    expect(runNotices({ ...baseSummary, meetings: [{ key: '2026-10-14', eventId: 5825, items: 87, diff: null, unchanged: true, final: false }] })).toEqual([])
    expect(runNotices({ ...baseSummary, dryRun: true, meetings: [{ key: '2026-10-14', eventId: 5825, items: 87, diff: null, unchanged: false, final: false }] })).toEqual([])
  })

  it('reports summaries with the flagged count, items needing a human, and the 80% spend line once', () => {
    const llm = (monthSpendUsd: number, costUsd: number, flagged: number, gaveUp = 0): TRunSummary => ({
      ...baseSummary,
      llm: {
        status: 'ran', reason: null, meetings: [], usage: { requests: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd },
        monthSpendUsd, capUsd: 25, commit: null, pushed: true, deployed: true, error: null,
        changes: { meetings: [{ key: '2026-10-14', summaries: 87, secondReadings: 24, failed: 0, waiting: 0, gaveUp, flagged }], costUsd, monthSpendUsd, capUsd: 25, capped: false },
      },
    })
    const ok = runNotices(llm(2, 1.5, 0))
    expect(ok.map(n => [n.title, n.priority])).toEqual([['October 14, 2026 summaries published', 'default']])
    expect(ok[0].message).toBe('87 summaries, 24 second readings. Nothing flagged for review.')

    const flagged = runNotices(llm(2, 1.5, 2, 1))
    expect(flagged.map(n => n.priority)).toEqual(['high', 'high'])
    expect(flagged[1].title).toBe('October 14, 2026: 1 item needs a human')

    expect(runNotices(llm(20.5, 1, 0)).some(n => n.title.includes('80%'))).toBe(true) // crossed 20 this run
    expect(runNotices(llm(21.5, 1, 0)).some(n => n.title.includes('80%'))).toBe(false) // already past it
  })

  it('alerts on the second failure in a row only', () => {
    expect(failureNotice('success', null)).toBeNull()
    expect(failureNotice('', null)).toBeNull()
    expect(failureNotice('failure', 'https://github.com/x/runs/1')).toMatchObject({ priority: 'urgent', click: 'https://github.com/x/runs/1' })
  })

  it('does nothing without an ntfy topic', async () => {
    expect(await sendNotice({ title: 't', message: 'm', priority: 'low', tags: [] }, { server: 'https://ntfy.sh', topic: undefined, token: undefined })).toBe(false)
  })
})

describe('standby', () => {
  it('stays out of the way of a recent or running CI run', () => {
    expect(standbyDecision([ciRun(10, 'completed', 'success')], NOW).run).toBe(false)
    expect(standbyDecision([ciRun(5, 'in_progress', null)], NOW).run).toBe(false)
  })

  it('runs when CI is late, or its recent run failed', () => {
    expect(standbyDecision([ciRun(55, 'completed', 'success')], NOW).run).toBe(true)
    expect(standbyDecision([ciRun(10, 'completed', 'failure')], NOW).run).toBe(true)
    expect(standbyDecision([], NOW).run).toBe(true)
  })
})

describe('watchdog (dead-man switch)', () => {
  it('alerts once when nothing has succeeded for 6 hours, repeats every 6 hours, and announces recovery', () => {
    const stale = [ciRun(7 * 60, 'completed', 'success'), ciRun(30, 'completed', 'failure')]
    const first = watchdog(stale, emptyStandbyState(), NOW)
    expect(first.notices.map(n => n.priority)).toEqual(['urgent'])

    const soon = watchdog(stale, first.state, new Date(NOW.getTime() + 60 * 60_000))
    expect(soon.notices).toEqual([])
    const later = watchdog(stale, first.state, new Date(NOW.getTime() + 6 * 60 * 60_000))
    expect(later.notices.map(n => n.priority)).toEqual(['urgent'])

    const recovered = watchdog([ciRun(5, 'completed', 'success')], first.state, NOW)
    expect(recovered.notices.map(n => n.title)).toEqual(['consent runs are succeeding again'])
    expect(recovered.state.deadAlertedAt).toBeNull()
  })

  it('says so when CI has stopped but the standby is covering', () => {
    const state = { ...emptyStandbyState(), lastLocalSuccess: minutesAgo(20) }
    const { notices } = watchdog([ciRun(8 * 60, 'completed', 'success')], state, NOW)
    expect(notices.map(n => [n.title, n.priority])).toEqual([['GitHub Actions has stopped running consent run', 'high']])
  })
})
