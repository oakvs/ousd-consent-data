import { describe, expect, it } from 'vitest'

import { FILE_NUMBER, normalizeCode } from '../normalize/raw-item'
import { cleanTitle, findConsentRows } from '../normalize/sections'
import { assignKeys, parseAgendaFilename } from '../registry/seed'

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

describe('registry seeding', () => {
  it('parses agenda filenames', () => {
    expect(parseAgendaFilename('OUSD-BOE_2026-06-24_1610_Agenda.pdf')).toEqual({ date: '2026-06-24', time: '16:10', kind: 'regular', canceled: false })
    expect(parseAgendaFilename('OUSD-BOE_2025-12-03_canceled_Special_Agenda.pdf')?.canceled).toBe(true)
    expect(parseAgendaFilename('OUSD-BOE_2026-01-05_1100_Organizational_Agenda.pdf')?.kind).toBe('organizational')
    expect(parseAgendaFilename('OUSD-BOE_2026-06-24_General-Consent-Items.csv')).toBeNull()
  })

  it('suffixes the non-regular meeting on a two-meeting day only', () => {
    const keys = assignKeys([
      { date: '2026-09-23', time: '16:00', kind: 'regular', canceled: false },
      { date: '2026-09-23', time: '20:00', kind: 'special', canceled: false },
      { date: '2026-09-28', time: '15:30', kind: 'special', canceled: false },
    ]).map(k => k.key)
    expect(keys).toEqual(['2026-09-23', '2026-09-23-special', '2026-09-28'])
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
