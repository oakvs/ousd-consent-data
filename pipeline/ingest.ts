/**
 * WF-2 Ingest: event items → consent rows → matters + histories → raw snapshot.
 */
import { SCHEMA_VERSION } from '@oakvs/consent-schema/schema'
import type { TConsentVote, TRawSnapshot } from '@oakvs/consent-schema/schema'

import { getEventItems, getHistories, getMatter, getVotes, mapConcurrent } from './legistar/client'
import { toRawItem } from './normalize/raw-item'
import { cleanTitle, findConsentRows } from './normalize/sections'
import { readRaw, stableStringify, writeJson, paths } from './store'
import { votedActions } from './validate/separate-vote'

export type TIngestResult = { snapshot: TRawSnapshot; changed: boolean }

export async function ingestMeeting(
  meetingKey: string,
  eventId: number,
  { fresh = true }: { fresh?: boolean } = {},
): Promise<TIngestResult> {
  const eventItems = await getEventItems(eventId, { fresh })
  const rows = findConsentRows(eventItems)
  if (rows.length === 0) throw new Error(`No consent section found for event ${eventId} (${meetingKey})`)

  const items = await mapConcurrent(rows, async sectionRow => {
    const matterId = sectionRow.row.EventItemMatterId!
    const [matter, histories] = await Promise.all([
      getMatter(matterId).catch(() => null),
      getHistories(matterId, { fresh }).catch(() => []),
    ])
    const item = toRawItem(sectionRow, matter, histories)
    // Roll calls only for actions taken off the consent vote (separate votes), from this meeting on.
    for (const action of votedActions(item.history, meetingKey.slice(0, 10))) {
      const votes = await getVotes(action.historyId!, { fresh }).catch(() => [])
      action.votes = votes
        .filter(v => v.VotePersonName && v.VoteValueName)
        .map(v => ({ name: v.VotePersonName!.trim(), vote: v.VoteValueName!.trim() }))
    }
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

  const previous = await readRaw(meetingKey)
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
  return { snapshot, changed }
}
