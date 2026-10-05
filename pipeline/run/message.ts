/**
 * Commit messages for `consent run`. The subject says what a reader of the
 * data repo's history wants to know at a glance:
 *   2026-10-14: agenda posted — 87 items
 *   2026-10-14: agenda revised — 2 added, 1 revised
 *   2026-10-14: outcomes updated — 85 items
 */
import type { TItemDiff } from '../ingest'

export type TMeetingChange = {
  key: string
  eventId: number
  items: number
  /** Null for a first ingest. */
  diff: TItemDiff | null
  /** True when the item data didn't change (only bookkeeping, e.g. the daily outcome check). */
  unchanged: boolean
  final: boolean
}

export type TRunChanges = {
  upcoming: { changed: boolean; date: string | null; consentItems: number | null }
  discovered: string[]
  resolved: { key: string; eventId: number; resolvedBy: string }[]
  meetings: TMeetingChange[]
  /** Items across all meetings that have no AI summary yet. */
  pendingSummaries: number
}

const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`

function revisionParts(diff: TItemDiff): string[] {
  const parts: string[] = []
  if (diff.added.length) parts.push(`${diff.added.length} added`)
  if (diff.removed.length) parts.push(`${diff.removed.length} removed`)
  if (diff.revised.length) parts.push(`${diff.revised.length} revised`)
  return parts
}

/** One line per meeting whose items changed, or null when only bookkeeping changed. */
export function meetingLine(m: TMeetingChange): string | null {
  if (m.unchanged) return m.final ? `${m.key}: final` : null
  if (!m.diff) return `${m.key}: agenda posted — ${plural(m.items, 'item')}`
  const revision = revisionParts(m.diff)
  const suffix = m.final ? ' [final]' : ''
  if (revision.length) return `${m.key}: agenda revised — ${revision.join(', ')}${suffix}`
  if (m.diff.outcomes.length) return `${m.key}: outcomes updated — ${plural(m.diff.outcomes.length, 'item')}${suffix}`
  return `${m.key}: consent votes updated${suffix}`
}

export function commitMessage(c: TRunChanges): { subject: string; body: string } {
  const lines = c.meetings.map(meetingLine).filter((l): l is string => l != null)
  const found = c.resolved.map(r => `${r.key}: meeting found (event ${r.eventId}, via ${r.resolvedBy})`)
  const detected = c.discovered
    .filter(k => !c.resolved.some(r => r.key === k))
    .map(k => `${k}: meeting detected from future-dated items`)
  const upcoming = c.upcoming.changed
    ? c.upcoming.date
      ? `upcoming: ${c.upcoming.date}, ${plural(c.upcoming.consentItems ?? 0, 'consent item')} filed so far`
      : 'upcoming: no meeting confirmed'
    : null

  const subjectParts = lines.length ? lines : found.length ? found : detected.length ? detected : upcoming ? [upcoming] : []
  const subject = subjectParts.length ? subjectParts.join('; ') : 'registry: routine check'

  const body = [
    ...lines,
    ...found,
    ...detected,
    ...(upcoming ? [upcoming] : []),
    ...c.meetings.filter(m => m.unchanged && !m.final).map(m => `${m.key}: checked, no item changes`),
    ...(c.pendingSummaries ? [`${plural(c.pendingSummaries, 'item')} awaiting AI summaries`] : []),
  ]
  return { subject, body: body.map(l => `- ${l}`).join('\n') }
}

// ─── LLM publish ─────────────────────────────────────────────────────────────

export type TLlmMeetingChange = {
  key: string
  summaries: number
  secondReadings: number
  failed: number
  waiting: number
  gaveUp: number
  /** Items the build routed to review (needs_review or blocked) after this step. */
  flagged: number
}

export type TVendorChanges = {
  /** Duplicates the judge merged: the vendors folded in, the one they joined, and why. */
  merged: { into: string; from: string[]; reason: string }[]
  keptSeparate: number
  mergeGroupsLeft: number
  historiesUpdated: number
  /** History files for vendor keys that no longer exist (merged away). */
  historiesRemoved: number
  historiesLeft: number
  researched: number
  /** Profiles that passed the review and now show on vendor pages. */
  published: number
  reviewed: number
  failed: number
  gaveUp: number
  /** Unresearched vendors left for later runs. */
  remaining: number
}

export type TLlmChanges = {
  meetings: TLlmMeetingChange[]
  /** Null when no vendor step ran. */
  vendors?: TVendorChanges | null
  costUsd: number
  monthSpendUsd: number
  capUsd: number
  capped: boolean
}

const usd = (n: number): string => `$${n.toFixed(2)}`

export function llmCommitMessage(c: TLlmChanges): { subject: string; body: string } {
  const lines = c.meetings
    .filter(m => m.summaries || m.secondReadings)
    .map(m => {
      const parts = [
        m.summaries ? `summaries — ${plural(m.summaries, 'item')}` : null,
        m.secondReadings ? plural(m.secondReadings, 'second reading') : null,
      ].filter(Boolean).join(', ')
      return `${m.key}: ${parts}${m.flagged ? ` (${m.flagged} flagged for review)` : ''}`
    })
  const problems = c.meetings.flatMap(m => [
    m.failed ? `${m.key}: ${plural(m.failed, 'item')} failed the checks (retried tomorrow)` : null,
    m.gaveUp ? `${m.key}: ${plural(m.gaveUp, 'item')} still failing after 3 days — needs a human` : null,
  ]).filter((l): l is string => l != null)
  const v = c.vendors
  const vendorParts = v
    ? [
      v.merged.length ? `${plural(v.merged.reduce((n, m) => n + m.from.length, 0), 'duplicate')} merged` : null,
      v.researched || v.reviewed ? `${v.researched} researched, ${plural(v.published, 'profile')} published` : null,
      v.historiesUpdated ? `${plural(v.historiesUpdated, 'Legistar history', 'Legistar histories')} updated` : null,
    ].filter((l): l is string => l != null)
    : []
  const vendorLine = vendorParts.length ? `vendors: ${vendorParts.join(', ')}` : null
  const vendorProblems = v
    ? [
      ...v.merged.map(m => `vendors: merged ${m.from.join(', ')} into ${m.into} — ${m.reason}`),
      v.historiesRemoved ? `vendors: ${plural(v.historiesRemoved, 'history file')} for merged-away vendors removed` : null,
      v.failed ? `vendors: ${plural(v.failed, 'vendor')} or merge group(s) failed (retried tomorrow)` : null,
      v.gaveUp ? `vendors: ${plural(v.gaveUp, 'vendor')} or merge group(s) still failing after 3 days — needs a human` : null,
      v.mergeGroupsLeft ? `vendors: ${v.mergeGroupsLeft} possible duplicate group(s) still to judge (next runs)` : null,
      v.historiesLeft ? `vendors: ${v.historiesLeft} Legistar histories still to update (next runs)` : null,
      v.remaining ? `vendors: ${v.remaining} still to research (next runs)` : null,
    ].filter((l): l is string => l != null)
    : []
  const subject = lines.length
    ? lines.join('; ')
    : vendorLine ? `Vendors: ${vendorLine.slice('vendors: '.length)}` : problems.length ? `llm: ${problems[0]}` : vendorProblems.length ? vendorProblems[0] : 'llm: bookkeeping'
  const body = [
    ...lines,
    ...(vendorLine ? [vendorLine] : []),
    ...problems,
    ...vendorProblems,
    `LLM cost ${usd(c.costUsd)} (this month ${usd(c.monthSpendUsd)} of ${usd(c.capUsd)})${c.capped ? ' — monthly cap reached, step stopped' : ''}`,
  ]
  return { subject, body: body.map(l => `- ${l}`).join('\n') }
}
