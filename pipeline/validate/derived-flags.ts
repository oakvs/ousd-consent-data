/**
 * Derived flags (§7.3). Computed in code, never by the LLM.
 */
import type { TDerivedFlag, TEnrichment, THistoryEntry } from '@oakvs/consent-schema/schema'

export type TDerivedFlagInput = {
  meetingDate: string
  title?: string
  text: string
  history: THistoryEntry[]
  enrichment: TEnrichment | null
  sourceIssue: string | null
}

const DELAY = /postpon|fail|continued/i

/** "Accounts Payable Warrants - Fiscal Year …", "Payroll Warrants and Direct Deposits - …". */
export const PAYMENT_RATIFICATION = /^\s*(accounts\s+payable|payroll)\s+warrants?\b/i

/**
 * OUSD's labels for applying for money: "Grant Application - …", "Grant Proposal - …",
 * "Consolidated Application …" (CARS), "Continued Funding Application …", "E-Rate … Application".
 * One title starts "23-127123Grant Application", so "grant" needn't start the title.
 */
/**
 * The district dividing up its own funds: "Measure N Commission - … Plans and Budgets",
 * "… Carryover …", "Measure G1 - Allocations …", "Education Protection Act …", "… Expenditure Plan".
 */
export const BUDGET_ALLOCATION = /^\s*measure\s+(n|g1|h|g)\b.*\b(plans?|budgets?|allocations?|carryover|funding\s+levels?|probationary|education\s+plan)\b|education\s+protection\s+(act|account)|\b(spending|expenditure)\s+plan\b|block\s+grant.*\bplan\b/i

export const GRANT_APPLICATION = /(^|[^a-z])grant\s+(application|proposal)\b|^\s*consolidated\s+application\b|continued\s+(and\s+expansion\s+)?funding\s+application\b|e-?rate\b[^,]*\bapplication\b/i
const MULTI_YEAR_DAYS = 400 // a little over 13 months

function daysBetween(start: string, end: string): number {
  return (Date.parse(end) - Date.parse(start)) / 86_400_000
}

const CHANGES_EXISTING = new Set(['amendment', 'change_order'])

/**
 * `term.start < meeting date`, or "Ratif…" with no start stated. For
 * amendments and change orders, `term.start` is the ORIGINAL agreement's
 * start, so only the added period (`term.addedStart`) counts.
 */
export function afterWorkBegan(input: TDerivedFlagInput): boolean {
  const e = input.enrichment
  const start = e?.term.addedStart ?? (e && CHANGES_EXISTING.has(e.actionType) ? null : e?.term.start) ?? null
  if (start) return start < input.meetingDate
  return /ratif/i.test(input.text)
}

export function previouslyDelayed(history: THistoryEntry[], meetingDate: string): boolean {
  return history.some(entry => entry.date < meetingDate && DELAY.test(entry.action))
}

export function deriveFlags(input: TDerivedFlagInput): TDerivedFlag[] {
  const flags: TDerivedFlag[] = []
  const { enrichment } = input

  if (previouslyDelayed(input.history, input.meetingDate)) flags.push('previously_delayed')
  if (input.sourceIssue) flags.push('source_issue')
  if (input.title && PAYMENT_RATIFICATION.test(input.title)) flags.push('payment_ratification')
  if (input.title && BUDGET_ALLOCATION.test(input.title)) flags.push('budget_allocation')
  // An E-Rate "application" can also be the purchase itself; only money not going out is an application.
  if (input.title && GRANT_APPLICATION.test(input.title) && enrichment?.money.direction !== 'expense') flags.push('grant_application')
  if (!enrichment) return flags

  const { money, term } = enrichment
  if (afterWorkBegan(input)) flags.push('after_work_began')

  const raises =
    money.direction === 'expense'
    && money.priorTotal != null
    && money.newTotal != null
    && money.newTotal > money.priorTotal
  if (raises) {
    flags.push('raises_existing_contract')
    if (money.thisAction != null && money.priorTotal! > 0 && money.thisAction / money.priorTotal! >= 0.5) {
      flags.push('large_increase')
    }
  }

  if (money.amountType === 'per_year') {
    flags.push('yearly_cap')
    const spansYears = term.start && term.end && daysBetween(term.start, term.end) > MULTI_YEAR_DAYS
    if (spansYears && money.newTotal == null && money.priorTotal == null) flags.push('no_total_stated')
  }

  return flags
}
