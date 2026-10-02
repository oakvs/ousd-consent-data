/**
 * Zero-touch review rules.
 *
 * Material = changes the amount, vendor, school, scope or term of what's
 * being voted on. Code settles facts, independent model readings settle
 * judgment calls (majority of three when two disagree), and a person is only
 * alerted when a money discrepancy is large (over $10,000 AND over 1% of the
 * item) or the official text leaves the money genuinely unclear, and no
 * person has looked at it yet.
 */
import type { TEnrichment, TMoney, TVerificationRecord, TVerifiedMoney } from '@oakvs/consent-schema/schema'

import { MONEY_SOFT_CHECKS } from './checks'

import type { TCheck, TNote } from './checks'

export const ALERT_MIN_DOLLARS = 10_000
export const ALERT_MIN_SHARE = 0.01

const usd = (v: number | null | undefined): string =>
  v == null ? 'none' : `$${v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })}`

/** True when a discrepancy is big enough to matter: over $10K and over 1% of the item. */
export function isMaterialDiscrepancy(diff: number, base: number): boolean {
  return Math.abs(diff) > ALERT_MIN_DOLLARS && Math.abs(diff) > ALERT_MIN_SHARE * Math.abs(base)
}

const bucket = (t: TMoney['amountType']): string => (t === 'per_year' || t === 'sales_cap' ? t : 'total')

type TMoneyField = 'direction' | 'bucket' | 'thisAction' | 'priorTotal' | 'newTotal'

/** Fields that change the meeting's totals (vs. display-only fields). */
const TOTALS_FIELDS = new Set<TMoneyField>(['direction', 'bucket', 'thisAction'])

function same(field: TMoneyField, a: TVerifiedMoney, b: TVerifiedMoney): boolean {
  if (field === 'direction') return a.direction === b.direction
  if (field === 'bucket') return bucket(a.amountType) === bucket(b.amountType)
  const x = a[field]
  const y = b[field]
  return x == null || y == null ? x == null && y == null : Math.abs(x - y) <= 1
}

const describe = (field: TMoneyField, m: TVerifiedMoney): string =>
  field === 'direction' ? m.direction : field === 'bucket' ? (m.amountType ?? 'none') : usd(m[field])

const label: Record<TMoneyField, string> = {
  direction: 'direction',
  bucket: 'amount type',
  thisAction: 'amount of this vote',
  priorTotal: 'previous total',
  newTotal: 'new total',
}

/** Fields where two independent money readings disagree (amounts within $1 agree). */
export function compareMoney(primary: TVerifiedMoney, second: TVerifiedMoney): string[] {
  return (['direction', 'bucket', 'thisAction', 'priorTotal', 'newTotal'] as TMoneyField[])
    .filter(f => !same(f, primary, second))
    .map(f => `${label[f]} (${describe(f, primary)} vs ${describe(f, second)})`)
}

/** Disagreements on fields that change totals, ignoring immaterial amount differences. */
export function totalsDisagreements(primary: TVerifiedMoney, second: TVerifiedMoney): TMoneyField[] {
  const size = Math.max(primary.thisAction ?? 0, second.thisAction ?? 0)
  return [...TOTALS_FIELDS].filter(f => {
    if (same(f, primary, second)) return false
    if (f === 'thisAction' && primary.thisAction != null && second.thisAction != null) {
      return isMaterialDiscrepancy(primary.thisAction - second.thisAction, size)
    }
    return size >= ALERT_MIN_DOLLARS
  })
}

export type TAssessment = {
  alerts: string[]
  notes: TNote[]
  sourceIssue: string | null
  sourceIssueBy: 'computed' | 'verifier' | null
  /** Money fields corrected by a majority of three independent readings. */
  corrected: Partial<TVerifiedMoney>
}

export type TAssessOptions = {
  /** A person has already looked at this item's money (override with a source issue or money fields). */
  humanTouched?: boolean
}

/** Decide alerts, public source issues, notes and majority corrections for one item (before human overrides). */
export function assess(
  enrichment: TEnrichment,
  checks: TCheck[],
  verification: TVerificationRecord | null,
  { humanTouched = false }: TAssessOptions = {},
): TAssessment {
  const alerts: string[] = []
  const notes: TNote[] = []
  const corrected: Partial<TVerifiedMoney> = {}
  let sourceIssue: string | null = null
  let sourceIssueBy: TAssessment['sourceIssueBy'] = null
  const { money } = enrichment
  const second = verification?.money ?? null
  const third = verification?.tiebreakMoney ?? null

  // 1. Independent readings. Display-only disagreements become a note;
  //    disagreements that change totals go to a third reading (majority wins).
  if (second) {
    const display = (['priorTotal', 'newTotal'] as TMoneyField[]).filter(f => !same(f, money, second))
    if (display.length) {
      notes.push({
        kind: 'reading',
        text: `A second reading of the official text found ${display.map(f => `a ${label[f]} of ${describe(f, second)}`).join(' and ')}.`,
      })
    }
    const disputed = totalsDisagreements(money, second)
    if (disputed.length && !third) {
      alerts.push(`Awaiting a third reading: two readings disagree on ${disputed.map(f => `${label[f]} (${describe(f, money)} vs ${describe(f, second)})`).join('; ')}.`)
    } else if (disputed.length && third) {
      for (const f of disputed) {
        if (same(f, money, third)) continue // primary has the majority
        if (same(f, second, third)) {
          if (f === 'direction') corrected.direction = second.direction
          else if (f === 'bucket') corrected.amountType = second.amountType
          else corrected[f] = second[f] as never
          notes.push({ kind: 'reading', text: `The ${label[f]} was corrected to ${describe(f, second)} by two of three independent readings.` })
        } else {
          alerts.push(`Three independent readings disagree on the ${label[f]}.`)
        }
      }
    }
  }

  // 2. Money checks that can distort totals need a second reading to clear.
  for (const c of checks.filter(x => !x.pass && MONEY_SOFT_CHECKS.has(x.name))) {
    if (!second) alerts.push(`Awaiting a second reading: ${c.name} (${c.detail}).`)
  }

  // 3. Arithmetic in the official text, computed in code: from the primary
  //    reading, filling gaps from the second. Code is the authority here.
  const pick = (f: 'thisAction' | 'priorTotal' | 'newTotal'): number | null => money[f] ?? second?.[f] ?? null
  const [added, prior, next] = [pick('thisAction'), pick('priorTotal'), pick('newTotal')]
  const direction = money.direction
  const arithmeticKnown = added != null && prior != null && next != null && direction !== 'no_cost'
  let arithmeticFails = false
  if (arithmeticKnown) {
    const signed = direction === 'decrease' ? -added : added
    const expected = prior + signed
    const diff = expected - next
    if (Math.abs(diff) > 0.005) {
      arithmeticFails = true
      const sentence = `The official text's numbers don't add up: ${usd(prior)} ${signed < 0 ? 'minus' : 'plus'} ${usd(Math.abs(signed))} `
        + `is ${usd(expected)}, but it states a new total of ${usd(next)}.`
      if (isMaterialDiscrepancy(diff, Math.max(next, prior, added))) {
        sourceIssue = sentence
        sourceIssueBy = 'computed'
        if (!humanTouched) alerts.push(`Arithmetic in the official text is off by ${usd(Math.abs(diff))}.`)
      } else {
        notes.push({ kind: 'math', text: `${sentence} The difference (${usd(Math.abs(diff))}) is small.` })
      }
    }
  }

  // 4. A second reading's verdict on an AI-suggested problem in the official text.
  //    Arithmetic the code could compute is settled above; don't double count it.
  const issue = verification?.issue
  const settledByCode = issue?.topic === 'money' && arithmeticFails
  if (issue?.verdict === 'material' && !settledByCode) {
    sourceIssue ??= issue.explanation
    sourceIssueBy ??= 'verifier'
    const big = Math.max(money.thisAction ?? 0, money.newTotal ?? 0, second?.thisAction ?? 0) >= ALERT_MIN_DOLLARS
    if (issue.topic === 'money' && big && !humanTouched) alerts.push(`Money in the official text is unclear: ${issue.explanation}`)
  } else if (issue?.verdict === 'cosmetic') {
    notes.push({ kind: 'cosmetic', text: issue.explanation })
  }

  return { alerts, notes, sourceIssue, sourceIssueBy, corrected }
}
