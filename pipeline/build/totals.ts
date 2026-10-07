/**
 * Meeting totals (§7.4). Spending excludes per-year caps and sales caps.
 *
 * Every listed item counts toward `items`, `enrichedItems` and `flagCounts`. Money and
 * categories count only items with `countsTowardTotals` (see buildMeeting).
 */
import { spendingAmount } from '@oakvs/consent-schema/format'
import type { TPublishedItem, TTotals } from '@oakvs/consent-schema/schema'

export function computeTotals(items: TPublishedItem[]): TTotals {
  const totals: TTotals = {
    items: items.length,
    enrichedItems: 0,
    spendingTotal: 0,
    spendingItems: 0,
    yearlyCapsTotal: 0,
    yearlyCapItems: 0,
    revenueTotal: 0,
    revenueItems: 0,
    decreaseTotal: 0,
    paymentsRatifiedTotal: 0,
    paymentsRatifiedItems: 0,
    appliedForTotal: 0,
    appliedForItems: 0,
    budgetAllocatedTotal: 0,
    budgetAllocatedItems: 0,
    flagCounts: {},
    byCategory: {},
    bySubcategory: {},
  }

  for (const item of items) {
    for (const flag of item.flags) totals.flagCounts[flag] = (totals.flagCounts[flag] ?? 0) + 1
    const e = item.enrichment
    if (!e) continue
    totals.enrichedItems++
    if (!item.countsTowardTotals) continue
    if (item.flags.includes('budget_allocation')) {
      if (e.money.thisAction && e.money.direction === 'expense') {
        totals.budgetAllocatedTotal += e.money.thisAction
        totals.budgetAllocatedItems++
      }
      continue
    }
    if (item.flags.includes('grant_application')) {
      if (e.money.thisAction) {
        totals.appliedForTotal += e.money.thisAction
        totals.appliedForItems++
      }
      continue
    }
    if (item.flags.includes('payment_ratification')) {
      if (e.money.thisAction) {
        totals.paymentsRatifiedTotal += e.money.thisAction
        totals.paymentsRatifiedItems++
      }
      continue
    }
    const { money } = e

    const spend = spendingAmount(money)
    if (spend > 0) {
      totals.spendingTotal += spend
      totals.spendingItems++
    }
    if (money.direction === 'expense' && money.amountType === 'per_year' && money.thisAction) {
      totals.yearlyCapsTotal += money.thisAction
      totals.yearlyCapItems++
    }
    if (money.direction === 'revenue' && money.thisAction) {
      totals.revenueTotal += money.thisAction
      totals.revenueItems++
    }
    if (money.direction === 'decrease' && money.thisAction) totals.decreaseTotal += money.thisAction

    const bucket = (totals.byCategory[e.category] ??= { items: 0, spending: 0 })
    bucket.items++
    bucket.spending += spend
    if (e.subcategory) {
      const sub = (totals.bySubcategory[e.subcategory] ??= { items: 0, spending: 0 })
      sub.items++
      sub.spending += spend
    }
  }

  // Round away float noise from summing cents; display rounding still happens in the UI.
  const cents = (v: number): number => Math.round(v * 100) / 100
  totals.spendingTotal = cents(totals.spendingTotal)
  totals.yearlyCapsTotal = cents(totals.yearlyCapsTotal)
  totals.revenueTotal = cents(totals.revenueTotal)
  totals.decreaseTotal = cents(totals.decreaseTotal)
  totals.paymentsRatifiedTotal = cents(totals.paymentsRatifiedTotal)
  totals.appliedForTotal = cents(totals.appliedForTotal)
  totals.budgetAllocatedTotal = cents(totals.budgetAllocatedTotal)
  for (const bucket of Object.values(totals.byCategory)) bucket.spending = cents(bucket.spending)
  for (const bucket of Object.values(totals.bySubcategory)) bucket.spending = cents(bucket.spending)
  return totals
}
