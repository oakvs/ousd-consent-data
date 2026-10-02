import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { diffItems, sameRow } from '../ingest'
import { futureMeetings } from '../legistar/upcoming'
import { toRawItem } from '../normalize/raw-item'
import { commitMessage, meetingLine } from '../run/message'
import { diffTrees, hashEventItems } from '../run/run'

import { h } from './helpers'

import type { TLegistarEventItem, TLegistarMatter } from '../legistar/client'
import type { TSectionRow } from '../normalize/sections'
import type { TMeetingChange, TRunChanges } from '../run/message'

function sectionRow(overrides: Partial<TLegistarEventItem> = {}): TSectionRow {
  return {
    consentSection: 'general',
    group: 'Chief Academic Officer',
    row: {
      EventItemId: 1,
      EventItemAgendaSequence: 12,
      EventItemAgendaNumber: 'P.1',
      EventItemTitle: 'Approval of a services agreement with Acme, not to exceed $100,000.00.',
      EventItemMatterId: 501,
      EventItemMatterFile: '26-1501',
      EventItemMatterName: 'Acme - Tutoring',
      EventItemMatterType: 'Agreement or Contract',
      EventItemMatterStatus: 'Board, General Consent Report',
      EventItemConsent: 0,
      EventItemActionName: null,
      EventItemLastModifiedUtc: null,
      EventItemMatterAttachments: [{ MatterAttachmentName: 'Agreement', MatterAttachmentHyperlink: 'https://example.com/a.pdf' }],
      ...overrides,
    },
  }
}

const matter = { MatterId: 501, MatterGuid: 'G', MatterFile: '26-1501', MatterName: 'Acme - Tutoring', MatterTitle: null, MatterTypeName: 'Agreement or Contract', MatterStatusName: null, MatterBodyName: 'Chief Academic Officer', MatterIntroDate: '2026-09-30T00:00:00', MatterAgendaDate: '2026-10-14T00:00:00', MatterEXText1: '006530', MatterEXText3: null, MatterText1: '0000 - General Purpose' } satisfies TLegistarMatter

describe('incremental ingest', () => {
  const stored = toRawItem(sectionRow(), matter, [])

  it('treats an identical agenda row as unchanged, without the matter', () => {
    expect(sameRow(sectionRow(), stored)).toBe(true)
  })

  it('notices a changed title, number or attachment list', () => {
    expect(sameRow(sectionRow({ EventItemMatterName: 'Acme - Tutoring (Amended)' }), stored)).toBe(false)
    expect(sameRow(sectionRow({ EventItemAgendaNumber: 'P.2' }), stored)).toBe(false)
    expect(sameRow(sectionRow({ EventItemMatterAttachments: [] }), stored)).toBe(false)
  })

  it('separates agenda revisions from outcome-only changes', () => {
    const other = toRawItem(sectionRow({ EventItemMatterId: 502, EventItemMatterFile: '26-1502' }), null, [])
    const decided = { ...stored, history: [h({ date: '2026-10-14', action: 'Approved' })] }
    const retitled = { ...other, title: 'Something else' }
    const added = toRawItem(sectionRow({ EventItemMatterId: 503, EventItemMatterFile: '26-1503' }), null, [])
    expect(diffItems([stored, other], [decided, retitled, added])).toEqual({
      added: ['26-1503'], removed: [], revised: ['26-1502'], outcomes: ['26-1501'],
    })
    expect(diffItems([stored, other], [stored])).toEqual({ added: [], removed: ['26-1502'], revised: [], outcomes: [] })
  })
})

describe('event-item hash', () => {
  it('ignores key order and changes with content', () => {
    expect(hashEventItems([{ a: 1, b: 2 }])).toBe(hashEventItems([{ b: 2, a: 1 }]))
    expect(hashEventItems([{ a: 1 }])).not.toBe(hashEventItems([{ a: 2 }]))
  })
})

describe('meeting discovery from future-dated matters', () => {
  it('returns every confirmed date, earliest first', () => {
    const items = (date: string, n: number): { MatterAgendaDate: string; MatterStatusName: string }[] =>
      Array.from({ length: n }, () => ({ MatterAgendaDate: `${date}T00:00:00`, MatterStatusName: 'Board, General Consent Report' }))
    const found = futureMeetings([...items('2026-10-28', 6), ...items('2026-10-14', 73), ...items('2026-11-12', 2)], '2026-10-01')
    expect(found.map(m => m.date)).toEqual(['2026-10-14', '2026-10-28'])
  })
})

describe('commit messages', () => {
  const base: TRunChanges = { upcoming: { changed: false, date: null, consentItems: null }, discovered: [], resolved: [], meetings: [], pendingSummaries: 0 }
  const meeting = (m: Partial<TMeetingChange>): TMeetingChange => ({ key: '2026-10-14', eventId: 5825, items: 87, diff: null, unchanged: false, final: false, ...m })
  const noDiff = { added: [], removed: [], revised: [], outcomes: [] }

  it('says when an agenda is posted, revised or decided', () => {
    expect(meetingLine(meeting({}))).toBe('2026-10-14: agenda posted — 87 items')
    expect(meetingLine(meeting({ diff: { ...noDiff, added: ['a', 'b'], revised: ['c'] } }))).toBe('2026-10-14: agenda revised — 2 added, 1 revised')
    expect(meetingLine(meeting({ diff: { ...noDiff, outcomes: ['a'] }, final: true }))).toBe('2026-10-14: outcomes updated — 1 item [final]')
    expect(meetingLine(meeting({ unchanged: true }))).toBeNull()
  })

  it('falls back to discovery, then the upcoming count, then a routine check', () => {
    expect(commitMessage({ ...base, resolved: [{ key: '2026-10-14', eventId: 5825, resolvedBy: 'probe' }], discovered: ['2026-10-14'] }).subject)
      .toBe('2026-10-14: meeting found (event 5825, via probe)')
    expect(commitMessage({ ...base, upcoming: { changed: true, date: '2026-10-14', consentItems: 74 } }).subject)
      .toBe('upcoming: 2026-10-14, 74 consent items filed so far')
    expect(commitMessage({ ...base, meetings: [meeting({ unchanged: true })] }).subject).toBe('registry: routine check')
  })

  it('lists pending summaries in the body', () => {
    expect(commitMessage({ ...base, meetings: [meeting({})], pendingSummaries: 87 }).body)
      .toBe('- 2026-10-14: agenda posted — 87 items\n- 87 items awaiting AI summaries')
  })
})

describe('dry-run tree diff', () => {
  it('reports added, removed and changed files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tree-'))
    const [a, b] = [path.join(root, 'a'), path.join(root, 'b')]
    await mkdir(path.join(a, 'raw'), { recursive: true })
    await mkdir(path.join(b, 'raw'), { recursive: true })
    await writeFile(path.join(a, 'same.json'), '1')
    await writeFile(path.join(b, 'same.json'), '1')
    await writeFile(path.join(a, 'raw', 'x.json'), '1')
    await writeFile(path.join(b, 'raw', 'x.json'), '2')
    await writeFile(path.join(a, 'gone.json'), '1')
    await writeFile(path.join(b, 'new.json'), '1')
    expect(await diffTrees(a, b)).toEqual(['gone.json', 'new.json', path.join('raw', 'x.json')])
  })
})
