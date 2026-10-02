import { describe, expect, it } from 'vitest'

import type { TEnrichment } from '@oakvs/consent-schema/schema'

import { amountInText, amountNear, extractAmounts } from '../validate/amounts'
import { routeReview, runChecks } from '../validate/checks'
import { afterWorkBegan, deriveFlags } from '../validate/derived-flags'

import { h, makeEnrichment } from './helpers'

const TEXT = 'Approval of an agreement with Acme, in an amount not to exceed $100,000.00, for tutoring.'

const failing = (text: string, e: TEnrichment, extra: { sourceIssue?: string | null } = {}): string[] =>
  runChecks({ text, enrichment: e, sourceIssue: extra.sourceIssue ?? null })
    .checks.filter(c => !c.pass).map(c => c.name)

describe('amount matcher', () => {
  it('finds common formats', () => {
    expect(amountInText(1_019_870.42, 'not to exceed $1,019,870.42')).toBe(true)
    expect(amountInText(248_062, 'the amount of $248,062.00')).toBe(true)
    expect(amountInText(1234.56, 'costs 1234.56 dollars')).toBe(true)
    expect(amountInText(1_200_000, 'about $1.2 million')).toBe(true)
    expect(amountInText(1_250_000, 'about $1.2 million')).toBe(false)
  })

  it('does not treat dates or counts as amounts', () => {
    expect(extractAmounts('from July 1, 2026 through 2028 for 12 schools').map(a => a.value)).toEqual([])
  })

  it('rejects the R.-248 misprint as a match for the intended figure', () => {
    expect(amountInText(8_639_911, 'in the not to exceed amount of $8,639.911.00')).toBe(false)
  })

  it('matches headline amounts within 1%', () => {
    expect(amountNear(1_019_870.42, 'Adds $1.02M to keep Frontline')).toBe(true)
    expect(amountNear(1_019_870.42, 'Adds $1.1M to keep Frontline')).toBe(false)
  })
})

describe('deterministic checks', () => {
  it('passes a clean item', () => {
    expect(failing(TEXT, makeEnrichment())).toEqual([])
    expect(routeReview(runChecks({ text: TEXT, enrichment: makeEnrichment(), sourceIssue: null }).checks, makeEnrichment(), null, [])).toBe('auto_ok')
  })

  it('blocks when evidence is not verbatim', () => {
    const e = makeEnrichment({ money: { evidence: 'not to exceed $100,000' + ' (paraphrased)' } })
    expect(failing(TEXT, e)).toContain('evidence_substring')
  })

  it('blocks amounts not in the text unless a source issue explains them', () => {
    const e = makeEnrichment({ money: { thisAction: 150_000 } })
    expect(failing(TEXT, e)).toContain('amounts_in_text')
    expect(failing(TEXT, e, { sourceIssue: 'Misprinted amount' })).not.toContain('amounts_in_text')
  })

  it('catches amendment math that does not add up (R.-3)', () => {
    const text = 'in the not-to-exceed amount of $277,041.24, increasing the Agreement not to exceed amount from $10,922,885.00 to $11,757,368.71.'
    const e = makeEnrichment({
      headline: 'Adds $277,041 to Cahill for Fremont High',
      actionType: 'change_order',
      money: { thisAction: 277_041.24, priorTotal: 10_922_885, newTotal: 11_757_368.71, evidence: 'in the not-to-exceed amount of $277,041.24' },
    })
    expect(failing(text, e)).toEqual(['amendment_math'])
  })

  it('handles decrease math', () => {
    const text = 'decreasing the amount of the Agreement by $164,385.00, reducing the not to exceed amount of $276,000.00 to $111,615.00'
    const e = makeEnrichment({
      headline: 'Cuts $164,385 from a counseling agreement',
      money: { direction: 'decrease', thisAction: 164_385, priorTotal: 276_000, newTotal: 111_615, evidence: 'decreasing the amount of the Agreement by $164,385.00' },
    })
    expect(failing(text, e)).not.toContain('amendment_math')
  })

  it('flags yearly limits that were not typed per_year', () => {
    const text = 'in an amount not to exceed $500,000.00 in a fiscal year, per fiscal year, through June 30, 2029.'
    const e = makeEnrichment({ headline: 'Up to $500,000 a year', money: { thisAction: 500_000, evidence: 'not to exceed $500,000.00' } })
    expect(failing(text, e)).toContain('per_year_detection')
  })

  it('flags unexpanded jargon but accepts expansions', () => {
    expect(failing(TEXT, makeEnrichment({ summary: 'Bought through CMAS.' }))).toContain('jargon')
    expect(failing(TEXT, makeEnrichment({ summary: 'Bought through California Multiple Award Schedules (CMAS).' }))).not.toContain('jargon')
  })

  it('routes to review only on alerts, never on style checks', () => {
    const e = makeEnrichment({ summary: 'Bought through CMAS.' })
    const { checks } = runChecks({ text: TEXT, enrichment: e, sourceIssue: null })
    expect(checks.some(c => c.name === 'jargon' && !c.pass)).toBe(true)
    expect(routeReview(checks, e, null, [])).toBe('auto_ok')
    expect(routeReview(checks, e, null, ['Two independent readings disagree on thisAction.'])).toBe('needs_review')
  })

  it('accepts misprinted amounts the lenient reader can resolve, with a note', () => {
    const text = 'increasing the Agreement not to exceed amount from $70,000.00 to $8,273.319.00, for the unchanged term'
    const e = makeEnrichment({
      headline: 'Raises the Invo Healthcare contract to $8.27M',
      money: { thisAction: null, priorTotal: 70_000, newTotal: 8_273_319, evidence: null },
    })
    const { checks, notes } = runChecks({ text, enrichment: e, sourceIssue: null })
    expect(checks.find(c => c.name === 'amounts_in_text')?.pass).toBe(true)
    expect(notes[0]?.text).toContain('"$8,273.319.00"')
  })

  it('accepts an unreadable amount when an independent reading agrees', () => {
    const text = 'with the District receiving an additional $225,000.00, increasing the grant from $675,00.00 to $900,000.00'
    const e = makeEnrichment({
      headline: 'Accepts $225,000 more',
      money: { direction: 'revenue', thisAction: 225_000, priorTotal: 675_000, newTotal: 900_000, evidence: 'an additional $225,000.00' },
    })
    expect(failing(text, e)).toContain('amounts_in_text')
    const second = { direction: 'revenue' as const, amountType: 'fixed' as const, thisAction: 225_000, priorTotal: 675_000, newTotal: 900_000 }
    const { checks, notes } = runChecks({ text, enrichment: e, sourceIssue: null, secondReading: second })
    expect(checks.find(c => c.name === 'amounts_in_text')?.pass).toBe(true)
    expect(notes[0]?.kind).toBe('reading')
  })

  it('treats receiving and anticipated revenue as money in', () => {
    const text = 'Facilities Use Agreement for the period July 1, 2026 through June 30, 2027, with anticipated revenue to the District of $268,662.35.'
    const e = makeEnrichment({
      headline: 'Leases space for $268,662.35',
      money: { direction: 'revenue', amountType: 'fixed', thisAction: 268_662.35, evidence: 'anticipated revenue to the District of $268,662.35' },
    })
    expect(failing(text, e)).not.toContain('direction_consistency')
  })

  it('ignores yearly words that are not about the money', () => {
    const text = 'attend COST meetings and 3 additional annual meetings with the principal, in an amount not to exceed $132,000.00, for 2025-2026.'
    const e = makeEnrichment({ headline: 'Pays up to $132,000', money: { thisAction: 132_000, evidence: 'not to exceed $132,000.00' } })
    expect(failing(text, e)).not.toContain('per_year_detection')
  })

  it('counts a spelled-out acronym anywhere in the summary as explained', () => {
    const e = makeEnrichment({ summary: 'Students with Individualized Education Programs (IEPs, their legal plans). Attends IEP meetings.' })
    expect(failing(TEXT, e)).not.toContain('jargon')
  })

  it('flags an individual named in the headline', () => {
    const e = makeEnrichment({ headline: 'Hires speech-language pathologist Rachel Hart for up to $100,000', vendor: { name: 'Rachel Hart', location: null, kind: null } })
    expect(failing(TEXT, e)).toContain('person_in_headline')
    const org = makeEnrichment({ headline: 'Pays Rachel Hart Consulting LLC up to $100,000', vendor: { name: 'Rachel Hart Consulting LLC', location: null, kind: null } })
    expect(failing(TEXT, org)).not.toContain('person_in_headline')
  })

  it('reports schema failures as blocked', () => {
    const { checks, enrichment } = runChecks({ text: TEXT, enrichment: { headline: 1 }, sourceIssue: null })
    expect(enrichment).toBeNull()
    expect(routeReview(checks, enrichment, null, [])).toBe('blocked')
  })

  it('treats human review as final', () => {
    const e = makeEnrichment({ money: { thisAction: 150_000 } })
    const { checks } = runChecks({ text: TEXT, enrichment: e, sourceIssue: null })
    expect(routeReview(checks, e, { fields: {}, reviewer: 'me', reviewedAt: '2026-06-22', note: null }, [])).toBe('human_reviewed')
  })
})

describe('derived flags', () => {
  const base = { meetingDate: '2026-06-24', text: TEXT, history: [], sourceIssue: null }

  it('after_work_began uses dates, not the word "Ratification"', () => {
    // R.-116: titled "Ratification" but starts in August 2026.
    const future = makeEnrichment({ term: { start: '2026-08-01', end: '2027-06-30', addedStart: null } })
    expect(afterWorkBegan({ ...base, text: 'Ratification by the Board…', enrichment: future })).toBe(false)
    const past = makeEnrichment({ term: { start: '2026-01-01', end: '2026-12-31', addedStart: null } })
    expect(afterWorkBegan({ ...base, enrichment: past })).toBe(true)
    expect(afterWorkBegan({ ...base, text: 'Ratification by the Board…', enrichment: makeEnrichment() })).toBe(true)
  })

  it('after_work_began ignores an amendment’s original start date', () => {
    const amendment = makeEnrichment({ actionType: 'amendment', term: { start: '2020-08-01', end: '2041-06-30', addedStart: null } })
    expect(afterWorkBegan({ ...base, enrichment: amendment })).toBe(false)
    const withAdded = makeEnrichment({ actionType: 'amendment', term: { start: '2020-08-01', end: '2041-06-30', addedStart: '2026-01-01' } })
    expect(afterWorkBegan({ ...base, enrichment: withAdded })).toBe(true)
  })

  it('raises_existing_contract and large_increase', () => {
    const e = makeEnrichment({ money: { priorTotal: 99_000, thisAction: 71_000, newTotal: 170_000 } })
    expect(deriveFlags({ ...base, enrichment: e })).toEqual(expect.arrayContaining(['raises_existing_contract', 'large_increase']))
    const small = makeEnrichment({ money: { priorTotal: 3_175_729.23, thisAction: 1_019_870.42, newTotal: 4_195_599.65 } })
    const flags = deriveFlags({ ...base, enrichment: small })
    expect(flags).toContain('raises_existing_contract')
    expect(flags).not.toContain('large_increase')
  })

  it('previously_delayed only counts earlier meetings', () => {
    const history = [
      h({ date: '2026-06-10', action: 'Postponed to a Date Certain', body: 'Board of Education', eventId: 1 }),
      h({ date: '2026-06-24', action: 'Not Discussed and/or Taken Up', body: 'Board of Education', eventId: 2 }),
    ]
    expect(deriveFlags({ ...base, history, enrichment: null })).toEqual(['previously_delayed'])
    expect(deriveFlags({ ...base, history: history.slice(1), enrichment: null })).toEqual([])
  })

  it('yearly_cap and no_total_stated (Zum R.-62)', () => {
    const zum = makeEnrichment({
      actionType: 'amendment',
      term: { start: '2020-08-01', end: '2041-06-30', addedStart: '2026-07-01' },
      money: { amountType: 'per_year', thisAction: 17_608_594, thisActionRange: [13_083_445, 17_608_594] },
    })
    expect(deriveFlags({ ...base, enrichment: zum })).toEqual(expect.arrayContaining(['yearly_cap', 'no_total_stated']))
  })

  it('source_issue only when human-confirmed', () => {
    expect(deriveFlags({ ...base, enrichment: makeEnrichment({ sourceIssueCandidate: 'Numbers do not add up' }) })).not.toContain('source_issue')
    expect(deriveFlags({ ...base, enrichment: makeEnrichment(), sourceIssue: 'Numbers do not add up' })).toContain('source_issue')
  })
})
