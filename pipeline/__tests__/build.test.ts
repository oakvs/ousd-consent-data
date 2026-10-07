import { readdirSync, readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { voteOutcome } from '@oakvs/consent-schema/format'
import {
  IndexFile,
  MeetingFile,
  MeetingListFile,
  VendorFile,
  VendorIndexFile,
} from '@oakvs/consent-schema/schema'
import { SCHEMA_VERSION } from '@oakvs/consent-schema/schema'
import type { TMeetingFile, TOfficialMatter, TPublishedItem } from '@oakvs/consent-schema/schema'
import { NO_ALIASES, normalizeVendorName, vendorKey } from '@oakvs/consent-schema/vendor-key'

import { generateAliases } from '../build/aliases'
import { applyOverride, deriveOutcome, laterDecisionNote, parseAmendmentNo } from '../build/meeting'
import { computeTotals } from '../build/totals'
import { buildVendors } from '../build/vendors'
import { stableStringify } from '../store'
import { assess, compareMoney, isMaterialDiscrepancy } from '../validate/alerts'
import { runChecks } from '../validate/checks'
import { describePulled, votedActions } from '../validate/separate-vote'

import { h, makeEnrichment, makePublishedItem } from './helpers'

const PUBLISHED = path.join(process.cwd(), 'data', 'published')
const GOLDEN = path.join(process.cwd(), 'data', 'fixtures', 'golden', '2026-06-24')

const item = makePublishedItem

describe('merge and outcomes', () => {
  it('applies overrides field by field', () => {
    const merged = applyOverride(makeEnrichment(), {
      fields: { money: { thisActionRange: [1, 2] }, term: { start: null, end: null, addedStart: '2026-07-01' } },
      reviewer: null,
      reviewedAt: null,
      note: null,
    })
    expect(merged?.money.thisAction).toBe(100_000)
    expect(merged?.money.thisActionRange).toEqual([1, 2])
    expect(merged?.term.addedStart).toBe('2026-07-01')
  })

  it('takes the outcome from histories, including later meetings', () => {
    const history = [
      h({ date: '2026-06-10', action: 'Postponed to a Date Certain', body: 'Board of Education', eventId: 5764 }),
      h({ date: '2026-06-24', action: 'Not Discussed and/or Taken Up', body: 'Board of Education', eventId: 5785 }),
      h({ date: '2026-06-29', action: 'Adopted', body: 'Board of Education', eventId: 5786 }),
    ]
    expect(deriveOutcome(history, '2026-06-24')).toEqual({ action: 'Adopted', date: '2026-06-29', meetingEventId: 5786, adopted: true })
    expect(deriveOutcome(history.slice(0, 2), '2026-06-24')?.adopted).toBe(false)
    expect(deriveOutcome([], '2026-06-24')).toBeNull()
  })

  it('writes a note for items decided at a later meeting', () => {
    const later = { action: 'Adopted', date: '2026-06-29', meetingEventId: 5786, adopted: true }
    const same = { ...later, date: '2026-06-24', action: 'Adopted on the General Consent Report' }
    const note = laterDecisionNote([item('a', { outcome: later }), item('b', { outcome: same }), item('c', { outcome: same })], '2026-06-24')
    expect(note).toBe('1 item was pulled from the consent report and decided on June 29, 2026.')
    expect(laterDecisionNote([item('a', { outcome: same })], '2026-06-24')).toBeNull()
  })

  it("doesn't call an item pulled when it was adopted here and repealed later", () => {
    const repealed = { action: 'Repealed', date: '2024-04-10', meetingEventId: null, adopted: false }
    const history = [
      h({ date: '2023-10-25', action: 'Adopted on the General Consent Report', consent: true }),
      h({ date: '2024-04-10', action: 'Repealed' }),
    ]
    expect(laterDecisionNote([item('a', { outcome: repealed, history })], '2023-10-25')).toBeNull()
  })

  it('parses amendment numbers', () => {
    expect(parseAmendmentNo('Amendment No. 3, Services Agreement')).toBe(3)
    expect(parseAmendmentNo('Services Agreement', 'Approval of Amendment No.1, …')).toBe(1)
    expect(parseAmendmentNo('Services Agreement')).toBeNull()
  })
})

describe('zero-touch alerts', () => {
  it('only treats a discrepancy as material when it is over $10K AND over 1%', () => {
    expect(isMaterialDiscrepancy(100_109, 1_038_407)).toBe(true)
    expect(isMaterialDiscrepancy(90, 20_223_399)).toBe(false)
    expect(isMaterialDiscrepancy(15_000, 20_000_000)).toBe(false)
    expect(isMaterialDiscrepancy(5_000, 50_000)).toBe(false)
  })

  it('compares two money readings field by field', () => {
    const a = { direction: 'expense' as const, amountType: 'not_to_exceed' as const, thisAction: 100, priorTotal: null, newTotal: null }
    expect(compareMoney(a, { ...a, amountType: 'fixed' })).toEqual([])
    expect(compareMoney(a, { ...a, amountType: 'per_year' })).toHaveLength(1)
    expect(compareMoney(a, { ...a, thisAction: 100.5 })).toEqual([])
    expect(compareMoney(a, { ...a, thisAction: null, newTotal: 100 })).toHaveLength(2)
  })

  it('turns large arithmetic errors into a public flag and an alert, small ones into a note', () => {
    const big = makeEnrichment({
      actionType: 'amendment',
      money: { thisAction: 301_571.51, priorTotal: 836_945.38, newTotal: 1_038_407.72, evidence: '$301,571.51' },
    })
    const text = 'additional amount of $301,571.51, increasing the not to exceed amount of the Agreement from $836,945.38 to $1,038,407.72'
    const r = assess(big, runChecks({ text, enrichment: big, sourceIssue: null }).checks, null)
    expect(r.sourceIssueBy).toBe('computed')
    expect(r.alerts[0]).toMatch(/off by \$100,109/)

    const small = makeEnrichment({ money: { thisAction: 457_657.84, priorTotal: 19_765_831.77, newTotal: 20_223_399.61, evidence: '$457,657.84' } })
    const t2 = 'in the amount of $457,657.84, increasing from $19,765,831.77 to $20,223,399.61'
    const r2 = assess(small, runChecks({ text: t2, enrichment: small, sourceIssue: null }).checks, null)
    expect(r2.alerts).toEqual([])
    expect(r2.notes[0]?.kind).toBe('math')
  })

  it('publishes material verifier verdicts as flags and cosmetic ones as notes', () => {
    const e = makeEnrichment()
    const base = { modelId: 'm', promptVersion: 'v', enrichmentCacheKey: 'k', money: null, tiebreakMoney: null, vendorKind: null, headlineFix: null }
    const material = assess(e, [], { ...base, issue: { verdict: 'material', topic: 'school', explanation: 'Title and text name different schools.', quote: null } })
    expect(material.sourceIssueBy).toBe('verifier')
    expect(material.alerts).toEqual([])
    const cosmetic = assess(e, [], { ...base, issue: { verdict: 'cosmetic', topic: 'other', explanation: 'A typo.', quote: null } })
    expect(cosmetic.sourceIssue).toBeNull()
    expect(cosmetic.notes).toHaveLength(1)
  })
})

describe('pulled from the consent vote', () => {
  it('flags an item voted on separately and summarizes the roll call', () => {
    const votes = [
      { name: 'A', vote: 'Aye' }, { name: 'B', vote: 'Aye' }, { name: 'C', vote: 'Aye' }, { name: 'D', vote: 'Aye' },
      { name: 'E', vote: 'Nay' }, { name: 'F', vote: 'Abstained' }, { name: 'G', vote: 'Abstained' }, { name: 'H', vote: 'Absent' },
    ]
    const history = [h({ date: '2026-09-23', action: 'Adopted', eventId: 5810, historyId: 382655, consent: false, mover: 'Rachel Latta', passed: 'Pass', votes })]
    const r = describePulled(history, '2026-09-23', 5810)
    expect(r?.summary).toBe('Adopted in its own vote at this meeting (4\u20131, 2 abstaining), instead of with the rest of the consent report.')
    expect(votedActions(history, '2026-09-23')).toHaveLength(1)
  })

  it('does not flag items adopted on the consent report', () => {
    const history = [h({ date: '2026-09-23', action: 'Adopted on the General Consent Report', eventId: 5810, consent: true })]
    expect(describePulled(history, '2026-09-23', 5810)).toBeNull()
  })

  it('handles items not taken up and decided at a later meeting (June 24 \u2192 June 29)', () => {
    const history = [
      h({ date: '2026-06-24', action: 'Not Discussed and/or Taken Up', eventId: 5785, consent: false }),
      h({ date: '2026-06-29', action: 'Adopted', eventId: 5786, consent: false, mover: 'Mike Hutchinson', passed: 'Pass' }),
    ]
    expect(describePulled(history, '2026-06-24', 5785)?.summary).toMatch(/in its own vote on June 29/)
  })

  it('trusts a consent action name over an inconsistent Legistar flag', () => {
    const history = [h({ date: '2026-09-23', action: 'Adopted on the General Consent Report', eventId: 5810, consent: false })]
    expect(describePulled(history, '2026-09-23', 5810)).toBeNull()
  })

  it('ignores committee actions and earlier meetings', () => {
    const history = [
      h({ date: '2026-09-15', action: 'Recommended Favorably', body: 'Teaching and Learning Committee', consent: false }),
      h({ date: '2026-09-23', action: 'Adopted on the General Consent Report', eventId: 5810, consent: true }),
    ]
    expect(describePulled(history, '2026-09-23', 5810)).toBeNull()
  })
})

describe('consent report votes', () => {
  it('trusts the motion text over a wrong pass/fail field (June 15, 2026)', () => {
    expect(voteOutcome({ motion: 'A motion was made by Director Latta… The motion Failed by the following vote:', passed: 'Pass' })).toBe('failed')
    expect(voteOutcome({ motion: 'The motion carried by the following vote', passed: 'Pass' })).toBe('carried')
    expect(voteOutcome({ motion: null, passed: 'Fail' })).toBe('failed')
    expect(voteOutcome({ motion: null, passed: null })).toBeNull()
  })

  it('every published meeting carries its consent votes', () => {
    for (const f of readdirSync(path.join(PUBLISHED, 'meetings')).filter(n => !n.endsWith('.list.json'))) {
      const m = MeetingFile.parse(JSON.parse(readFileSync(path.join(PUBLISHED, 'meetings', f), 'utf8')))
      for (const v of m.meeting.consentVotes) expect(v.title).toMatch(/general consent report/i)
    }
  })
})

describe('vendor aliases', () => {
  it('merges leading-zero typos only when the names agree', () => {
    const a = generateAliases([
      { codes: ['000453'], name: 'anthonio' }, { codes: ['000453'], name: 'anthonio' }, { codes: ['00453'], name: 'anthonio' },
      { codes: ['1201'], name: 'cumming management group' }, { codes: ['001201'], name: 'cordoba' },
    ])
    expect(a.vendorNumbers).toEqual({ '00453': '000453' })
  })

  it('prefers the 6-digit form as canonical', () => {
    const a = generateAliases([{ codes: ['1567'], name: 'emergency rooter' }, { codes: ['1567'], name: 'emergency rooter' }, { codes: ['001567'], name: 'emergency rooter' }])
    expect(a.vendorNumbers).toEqual({ 1567: '001567' })
  })

  it('maps a number-less name to its vendor only when unambiguous', () => {
    const a = generateAliases([
      { codes: ['006491'], name: 'ags' }, { codes: [], name: 'ags' },
      { codes: ['000111'], name: 'acme' }, { codes: ['000222'], name: 'acme' }, { codes: [], name: 'acme' },
    ])
    expect(a.names).toEqual({ ags: '006491' })
  })

  it('keys aliased vendors on the canonical number', () => {
    const aliases = { vendorNumbers: { '00453': '000453' }, names: { ags: '006491' } }
    expect(vendorKey('00453', 'Anthonio, Inc.', aliases)).toBe('v-000453')
    expect(vendorKey(null, 'AGS, Inc.', aliases)).toBe('v-006491')
  })
})

describe('vendors', () => {
  it('keys on vendor number, then normalized name', () => {
    expect(vendorKey('006530', 'Frontline')).toBe('v-006530')
    expect(vendorKey('005403 001582', null)).toBe('v-005403')
    expect(vendorKey(null, 'Bay Area Community Resources, Inc.')).toBe('n-bay-area-community-resources')
    expect(vendorKey(null, 'BACR', { vendorNumbers: {}, names: { bacr: 'bay area community resources' } })).toBe('n-bay-area-community-resources')
    expect(normalizeVendorName('Rob’s Skate Academy, LLC')).toBe('robs skate academy')
  })

  it("follows the build's countsTowardTotals for a re-agendized file number", () => {
    const adopted = { action: 'Adopted', date: '2026-06-29', meetingEventId: 5786, adopted: true }
    const meeting = (key: string, items: TPublishedItem[]): TMeetingFile => ({
      schemaVersion: SCHEMA_VERSION,
      meeting: { key, date: key, time: null, kind: 'regular', title: 't', eventId: null, agendaPdfUrl: null, legistarMeetingUrl: null, revision: 1, updatedAt: key, note: null, consentVotes: [] },
      totals: computeTotals(items),
      items,
    })
    const { files } = buildVendors([
      meeting('2026-06-10', [item('26-1036', { vendorNo: '009906', outcome: adopted, countsTowardTotals: false })]),
      meeting('2026-06-24', [item('26-1036', { vendorNo: '009906', outcome: adopted })]),
    ], NO_ALIASES)
    expect(files).toHaveLength(1)
    expect(files[0].appearances.map(a => a.countsTowardTotals)).toEqual([false, true])
    expect(files[0].approvedTotal).toBe(100_000)
  })
})

describe('vendor pages', () => {
  const adopted = { action: 'Adopted', date: '2026-06-24', meetingEventId: 5785, adopted: true }
  const meeting = (key: string, items: TPublishedItem[]): TMeetingFile => ({
    schemaVersion: SCHEMA_VERSION,
    meeting: { key, date: key, time: null, kind: 'regular', title: 't', eventId: null, agendaPdfUrl: null, legistarMeetingUrl: null, revision: 1, updatedAt: key, note: null, consentVotes: [] },
    totals: computeTotals(items),
    items,
  })
  const official = (matterId: number, file: string, department: string, passedDate: string): TOfficialMatter => ({
    matterId, file, title: `Record ${file}`, type: 'Agreement or Contract', status: 'Passed', department,
    introDate: null, agendaDate: null, passedDate, enactmentNumber: null, vendorNo: '006530',
    fundingSource: '0000 - General Purpose', resourceSite: null,
    legistarUrl: 'https://ousd.legistar.com/LegislationDetail.aspx?ID=1', relatedMatterIds: [],
  })

  it('merges official Legistar history, tallies and the approved list', () => {
    const items = [item('26-1329', { vendorNo: '006530', vendorKey: 'v-006530', outcome: adopted })]
    const history = [official(69749, '26-1329', 'Chief Systems and Services Officer', '2026-06-29'), official(53786, '21-2652', 'Talent', '2022-01-12')]
    const { files, index } = buildVendors([meeting('2026-06-24', items)], NO_ALIASES, new Map([['v-006530', { key: 'v-006530', vendorNo: '006530', matters: history }]]))
    expect(files[0].legistarHistory).toHaveLength(2)
    expect(files[0].official.departments.map(d => d.name)).toEqual(['Chief Systems and Services Officer', 'Talent'])
    expect(files[0].approvedCount).toBe(1)
    expect(files[0].taxonomy.categories[0]).toEqual({ name: 'Classroom & academic programs', count: 1 })
    expect(index.vendors[0]).toMatchObject({ key: 'v-006530', legistarRecords: 2, approvedCount: 1 })
  })

  it('describes individuals by role, not name', () => {
    const e = makeEnrichment({ vendor: { name: 'Rachel Hart', location: 'San Leandro, CA', kind: 'individual' } })
    const { files } = buildVendors([meeting('2026-06-24', [item('26-1137', { vendorNo: '012345', vendorKey: 'v-012345', enrichment: e, outcome: adopted })])], NO_ALIASES)
    expect(files[0].displayName).toBe('Individual contractor (vendor no. 012345)')
    expect(files[0].displayName).not.toContain('Hart')
  })
})

describe('determinism', () => {
  it('sorts keys recursively', () => {
    expect(stableStringify({ b: 1, a: { d: 1, c: [{ f: 1, e: 2 }] } })).toBe(stableStringify({ a: { c: [{ e: 2, f: 1 }], d: 1 }, b: 1 }))
  })
})

describe('published contract', () => {
  it('every published file validates against its schema', async () => {
    IndexFile.parse(JSON.parse(await readFile(path.join(PUBLISHED, 'index.json'), 'utf8')))
    VendorIndexFile.parse(JSON.parse(await readFile(path.join(PUBLISHED, 'vendors', 'index.json'), 'utf8')))
    for (const f of await readdir(path.join(PUBLISHED, 'meetings'))) {
      const data: unknown = JSON.parse(await readFile(path.join(PUBLISHED, 'meetings', f), 'utf8'))
      if (f.endsWith('.list.json')) MeetingListFile.parse(data)
      else MeetingFile.parse(data)
    }
    const vendors = (await readdir(path.join(PUBLISHED, 'vendors'))).filter(f => f !== 'index.json')
    for (const f of vendors) VendorFile.parse(JSON.parse(await readFile(path.join(PUBLISHED, 'vendors', f), 'utf8')))
  })
})

describe('golden set, 2026-06-24', async () => {
  const meeting = MeetingFile.parse(JSON.parse(await readFile(path.join(PUBLISHED, 'meetings', '2026-06-24.json'), 'utf8')))
  const byFile = new Map(meeting.items.map(i => [i.file, i]))
  const fixtures = await readdir(GOLDEN)

  it('matches the §18.5 prototype numbers', () => {
    expect(meeting.totals.items).toBe(263)
    // §18.5 said 103 spending items and 22 yearly caps. R.-225 (Claremont Partners, "$36,000.00
    // annually") was misread as a total by the v1 prototype; two of three independent readings
    // correct it to a yearly cap, so it moves from spending to yearly caps.
    expect(meeting.totals.spendingItems).toBe(102)
    expect(Math.round(meeting.totals.spendingTotal / 1e5) / 10).toBe(135.2)
    expect(meeting.totals.yearlyCapItems).toBe(23)
    // source_issue: 12 in §18.5, plus R.-237 (26-1467, Segal), confirmed in the 2026-10-04 attachment check:
    // the text keeps "$201,000.00 per year" and "$603,000.00 for term" while doubling the term to six years.
    // The codebook-v5 re-read (October 2026) surfaced three more, each confirmed material by the independent
    // second reading: R.-34 (26-1341, an amendment amount that doesn't say whether it's added or a new total),
    // R.-41 (26-1443, title says Architectural Services, text says surveying under the General Services MA) and
    // R.-122 (26-1407, "$3,134,100.00 30, 2028" garbles the term).
    expect(meeting.totals.flagCounts).toMatchObject({ no_competitive_bid: 16, previously_delayed: 56, source_issue: 16 })
  })

  for (const f of fixtures) {
    it(`${f.replace('.json', '')} matches its golden fixture`, async () => {
      const golden = JSON.parse(await readFile(path.join(GOLDEN, f), 'utf8')) as {
        file: string
        expected: { category: string; subcategory?: string | null; actionType: string; money: Record<string, unknown>; term: unknown; flags: string[] }
      }
      const published = byFile.get(golden.file)
      expect(published?.enrichment).toBeTruthy()
      expect(published!.enrichment!.category).toBe(golden.expected.category)
      if ('subcategory' in golden.expected) expect(published!.enrichment!.subcategory).toBe(golden.expected.subcategory ?? null)
      expect(published!.enrichment!.actionType).toBe(golden.expected.actionType)
      expect(published!.enrichment!.money).toMatchObject(golden.expected.money)
      expect(published!.enrichment!.term).toEqual(golden.expected.term)
      expect([...published!.flags].sort()).toEqual([...golden.expected.flags].sort())
    })
  }
})

describe('duplicate listings', () => {
  it('point at another item in the same meeting and are left out of meeting and vendor totals', async () => {
    const dir = path.join(PUBLISHED, 'meetings')
    const dupIds = new Set<string>()
    for (const f of (await readdir(dir)).filter(n => !n.endsWith('.list.json'))) {
      const m = MeetingFile.parse(JSON.parse(await readFile(path.join(dir, f), 'utf8')))
      const ids = new Set(m.items.map(i => i.id))
      const dups = m.items.filter(i => i.duplicateOf)
      for (const d of dups) {
        expect(ids.has(d.duplicateOf!), `${d.id} → ${d.duplicateOf}`).toBe(true)
        expect(d.duplicateOf).not.toBe(d.id)
        dupIds.add(d.id)
      }
      expect(m.totals.items).toBe(m.items.length - dups.length)
    }
    expect(dupIds.size).toBeGreaterThan(0)
    const vendorDir = path.join(PUBLISHED, 'vendors')
    for (const f of (await readdir(vendorDir)).filter(n => n !== 'index.json')) {
      const v = VendorFile.parse(JSON.parse(await readFile(path.join(vendorDir, f), 'utf8')))
      for (const a of v.appearances) if (dupIds.has(a.id)) expect(a.countsTowardTotals, a.id).toBe(false)
    }
  })
})

describe('counting each action once', () => {
  it('counts every file number in at most one meeting, and never one the Board rejected', async () => {
    const dir = path.join(PUBLISHED, 'meetings')
    const countedAt = new Map<string, string[]>()
    for (const f of (await readdir(dir)).filter(n => !n.endsWith('.list.json'))) {
      const m = MeetingFile.parse(JSON.parse(await readFile(path.join(dir, f), 'utf8')))
      for (const i of m.items.filter(x => x.countsTowardTotals)) {
        expect(i.outcome?.adopted, i.id).not.toBe(false)
        expect(i.duplicateOf, i.id).toBeUndefined()
        countedAt.set(i.file, [...(countedAt.get(i.file) ?? []), m.meeting.key])
      }
    }
    const twice = [...countedAt].filter(([, keys]) => keys.length > 1)
    expect(twice).toEqual([])
  })
})
