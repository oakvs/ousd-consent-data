import { describe, expect, it } from 'vitest'

import { diffEnrichments, formatCategoryDiff } from '../enrich/category-diff'

import { makeEnrichment } from './helpers'

import type { TLooseEnrichmentsFile } from '../enrich/agent-io'

const rec = (output: Record<string, unknown>, promptVersion = 'enrich.v3.md'): TLooseEnrichmentsFile['items'][string] =>
  ({ modelId: 'sonnet-agent', promptVersion, cacheKey: 'k', output })

const previous = new Map<string, TLooseEnrichmentsFile>([
  ['2026-01-14', {
    meetingKey: '2026-01-14',
    items: {
      // Old codebook: a value v2 no longer has, and no subcategory field at all.
      '26-0001': rec({ ...makeEnrichment(), category: 'Legal, insurance & risk', subcategory: undefined }),
      '26-0002': rec({ ...makeEnrichment({ headline: 'Arts during the day' }), category: 'After-school & summer programs', subcategory: undefined }),
      '26-0003': rec({ ...makeEnrichment(), category: 'Special education', subcategory: undefined }),
      '26-0009': rec({ ...makeEnrichment(), subcategory: undefined }),
    },
  }],
])

const current = new Map<string, TLooseEnrichmentsFile>([
  ['2026-01-14', {
    meetingKey: '2026-01-14',
    items: {
      '26-0001': rec({ ...makeEnrichment(), category: 'Legal, compliance & risk' }, 'enrich.v5.md'),
      '26-0002': rec({ ...makeEnrichment({ headline: 'Arts during the day', money: { thisAction: 100_000 } }), category: 'Classroom & academic programs' }, 'enrich.v5.md'),
      '26-0003': rec({ ...makeEnrichment({ money: { thisAction: 50_000 } }), category: 'Special education', subcategory: 'Transportation' }, 'enrich.v5.md'),
      '26-0010': rec({ ...makeEnrichment() }, 'enrich.v5.md'),
    },
  }],
])

describe('category-diff', () => {
  const d = diffEnrichments(previous, current)

  it('compares items present on both sides and lists the rest', () => {
    expect(d.compared).toBe(3)
    expect(d.onlyPrevious).toEqual(['2026-01-14:26-0009'])
    expect(d.onlyCurrent).toEqual(['2026-01-14:26-0010'])
  })

  it('counts moves in a from→to matrix with spending', () => {
    expect(d.changed).toBe(2)
    expect(d.matrix['Legal, insurance & risk']['Legal, compliance & risk']).toEqual({ items: 1, spending: 100_000 })
    expect(d.matrix['After-school & summer programs']['Classroom & academic programs']).toEqual({ items: 1, spending: 100_000 })
    expect(d.matrix['Special education']).toBeUndefined()
  })

  it('lists movers with the new sub-category and tallies sub-categories', () => {
    expect(d.movers).toEqual([
      { id: '2026-01-14:26-0001', headline: 'Pays Acme up to $100,000 for tutoring', from: 'Legal, insurance & risk', to: 'Legal, compliance & risk', subcategory: null },
      { id: '2026-01-14:26-0002', headline: 'Arts during the day', from: 'After-school & summer programs', to: 'Classroom & academic programs', subcategory: null },
    ])
    expect(d.subcategories).toEqual({ Transportation: { items: 1, spending: 50_000 } })
  })

  it('formats a readable summary', () => {
    const text = formatCategoryDiff(d)
    expect(text).toContain('3 items compared, 2 changed category')
    expect(text).toContain('After-school & summer programs → Classroom & academic programs: 1')
    expect(text).toContain('Transportation: 1 items')
  })

  it('is deterministic', () => {
    expect(JSON.stringify(diffEnrichments(previous, current))).toBe(JSON.stringify(d))
  })
})
