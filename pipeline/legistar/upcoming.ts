/**
 * Next-meeting detection. Legistar's /events API is broken for OUSD, but staff
 * file agenda items with a target meeting date long before the agenda is
 * published, so future-dated matters reveal upcoming Board meetings. This is
 * also how `consent run` discovers meetings for the registry.
 *
 * A date counts only when at least MIN_CONSENT_ITEMS items are filed as
 * "Board, General Consent Report" for it — one mis-dated item (they exist:
 * one is dated 3036) can't conjure a meeting.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { oaklandToday } from '@oakvs/consent-schema/format'
import { SCHEMA_VERSION, UpcomingFile } from '@oakvs/consent-schema/schema'
import type { TUpcomingFile } from '@oakvs/consent-schema/schema'

import { paths, writeJson } from '../store'

import { legistarGet } from './client'

export const MIN_CONSENT_ITEMS = 5
/** Ignore anything further out than this; real agendas fill in a few weeks ahead. */
export const HORIZON_DAYS = 90

export type TFutureMatter = { MatterAgendaDate: string | null; MatterStatusName: string | null }
export type TFutureMeeting = NonNullable<TUpcomingFile['meeting']>

const addDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Every date from today to the horizon with enough Board consent-report items, earliest first. */
export function futureMeetings(matters: TFutureMatter[], today: string): TFutureMeeting[] {
  const horizon = addDays(today, HORIZON_DAYS)
  const byDate = new Map<string, { consentItems: number; boardItems: number }>()
  for (const m of matters) {
    const date = m.MatterAgendaDate?.slice(0, 10)
    const status = m.MatterStatusName ?? ''
    if (!date || date < today || date > horizon || !status.startsWith('Board,')) continue
    const entry = byDate.get(date) ?? { consentItems: 0, boardItems: 0 }
    entry.boardItems++
    if (status === 'Board, General Consent Report') entry.consentItems++
    byDate.set(date, entry)
  }
  return [...byDate.entries()]
    .filter(([, v]) => v.consentItems >= MIN_CONSENT_ITEMS)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, ...v }))
}

/** The earliest future date with enough Board consent-report items, or null. */
export function pickNextMeeting(matters: TFutureMatter[], today: string): TUpcomingFile['meeting'] {
  return futureMeetings(matters, today)[0] ?? null
}

export type TUpcomingCheck = {
  file: TUpcomingFile
  /** Every confirmed future meeting, not just the next one. */
  meetings: TFutureMeeting[]
  /** Whether upcoming.json now says something different. */
  changed: boolean
}

async function readUpcoming(file: string): Promise<TUpcomingFile | null> {
  try {
    return UpcomingFile.parse(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return null
  }
}

/**
 * Check Legistar (always live, never cached) and write published/upcoming.json.
 * When the next meeting and its counts are unchanged the file is left as is.
 */
export async function updateUpcoming(now = new Date()): Promise<TUpcomingCheck> {
  const today = oaklandToday(now)
  const query = `/matters?$filter=MatterAgendaDate+ge+datetime'${today}'&$select=MatterAgendaDate,MatterStatusName&$top=1000`
  const matters = await legistarGet<TFutureMatter[]>(query, { fresh: true })
  const meetings = futureMeetings(matters, today)
  const target = path.join(paths.published, 'upcoming.json')
  const previous = await readUpcoming(target)
  const meeting = meetings[0] ?? null
  const changed = !previous || JSON.stringify(previous.meeting) !== JSON.stringify(meeting)
  const file = changed
    ? UpcomingFile.parse({ schemaVersion: SCHEMA_VERSION, checkedAt: now.toISOString(), meeting })
    : previous
  if (changed) await writeJson(target, file)
  return { file, meetings, changed }
}
