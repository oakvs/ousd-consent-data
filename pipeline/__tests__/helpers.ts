import type { TEnrichment, THistoryEntry } from '@oakvs/consent-schema/schema'

/** A history entry with Legistar's optional fields defaulted. */
export function h(entry: Pick<THistoryEntry, 'date' | 'action'> & Partial<THistoryEntry>): THistoryEntry {
  return { body: 'Board of Education', eventId: null, historyId: null, consent: null, motion: null, mover: null, seconder: null, passed: null, votes: null, ...entry }
}

export function makeEnrichment(
  overrides: Omit<Partial<TEnrichment>, 'money'> & { money?: Partial<TEnrichment['money']> } = {},
): TEnrichment {
  const { money, ...rest } = overrides
  return {
    headline: 'Pays Acme up to $100,000 for tutoring',
    summary: 'Acme will tutor students.',
    category: 'Classroom & academic programs',
    actionType: 'new_agreement',
    vendor: { name: 'Acme', location: null, kind: null },
    schools: [],
    term: { start: null, end: null, addedStart: null },
    flags: [],
    sourceIssueCandidate: null,
    uncertain: [],
    ...rest,
    money: {
      direction: 'expense',
      amountType: 'not_to_exceed',
      thisAction: 100_000,
      thisActionRange: null,
      priorTotal: null,
      newTotal: null,
      byYear: {},
      evidence: 'not to exceed $100,000.00',
      ...money,
    },
  }
}
