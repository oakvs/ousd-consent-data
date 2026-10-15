/* eslint-disable no-console -- CLI output */
/**
 * `calendar-backfill`: fill `meetingDetailId`, `meetingDetailGuid` and
 * `agendaPdfUrl` for official meetings that don't have them, from Legistar's
 * public calendar (one year-view search per year). A date with one Board
 * meeting on the calendar and one meeting in the registry is matched by date;
 * anything else goes through `checkOfficial`, which matches by file numbers.
 * Never changes `agendaStatus`: drafts are left to `consent run`.
 */
import { readRaw, readRegistry, writeRegistry } from '../store'

import { checkOfficial, fetchBoardCalendar } from './calendar'

import type { TCalendarRow } from './calendar'

export type TBackfillResult = { filled: string[]; unmatched: { key: string; reason: string }[] }

export async function backfillAgendaLinks({ dryRun = false }: { dryRun?: boolean } = {}): Promise<TBackfillResult> {
  const registry = await readRegistry()
  const todo = registry.meetings.filter(m => m.agendaStatus === 'official' && m.meetingDetailId == null && m.lastIngestedAt != null)
  const years = [...new Set(todo.map(m => m.date.slice(0, 4)))].sort()
  const rowsByYear = new Map<string, TCalendarRow[]>()
  for (const year of years) {
    rowsByYear.set(year, await fetchBoardCalendar(year as `${number}`))
    console.log(`${year}: ${rowsByYear.get(year)!.length} Board meetings on the calendar`)
  }

  const result: TBackfillResult = { filled: [], unmatched: [] }
  for (const entry of todo) {
    const rows = rowsByYear.get(entry.date.slice(0, 4)) ?? []
    const onDate = rows.filter(r => r.date === entry.date && r.agendaUrl)
    const sameDay = registry.meetings.filter(m => m.date === entry.date && m.status !== 'skipped')
    let match: { meetingDetailId: number; meetingDetailGuid: string; agendaPdfUrl: string } | null = null
    if (onDate.length === 1 && sameDay.length === 1) {
      const [row] = onDate
      match = { meetingDetailId: row.meetingDetailId, meetingDetailGuid: row.meetingDetailGuid, agendaPdfUrl: row.agendaUrl! }
    } else {
      const raw = await readRaw(entry.key)
      if (!raw) continue
      const check = await checkOfficial(entry.date, new Set(raw.items.map(i => i.file)), rows)
      if (check.official) match = check.agenda
      else result.unmatched.push({ key: entry.key, reason: check.reason })
    }
    if (!match) continue
    entry.meetingDetailId = match.meetingDetailId
    entry.meetingDetailGuid = match.meetingDetailGuid
    entry.agendaPdfUrl = match.agendaPdfUrl
    result.filled.push(entry.key)
  }
  if (!dryRun) await writeRegistry(registry)
  return result
}
