import { describe, expect, it } from 'vitest'

import { computeTotals } from '../build/totals'

import { makeEnrichment, makePublishedItem } from './helpers'

const item = makePublishedItem

describe('totals', () => {
  it('keeps yearly caps, sales caps, revenue and decreases out of spending', () => {
    const totals = computeTotals([
      item('26-0001'),
      item('26-0002', { enrichment: makeEnrichment({ money: { amountType: 'per_year', thisAction: 17_608_594 } }) }),
      item('26-0003', { enrichment: makeEnrichment({ money: { direction: 'no_cost', amountType: 'sales_cap', thisAction: null } }) }),
      item('26-0004', { enrichment: makeEnrichment({ actionType: 'grant_or_funding_in', money: { direction: 'revenue', thisAction: 600_000 } }) }),
      item('26-0005', { enrichment: makeEnrichment({ money: { direction: 'decrease', thisAction: 164_385 } }) }),
      item('26-0006', { enrichment: null }),
    ])
    expect(totals).toMatchObject({
      items: 6,
      enrichedItems: 5,
      spendingTotal: 100_000,
      spendingItems: 1,
      yearlyCapsTotal: 17_608_594,
      yearlyCapItems: 1,
      revenueTotal: 600_000,
      decreaseTotal: 164_385,
    })
  })

  it('tallies special education sub-categories with the same counting rules as categories', () => {
    const sped = (subcategory: 'Transportation' | 'Services & contract staff', thisAction: number): ReturnType<typeof makeEnrichment> =>
      makeEnrichment({ category: 'Special education', subcategory, money: { thisAction } })
    const totals = computeTotals([
      item('26-0001', { enrichment: sped('Transportation', 50_000) }),
      item('26-0002', { enrichment: sped('Transportation', 25_000) }),
      item('26-0003', { enrichment: sped('Services & contract staff', 10_000) }),
      // Flagged budget allocation: counted as a budget item, never as sub-category spending.
      item('26-0004', { enrichment: sped('Services & contract staff', 999_999), flags: ['budget_allocation'] }),
      // Not counted at all (e.g. a duplicate listing).
      item('26-0005', { enrichment: sped('Transportation', 999_999), countsTowardTotals: false }),
      item('26-0006'),
    ])
    expect(totals.bySubcategory).toEqual({
      Transportation: { items: 2, spending: 75_000 },
      'Services & contract staff': { items: 1, spending: 10_000 },
    })
    expect(totals.byCategory['Special education']).toEqual({ items: 3, spending: 85_000 })
  })
})
