import { describe, expect, it } from 'vitest'

import { failureNotice, runNotices, sendNotice } from '../ops/notify'

import type { TRunSummary } from '../run/run'

const NOW = new Date('2026-10-14T20:00:00Z')

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
        monthSpendUsd, capUsd: 25, commit: null, pushed: true, deployed: true, error: null, merge: null, history: null, research: null,
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
