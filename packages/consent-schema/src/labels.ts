import type { TActionType, TCategory, TFlag, TReviewStatus } from './schema'

export const CATEGORY_NOTES: Record<TCategory, { includes: string; excludes: string | null }> = {
  'Special education': {
    includes: 'Nonpublic school and agency contracts, special-ed transport, related services, school psychology interns, special-ed legal',
    excludes: 'General student health',
  },
  'Classroom & academic programs': {
    includes: 'Curriculum, instructional services, teacher training tied to instruction, field trips, college and career pathways',
    excludes: 'After-school providers',
  },
  'After-school & summer programs': {
    includes: 'Expanded learning lead agencies, enrichment providers, summer programs',
    excludes: null,
  },
  'Student health, support & family services': {
    includes: 'Health centers, counseling, translation and interpretation, family engagement, newcomer support',
    excludes: 'Special-ed services',
  },
  'School buildings & construction': {
    includes: 'Bond projects, design, construction management, inspections, environmental work tied to projects, change orders',
    excludes: 'Routine maintenance contracts',
  },
  'Food, transportation & operations': {
    includes: 'Nutrition purchasing, activity buses, waste, routine maintenance, furniture and supplies, auctions',
    excludes: 'Special-ed busing',
  },
  Technology: {
    includes: 'Software licenses, devices, IT services',
    excludes: 'Tech purchased for a program, when the program is clearer',
  },
  'Staff & hiring': {
    includes: 'Personnel reports, job descriptions, union agreements, recruitment, workforce grants',
    excludes: null,
  },
  'Legal, insurance & risk': {
    includes: 'Outside counsel, claims administration, insurance premiums, risk services',
    excludes: 'Special-ed legal (goes to Special education)',
  },
  'School plans': { includes: 'School Plans for Student Achievement (SPSAs)', excludes: null },
  'Partnerships & data sharing': {
    includes: 'No-cost agreements and data-sharing agreements without a clearer program home',
    excludes: null,
  },
  'Governance & board business': {
    includes: 'Resolutions, board policies, commission items, real property, minutes, appointments',
    excludes: null,
  },
}

export const ACTION_LABELS: Record<TActionType, string> = {
  new_agreement: 'New agreement',
  amendment: 'Amendment',
  change_order: 'Change order',
  bid_award: 'Bid award',
  cooperative_purchase: 'Cooperative purchase',
  mou_or_data_sharing: 'MOU or data sharing',
  grant_or_funding_in: 'Grant or funding in',
  school_plan: 'School plan',
  personnel: 'Personnel',
  resolution_or_policy: 'Resolution or policy',
  termination: 'Termination',
  other: 'Other',
}

export type TFlagTone = 'warn' | 'crit' | 'info'

/** Plain-English description of each action type, shown on the about page. */
export const ACTION_NOTES: Record<TActionType, string> = {
  new_agreement: 'A new contract or agreement with a vendor or partner.',
  amendment: 'A change to an existing contract, such as adding money, time or work.',
  change_order: 'A change to the work or price of a construction project already under contract.',
  bid_award: 'Awarding a contract to the winner of a competitive bid.',
  cooperative_purchase:
    'Buying through a contract another public agency already bid out (sometimes called "piggybacking"), instead of running the district\'s own bid.',
  mou_or_data_sharing:
    'A memorandum of understanding (MOU) or data-sharing agreement, usually with a partner organization and often at no cost.',
  grant_or_funding_in: 'Accepting a grant or other money coming in to the district.',
  school_plan: 'Approving a school\'s annual School Plan for Student Achievement (SPSA).',
  personnel: 'Staffing matters, such as personnel reports, job descriptions and employee agreements.',
  resolution_or_policy: 'A board resolution or a new or updated board policy.',
  termination: 'Ending an existing contract or agreement.',
  other: 'Anything that doesn\'t fit the types above.',
}

export const FLAG_LABELS: Record<TFlag, { label: string; explain: string; tone: TFlagTone }> = {
  budget_allocation: {
    label: 'Budget allocation',
    explain: 'The district dividing up its own funds, such as a Measure N, G1 or H plan, budget or carryover. Not counted as spending: the money is spent through contracts that come to the Board separately.',
    tone: 'info',
  },
  grant_application: {
    label: 'Grant application',
    explain: 'The district is applying for this money, not receiving it yet. Not counted as money coming in; an award usually comes back to the Board to be accepted.',
    tone: 'info',
  },
  payment_ratification: {
    label: 'Ratifies payments already made',
    explain: 'Payroll or vendor checks the district has already paid, under contracts and salaries approved elsewhere. Shown here but not counted as new spending.',
    tone: 'info',
  },
  pulled_from_consent: {
    label: 'Voted on separately',
    explain: 'Taken off the single consent-report vote: voted on separately, or withdrawn, referred, postponed or decided at a later meeting. From Legistar\u2019s official record.',
    tone: 'warn',
  },
  after_work_began: {
    label: 'After work began',
    explain: 'The agreement’s start date is before this meeting, or it is a ratification with no start date stated.',
    tone: 'warn',
  },
  no_competitive_bid: {
    label: 'No bid',
    explain: 'Bought through another agency’s contract, a state schedule, or a legal exception to bidding. This describes the method; it is often legal.',
    tone: 'warn',
  },
  raises_existing_contract: {
    label: 'Raises existing contract',
    explain: 'An expense where the text states both a previous and a new total, and the new total is higher.',
    tone: 'info',
  },
  large_increase: {
    label: 'Large increase',
    explain: 'Raises an existing contract by half or more of its previous total.',
    tone: 'warn',
  },
  previously_delayed: {
    label: 'Delayed at earlier meeting',
    explain: 'The item was postponed, continued or failed at an earlier meeting.',
    tone: 'info',
  },
  source_issue: {
    label: 'Text discrepancy',
    explain: 'A reviewer confirmed the official text has an error: numbers that don’t add up, a misprint, or a title that doesn’t match.',
    tone: 'crit',
  },
  yearly_cap: {
    label: 'Yearly cap',
    explain: 'Sets a limit per year rather than a total. Kept out of spending totals.',
    tone: 'info',
  },
  no_total_stated: {
    label: 'No total stated',
    explain: 'A yearly cap over more than one year, with no overall total in the text.',
    tone: 'warn',
  },
  multi_year: {
    label: 'Multi-year',
    explain: 'The term spans more than one school year.',
    tone: 'info',
  },
  time_extension_only: {
    label: 'Time extension only',
    explain: 'Extends the end date without adding money.',
    tone: 'info',
  },
  emergency: {
    label: 'Emergency',
    explain: 'The text describes emergency work or emergency contracting.',
    tone: 'warn',
  },
}

export const REVIEW_LABELS: Record<TReviewStatus, string> = {
  auto_ok: 'AI summary · amounts checked against official text',
  needs_review: 'AI summary · flagged for a closer look',
  blocked: 'Summary pending',
  human_reviewed: 'Reviewed',
  pending: 'Summary pending',
}

/**
 * Acronyms and terms that must be explained on first use (§8.1), with the
 * lowercase phrases that count as explaining them.
 */
export const JARGON_EXPANSIONS: Record<string, string[]> = {
  CMAS: ['california multiple award schedule'],
  Graydon: ['exception to public bidding', 'exception to bidding', 'without a competitive bid', 'instead of running its own bid'],
  LLB: ['lease-leaseback', 'lease leaseback'],
  SPSA: ['school plan for student achievement', 'school plans for student achievement'],
  MOU: ['memorandum of understanding', 'memoranda of understanding'],
  NPS: ['nonpublic school', 'non-public school'],
  NPA: ['nonpublic agency', 'non-public agency', 'nonpublic school/agency'],
  PCO: ['preliminary change order', 'potential change order'],
  IEP: ['individualized education program', 'individualized education plan'],
  DSA: ['division of the state architect', 'data-sharing agreement', 'data sharing agreement'],
}

export const JARGON = Object.keys(JARGON_EXPANSIONS)

/** Display and publish order for flags. */
export const FLAG_ORDER: readonly TFlag[] = [
  'pulled_from_consent',
  'payment_ratification',
  'grant_application',
  'budget_allocation',
  'after_work_began',
  'no_competitive_bid',
  'raises_existing_contract',
  'large_increase',
  'source_issue',
  'previously_delayed',
  'yearly_cap',
  'no_total_stated',
  'multi_year',
  'time_extension_only',
  'emergency',
]

/** CSS-safe keys for the per-category color tokens (`--cat-*`, defined in the Consent Tracker layout). */
export const CATEGORY_SLUGS: Record<TCategory, string> = {
  'Special education': 'special-education',
  'Classroom & academic programs': 'classroom-academic',
  'After-school & summer programs': 'after-school-summer',
  'Student health, support & family services': 'student-health-support',
  'School buildings & construction': 'buildings-construction',
  'Food, transportation & operations': 'food-transportation-operations',
  Technology: 'technology',
  'Staff & hiring': 'staff-hiring',
  'Legal, insurance & risk': 'legal-insurance-risk',
  'School plans': 'school-plans',
  'Partnerships & data sharing': 'partnerships-data-sharing',
  'Governance & board business': 'governance-board',
}

/** A flag's color token. */
export const flagColor = (flag: TFlag): string => `var(--flag-${flag})`

/** A category's color token; unknown strings fall back to the muted text color. */
export const categoryColor = (category: string | null | undefined): string => {
  const slug = category ? CATEGORY_SLUGS[category as TCategory] : undefined
  return slug ? `var(--cat-${slug})` : 'var(--consent-muted)'
}
