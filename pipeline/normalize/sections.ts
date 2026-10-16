/**
 * Consent-section finder.
 *
 * The section letter changes every meeting (L., O., R. …), so we find it by
 * its header row ("Adoption of the General Consent Report"), then take every
 * matter row whose agenda number carries that letter prefix, up to the next
 * top-level header.
 *
 * `EventItemConsent` is NOT reliable on its own: on June 24, 2026, 24 of the
 * 263 consent items (including R.-1 and R.-2) had it set to 0.
 *
 * Rows inside the section with no matter ID are group headers ("Chief
 * Academic Officer", "Measures N and H Commission – …") and propagate as
 * `group` to the items that follow.
 */
import type { TConsentSection } from '@oakvs/consent-schema/schema'

import type { TLegistarEventItem } from '../legistar/client'

export type TSectionRow = {
  row: TLegistarEventItem
  consentSection: TConsentSection
  group: string | null
}

const GENERAL_CONSENT = /general consent report/i
const BONDS = /bond/i
const TOP_LEVEL = /^[A-Z]{1,2}\d?\.$/

/** Strip Legistar's eComment marker and collapse whitespace. */
export function cleanTitle(title: string | null | undefined): string {
  return (title ?? '').replace(/#comment/gi, '').replace(/\s+/g, ' ').trim()
}

export function isConsentHeader(row: TLegistarEventItem): boolean {
  return row.EventItemMatterId == null
    && TOP_LEVEL.test(row.EventItemAgendaNumber ?? '')
    && GENERAL_CONSENT.test(row.EventItemTitle ?? '')
}

export function findConsentRows(eventItems: TLegistarEventItem[]): TSectionRow[] {
  const rows = eventItems
    .filter(r => r.EventItemAgendaSequence != null)
    .sort((a, b) => a.EventItemAgendaSequence! - b.EventItemAgendaSequence!)

  const out: TSectionRow[] = []
  let section: { letter: string; kind: TConsentSection } | null = null
  let group: string | null = null

  for (const row of rows) {
    const number = row.EventItemAgendaNumber ?? ''

    if (isConsentHeader(row)) {
      section = { letter: number.replace(/\.$/, ''), kind: BONDS.test(row.EventItemTitle ?? '') ? 'bonds' : 'general' }
      group = null
      continue
    }
    if (!section) continue

    if (TOP_LEVEL.test(number)) {
      // Next top-level header ends the section.
      section = null
      group = null
      continue
    }

    if (row.EventItemMatterId == null) {
      if (!number) group = cleanTitle(row.EventItemTitle) || group
      continue
    }

    // Unnumbered rows inside the section count too: the 2020 virtual special meetings list
    // consent items without numbers, and Legistar clears the consent flag on a withdrawn one.
    if (!number || number.startsWith(`${section.letter}.-`) || row.EventItemConsent === 1) {
      out.push({ row, consentSection: section.kind, group })
    }
  }

  return out
}

const PUPIL = /pupil/i
const CONSENT = /consent/i
const NAMES_REPORT = /consent report/i

export type TConsentVoteRow = {
  row: TLegistarEventItem
  /** Legistar's title, or the section's when the row's doesn't name a consent report ("Approval of the Consent Agenda"). */
  title: string
  /** The agenda section the vote falls under, e.g. "Adoption of General Consent Report - General Obligation Bonds …". */
  section: string | null
}

/**
 * The minutes rows that record a vote on a General Consent Report as a whole (including a
 * General Obligation Bond one), never the Pupil Discipline Consent Report's.
 *
 * Vote rows have no agenda sequence and an action. Their titles vary: "Approval of the General
 * Consent Report", typos ("Geneal"), a bare "Approval of the Consent Agenda" that both reports
 * use at the same meeting, and now and then a Pupil Discipline vote titled "General Consent
 * Report". So each row is placed, by minutes order, under the top-level agenda header before it.
 * It counts when that header is a General Consent Report, or when its own title names the
 * General Consent Report (a motion to postpone the whole report, say) and it isn't under the
 * Pupil Discipline header. Each vote records that header as its `section`; a row whose own
 * title doesn't name a consent report also takes the section as its title.
 */
export function findConsentVoteRows(eventItems: TLegistarEventItem[]): TConsentVoteRow[] {
  const titleOf = (r: TLegistarEventItem): string => r.EventItemTitle ?? ''
  const isVote = (r: TLegistarEventItem): boolean =>
    r.EventItemAgendaSequence == null && !!r.EventItemActionName && CONSENT.test(titleOf(r)) && !PUPIL.test(titleOf(r))

  const sequenced = eventItems
    .filter(r => r.EventItemMinutesSequence != null)
    .sort((a, b) => a.EventItemMinutesSequence! - b.EventItemMinutesSequence!)
  const unsequenced = eventItems.filter(r => r.EventItemMinutesSequence == null)

  const out: TConsentVoteRow[] = []
  let header: TLegistarEventItem | null = null
  for (const row of [...sequenced, ...unsequenced]) {
    if (row.EventItemMinutesSequence == null) header = null
    if (row.EventItemMatterId == null && TOP_LEVEL.test(row.EventItemAgendaNumber ?? '')) {
      header = row
      continue
    }
    if (!isVote(row)) continue
    const underReport = header != null && isConsentHeader(header) && !PUPIL.test(titleOf(header))
    const underPupil = header != null && PUPIL.test(titleOf(header))
    if (!underReport && (underPupil || !GENERAL_CONSENT.test(titleOf(row)))) continue
    const own = cleanTitle(row.EventItemTitle)
    const section = underReport ? cleanTitle(header!.EventItemTitle) : null
    out.push({ row, title: section && !NAMES_REPORT.test(own) ? section : own, section })
  }
  return out
}
