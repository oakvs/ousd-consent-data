import { describe, expect, it } from 'vitest'

import { expectedMeetingKind, oaklandToday } from '@oakvs/consent-schema/format'

import { MIN_CONSENT_ITEMS, pickNextMeeting } from '../legistar/upcoming'

import type { TFutureMatter } from '../legistar/upcoming'

const items = (date: string, status: string, n: number): TFutureMatter[] =>
  Array.from({ length: n }, () => ({ MatterAgendaDate: `${date}T00:00:00`, MatterStatusName: status }))

describe('next-meeting detection', () => {
  const today = '2026-10-01'

  it('picks the earliest date with enough Board consent-report items', () => {
    const matters = [
      ...items('2026-10-06', 'Board, New Business', 4),
      ...items('2026-10-06', 'Committee, General Consent Report', 13),
      ...items('2026-10-14', 'Board, General Consent Report', 73),
      ...items('2026-10-14', 'Board, New Business', 9),
      ...items('2026-10-28', 'Board, Public Hearing', 1),
    ]
    expect(pickNextMeeting(matters, today)).toEqual({ date: '2026-10-14', consentItems: 73, boardItems: 82 })
  })

  it('is not fooled by a few stray or mis-dated items', () => {
    const matters = [
      ...items('2026-10-14', 'Board, General Consent Report', MIN_CONSENT_ITEMS - 1),
      ...items('3036-09-23', 'Board, General Consent Report', 20),
      ...items('2026-09-30', 'Board, General Consent Report', 20),
      { MatterAgendaDate: null, MatterStatusName: 'Board, General Consent Report' },
    ]
    expect(pickNextMeeting(matters, today)).toBeNull()
  })

  it('counts a meeting on today’s date', () => {
    expect(pickNextMeeting(items(today, 'Board, General Consent Report', 5), today)?.date).toBe(today)
  })

  it('uses Oakland’s date, not UTC', () => {
    // 2026-10-02 03:00 UTC is still Oct 1 in Oakland.
    expect(oaklandToday(new Date('2026-10-02T03:00:00Z'))).toBe('2026-10-01')
  })

  it('infers regular meetings from the 2nd/4th-Wednesday cadence', () => {
    // 2nd and 4th Wednesdays → regular.
    expect(expectedMeetingKind('2026-10-14')).toBe('regular')
    expect(expectedMeetingKind('2026-10-28')).toBe('regular')
    expect(expectedMeetingKind('2026-06-24')).toBe('regular')
    // A 3rd Wednesday, a 1st Wednesday and a Monday → special.
    expect(expectedMeetingKind('2025-11-19')).toBe('special')
    expect(expectedMeetingKind('2025-12-03')).toBe('special')
    expect(expectedMeetingKind('2026-06-15')).toBe('special')
  })
})
