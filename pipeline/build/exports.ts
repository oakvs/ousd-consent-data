/**
 * Flat exports for people who want a spreadsheet, not JSON (`data/exports/`):
 *
 *   items.csv               every consent item, all meetings
 *   meetings/{key}.csv      the same rows, one file per meeting
 *   meetings.csv            one row per meeting, with totals
 *   vendors.csv             one row per vendor
 *   datapackage.json        Frictionless Data Package: columns, types, license, sources
 *
 * Each table's columns are defined once below; the CSV and its schema in
 * datapackage.json both come from that definition. Like the rest of the
 * build, the output is deterministic.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { TMeetingFile, TPublishedItem, TVendorIndexFile } from '@oakvs/consent-schema/schema'

import { getDataRoot, writeJson } from '../store'

type TFieldType = 'string' | 'integer' | 'number' | 'boolean' | 'date'
type TValue = string | number | boolean | null | undefined

export type TColumn<R> = { name: string; type: TFieldType; description: string; get: (row: R) => TValue }

type TItemRow = { meeting: TMeetingFile['meeting']; item: TPublishedItem }

const list = (values: string[] | null | undefined): string | null => (values?.length ? values.join('; ') : null)

export const ITEM_COLUMNS: TColumn<TItemRow>[] = [
  { name: 'item_id', type: 'string', description: 'Stable id: meeting key and file number, e.g. 2026-09-23:26-1736.', get: r => r.item.id },
  { name: 'meeting_key', type: 'string', description: 'Meeting key: the date, with a suffix when two meetings share a day.', get: r => r.meeting.key },
  { name: 'meeting_date', type: 'date', description: 'Date of the Board meeting.', get: r => r.meeting.date },
  { name: 'meeting_kind', type: 'string', description: 'regular, special or organizational.', get: r => r.meeting.kind },
  { name: 'agenda_number', type: 'string', description: 'Agenda item number, e.g. R.-1.', get: r => r.item.agendaNumber },
  { name: 'agenda_sequence', type: 'integer', description: "Position in Legistar's agenda order.", get: r => r.item.agendaSequence },
  { name: 'consent_section', type: 'string', description: 'general (General Consent Report) or bonds.', get: r => r.item.consentSection },
  { name: 'group', type: 'string', description: 'Agenda group the item is listed under, usually the presenting office.', get: r => r.item.group },
  { name: 'file_number', type: 'string', description: 'Legistar file number, e.g. 26-1736.', get: r => r.item.file },
  { name: 'legistar_url', type: 'string', description: 'The item on Legistar, the official record.', get: r => r.item.legistarUrl },
  { name: 'title', type: 'string', description: 'Official short title (Legistar).', get: r => r.item.title },
  { name: 'official_text', type: 'string', description: 'Official action text (Legistar), the source of truth for everything below.', get: r => r.item.text },
  { name: 'matter_type', type: 'string', description: 'Legistar matter type.', get: r => r.item.matterType },
  { name: 'presenter', type: 'string', description: 'Presenting office (Legistar).', get: r => r.item.presenter },
  { name: 'vendor_number', type: 'string', description: 'OUSD vendor number(s) from Legistar, space-separated.', get: r => r.item.vendorNo },
  { name: 'vendor_key', type: 'string', description: "This project's vendor id; see vendors.csv.", get: r => r.item.vendorKey },
  { name: 'funding_source', type: 'string', description: 'Funding source (Legistar).', get: r => r.item.fundingSource },
  { name: 'headline', type: 'string', description: 'Plain-English headline (AI-written, checked).', get: r => r.item.enrichment?.headline },
  { name: 'summary', type: 'string', description: 'Plain-English summary (AI-written, checked).', get: r => r.item.enrichment?.summary },
  { name: 'category', type: 'string', description: 'What the item is for (AI classification).', get: r => r.item.enrichment?.category },
  { name: 'action_type', type: 'string', description: 'Kind of action, e.g. new_agreement, amendment (AI classification).', get: r => r.item.enrichment?.actionType },
  { name: 'vendor_name', type: 'string', description: 'Vendor or partner named in the text (AI-extracted).', get: r => r.item.enrichment?.vendor.name },
  { name: 'vendor_kind', type: 'string', description: 'individual or organization (AI-judged).', get: r => r.item.enrichment?.vendor.kind },
  { name: 'schools', type: 'string', description: 'Schools or sites named in the text, semicolon-separated.', get: r => list(r.item.enrichment?.schools) },
  { name: 'money_direction', type: 'string', description: 'expense, revenue, decrease or no_cost.', get: r => r.item.enrichment?.money.direction },
  { name: 'amount_type', type: 'string', description: 'not_to_exceed, fixed, cumulative, per_year or sales_cap.', get: r => r.item.enrichment?.money.amountType },
  { name: 'amount', type: 'number', description: 'Dollars this vote adds, authorizes or receives, as stated in the text. Empty when not stated.', get: r => r.item.enrichment?.money.thisAction },
  { name: 'amount_range_low', type: 'number', description: 'Low end, when the text gives a yearly range.', get: r => r.item.enrichment?.money.thisActionRange?.[0] },
  { name: 'amount_range_high', type: 'number', description: 'High end, when the text gives a yearly range.', get: r => r.item.enrichment?.money.thisActionRange?.[1] },
  { name: 'prior_total', type: 'number', description: 'Earlier contract total, when the text states it.', get: r => r.item.enrichment?.money.priorTotal },
  { name: 'new_total', type: 'number', description: 'New contract total, when the text states it.', get: r => r.item.enrichment?.money.newTotal },
  { name: 'amount_verified', type: 'boolean', description: 'True when the amount passed the automated checks (and any second reading).', get: r => r.item.amountVerified },
  { name: 'term_start', type: 'date', description: 'Start of the agreement or service period, if stated.', get: r => r.item.enrichment?.term.start },
  { name: 'term_end', type: 'date', description: 'End of the agreement or service period, if stated.', get: r => r.item.enrichment?.term.end },
  { name: 'flags', type: 'string', description: 'Flags such as no_competitive_bid or after_work_began, semicolon-separated.', get: r => list(r.item.flags) },
  { name: 'source_issue', type: 'string', description: 'A confirmed problem in the official text itself (e.g. totals that do not add up).', get: r => r.item.sourceIssue },
  { name: 'pulled_from_consent', type: 'string', description: 'Set when the item was taken off the single consent vote; says what happened.', get: r => r.item.pulled?.summary },
  { name: 'outcome_action', type: 'string', description: 'Final action on the item (Legistar).', get: r => r.item.outcome?.action },
  { name: 'outcome_date', type: 'date', description: 'Date of that action.', get: r => r.item.outcome?.date },
  { name: 'adopted', type: 'boolean', description: 'True when the item was adopted or approved.', get: r => r.item.outcome?.adopted },
  { name: 'review_status', type: 'string', description: 'auto_ok, needs_review, blocked, human_reviewed, or pending (no summary yet).', get: r => r.item.review.status },
  { name: 'model_id', type: 'string', description: 'Model that wrote the summary.', get: r => r.item.review.modelId },
  { name: 'prompt_version', type: 'string', description: 'Prompt version used for the summary.', get: r => r.item.review.promptVersion },
  { name: 'duplicate_of', type: 'string', description: 'Item id this row repeats (the same action listed twice); repeats are left out of totals.', get: r => r.item.duplicateOf ?? null },
]

export const MEETING_COLUMNS: TColumn<TMeetingFile>[] = [
  { name: 'meeting_key', type: 'string', description: 'Meeting key.', get: m => m.meeting.key },
  { name: 'meeting_date', type: 'date', description: 'Date of the Board meeting.', get: m => m.meeting.date },
  { name: 'meeting_kind', type: 'string', description: 'regular, special or organizational.', get: m => m.meeting.kind },
  { name: 'title', type: 'string', description: 'Meeting title.', get: m => m.meeting.title },
  { name: 'legistar_event_id', type: 'integer', description: 'Legistar EventId.', get: m => m.meeting.eventId },
  { name: 'legistar_meeting_url', type: 'string', description: 'The meeting on Legistar, when known.', get: m => m.meeting.legistarMeetingUrl },
  { name: 'items', type: 'integer', description: 'Consent items.', get: m => m.totals.items },
  { name: 'summarized_items', type: 'integer', description: 'Items with a summary.', get: m => m.totals.enrichedItems },
  { name: 'spending_total', type: 'number', description: 'Total spending authorized, excluding yearly caps and sales caps.', get: m => m.totals.spendingTotal },
  { name: 'spending_items', type: 'integer', description: 'Items in spending_total.', get: m => m.totals.spendingItems },
  { name: 'yearly_caps_total', type: 'number', description: 'Sum of per-year spending limits.', get: m => m.totals.yearlyCapsTotal },
  { name: 'revenue_total', type: 'number', description: 'Money coming to the district.', get: m => m.totals.revenueTotal },
  { name: 'decrease_total', type: 'number', description: 'Reductions to earlier contracts.', get: m => m.totals.decreaseTotal },
  { name: 'note', type: 'string', description: 'Meeting-level note, e.g. a consent report postponed as a whole.', get: m => m.meeting.note },
  { name: 'updated_at', type: 'string', description: 'When the source data last changed (ISO timestamp).', get: m => m.meeting.updatedAt },
]

type TVendorRow = TVendorIndexFile['vendors'][number]

export const VENDOR_COLUMNS: TColumn<TVendorRow>[] = [
  { name: 'vendor_key', type: 'string', description: "This project's vendor id.", get: v => v.key },
  { name: 'vendor_number', type: 'string', description: 'OUSD vendor number, when known.', get: v => v.vendorNo },
  { name: 'name', type: 'string', description: 'Vendor name.', get: v => v.name },
  { name: 'kind', type: 'string', description: 'individual or organization.', get: v => v.kind },
  { name: 'top_category', type: 'string', description: 'Most common category of its items.', get: v => v.topCategory },
  { name: 'meetings', type: 'integer', description: 'Meetings it appeared in.', get: v => v.meetings },
  { name: 'appearances', type: 'integer', description: 'Consent items naming it.', get: v => v.appearances },
  { name: 'approved_count', type: 'integer', description: 'Of those, items approved.', get: v => v.approvedCount },
  { name: 'approved_total', type: 'number', description: 'Dollars on its approved items.', get: v => v.approvedTotal },
  { name: 'legistar_records', type: 'integer', description: 'Legistar records carrying its vendor number, in any year.', get: v => v.legistarRecords },
  { name: 'last_seen', type: 'date', description: 'Date of the latest meeting naming it.', get: v => v.lastSeen },
]

/** RFC 4180 field: quoted when it holds a comma, quote or line break. Null is empty. */
function cell(value: TValue): string {
  if (value == null) return ''
  const s = typeof value === 'string' ? value : String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv<R>(columns: TColumn<R>[], rows: R[]): string {
  const lines = [columns.map(c => c.name).join(','), ...rows.map(r => columns.map(c => cell(c.get(r))).join(','))]
  return `${lines.join('\n')}\n`
}

const schemaOf = <R>(columns: TColumn<R>[], primaryKey: string): object => ({
  fields: columns.map(c => ({ name: c.name, type: c.type, description: c.description })),
  missingValues: [''],
  primaryKey,
})

const resource = <R>(name: string, file: string, description: string, columns: TColumn<R>[], primaryKey: string): object => ({
  name,
  path: file,
  profile: 'tabular-data-resource',
  format: 'csv',
  mediatype: 'text/csv',
  encoding: 'utf-8',
  dialect: { delimiter: ',', lineTerminator: '\n', quoteChar: '"', doubleQuote: true, header: true },
  description,
  schema: schemaOf(columns, primaryKey),
})

export function dataPackage(): object {
  return {
    profile: 'tabular-data-package',
    name: 'ousd-consent-data',
    title: 'OUSD Board of Education consent agenda items',
    description:
      'Every item on the Oakland Unified School District Board of Education General Consent Report, from Legistar, '
      + 'with plain-English summaries, classifications and dollar amounts checked in code. '
      + 'meetings/{meeting_key}.csv holds the rows of items.csv one meeting at a time. '
      + 'The JSON under ../published/ has the same data with full detail (history, checks, attachments).',
    homepage: 'https://oakvs.world/consent-tracker',
    keywords: ['Oakland', 'OUSD', 'school board', 'consent agenda', 'contracts', 'public spending', 'Legistar'],
    licenses: [{
      name: 'CC-BY-4.0',
      title: 'Creative Commons Attribution 4.0 (summaries, classifications, vendor profiles; official Legistar text is public record)',
      path: 'https://creativecommons.org/licenses/by/4.0/',
    }],
    sources: [{ title: 'OUSD Legistar (Board of Education)', path: 'https://ousd.legistar.com' }],
    contributors: [{ title: 'Oakland vs. the World', path: 'https://oakvs.world', role: 'author' }],
    resources: [
      resource('items', 'items.csv', 'One row per consent item, all meetings.', ITEM_COLUMNS, 'item_id'),
      resource('meetings', 'meetings.csv', 'One row per meeting, with totals.', MEETING_COLUMNS, 'meeting_key'),
      resource('vendors', 'vendors.csv', 'One row per vendor.', VENDOR_COLUMNS, 'vendor_key'),
    ],
  }
}

export async function writeExports(meetings: TMeetingFile[], vendors: TVendorIndexFile): Promise<void> {
  const out = path.join(getDataRoot(), 'exports')
  await rm(path.join(out, 'meetings'), { recursive: true, force: true })
  await mkdir(path.join(out, 'meetings'), { recursive: true })

  const ordered = [...meetings].sort((a, b) => a.meeting.key.localeCompare(b.meeting.key))
  const rowsOf = (m: TMeetingFile): TItemRow[] =>
    [...m.items].sort((a, b) => a.agendaSequence - b.agendaSequence).map(item => ({ meeting: m.meeting, item }))

  for (const m of ordered) await writeFile(path.join(out, 'meetings', `${m.meeting.key}.csv`), toCsv(ITEM_COLUMNS, rowsOf(m)))
  await writeFile(path.join(out, 'items.csv'), toCsv(ITEM_COLUMNS, ordered.flatMap(rowsOf)))
  await writeFile(path.join(out, 'meetings.csv'), toCsv(MEETING_COLUMNS, ordered))
  const vendorRows = [...vendors.vendors].sort((a, b) => a.key.localeCompare(b.key))
  await writeFile(path.join(out, 'vendors.csv'), toCsv(VENDOR_COLUMNS, vendorRows))
  await writeJson(path.join(out, 'datapackage.json'), dataPackage())
}
