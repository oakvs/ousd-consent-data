/**
 * WF-2 Ingest: event items → consent rows → matters + histories → raw snapshot.
 *
 * Two modes:
 * - full (backfill, `consent ingest`): every item's matter and history is fetched.
 * - incremental (`consent run`, `reuseUnchanged`): an item whose agenda row is
 *   identical to the previous snapshot keeps its stored matter fields, and its
 *   history is only refetched when `refreshHistories` is set (once a day until
 *   the meeting is final). New or changed rows are always fetched in full.
 */
import { SCHEMA_VERSION } from '@oakvs/consent-schema/schema'
import type { TConsentVote, THistoryEntry, TRawItem, TRawSnapshot } from '@oakvs/consent-schema/schema'

import { getEventItems, getHistories, getMatter, getVotes, mapConcurrent } from './legistar/client'
import { normalizeHistory, toRawItem } from './normalize/raw-item'
import { cleanTitle, findConsentRows } from './normalize/sections'
import { readRaw, stableStringify, writeJson, paths } from './store'
import { votedActions } from './validate/separate-vote'

import type { TLegistarEventItem } from './legistar/client'
import type { TSectionRow } from './normalize/sections'

/** How the new snapshot differs from the previous one, by file number. */
export type TItemDiff = {
  added: string[]
  removed: string[]
  /** Agenda content changed (number, title, text, attachments, matter fields…). */
  revised: string[]
  /** Only the history (actions, outcomes, votes) changed. */
  outcomes: string[]
}

export type TIngestResult = {
  snapshot: TRawSnapshot
  changed: boolean
  /** Null when there was no previous snapshot (a first ingest). */
  diff: TItemDiff | null
  /** Legistar matter records fetched (the rest were reused). */
  mattersFetched: number
}

export type TIngestOptions = {
  /** Live data for histories and votes (default true). */
  fresh?: boolean
  /** Event items the caller already fetched (e.g. `consent run`'s change check). */
  eventItems?: TLegistarEventItem[]
  /** Reuse stored items whose agenda row is unchanged instead of refetching their matter. */
  reuseUnchanged?: boolean
  /** With `reuseUnchanged`: also refetch histories of reused items (once a day until final). */
  refreshHistories?: boolean
}

/** The fields an item takes from its agenda row; if these match, the row is unchanged. */
const ROW_FIELDS = ['agendaNumber', 'agendaSequence', 'consentSection', 'group', 'file', 'matterId', 'title', 'text', 'matterType', 'attachments'] as const

export function sameRow(row: TSectionRow, previous: TRawItem): boolean {
  const fromRow = toRawItem(row, null, [])
  return ROW_FIELDS.every(f => stableStringify(fromRow[f]) === stableStringify(previous[f]))
}

export function diffItems(previous: TRawItem[], next: TRawItem[]): TItemDiff {
  const before = new Map(previous.map(i => [i.file, i]))
  const after = new Map(next.map(i => [i.file, i]))
  const diff: TItemDiff = { added: [], removed: [], revised: [], outcomes: [] }
  for (const [file, item] of after) {
    const old = before.get(file)
    if (!old) {
      diff.added.push(file)
      continue
    }
    if (stableStringify(old) === stableStringify(item)) continue
    const withoutHistory = (i: TRawItem): string => stableStringify({ ...i, history: null })
    if (withoutHistory(old) === withoutHistory(item)) diff.outcomes.push(file)
    else diff.revised.push(file)
  }
  for (const file of before.keys()) if (!after.has(file)) diff.removed.push(file)
  return diff
}

async function attachVotes(history: THistoryEntry[], meetingDate: string, fresh: boolean): Promise<void> {
  // Roll calls only for actions taken off the consent vote (separate votes), from this meeting on.
  for (const action of votedActions(history, meetingDate)) {
    const votes = await getVotes(action.historyId!, { fresh }).catch(() => [])
    action.votes = votes
      .filter(v => v.VotePersonName && v.VoteValueName)
      .map(v => ({ name: v.VotePersonName!.trim(), vote: v.VoteValueName!.trim() }))
  }
}

export async function ingestMeeting(
  meetingKey: string,
  eventId: number,
  { fresh = true, eventItems: given, reuseUnchanged = false, refreshHistories = true }: TIngestOptions = {},
): Promise<TIngestResult> {
  const eventItems = given ?? await getEventItems(eventId, { fresh })
  const rows = findConsentRows(eventItems)
  if (rows.length === 0) throw new Error(`No consent section found for event ${eventId} (${meetingKey})`)

  const previous = await readRaw(meetingKey)
  const previousByMatter = new Map(previous?.items.map(i => [i.matterId, i]) ?? [])
  const meetingDate = meetingKey.slice(0, 10)
  let mattersFetched = 0

  const items = await mapConcurrent(rows, async sectionRow => {
    const matterId = sectionRow.row.EventItemMatterId!
    const old = previousByMatter.get(matterId)
    if (reuseUnchanged && old && sameRow(sectionRow, old)) {
      if (!refreshHistories) return old
      const histories = await getHistories(matterId, { fresh }).catch(() => null)
      if (!histories) return old
      const item: TRawItem = { ...old, history: normalizeHistory(histories) }
      await attachVotes(item.history, meetingDate, fresh)
      return item
    }
    mattersFetched++
    const [matter, histories] = await Promise.all([
      // Full mode keeps the old behaviour (cached matter); incremental fetches it live.
      getMatter(matterId, { fresh: reuseUnchanged && fresh }).catch(() => null),
      getHistories(matterId, { fresh }).catch(() => []),
    ])
    const item = toRawItem(sectionRow, matter, histories)
    await attachVotes(item.history, meetingDate, fresh)
    return item
  })

  // The vote on each General Consent Report as a whole lives in a minutes row (no agenda
  // sequence) like "Approval of the General Consent Report". Pupil Discipline votes are excluded.
  const voteRows = eventItems
    .filter(r => r.EventItemAgendaSequence == null && r.EventItemActionName)
    .filter(r => /general consent report/i.test(r.EventItemTitle ?? '') && !/pupil/i.test(r.EventItemTitle ?? ''))
    .sort((a, b) => (a.EventItemMinutesSequence ?? 0) - (b.EventItemMinutesSequence ?? 0))
  const consentVotes: TConsentVote[] = []
  for (const r of voteRows) {
    const votes = await getVotes(r.EventItemId, { fresh }).catch(() => [])
    const clean = (v: string | null | undefined): string | null => v?.replace(/\s+/g, ' ').trim() || null
    consentVotes.push({
      title: cleanTitle(r.EventItemTitle),
      action: r.EventItemActionName!.trim(),
      motion: clean(r.EventItemActionText),
      mover: clean(r.EventItemMover),
      seconder: clean(r.EventItemSeconder),
      passed: clean(r.EventItemPassedFlagName),
      votes: votes
        .filter(v => v.VotePersonName && v.VoteValueName)
        .map(v => ({ name: v.VotePersonName!.trim(), vote: v.VoteValueName!.trim() })),
    })
  }

  const changed = !previous
    || stableStringify(previous.items) !== stableStringify(items)
    || stableStringify(previous.consentVotes) !== stableStringify(consentVotes)
  const snapshot: TRawSnapshot = {
    schemaVersion: SCHEMA_VERSION,
    meetingKey,
    eventId,
    // Keep the old timestamp when nothing changed, so rebuilds stay byte-identical.
    fetchedAt: changed || !previous ? new Date().toISOString() : previous.fetchedAt,
    source: 'legistar',
    consentVotes,
    items,
  }
  if (changed) await writeJson(paths.raw(meetingKey), snapshot)
  return { snapshot, changed, diff: previous ? diffItems(previous.items, items) : null, mattersFetched }
}
