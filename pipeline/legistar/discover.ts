/**
 * Meeting → EventId resolution (§4.3). `/events` is broken for OUSD, so:
 *
 * 1. history (past meetings): matters with that agenda date → their
 *    histories → the `MatterHistoryEventId` on Board of Education entries
 *    dated that day. Majority vote across a sample of matters.
 * 2. probe (upcoming meetings, before anything has a history): probe
 *    sequential EventIds after the last known one, and match an event to
 *    the date by ≥80% overlap of its file numbers with the matters-by-date
 *    list.
 *
 * Every candidate is confirmed by fetching its event items.
 */
import type { TMeetingKind, TRegistry } from '@oakvs/consent-schema/schema'

import { findConsentRows } from '../normalize/sections'

import { getEventItems, getHistories, getMattersByAgendaDate, mapConcurrent } from './client'

import type { TLegistarEventItem } from './client'

export type TResolved = { eventId: number; resolvedBy: 'history' | 'probe' }

const BOARD = /board of education/i
const HISTORY_SAMPLE = 12
const PROBE_AHEAD = 40
const PROBE_MAX_EMPTY = 8
const MIN_OVERLAP = 0.8
/** June 24, 2026 — a known-good anchor when the registry is empty. */
export const ANCHOR_EVENT_ID = 5785

async function historyCandidates(date: string, matterIds: number[]): Promise<number[]> {
  const votes = new Map<number, number>()
  const sample = matterIds.slice(0, HISTORY_SAMPLE)
  const histories = await mapConcurrent(sample, id => getHistories(id).catch(() => []))
  for (const list of histories) {
    for (const h of list) {
      if (h.MatterHistoryEventId && h.MatterHistoryActionDate?.startsWith(date) && BOARD.test(h.MatterHistoryActionBodyName ?? '')) {
        votes.set(h.MatterHistoryEventId, (votes.get(h.MatterHistoryEventId) ?? 0) + 1)
      }
    }
  }
  return [...votes.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

function overlap(eventFiles: Set<string>, dateFiles: Set<string>): number {
  if (eventFiles.size === 0) return 0
  let hits = 0
  for (const f of eventFiles) if (dateFiles.has(f)) hits++
  return hits / eventFiles.size
}

export type TProbedEvents = Map<number, TLegistarEventItem[]>

/**
 * Live-fetch the EventIds after `startAfter` until PROBE_MAX_EMPTY empty ones
 * in a row (or PROBE_AHEAD tried). Returns only events that have items.
 * `consent run` probes once and shares the result across meetings.
 */
export async function probeEvents(startAfter: number): Promise<TProbedEvents> {
  const found: TProbedEvents = new Map()
  let empty = 0
  for (let id = startAfter + 1; id <= startAfter + PROBE_AHEAD && empty < PROBE_MAX_EMPTY; id++) {
    const items = await getEventItems(id, { fresh: true }).catch(() => [])
    if (items.length === 0) {
      empty++
      continue
    }
    empty = 0
    found.set(id, items)
  }
  return found
}

function probeCandidates(dateFiles: Set<string>, probed: TProbedEvents): number[] {
  const matches: number[] = []
  for (const [id, items] of probed) {
    const files = new Set(items.map(i => i.EventItemMatterFile).filter((f): f is string => !!f))
    if (overlap(files, dateFiles) >= MIN_OVERLAP) matches.push(id)
  }
  return matches
}

export type TResolveOptions = {
  /** Look for the EventId in matter histories first. Pointless before the meeting has happened. */
  useHistory?: boolean
  /** A probe already run this cycle; otherwise this call probes on its own. */
  probed?: TProbedEvents
}

export async function resolveEventId(
  key: string,
  date: string,
  _kind: TMeetingKind,
  registry: TRegistry,
  { useHistory = true, probed }: TResolveOptions = {},
): Promise<TResolved | null> {
  const matters = await getMattersByAgendaDate(date, { fresh: true })
  if (matters.length === 0) return null
  // Events already claimed by another meeting — including the other meeting on a two-meeting day.
  const taken = new Set(registry.meetings.filter(m => m.eventId != null && m.key !== key).map(m => m.eventId))

  const confirm = async (ids: number[], resolvedBy: TResolved['resolvedBy']): Promise<TResolved | null> => {
    const candidates = ids.filter(i => !taken.has(i))
    // Prefer an event with a consent section; otherwise take the best candidate
    // (some meetings, regular or special, simply have no consent report).
    for (const id of candidates) {
      if (findConsentRows(await getEventItems(id)).length > 0) return { eventId: id, resolvedBy }
    }
    return candidates[0] != null ? { eventId: candidates[0], resolvedBy } : null
  }

  if (useHistory) {
    const fromHistory = await confirm(await historyCandidates(date, matters.map(m => m.MatterId)), 'history')
    if (fromHistory) return fromHistory
  }

  const dateFiles = new Set(matters.map(m => m.MatterFile))
  const events = probed ?? await probeEvents(registry.lastKnownEventId ?? ANCHOR_EVENT_ID)
  return confirm(probeCandidates(dateFiles, events), 'probe')
}
