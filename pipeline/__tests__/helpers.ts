import type { TEnrichment, THistoryEntry, TPublishedItem } from '@oakvs/consent-schema/schema'

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
    subcategory: null,
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

/** A published item for the 2026-06-24 meeting with every field defaulted; `enrichment` is `makeEnrichment()`. */
export function makePublishedItem(file: string, overrides: Partial<TPublishedItem> = {}): TPublishedItem {
  return {
    id: `2026-06-24:${file}`,
    vendorKey: null,
    agendaNumber: 'R.-1',
    agendaSequence: 1,
    consentSection: 'general',
    group: null,
    file,
    matterId: 1,
    matterGuid: null,
    title: 'Title',
    text: 'Text',
    matterType: null,
    presenter: null,
    vendorNo: null,
    resourceSite: null,
    fundingSource: null,
    introDate: null,
    attachments: [],
    history: [],
    legistarUrl: 'https://ousd.legistar.com/LegislationDetail.aspx?ID=1',
    enrichment: makeEnrichment(),
    flags: [],
    sourceIssue: null,
    amountVerified: true,
    checks: [],
    sourceIssueBy: null,
    pulled: null,
    notes: [],
    review: { status: 'auto_ok', modelId: null, promptVersion: null, reviewedAt: null, correction: null, verifiedBy: null, alerts: [] },
    outcome: null,
    countsTowardTotals: true,
    lineage: { amendmentNo: null, otherMeetings: [] },
    ...overrides,
  }
}
