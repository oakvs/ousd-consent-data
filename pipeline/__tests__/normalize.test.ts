import { describe, expect, it } from 'vitest'

import { FILE_NUMBER, agendaLabel, cleanFileNumber, normalizeCode } from '../normalize/raw-item'
import { cleanTitle, findConsentRows } from '../normalize/sections'
import { blankEntry, registerFutureDates } from '../registry/entries'

import type { TLegistarEventItem } from '../legistar/client'

let seq = 0
function row(number: string | null, title: string, matterId: number | null = null, consent = 0): TLegistarEventItem {
  seq++
  return {
    EventItemId: seq,
    EventItemAgendaSequence: seq,
    EventItemAgendaNumber: number,
    EventItemTitle: title,
    EventItemMatterId: matterId,
    EventItemMatterFile: matterId ? `26-${String(1000 + matterId)}` : null,
    EventItemMatterName: matterId ? title : null,
    EventItemMatterType: null,
    EventItemMatterStatus: null,
    EventItemConsent: consent,
    EventItemActionName: null,
    EventItemLastModifiedUtc: null,
  }
}

describe('consent-section finder', () => {
  it('finds the section by header, not by a hard-coded letter, and propagates groups', () => {
    seq = 0
    const items = [
      row('I.', 'Adoption of the Pupil Discipline Consent Report   #comment'),
      row('I.-1', 'Expulsion', 1, 1),
      row('O.', 'Adoption of the General Consent Report  #comment'),
      row(null, 'Chief Systems and Services Officer'),
      row('O.-1', 'Item one', 2, 0), // EventItemConsent can be 0 inside the section
      row('O.-2', 'Item two', 3, 1),
      row(null, 'Chief Academic Officer'),
      row('O.-3', 'Item three', 4, 1),
      row('P.', "Superintendent's Report"),
      row('P.-1', 'Report', 5, 0),
    ]
    // Legistar returns rows out of order.
    const rows = findConsentRows([...items].reverse())
    expect(rows.map(r => r.row.EventItemAgendaNumber)).toEqual(['O.-1', 'O.-2', 'O.-3'])
    expect(rows.map(r => r.group)).toEqual(['Chief Systems and Services Officer', 'Chief Systems and Services Officer', 'Chief Academic Officer'])
    expect(rows.every(r => r.consentSection === 'general')).toBe(true)
  })

  it('tags a General Obligation Bonds consent section', () => {
    seq = 0
    const rows = findConsentRows([
      row('L.', 'Adoption of the General Consent Report'),
      row('L.-1', 'Item', 1, 1),
      row('M.', 'Adoption of the General Consent Report – General Obligation Bonds'),
      row('M.-1', 'Bond item', 2, 1),
      row('N.', 'Adjournment'),
    ])
    expect(rows.map(r => [r.row.EventItemAgendaNumber, r.consentSection])).toEqual([['L.-1', 'general'], ['M.-1', 'bonds']])
  })

  it('strips eComment markers', () => {
    expect(cleanTitle('Adoption of the General Consent Report         #comment')).toBe('Adoption of the General Consent Report')
  })
})

describe('field normalization', () => {
  it('accepts file numbers with a letter suffix', () => {
    expect(FILE_NUMBER.test('26-0263A')).toBe(true)
    expect(FILE_NUMBER.test('26-1329')).toBe(true)
    expect(FILE_NUMBER.test('2026-1329')).toBe(false)
  })

  it('dedupes repeated codes', () => {
    expect(normalizeCode('005403\r\n005403')).toBe('005403')
    expect(normalizeCode('005403\r\n001582')).toBe('005403 001582')
    expect(normalizeCode('  ')).toBeNull()
  })
})

describe('registry discovery', () => {
  it('registers a future date with the kind its weekday implies', () => {
    const registry = { lastKnownEventId: null, meetings: [] }
    const added = registerFutureDates(registry, ['2026-10-14', '2026-10-19'])
    expect(added.map(e => [e.key, e.kind, e.status])).toEqual([
      ['2026-10-14', 'regular', 'discovered'],
      ['2026-10-19', 'special', 'discovered'],
    ])
  })

  it('leaves a date alone when the registry already has it under any key', () => {
    const registry = { lastKnownEventId: null, meetings: [blankEntry('2026-10-14-special')] }
    expect(registerFutureDates(registry, ['2026-10-14'])).toEqual([])
    expect(registry.meetings).toHaveLength(1)
  })
})

describe('vendor-number matching', () => {
  it('matches exact codes only, not substrings', async () => {
    const { sameVendorNo } = await import('../legistar/vendor-history')
    expect(sameVendorNo('005403\r\n005403', ['005403'])).toBe(true)
    expect(sameVendorNo('001201', ['1201'])).toBe(false)
    expect(sameVendorNo('012010', ['1201'])).toBe(false)
    expect(sameVendorNo('N/A', ['1201'])).toBe(false)
  })
})

describe('final meetings', () => {
  it('settles 14 days on once every item has a later action, or after 180 days regardless', async () => {
    const { isSettled } = await import('../registry/entries')
    const entry = blankEntry('2026-02-11')
    const open = { items: [{ history: [] }] } as unknown as Parameters<typeof isSettled>[1]
    const done = { items: [{ history: [{ date: '2026-02-11' }] }] } as unknown as Parameters<typeof isSettled>[1]
    expect(isSettled(entry, done, new Date('2026-02-20'))).toBe(false)
    expect(isSettled(entry, done, new Date('2026-03-01'))).toBe(true)
    expect(isSettled(entry, open, new Date('2026-06-01'))).toBe(false)
    expect(isSettled(entry, open, new Date('2026-10-01'))).toBe(true)
  })
})

describe('odd Legistar rows', () => {
  it('strips stray punctuation from a file number (2020-01-22, "+20-0100")', () => {
    expect(cleanFileNumber('+20-0100')).toBe('20-0100')
    expect(cleanFileNumber(' 21-1738A ')).toBe('21-1738A')
    expect(FILE_NUMBER.test(cleanFileNumber('+20-0100'))).toBe(true)
  })

  it('labels an unnumbered consent item by its agenda order (2020-06-29 special meeting)', () => {
    expect(agendaLabel({ EventItemAgendaNumber: null, EventItemAgendaSequence: 12 })).toBe('#12')
    expect(agendaLabel({ EventItemAgendaNumber: ' T.-3 ', EventItemAgendaSequence: 40 })).toBe('T.-3')
  })
})
