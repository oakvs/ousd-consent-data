/**
 * Consent-section finder (§2 facts 4–5).
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

    if (number.startsWith(`${section.letter}.-`) || row.EventItemConsent === 1) {
      out.push({ row, consentSection: section.kind, group })
    }
  }

  return out
}
