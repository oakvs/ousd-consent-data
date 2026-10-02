/**
 * Build one meeting: merge raw → enrichment → override, validate, derive
 * flags and outcomes, and produce the published MeetingFile.
 */

import { formatDate } from '@oakvs/consent-schema/format'
import { FLAG_ORDER } from '@oakvs/consent-schema/labels'
import { SCHEMA_VERSION } from '@oakvs/consent-schema/schema'
import type {
  TEnrichment,
  TEnrichmentsFile,
  THistoryEntry,
  TMeetingFile,
  TOutcome,
  TOverride,
  TOverridesFile,
  TPublishedItem,
  TRawSnapshot,
  TRegistryEntry,
  TVerificationRecord,
  TVerificationsFile,
} from '@oakvs/consent-schema/schema'
import { NO_ALIASES, vendorKey } from '@oakvs/consent-schema/vendor-key'
import type { TVendorAliases } from '@oakvs/consent-schema/vendor-key'

import { legistarItemUrl } from '../normalize/raw-item'
import { assess } from '../validate/alerts'
import { runChecks, routeReview } from '../validate/checks'
import { deriveFlags } from '../validate/derived-flags'
import { describePulled, wholeReportAction } from '../validate/separate-vote'

import { computeTotals } from './totals'

import type { TCheck } from '../validate/checks'

export const HIGH_VALUE_COUNT = 20

const ADOPTED = /adopt|approv|passed|ratif/i
const NOT_ADOPTED = /not |fail|withdraw|postpon|continued|tabled|deferred/i

/** A verification only applies to the exact enrichment it checked. */
export function currentVerification(
  verification: TVerificationRecord | null | undefined,
  cacheKey: string | null | undefined,
): TVerificationRecord | null {
  return verification && cacheKey && verification.enrichmentCacheKey === cacheKey ? verification : null
}

export function applyVerification(enrichment: TEnrichment | null, verification: TVerificationRecord | null): TEnrichment | null {
  if (!enrichment || !verification?.vendorKind) return enrichment
  const vendor = { ...enrichment.vendor, kind: verification.vendorKind }
  const headline = verification.vendorKind === 'individual' && verification.headlineFix ? verification.headlineFix : enrichment.headline
  return { ...enrichment, vendor, headline }
}

/** Top items by amount in a meeting; these always get an independent money reading. */
export function highValueFiles(items: { file: string; enrichment: TEnrichment | null }[]): Set<string> {
  return new Set(
    items
      .filter(m => m.enrichment?.money.thisAction)
      .sort((a, b) => b.enrichment!.money.thisAction! - a.enrichment!.money.thisAction!)
      .slice(0, HIGH_VALUE_COUNT)
      .map(m => m.file),
  )
}

export function applyOverride(enrichment: TEnrichment | null, override: TOverride | null): TEnrichment | null {
  if (!enrichment || !override) return enrichment
  const { money, term, vendor, ...rest } = override.fields
  return {
    ...enrichment,
    ...rest,
    vendor: vendor ?? enrichment.vendor,
    term: term ? { ...enrichment.term, ...term } : enrichment.term,
    money: money ? { ...enrichment.money, ...money } : enrichment.money,
  }
}

/**
 * The item's outcome: the latest history entry on or after the meeting date.
 * Handles deferrals (June 24 "Not Discussed" → June 29 "Adopted").
 */
export function deriveOutcome(history: THistoryEntry[], meetingDate: string): TOutcome | null {
  const after = history.filter(h => h.date >= meetingDate)
  const last = after.at(-1)
  if (!last) return null
  return {
    action: last.action,
    date: last.date,
    meetingEventId: last.eventId,
    adopted: ADOPTED.test(last.action) && !NOT_ADOPTED.test(last.action),
  }
}

export function parseAmendmentNo(...texts: string[]): number | null {
  for (const text of texts) {
    const match = /Amendment No\.?\s*(\d+)/i.exec(text)
    if (match) return Number(match[1])
  }
  return null
}

function meetingTitle(entry: TRegistryEntry | null): string {
  const kind = entry?.kind ?? 'regular'
  const label = kind === 'special' ? 'Special' : kind === 'organizational' ? 'Organizational' : 'Regular'
  return `Board of Education ${label} Meeting`
}

/**
 * A note when some or all items were decided at a later meeting, e.g. items
 * pulled from the June 24, 2026 consent report and decided June 29.
 */
export function laterDecisionNote(items: TPublishedItem[], meetingDate: string): string | null {
  const later = items.filter(i => i.outcome && i.outcome.date > meetingDate)
  if (later.length === 0) return null
  const dates = [...new Set(later.map(i => i.outcome!.date))].sort().map(d => formatDate(d, 'long'))
  if (later.length > items.length / 2) {
    return `Most of the consent report was not acted on at this meeting; ${later.length} of ${items.length} items were decided on ${dates.join(' and ')}.`
  }
  const noun = later.length === 1 ? 'item was' : 'items were'
  return `${later.length} ${noun} pulled from the consent report and decided on ${dates.join(' and ')}.`
}

export type TBuildInput = {
  raw: TRawSnapshot
  enrichments: TEnrichmentsFile | null
  overrides: TOverridesFile | null
  verifications?: TVerificationsFile | null
  /** Human overrides from other meetings, keyed by `overrideKey`, applied to identical items here. */
  sharedOverrides?: Map<string, TOverride>
  vendorAliases?: TVendorAliases
  registry: TRegistryEntry | null
  /** file number → every meeting key it appears in (for lineage). */
  fileAppearances: Map<string, string[]>
}

/** The same file number with identical official text is the same item, at any meeting. */
export const overrideKey = (file: string, text: string): string => `${file}\u0000${text}`

export function buildMeeting({ raw, enrichments, overrides, verifications, sharedOverrides, vendorAliases = NO_ALIASES, registry, fileAppearances }: TBuildInput): TMeetingFile {
  const key = raw.meetingKey
  const meetingDate = key.slice(0, 10)

  const merged = raw.items.map(item => {
    const record = enrichments?.items[item.file] ?? null
    const override = overrides?.items[item.file] ?? sharedOverrides?.get(overrideKey(item.file, item.text)) ?? null
    const verification = currentVerification(verifications?.items[item.file], record?.cacheKey)
    const enrichment = applyOverride(applyVerification(record?.output ?? null, verification), override)
    return { item, record, override, verification, enrichment }
  })

  // A single action on (nearly) the whole report is a decision on the report, not individual pulls.
  const reportAction = wholeReportAction(raw.items.map(i => i.history), meetingDate, raw.eventId)

  const items: TPublishedItem[] = merged.map(({ item, record, override, verification, enrichment }) => {
    let checks: TCheck[] = []
    let published: TEnrichment | null = null
    let notes: TPublishedItem['notes'] = []
    let alerts: string[] = []
    let sourceIssue: string | null = null
    let sourceIssueBy: TPublishedItem['sourceIssueBy'] = null

    if (enrichment) {
      const result = runChecks({
        text: item.text,
        enrichment,
        sourceIssue: override?.sourceIssue ?? null,
        secondReading: verification?.money ?? null,
      })
      checks = result.checks
      published = result.enrichment
      notes = result.notes
      if (published) {
        const humanTouched = Boolean(override?.sourceIssue || override?.fields.money)
        const assessment = assess(published, checks, verification, { humanTouched })
        if (Object.keys(assessment.corrected).length && !override?.fields.money) {
          published = { ...published, money: { ...published.money, ...assessment.corrected } }
        }
        alerts = assessment.alerts
        notes = [...notes, ...assessment.notes]
        sourceIssue = assessment.sourceIssue
        sourceIssueBy = assessment.sourceIssueBy
      }
    }
    // A person's call always wins.
    if (override?.sourceIssue) {
      sourceIssue = override.sourceIssue
      sourceIssueBy = 'human'
    }
    const status = routeReview(checks, published, override, alerts)
    // Blocked items publish official text only (§9, WF-4).
    if (status === 'blocked') published = null

    const derived = deriveFlags({ meetingDate, text: item.text, history: item.history, enrichment: published, sourceIssue })
    const pulled = reportAction ? null : describePulled(item.history, meetingDate, raw.eventId)
    const present = new Set<string>([...derived, ...(published?.flags ?? []), ...(pulled ? ['pulled_from_consent'] : [])])
    const flags = FLAG_ORDER.filter(f => present.has(f))

    return {
      ...item,
      id: `${key}:${item.file}`,
      vendorKey: vendorKey(item.vendorNo, published?.vendor.name ?? null, vendorAliases),
      legistarUrl: legistarItemUrl(item.matterId, item.matterGuid),
      enrichment: published,
      flags,
      sourceIssue,
      sourceIssueBy,
      pulled: pulled ? { summary: pulled.summary } : null,
      notes,
      amountVerified: override?.amountVerified ?? true,
      checks,
      review: {
        status,
        modelId: record?.modelId ?? null,
        promptVersion: record?.promptVersion ?? null,
        reviewedAt: override?.reviewedAt ?? null,
        correction: override?.note ?? null,
        verifiedBy: verification?.money ? verification.modelId : null,
        alerts: status === 'needs_review' ? alerts : [],
      },
      outcome: deriveOutcome(item.history, meetingDate),
      lineage: {
        amendmentNo: parseAmendmentNo(item.title, item.text),
        otherMeetings: (fileAppearances.get(item.file) ?? []).filter(k => k !== key),
      },
    }
  }).sort((a, b) => a.agendaSequence - b.agendaSequence)

  return {
    schemaVersion: SCHEMA_VERSION,
    meeting: {
      key,
      date: meetingDate,
      time: registry?.time ?? null,
      kind: registry?.kind ?? 'regular',
      title: meetingTitle(registry),
      eventId: raw.eventId,
      agendaPdfUrl: registry?.agendaPdfUrl ?? null,
      legistarMeetingUrl: registry?.meetingDetailId
        ? `https://ousd.legistar.com/MeetingDetail.aspx?ID=${registry.meetingDetailId}`
        : null,
      revision: 1,
      updatedAt: raw.fetchedAt,
      consentVotes: raw.consentVotes,
      note: registry?.note
        ?? (reportAction
          ? `The consent report as a whole ${/fail/i.test(reportAction) ? 'failed' : `was ${reportAction.toLowerCase()}`} at this meeting, in a single vote.`
          : null)
        ?? laterDecisionNote(items, meetingDate),
    },
    totals: computeTotals(items),
    items,
  }
}
