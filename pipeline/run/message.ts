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

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

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
