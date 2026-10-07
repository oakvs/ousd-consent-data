/**
 * Legistar → RawItem (§4.2).
 *
 * Never reads `MatterText2` (staff email) or `MatterCost` (unreliable), and
 * strips stray email addresses from `MatterText1` (funding source).
 */
import type { THistoryEntry, TRawItem } from '@oakvs/consent-schema/schema'

import { withoutEmails } from './privacy'
import { cleanTitle } from './sections'

import type { TSectionRow } from './sections'
import type { TLegistarHistory, TLegistarMatter } from '../legistar/client'

export const FILE_NUMBER = /^\d{2}-\d{4}[A-Z]?$/

const isoDay = (value: string | null | undefined): string | null => value?.slice(0, 10) ?? null

const blankToNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.replace(/\s+/g, ' ').trim()
  return trimmed ? trimmed : null
}

/** Codes sometimes repeat across lines ("005403\r\n005403"); keep each distinct code once. */
export const normalizeCode = (value: string | null | undefined): string | null => {
  const codes = [...new Set((value ?? '').split(/\s+/).filter(Boolean))]
  return codes.length ? codes.join(' ') : null
}

/** OUSD vendor numbers are numeric (e.g. `006530`); Legistar also holds "N/A", file numbers and other junk. */
export const normalizeVendorNo = (value: string | null | undefined): string | null =>
  normalizeCode((value ?? '').split(/\s+/).filter(code => /^\d{4,8}$/.test(code)).join(' '))

export function normalizeHistory(histories: TLegistarHistory[]): THistoryEntry[] {
  return histories
    .filter(h => h.MatterHistoryActionDate && h.MatterHistoryActionName)
    .map(h => ({
      date: isoDay(h.MatterHistoryActionDate)!,
      action: h.MatterHistoryActionName!.trim(),
      body: blankToNull(h.MatterHistoryActionBodyName),
      eventId: h.MatterHistoryEventId ?? null,
      historyId: h.MatterHistoryId ?? null,
      consent: h.MatterHistoryConsent == null ? null : h.MatterHistoryConsent === 1,
      motion: blankToNull(h.MatterHistoryActionText),
      mover: blankToNull(h.MatterHistoryMoverName),
      seconder: blankToNull(h.MatterHistorySeconderName),
      passed: blankToNull(h.MatterHistoryPassedFlagName),
      votes: null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.action.localeCompare(b.action))
}

/** Legistar file number, without stray leading punctuation (2020-01-22 lists "+20-0100"). */
export const cleanFileNumber = (file: string | null | undefined): string => (file ?? '').trim().replace(/^[^0-9A-Za-z]+/, '')

/**
 * The item's agenda number. Two virtual special meetings in 2020 (June 29, Aug 1) list their
 * consent items unnumbered; those get "#" plus their place in Legistar's agenda order, which
 * can't be mistaken for an official number.
 */
export const agendaLabel = (row: Pick<TSectionRow['row'], 'EventItemAgendaNumber' | 'EventItemAgendaSequence'>): string =>
  row.EventItemAgendaNumber?.trim() || `#${row.EventItemAgendaSequence}`

export function toRawItem(
  { row, consentSection, group }: TSectionRow,
  matter: TLegistarMatter | null,
  histories: TLegistarHistory[],
): TRawItem {
  const file = cleanFileNumber(row.EventItemMatterFile ?? matter?.MatterFile)
  if (!FILE_NUMBER.test(file)) {
    throw new Error(`Unexpected file number ${JSON.stringify(file)} at ${row.EventItemAgendaNumber}`)
  }
  return {
    agendaNumber: agendaLabel(row),
    agendaSequence: row.EventItemAgendaSequence!,
    consentSection,
    group,
    file,
    matterId: row.EventItemMatterId!,
    matterGuid: matter?.MatterGuid ?? null,
    title: cleanTitle(row.EventItemMatterName ?? matter?.MatterName),
    text: (row.EventItemTitle ?? matter?.MatterTitle ?? '').trim(),
    matterType: blankToNull(row.EventItemMatterType ?? matter?.MatterTypeName),
    presenter: blankToNull(matter?.MatterBodyName),
    vendorNo: normalizeVendorNo(matter?.MatterEXText1),
    resourceSite: normalizeCode(matter?.MatterEXText3),
    fundingSource: withoutEmails(blankToNull(matter?.MatterText1)),
    introDate: isoDay(matter?.MatterIntroDate),
    attachments: (row.EventItemMatterAttachments ?? [])
      .filter(a => a.MatterAttachmentHyperlink)
      .map(a => ({ name: cleanTitle(a.MatterAttachmentName), url: a.MatterAttachmentHyperlink })),
    history: normalizeHistory(histories),
  }
}

/**
 * Public link to a matter on ousd.legistar.com.
 *
 * The web app's LegislationDetail.aspx takes its own ID and GUID, which differ
 * from the API's MatterId and MatterGuid, so building that URL from API fields
 * shows "Invalid parameters!". gateway.aspx takes the API MatterId and redirects
 * to the right LegislationDetail page.
 */
export function legistarItemUrl(matterId: number): string {
  return `https://ousd.legistar.com/gateway.aspx?M=L&ID=${matterId}`
}
