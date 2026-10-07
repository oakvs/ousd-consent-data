import type { TConsentVote, TEnrichment, TMeetingKind, TMoney, TVoteSummary } from './schema'

/** The money fields present in both the full and the light list files. */
export type TMoneySummary = Omit<TMoney, 'byYear' | 'evidence'>

export type TMoneyCellInput = Pick<TEnrichment, 'actionType'> & { money: TMoneySummary }

/** Compact display: $1.02M, $248K, $950. Rounding happens here only; data keeps full precision. */
export function formatMoney(value: number | null | undefined): string {
  if (value == null) return ''
  const abs = Math.abs(value)
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(abs >= 1e7 ? 1 : 2).replace(/\.0+$/, '')}M`
  if (abs >= 1e3) return `$${Math.round(value / 1e3).toLocaleString('en-US')}K`
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

/** Full precision display: $1,019,870.42 */
export function formatMoneyFull(value: number | null | undefined): string {
  if (value == null) return ''
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: value % 1 ? 2 : 0,
    maximumFractionDigits: 2,
  })}`
}

/**
 * `2026-06-24` → `Jun 24, 2026` (short), `June 24, 2026` (long) or
 * `Wednesday, June 24, 2026` (full), without timezone drift.
 */
export function formatDate(iso: string | null | undefined, style: 'short' | 'long' | 'full' = 'short'): string {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    ...(style === 'full' && { weekday: 'long' }),
    month: style === 'short' ? 'short' : 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/** `2026-06-24` → `Wednesday`, without timezone drift. */
export function formatWeekday(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
}

/** `2026-06-24` → `2025-26`; school years run July–June. */
export function schoolYearOf(iso: string): string {
  const [y, m] = iso.split('-').map(Number)
  const start = m >= 7 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

export type TMoneyTone = 'expense' | 'revenue' | 'decrease' | 'none'

export type TMoneyCell = {
  primary: string
  secondary: string | null
  tone: TMoneyTone
}

/** The amount this item adds to the meeting's spending total (0 if excluded). */
export function spendingAmount(money: TMoneySummary | null | undefined): number {
  if (!money || money.direction !== 'expense' || !money.thisAction) return 0
  if (money.amountType === 'per_year' || money.amountType === 'sales_cap') return 0
  return money.thisAction
}

/** Sort key for "largest first": per-year caps rank by their yearly figure. */
export function sortAmount(money: TMoneySummary | null | undefined): number {
  return money?.thisAction ?? -1
}

/**
 * The money column, in the six variants worked out in the prototype.
 */
export function moneyCell(
  enrichment: TMoneyCellInput | null,
  amountVerified: boolean,
): TMoneyCell {
  if (!enrichment) return { primary: 'Pending', secondary: 'summary not written yet', tone: 'none' }
  const { money, actionType } = enrichment

  if (money.amountType === 'sales_cap') return { primary: 'Sales cap', secondary: 'not a cost', tone: 'none' }

  if (money.direction === 'expense' && money.amountType === 'per_year' && money.thisAction) {
    const range = money.thisActionRange
    return {
      primary: range
        ? `${formatMoney(range[0])}–${formatMoney(range[1])}/yr`
        : `${formatMoney(money.thisAction)}/yr`,
      secondary: 'yearly cap',
      tone: 'expense',
    }
  }

  if (money.direction === 'expense' && money.thisAction) {
    const isChange = actionType === 'amendment' || actionType === 'change_order' || money.priorTotal != null
    let secondary: string | null = null
    if (money.newTotal != null) secondary = `new total ${formatMoney(money.newTotal)}`
    else if (money.amountType === 'not_to_exceed') secondary = 'not to exceed'
    else if (money.amountType === 'cumulative') secondary = 'cumulative'
    if (!amountVerified) secondary = 'amount unverified'
    return { primary: `${isChange ? '+' : ''}${formatMoney(money.thisAction)}`, secondary, tone: 'expense' }
  }

  if (money.direction === 'revenue') {
    return money.thisAction
      ? { primary: `+${formatMoney(money.thisAction)}`, secondary: 'coming in', tone: 'revenue' }
      : { primary: 'Funding in', secondary: 'amount not stated', tone: 'none' }
  }

  if (money.direction === 'decrease') {
    return {
      primary: `−${formatMoney(money.thisAction)}`,
      secondary: money.newTotal != null ? `new total ${formatMoney(money.newTotal)}` : 'contract cut',
      tone: 'decrease',
    }
  }

  if (money.direction === 'expense') return { primary: 'Cost not stated', secondary: null, tone: 'none' }
  return { primary: 'No cost stated', secondary: null, tone: 'none' }
}

/**
 * Outcome of a consent-report vote. Legistar's pass/fail field is not always
 * right (June 15, 2026 says "Pass" for a motion that "Failed by the following
 * vote"), so the motion's own words decide when they say.
 */
export function voteOutcome(vote: Pick<TConsentVote, 'motion' | 'passed'>): 'carried' | 'failed' | null {
  if (/motion failed/i.test(vote.motion ?? '')) return 'failed'
  if (/motion carried/i.test(vote.motion ?? '')) return 'carried'
  if (vote.passed === 'Fail') return 'failed'
  if (vote.passed === 'Pass') return 'carried'
  return null
}

/** Roll-call counts by vote value ("Aye", "Nay", "Abstained", …). */
export function voteCounts(vote: Pick<TConsentVote, 'votes'>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const v of vote.votes) counts[v.vote] = (counts[v.vote] ?? 0) + 1
  return counts
}

/** Which consent report a vote was on, in a word or two: "General", "Bonds", "Report 2". */
export function consentVoteLabel(title: string): string {
  if (/general obligation bonds/i.test(title)) return 'Bonds'
  const number = /No\.\s*(\d+)/i.exec(title)
  return number ? `Report ${number[1]}` : 'General'
}

/** Reduce consent-report votes to badge-sized summaries (outcome + ayes–nays). */
export function summarizeConsentVotes(votes: TConsentVote[]): TVoteSummary[] {
  return votes.map(v => {
    const outcome = voteOutcome(v)
    const counts = voteCounts(v)
    const hasRollCall = v.votes.length > 0
    return {
      title: v.title,
      outcome: outcome ?? 'other',
      status: outcome === 'failed' ? 'Failed' : outcome === 'carried' ? 'Passed' : v.action,
      ayes: hasRollCall ? counts.Aye ?? 0 : null,
      nays: hasRollCall ? counts.Nay ?? 0 : null,
    }
  })
}

/** A date as YYYY-MM-DD in Oakland's time zone (default: today). */
export function oaklandToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/**
 * The meeting type a date implies on the Board's cadence: regular meetings fall
 * on the 2nd and 4th Wednesdays of the month; any other day is a special
 * meeting. Only for meetings whose published agenda (which says for sure) isn't
 * out yet. The rare rescheduled regular meeting (e.g. June 3, 2026) would read
 * as special.
 */
export function expectedMeetingKind(iso: string): Extract<TMeetingKind, 'regular' | 'special'> {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  const isWednesday = new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 3
  const nth = Math.floor((d - 1) / 7) + 1
  return isWednesday && (nth === 2 || nth === 4) ? 'regular' : 'special'
}

const OAKLAND_TZ = 'America/Los_Angeles'

/** The UTC instant of a wall-clock time in Oakland (handles PST/PDT). */
export function oaklandInstant(dateIso: string, hhmm: string): Date {
  const [y, m, d] = dateIso.slice(0, 10).split('-').map(Number)
  const [hh, mm] = hhmm.split(':').map(Number)
  const guess = Date.UTC(y, m - 1, d, hh, mm)
  // Oakland's UTC offset at that moment, e.g. "GMT-7".
  const name = new Intl.DateTimeFormat('en-US', { timeZone: OAKLAND_TZ, timeZoneName: 'shortOffset' })
    .formatToParts(new Date(guess)).find(p => p.type === 'timeZoneName')?.value ?? 'GMT-8'
  const offsetHours = Number(/GMT([+-]\d+)/.exec(name)?.[1] ?? -8)
  return new Date(guess - offsetHours * 3_600_000)
}

/** Usual start of a Board meeting (local time). */
export const BOARD_START_TIME = '16:00'

/**
 * Brown Act posting deadline for a meeting's agenda: at least 72 hours before a
 * regular meeting (Gov. Code §54954.2), 24 hours before a special one (Gov. Code §54956).
 */
export function agendaDeadline(dateIso: string, kind: 'regular' | 'special', start = BOARD_START_TIME): Date {
  const hours = kind === 'regular' ? 72 : 24
  return new Date(oaklandInstant(dateIso, start).getTime() - hours * 3_600_000)
}

/** `Sun, Oct 11, 4 p.m.` (or `4:30 p.m.`) in Oakland time, AP style. */
export function formatOaklandDateTime(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: OAKLAND_TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).formatToParts(instant)
  const get = (type: string): string => parts.find(p => p.type === type)?.value ?? ''
  const period = get('dayPeriod').toLowerCase() === 'pm' ? 'p.m.' : 'a.m.'
  const minutes = get('minute') === '00' ? '' : `:${get('minute')}`
  return `${get('weekday')}, ${get('month')} ${get('day')}, ${get('hour')}${minutes} ${period}`
}
