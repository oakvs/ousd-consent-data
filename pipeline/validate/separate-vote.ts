/**
 * Items taken off the single consent-report vote.
 *
 * Legistar marks each history action with MatterHistoryConsent (1 = part of
 * the consent vote). An item on a meeting's consent report was "pulled" when
 * its Board action at that meeting was NOT a consent action: it was voted on
 * separately, failed, was withdrawn, referred, postponed, or not taken up and
 * decided later (June 24 → June 29, 2026).
 */
import type { THistoryEntry, TRollCallVote } from '@oakvs/consent-schema/schema'

const BOARD = /board of education/i
const isBoard = (h: THistoryEntry): boolean => !h.body || BOARD.test(h.body)
/**
 * Part of the consent vote. Legistar's MatterHistoryConsent flag is not always
 * consistent (22 "Adopted on the General Consent Report" actions are flagged 0),
 * so an action named as a consent action counts too.
 */
const isConsent = (h: THistoryEntry): boolean => h.consent === true || /consent/i.test(h.action)

export type TPulled = {
  /** Board actions from this meeting on, oldest first (the last is the outcome). */
  actions: THistoryEntry[]
  /** One plain sentence for the public. */
  summary: string
}

/** The item's Board actions at this meeting (by event id, else by date). */
function actionsAtMeeting(history: THistoryEntry[], meetingDate: string, eventId: number | null): THistoryEntry[] {
  const board = history.filter(isBoard)
  const byEvent = eventId != null ? board.filter(h => h.eventId === eventId) : []
  return byEvent.length ? byEvent : board.filter(h => h.date === meetingDate)
}

export function isPulledFromConsent(history: THistoryEntry[], meetingDate: string, eventId: number | null): boolean {
  const at = actionsAtMeeting(history, meetingDate, eventId)
  return at.length > 0 && !at.some(isConsent)
}

/** Actions that deserve a roll call: non-consent Board motions from this meeting on. */
export function votedActions(history: THistoryEntry[], meetingDate: string): THistoryEntry[] {
  return history.filter(h => isBoard(h) && h.date >= meetingDate && !isConsent(h) && h.historyId != null && (h.mover || h.passed))
}

export function tallyVotes(votes: TRollCallVote[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const v of votes) out[v.vote] = (out[v.vote] ?? 0) + 1
  return out
}

function describeTally(votes: TRollCallVote[] | null): string {
  if (!votes?.length) return ''
  const t = tallyVotes(votes)
  const parts = [`${t.Aye ?? 0}–${t.Nay ?? 0}`]
  if (t.Abstained) parts.push(`${t.Abstained} abstaining`)
  if (t.Recused) parts.push(`${t.Recused} recused`)
  return ` (${parts.join(', ')})`
}

const formatDay = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
}

export function describePulled(history: THistoryEntry[], meetingDate: string, eventId: number | null): TPulled | null {
  if (!isPulledFromConsent(history, meetingDate, eventId)) return null
  const actions = history.filter(h => isBoard(h) && h.date >= meetingDate)
  const outcome = actions.at(-1)!
  const sameDay = outcome.date === meetingDate
  const when = sameDay ? 'at this meeting' : `on ${formatDay(outcome.date)}`
  const action = outcome.action.toLowerCase()
  let summary: string
  if (isConsent(outcome)) {
    summary = `Taken off the consent vote, then approved on a later consent report ${when}.`
  } else if (/withdrawn/.test(action)) {
    summary = `Taken off the consent report and withdrawn ${when}.`
  } else if (/refer/.test(action)) {
    summary = `Taken off the consent report and referred ${when}.`
  } else if (/not discussed|not taken up/.test(action)) {
    summary = 'Taken off the consent vote and not taken up; no decision recorded yet.'
  } else if (/postpon|continued|tabled/.test(action)) {
    summary = `Taken off the consent vote and ${action} ${when}.`
  } else {
    const verb = outcome.action.charAt(0).toUpperCase() + outcome.action.slice(1).toLowerCase()
    summary = `${verb} in its own vote ${when}${describeTally(outcome.votes)}, instead of with the rest of the consent report.`
  }
  return { actions, summary }
}

/** Share of a report's items one action must cover to count as a decision on the whole report. */
export const WHOLE_REPORT_SHARE = 0.8

/**
 * When one action covers (nearly) the whole consent report, e.g. the entire
 * June 10, 2026 report "Postponed to a Date Certain" or the June 15 report
 * failing, that's a decision on the report, not individual items pulled.
 * Returns that action's name, or null.
 */
export function wholeReportAction(itemsHistories: THistoryEntry[][], meetingDate: string, eventId: number | null): string | null {
  if (itemsHistories.length === 0) return null
  const counts = new Map<string, number>()
  for (const history of itemsHistories) {
    const at = actionsAtMeeting(history, meetingDate, eventId)
    const main = at.find(h => !isConsent(h)) ?? at.find(isConsent)
    if (main) counts.set(main.action, (counts.get(main.action) ?? 0) + 1)
  }
  for (const [action, n] of counts) {
    if (n / itemsHistories.length >= WHOLE_REPORT_SHARE && !/on the general consent report/i.test(action)) return action
  }
  return null
}
