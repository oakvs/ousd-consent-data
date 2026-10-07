import { describe, expect, it } from 'vitest'

import { CATEGORY_NOTES, CATEGORY_SLUGS, SUBCATEGORY_NOTES } from './labels'
import { Category, Enrichment, Override, SCHEMA_VERSION, SpecialEdSubcategory, Totals } from './schema'

const base = {
  headline: 'Pays Zum up to $50,000 for special education busing',
  summary: 'Zum will bus students with disabilities to their placements.',
  category: 'Special education',
  subcategory: 'Transportation',
  actionType: 'new_agreement',
  vendor: { name: 'Zum', location: null, kind: 'organization' },
  schools: [],
  money: {
    direction: 'expense',
    amountType: 'not_to_exceed',
    thisAction: 50_000,
    thisActionRange: null,
    priorTotal: null,
    newTotal: null,
    byYear: {},
    evidence: 'not to exceed $50,000.00',
  },
  term: { start: null, end: null, addedStart: null },
  flags: [],
  sourceIssueCandidate: null,
  uncertain: [],
}

describe('schema 2.0.0 codebook', () => {
  it('is version 2.0.0', () => {
    expect(SCHEMA_VERSION).toBe('2.0.0')
  })

  it('has 13 categories with the renamed and new values', () => {
    expect(Category.options).toHaveLength(13)
    expect(Category.options).toContain('Legal, compliance & risk')
    expect(Category.options).toContain('Budget, finance & payments')
    expect(Category.options).not.toContain('Legal, insurance & risk')
  })

  it('has five special education sub-categories', () => {
    expect(SpecialEdSubcategory.options).toEqual([
      'Nonpublic schools & agencies',
      'Transportation',
      'Services & contract staff',
      'Programs & support',
      'Legal, compliance & policy',
    ])
  })

  it('labels every category and sub-category', () => {
    for (const c of Category.options) {
      expect(CATEGORY_NOTES[c].includes.length).toBeGreaterThan(10)
      expect(CATEGORY_SLUGS[c]).toMatch(/^[a-z-]+$/)
    }
    for (const s of SpecialEdSubcategory.options) expect(SUBCATEGORY_NOTES[s].length).toBeGreaterThan(10)
    expect(CATEGORY_SLUGS['Legal, compliance & risk']).toBe('legal-compliance-risk')
    expect(CATEGORY_SLUGS['Budget, finance & payments']).toBe('budget-finance-payments')
  })
})

describe('sub-category refinement', () => {
  it('accepts a special education item with a sub-category', () => {
    expect(Enrichment.safeParse(base).success).toBe(true)
  })

  it('accepts another category with a null sub-category', () => {
    expect(Enrichment.safeParse({ ...base, category: 'Technology', subcategory: null }).success).toBe(true)
  })

  it('rejects a special education item without a sub-category, naming the field', () => {
    const r = Enrichment.safeParse({ ...base, subcategory: null })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues[0].path).toEqual(['subcategory'])
      expect(r.error.issues[0].message).toBe('Special education items need a sub-category')
    }
  })

  it('rejects a sub-category on any other category', () => {
    const r = Enrichment.safeParse({ ...base, category: 'Technology' })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toBe('only Special education items have a sub-category')
  })

  it('lets an override set the sub-category', () => {
    const r = Override.safeParse({ fields: { subcategory: 'Programs & support' }, reviewer: null, reviewedAt: null, note: null })
    expect(r.success).toBe(true)
  })

  it('totals carry bySubcategory', () => {
    const r = Totals.safeParse({
      items: 0, enrichedItems: 0, spendingTotal: 0, spendingItems: 0, yearlyCapsTotal: 0, yearlyCapItems: 0,
      revenueTotal: 0, revenueItems: 0, decreaseTotal: 0, paymentsRatifiedTotal: 0, paymentsRatifiedItems: 0,
      budgetAllocatedTotal: 0, budgetAllocatedItems: 0, appliedForTotal: 0, appliedForItems: 0,
      flagCounts: {}, byCategory: {}, bySubcategory: { Transportation: { items: 1, spending: 50_000 } },
    })
    expect(r.success).toBe(true)
  })
})
