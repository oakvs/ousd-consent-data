/**
 * Meeting registry helpers (`data/meetings.json`).
 *
 * Key rule: the bare date, unless two meetings share the day, in which case
 * the non-regular one gets a suffix (`2026-09-23-special`). Discovery only
 * adds dates the registry doesn't have yet, so it always uses the bare date.
 */
import { expectedMeetingKind } from '@oakvs/consent-schema/format'
import type { TMeetingKind, TRawSnapshot, TRegistry, TRegistryEntry } from '@oakvs/consent-schema/schema'

export function blankEntry(key: string, kind: TMeetingKind = key.endsWith('-special') ? 'special' : 'regular'): TRegistryEntry {
  return {
    key,
    date: key.slice(0, 10),
    time: null,
    kind,
    eventId: null,
    resolvedBy: null,
    meetingDetailId: null,
    agendaPdfUrl: null,
    status: 'discovered',
    lastIngestedAt: null,
    note: null,
    eventItemsHash: null,
    historiesCheckedOn: null,
  }
}

export function upsert(registry: TRegistry, entry: TRegistryEntry): void {
  const i = registry.meetings.findIndex(m => m.key === entry.key)
  if (i >= 0) registry.meetings[i] = entry
  else registry.meetings.push(entry)
}

/**
 * Register meetings that future-dated Legistar matters reveal (see
 * `upcoming.ts`). Returns the entries it added. A date already in the
 * registry, under any key, is left alone.
 */
export function registerFutureDates(registry: TRegistry, dates: string[]): TRegistryEntry[] {
  const added: TRegistryEntry[] = []
  for (const date of dates) {
    if (registry.meetings.some(m => m.date === date)) continue
    const kind = expectedMeetingKind(date)
    const entry = blankEntry(date, kind)
    registry.meetings.push(entry)
    added.push(entry)
  }
  return added
}

/** A meeting is final 14+ days after it happened, once every item has an action dated that day or later … */
export const FINAL_AFTER_DAYS = 14
/** … or 180 days after it, regardless. Some items never get a later action in Legistar, and re-checking them forever costs requests. */
export const STALE_AFTER_DAYS = 180

export function isSettled(entry: TRegistryEntry, snapshot: TRawSnapshot, now: Date = new Date()): boolean {
  const daysSince = (now.getTime() - Date.parse(entry.date)) / 86_400_000
  if (daysSince > STALE_AFTER_DAYS) return true
  return daysSince > FINAL_AFTER_DAYS && snapshot.items.every(i => i.history.some(h => h.date >= entry.date))
}
