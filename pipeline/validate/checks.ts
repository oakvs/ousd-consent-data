/**
 * Deterministic checks, run on every enrichment, and review routing.
 */
import { JARGON_EXPANSIONS } from '@oakvs/consent-schema/labels'
import { Enrichment } from '@oakvs/consent-schema/schema'
import type { TEnrichment, TOverride, TReviewStatus, TVerifiedMoney } from '@oakvs/consent-schema/schema'

import { amountInText, amountNear, findMisprint } from './amounts'

export type TCheck = { name: string; pass: boolean; detail: string | null }

export type TNote = { kind: 'misprint' | 'math' | 'reading' | 'cosmetic'; text: string }

export type TCheckInput = {
  text: string
  enrichment: unknown
  /** Human-confirmed issue explaining why an amount can't be found verbatim (R.-248). */
  sourceIssue: string | null
  /** An independent second reading of the money, if one exists. */
  secondReading?: TVerifiedMoney | null
}

/** A yearly-limit phrase right next to a dollar figure (not "3 annual meetings"). */
const PER_YEAR_NEAR_MONEY = new RegExp(
  [
    String.raw`\$[\d,.]+[^.;$]{0,60}?(per (fiscal |contract |school )?year|annual(ly)?\b|each (fiscal |contract )?year|in a fiscal year|a year\b|\(contract year\))`,
    String.raw`(annual|yearly|per[- ]year|\(contract year\))[^.;$]{0,40}?\$[\d,.]+`,
  ].join('|'),
  'i',
)
const REVENUE_LANGUAGE = /receiv|accept|revenue|reimburs|award(ed)? to the District|grant(ed)? to the District|pay(s|ing)? the District|to the District in the amount|income/i
const HARD_FAILS = new Set(['schema', 'evidence_substring', 'amounts_in_text'])

const check = (name: string, pass: boolean, detail: string | null = null): TCheck => ({ name, pass, detail })

/** Acronyms in the headline or summary that are never spelled out in either. */
function unexpandedJargon(headline: string, summary: string): string[] {
  const both = `${headline}\n${summary}`
  return Object.entries(JARGON_EXPANSIONS).filter(([term, expansions]) => {
    if (!new RegExp(`\\b${term}s?\\b`).test(both)) return false
    const expandedInline = new RegExp(`\\(${term}s?\\b|\\b${term}s?\\s*\\(`).test(both)
    const spelledOut = expansions.some(e => both.toLowerCase().includes(e))
    return !expandedInline && !spelledOut
  }).map(([term]) => term)
}

const ORG_WORDS = /\b(inc|llc|l\.l\.c|corp|corporation|co|company|group|services?|center|centre|foundation|associates?|consult\w*|district|city|county|state|schools?|academy|institute|university|college|partners?|partnership|agency|council|association|trust|fund|alliance|network|solutions|systems|technolog\w*|health|healthcare|care|youth|community|project|program|education|learning|league|club|society|bank|church|department|office|board|commission|ltd|pc|pllc|llp|lp|of|the|and|for|dba)\b|&|\d/i

/** Heuristic: "Rachel Hart" looks like a person; "Rachel Hart Consulting" doesn't. */
export function looksLikePerson(name: string | null | undefined): boolean {
  if (!name) return false
  const words = name.replace(/[,.]/g, ' ').trim().split(/\s+/)
  if (words.length < 2 || words.length > 4) return false
  if (ORG_WORDS.test(name)) return false
  return words.every(w => /^[A-Z][a-zA-Z'\u2019-]+$/.test(w) || /^[A-Z]\.?$/.test(w))
}

export function runChecks(input: TCheckInput): { checks: TCheck[]; enrichment: TEnrichment | null; notes: TNote[] } {
  const parsed = Enrichment.safeParse(input.enrichment)
  if (!parsed.success) {
    return { checks: [check('schema', false, parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))], enrichment: null, notes: [] }
  }
  const e = parsed.data
  const { money, term } = e
  const checks: TCheck[] = [check('schema', true)]

  // evidence_substring
  if (money.thisAction != null) {
    const ok = money.evidence != null && input.text.includes(money.evidence)
    checks.push(check('evidence_substring', ok, ok ? null : `evidence not found verbatim: ${JSON.stringify(money.evidence)}`))
  }

  // amounts_in_text
  const amounts: [string, number | null][] = [
    ['thisAction', money.thisAction],
    ['priorTotal', money.priorTotal],
    ['newTotal', money.newTotal],
    ...Object.entries(money.byYear).map(([year, v]): [string, number] => [`byYear.${year}`, v]),
    ...(money.thisActionRange ? money.thisActionRange.map((v, i): [string, number] => [`thisActionRange.${i}`, v]) : []),
  ]
  const notes: TNote[] = []
  const missing: string[] = []
  for (const [field, value] of amounts) {
    if (value == null || amountInText(value, input.text)) continue
    const printed = findMisprint(value, input.text)
    if (printed) {
      notes.push({ kind: 'misprint', text: `The official text prints this amount as "${printed}"; it is read here as ${formatUsd(value)}.` })
      continue
    }
    const second = input.secondReading?.[field as keyof TVerifiedMoney]
    if (typeof second === 'number' && Math.abs(second - value) < 0.005) {
      notes.push({ kind: 'reading', text: `An amount in the official text appears misprinted; two independent readings agree on ${formatUsd(value)}.` })
      continue
    }
    missing.push(`${field}=${value}`)
  }
  const amountsOk = missing.length === 0 || input.sourceIssue != null
  checks.push(check('amounts_in_text', amountsOk, missing.length ? `not in text: ${missing.join(', ')}${input.sourceIssue ? ' (explained by source issue)' : ''}` : null))

  // amendment_math
  if (money.priorTotal != null && money.thisAction != null && money.newTotal != null) {
    const signed = money.direction === 'decrease' ? -money.thisAction : money.thisAction
    const diff = money.priorTotal + signed - money.newTotal
    checks.push(check('amendment_math', Math.abs(diff) <= 1, Math.abs(diff) <= 1 ? null : `prior ${money.priorTotal} ${signed >= 0 ? '+' : '−'} ${Math.abs(signed)} ≠ new ${money.newTotal} (off by ${diff.toFixed(2)})`))
  }

  // direction_consistency
  if (money.direction === 'no_cost') {
    checks.push(check('direction_consistency', money.thisAction == null, money.thisAction == null ? null : 'no_cost but thisAction is set'))
  } else if (money.direction === 'revenue') {
    const ok = e.actionType === 'grant_or_funding_in' || REVENUE_LANGUAGE.test(input.text)
    checks.push(check('direction_consistency', ok, ok ? null : 'revenue without a grant action type or money-in language'))
  }

  // per_year_detection
  if (money.thisAction != null && money.amountType !== 'per_year') {
    const at = money.evidence ? input.text.indexOf(money.evidence) : -1
    const window = at >= 0 ? input.text.slice(Math.max(0, at - 200), at + money.evidence!.length + 200) : input.text
    const looksPerYear = PER_YEAR_NEAR_MONEY.test(window)
    checks.push(check('per_year_detection', !looksPerYear, looksPerYear ? 'text near the amount reads as a yearly limit' : null))
  }

  // term_dates
  if (term.start || term.end) {
    const problems: string[] = []
    if (term.start && term.end && term.start > term.end) problems.push('start after end')
    if (term.end && term.end >= '2060-01-01') problems.push('end after 2060')
    checks.push(check('term_dates', problems.length === 0, problems.join('; ') || null))
  }

  // headline_amount
  if (money.thisAction != null && money.thisAction >= 10_000) {
    const ok = amountNear(money.thisAction, e.headline) || (money.thisActionRange?.some(v => amountNear(v, e.headline)) ?? false)
    checks.push(check('headline_amount', ok, ok ? null : 'headline lacks the amount'))
  }

  // jargon
  const jargon = unexpandedJargon(e.headline, e.summary)
  checks.push(check('jargon', jargon.length === 0, jargon.length ? `unexpanded: ${jargon.join(', ')}` : null))

  // person_in_headline (keep individuals' names out of headlines)
  // Known kind wins; the name-shape heuristic only nominates candidates for a second reading.
  const maybePerson = e.vendor.kind ? e.vendor.kind === 'individual' : looksLikePerson(e.vendor.name)
  if (maybePerson) {
    const named = e.headline.includes(e.vendor.name!)
    checks.push(check('person_in_headline', !named, named ? `headline names an individual (${e.vendor.name})` : null))
  }

  return { checks, enrichment: e, notes }
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: value % 1 ? 2 : 0, maximumFractionDigits: 2 })}`
}

/** Money checks whose failure can distort totals; resolved by a second reading. */
export const MONEY_SOFT_CHECKS = new Set(['per_year_detection', 'direction_consistency'])

/**
 * Zero-touch routing. Style checks never route to a person. An item is only
 * `needs_review` when there's an alert: a money disagreement between two
 * independent readings, a material money discrepancy above the threshold, or
 * a money check no second reading has resolved yet.
 */
export function routeReview(
  checks: TCheck[],
  enrichment: TEnrichment | null,
  override: TOverride | null,
  alerts: string[],
): TReviewStatus {
  if (override?.reviewedAt) return 'human_reviewed'
  if (!enrichment && checks.length === 0) return 'pending'
  if (checks.some(c => !c.pass && HARD_FAILS.has(c.name))) return 'blocked'
  if (alerts.length > 0) return 'needs_review'
  return 'auto_ok'
}
