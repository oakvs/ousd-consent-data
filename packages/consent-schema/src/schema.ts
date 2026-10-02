/**
 * Consent Tracker data contracts.
 *
 * Shared by the pipeline (`pipeline/consent`) and the site. Every published file
 * is parsed against these schemas at the boundary, so the two can't drift.
 * Bump SCHEMA_VERSION on any breaking change; published files are fully
 * derived from raw + enrichments + overrides, so a bump means `build --all`.
 */
import { z } from 'zod'

export const SCHEMA_VERSION = '1.0.0'

// ─── Codebook ────────────────────────────────────────────────────────────────

export const Category = z.enum([
  'Special education',
  'Classroom & academic programs',
  'After-school & summer programs',
  'Student health, support & family services',
  'School buildings & construction',
  'Food, transportation & operations',
  'Technology',
  'Staff & hiring',
  'Legal, insurance & risk',
  'School plans',
  'Partnerships & data sharing',
  'Governance & board business',
])
export type TCategory = z.infer<typeof Category>

export const ActionType = z.enum([
  'new_agreement',
  'amendment',
  'change_order',
  'bid_award',
  'cooperative_purchase',
  'mou_or_data_sharing',
  'grant_or_funding_in',
  'school_plan',
  'personnel',
  'resolution_or_policy',
  'termination',
  'other',
])
export type TActionType = z.infer<typeof ActionType>

/** Flags the LLM assigns from reading the text. */
export const LlmFlag = z.enum([
  'no_competitive_bid',
  'multi_year',
  'time_extension_only',
  'emergency',
])
export type TLlmFlag = z.infer<typeof LlmFlag>

/** Flags computed in code, never by the LLM (§7.3). */
export const DerivedFlag = z.enum([
  'after_work_began',
  'raises_existing_contract',
  'previously_delayed',
  'source_issue',
  'large_increase',
  'yearly_cap',
  'no_total_stated',
  'pulled_from_consent',
])
export type TDerivedFlag = z.infer<typeof DerivedFlag>

export const Flag = z.union([LlmFlag, DerivedFlag])
export type TFlag = z.infer<typeof Flag>

export const ConsentSection = z.enum(['general', 'bonds'])
export type TConsentSection = z.infer<typeof ConsentSection>

export const MeetingKind = z.enum(['regular', 'special', 'organizational'])
export type TMeetingKind = z.infer<typeof MeetingKind>

/** `YYYY-MM-DD`, or `YYYY-MM-DD-special` when two meetings share a day. */
export const MeetingKey = z.string().regex(/^\d{4}-\d{2}-\d{2}(-[a-z]+)?$/)

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

// ─── Enrichment (LLM output, §8) ─────────────────────────────────────────────

export const Money = z.object({
  direction: z.enum(['expense', 'revenue', 'decrease', 'no_cost']),
  amountType: z
    .enum(['not_to_exceed', 'fixed', 'cumulative', 'per_year', 'sales_cap'])
    .nullable(),
  thisAction: z.number().nonnegative().nullable(),
  /** e.g. Zum R.-62: 13,083,445–17,608,594 per year. */
  thisActionRange: z.tuple([z.number(), z.number()]).nullable(),
  priorTotal: z.number().nullable(),
  newTotal: z.number().nullable(),
  byYear: z.record(z.string(), z.number()),
  /** Exact substring of the source text containing `thisAction`. */
  evidence: z.string().nullable(),
})
export type TMoney = z.infer<typeof Money>

export const Enrichment = z.object({
  headline: z.string().max(140),
  summary: z.string().max(900),
  category: Category,
  actionType: ActionType,
  vendor: z.object({
    name: z.string().nullable(),
    location: z.string().nullable(),
    /** Individuals' names stay out of headlines (§15); organizations are always named. */
    kind: z.enum(['individual', 'organization']).nullable().default(null),
  }),
  schools: z.array(z.string()),
  money: Money,
  term: z.object({
    start: IsoDate.nullable(),
    end: IsoDate.nullable(),
    /** For amendments/extensions: when the newly added period starts, if stated. Drives `after_work_began`. */
    addedStart: IsoDate.nullable().default(null),
  }),
  flags: z.array(LlmFlag),
  /** LLM-noticed inconsistency; needs a human to confirm before it's public. */
  sourceIssueCandidate: z.string().nullable(),
  uncertain: z.array(z.string()),
})
export type TEnrichment = z.infer<typeof Enrichment>

// ─── Raw (normalized Legistar, §4.2) ─────────────────────────────────────────

export const Attachment = z.object({ name: z.string(), url: z.url() })
export type TAttachment = z.infer<typeof Attachment>

export const RollCallVote = z.object({ name: z.string(), vote: z.string() })
export type TRollCallVote = z.infer<typeof RollCallVote>

export const HistoryEntry = z.object({
  date: IsoDate,
  action: z.string(),
  body: z.string().nullable(),
  eventId: z.number().nullable(),
  /** Legistar's history id; equals the EventItemId, which the roll-call endpoint uses. */
  historyId: z.number().nullable().default(null),
  /** True when this action was part of the single consent-report vote. */
  consent: z.boolean().nullable().default(null),
  /** Official motion sentence, e.g. "A motion was made by Director Latta, seconded by…". */
  motion: z.string().nullable().default(null),
  mover: z.string().nullable().default(null),
  seconder: z.string().nullable().default(null),
  passed: z.string().nullable().default(null),
  /** Member-by-member roll call, fetched only for actions taken off the consent vote. */
  votes: z.array(RollCallVote).nullable().default(null),
})
export type THistoryEntry = z.infer<typeof HistoryEntry>

export const RawItem = z.object({
  agendaNumber: z.string(),
  agendaSequence: z.number(),
  consentSection: ConsentSection,
  group: z.string().nullable(),
  file: z.string(),
  matterId: z.number(),
  matterGuid: z.string().nullable(),
  title: z.string(),
  /** Full action text — the source of truth for the LLM and validation. */
  text: z.string(),
  matterType: z.string().nullable(),
  presenter: z.string().nullable(),
  vendorNo: z.string().nullable(),
  resourceSite: z.string().nullable(),
  fundingSource: z.string().nullable(),
  introDate: IsoDate.nullable(),
  attachments: z.array(Attachment),
  history: z.array(HistoryEntry),
})
export type TRawItem = z.infer<typeof RawItem>

/** A vote on a consent report as a whole, from the meeting minutes. */
export const ConsentVote = z.object({
  title: z.string(),
  action: z.string(),
  /** Official motion sentence, e.g. "…to Approve O. General Consent Report minus O.-121 …". */
  motion: z.string().nullable(),
  mover: z.string().nullable(),
  seconder: z.string().nullable(),
  passed: z.string().nullable(),
  votes: z.array(RollCallVote),
})
export type TConsentVote = z.infer<typeof ConsentVote>

export const RawSnapshot = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  meetingKey: MeetingKey,
  eventId: z.number().nullable(),
  fetchedAt: z.string(),
  source: z.enum(['legistar', 'prototype']),
  /** Votes on the consent report(s) as a whole; empty until Legistar publishes the minutes. */
  consentVotes: z.array(ConsentVote).default([]),
  items: z.array(RawItem),
})
export type TRawSnapshot = z.infer<typeof RawSnapshot>

// ─── Working store: enrichments + overrides ──────────────────────────────────

export const EnrichmentRecord = z.object({
  modelId: z.string(),
  promptVersion: z.string(),
  /** sha256(text + title + promptVersion + modelId) — see pipeline/consent/enrich. */
  cacheKey: z.string(),
  output: Enrichment,
})
export type TEnrichmentRecord = z.infer<typeof EnrichmentRecord>

export const EnrichmentsFile = z.object({
  meetingKey: MeetingKey,
  /** Keyed by file number. */
  items: z.record(z.string(), EnrichmentRecord),
})
export type TEnrichmentsFile = z.infer<typeof EnrichmentsFile>

export const Override = z.object({
  fields: z
    .object({
      headline: z.string(),
      summary: z.string(),
      category: Category,
      actionType: ActionType,
      vendor: Enrichment.shape.vendor,
      schools: z.array(z.string()),
      money: Money.partial(),
      term: Enrichment.shape.term,
      flags: z.array(LlmFlag),
    })
    .partial(),
  /** Human-confirmed problem in the official text; drives `source_issue`. */
  sourceIssue: z.string().nullable().optional(),
  /** Set false when the official text itself misprints the amount (R.-248). */
  amountVerified: z.boolean().optional(),
  reviewer: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  /** Public correction note when this changes an already-published claim. */
  note: z.string().nullable(),
})
export type TOverride = z.infer<typeof Override>

export const OverridesFile = z.object({
  meetingKey: MeetingKey,
  items: z.record(z.string(), Override),
})
export type TOverridesFile = z.infer<typeof OverridesFile>

// ─── Working store: automated verifications ──────────────────────────────────
// A second, independent model reading. Kept separate from human overrides so
// the public record shows which conclusions were the machine's and which a
// person's. Merge order in the build: raw → enrichment → verification → override.

export const IssueVerdict = z.enum(['material', 'cosmetic', 'not_real'])
export type TIssueVerdict = z.infer<typeof IssueVerdict>

/** What a material issue affects; "changes what's being voted on". */
export const IssueTopic = z.enum(['money', 'vendor', 'school', 'scope', 'term', 'other'])
export type TIssueTopic = z.infer<typeof IssueTopic>

export const VerifiedMoney = Money.pick({
  direction: true,
  amountType: true,
  thisAction: true,
  priorTotal: true,
  newTotal: true,
})
export type TVerifiedMoney = z.infer<typeof VerifiedMoney>

export const VerificationRecord = z.object({
  modelId: z.string(),
  promptVersion: z.string(),
  /** The enrichment this verified; a re-enrichment invalidates it. */
  enrichmentCacheKey: z.string(),
  /** Independent money reading (it never sees the primary values). */
  money: VerifiedMoney.nullable(),
  /** A third independent reading, taken only when the first two disagree in a way that changes totals. */
  tiebreakMoney: VerifiedMoney.nullable().default(null),
  /** Verdict on an AI-suggested problem in the official text. */
  issue: z.object({
    verdict: IssueVerdict,
    topic: IssueTopic,
    /** One neutral sentence, suitable for public display. */
    explanation: z.string().max(400),
    /** Exact quote from the title or text supporting the verdict. */
    quote: z.string().nullable(),
  }).nullable(),
  /** For the headline task: whether the vendor is a person or an organization. */
  vendorKind: z.enum(['individual', 'organization']).nullable().default(null),
  /** Replacement headline when the original named an individual. */
  headlineFix: z.string().max(140).nullable(),
})
export type TVerificationRecord = z.infer<typeof VerificationRecord>

export const VerificationsFile = z.object({
  meetingKey: MeetingKey,
  items: z.record(z.string(), VerificationRecord),
})
export type TVerificationsFile = z.infer<typeof VerificationsFile>

// ─── Meeting registry (stand-in for the Postgres `meetings` table) ───────────

export const MeetingStatus = z.enum(['discovered', 'ingested', 'published', 'final', 'skipped'])
export type TMeetingStatus = z.infer<typeof MeetingStatus>

export const RegistryEntry = z.object({
  key: MeetingKey,
  date: IsoDate,
  time: z.string().nullable(),
  kind: MeetingKind,
  eventId: z.number().nullable(),
  resolvedBy: z.enum(['history', 'probe', 'manual', 'prototype']).nullable(),
  meetingDetailId: z.number().nullable(),
  agendaPdfUrl: z.url().nullable(),
  status: MeetingStatus,
  lastIngestedAt: z.string().nullable(),
  note: z.string().nullable(),
  /** `consent run` bookkeeping: hash of the event's items at the last check (changes → re-ingest). */
  eventItemsHash: z.string().nullable().default(null),
  /** `consent run` bookkeeping: Oakland date outcomes (histories) were last refreshed; once a day until final. */
  historiesCheckedOn: IsoDate.nullable().default(null),
})
export type TRegistryEntry = z.infer<typeof RegistryEntry>

export const Registry = z.object({
  lastKnownEventId: z.number().nullable(),
  meetings: z.array(RegistryEntry),
})
export type TRegistry = z.infer<typeof Registry>

// ─── Published files (§6.3) ──────────────────────────────────────────────────

export const ReviewStatus = z.enum(['auto_ok', 'needs_review', 'blocked', 'human_reviewed', 'pending'])
export type TReviewStatus = z.infer<typeof ReviewStatus>

export const Outcome = z.object({
  action: z.string(),
  date: IsoDate,
  meetingEventId: z.number().nullable(),
  /** True when the item was adopted/approved (on consent or separately). */
  adopted: z.boolean(),
})
export type TOutcome = z.infer<typeof Outcome>

export const Lineage = z.object({
  /** "Amendment No. N", parsed from the title or text. */
  amendmentNo: z.number().nullable(),
  /** Other meetings where this same file number appeared. */
  otherMeetings: z.array(MeetingKey),
})
export type TLineage = z.infer<typeof Lineage>

export const PublishedItem = RawItem.extend({
  /** `${meetingKey}:${file}` — stable across agenda revisions. */
  id: z.string(),
  /** Vendor UID for /consent-tracker/vendors/{vendorKey}, or null when there's no vendor. */
  vendorKey: z.string().nullable(),
  legistarUrl: z.url(),
  /** Null when the item hasn't been enriched yet ("Summary pending"). */
  enrichment: Enrichment.nullable(),
  flags: z.array(Flag),
  sourceIssue: z.string().nullable(),
  /** Who established the source issue: computed in code, a second AI reading, or a person. */
  sourceIssueBy: z.enum(['computed', 'verifier', 'human']).nullable(),
  /** Set when the item was taken off the single consent vote (voted on separately, withdrawn, deferred…). */
  pulled: z.object({ summary: z.string() }).nullable(),
  /** Minor, non-material notes about the official text (misprints, typos, label mismatches). */
  notes: z.array(z.object({ kind: z.enum(['misprint', 'math', 'reading', 'cosmetic']), text: z.string() })),
  amountVerified: z.boolean(),
  checks: z.array(z.object({ name: z.string(), pass: z.boolean(), detail: z.string().nullable() })),
  review: z.object({
    status: ReviewStatus,
    modelId: z.string().nullable(),
    promptVersion: z.string().nullable(),
    reviewedAt: z.string().nullable(),
    correction: z.string().nullable(),
    /** Model that independently re-read this item's money, if any. */
    verifiedBy: z.string().nullable(),
    /** Why this item is flagged for a closer look (empty unless needs_review). */
    alerts: z.array(z.string()),
  }),
  outcome: Outcome.nullable(),
  lineage: Lineage,
})
export type TPublishedItem = z.infer<typeof PublishedItem>

export const Totals = z.object({
  items: z.number(),
  enrichedItems: z.number(),
  /** Excludes per-year caps and sales caps. */
  spendingTotal: z.number(),
  spendingItems: z.number(),
  yearlyCapsTotal: z.number(),
  yearlyCapItems: z.number(),
  revenueTotal: z.number(),
  revenueItems: z.number(),
  decreaseTotal: z.number(),
  flagCounts: z.record(z.string(), z.number()),
  byCategory: z.record(z.string(), z.object({ items: z.number(), spending: z.number() })),
})
export type TTotals = z.infer<typeof Totals>

export const MeetingMeta = z.object({
  key: MeetingKey,
  date: IsoDate,
  time: z.string().nullable(),
  kind: MeetingKind,
  title: z.string(),
  eventId: z.number().nullable(),
  agendaPdfUrl: z.url().nullable(),
  legistarMeetingUrl: z.url().nullable(),
  revision: z.number(),
  /** Last time the source data was fetched — not the build time, to keep builds deterministic. */
  updatedAt: z.string(),
  /** e.g. "The General Consent Report was adopted June 29." */
  note: z.string().nullable(),
  /** Votes on the consent report(s) as a whole, from the minutes. */
  consentVotes: z.array(ConsentVote),
})
export type TMeetingMeta = z.infer<typeof MeetingMeta>

export const MeetingFile = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  meeting: MeetingMeta,
  totals: Totals,
  items: z.array(PublishedItem),
})
export type TMeetingFile = z.infer<typeof MeetingFile>

/**
 * The light list sent to the client explorer (§11.6): everything the rows,
 * filters and search need, without official text, history, checks,
 * attachments or evidence. Details load from the full file on expand.
 */
export const ListItem = PublishedItem.pick({
  id: true,
  vendorKey: true,
  agendaNumber: true,
  agendaSequence: true,
  consentSection: true,
  group: true,
  file: true,
  title: true,
  matterType: true,
  presenter: true,
  vendorNo: true,
  fundingSource: true,
  flags: true,
  sourceIssue: true,
  amountVerified: true,
  pulled: true,
}).extend({
  review: PublishedItem.shape.review.pick({ status: true }),
  outcome: Outcome.pick({ action: true, date: true, adopted: true }).nullable(),
  enrichment: Enrichment.pick({
    headline: true,
    summary: true,
    category: true,
    actionType: true,
    vendor: true,
    schools: true,
  }).extend({
    money: Money.pick({
      direction: true,
      amountType: true,
      thisAction: true,
      thisActionRange: true,
      priorTotal: true,
      newTotal: true,
    }),
  }).nullable(),
})
export type TListItem = z.infer<typeof ListItem>

export const MeetingListFile = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  meeting: MeetingMeta,
  totals: Totals,
  items: z.array(ListItem),
})
export type TMeetingListFile = z.infer<typeof MeetingListFile>

/** A consent-report vote, reduced to what a badge shows. */
export const VoteSummary = z.object({
  title: z.string(),
  outcome: z.enum(['carried', 'failed', 'other']),
  /** "Passed", "Failed", or Legistar's action name for anything else (e.g. "Postponed"). */
  status: z.string(),
  ayes: z.number().nullable(),
  nays: z.number().nullable(),
})
export type TVoteSummary = z.infer<typeof VoteSummary>

export const IndexEntry = z.object({
  key: MeetingKey,
  date: IsoDate,
  kind: MeetingKind,
  title: z.string(),
  /** e.g. "2025-26" — for grouping the archive. */
  schoolYear: z.string(),
  items: z.number(),
  enrichedItems: z.number(),
  spendingTotal: z.number(),
  spendingItems: z.number(),
  revenueTotal: z.number(),
  revenueItems: z.number(),
  flagCounts: z.record(z.string(), z.number()),
  /** Votes on the consent report(s); empty until Legistar publishes the minutes. */
  consentVotes: z.array(VoteSummary),
  revision: z.number(),
  updatedAt: z.string(),
})
export type TIndexEntry = z.infer<typeof IndexEntry>

/**
 * The next Board meeting, inferred from items already filed in Legistar with a
 * future agenda date (its events API is broken for OUSD). Written by
 * `consent:upcoming`; the date is "confirmed" once enough consent-report items
 * are filed for it.
 */
export const UpcomingFile = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  /**
   * When Legistar last reported something new (ISO timestamp). Runs that find
   * the same meeting and counts keep the old value, so the file doesn't churn.
   */
  checkedAt: z.string(),
  meeting: z
    .object({
      date: IsoDate,
      /** Items filed as "Board, General Consent Report" for this date so far. */
      consentItems: z.number(),
      /** All Board items filed for this date so far (consent + other sections). */
      boardItems: z.number(),
    })
    .nullable(),
})
export type TUpcomingFile = z.infer<typeof UpcomingFile>

export const IndexFile = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  meetings: z.array(IndexEntry),
})
export type TIndexFile = z.infer<typeof IndexFile>

// ─── Vendors (cross-meeting, §12) ────────────────────────────────────────────

/**
 * An official Legistar record, as published. Fields come straight from the
 * matter record; staff emails (MatterText2) and MatterCost are never kept.
 */
export const OfficialMatter = z.object({
  matterId: z.number(),
  file: z.string(),
  /** Official short title (MatterName). */
  title: z.string(),
  type: z.string().nullable(),
  status: z.string().nullable(),
  /** Presenting office (MatterBodyName). */
  department: z.string().nullable(),
  introDate: IsoDate.nullable(),
  agendaDate: IsoDate.nullable(),
  passedDate: IsoDate.nullable(),
  enactmentNumber: z.string().nullable(),
  vendorNo: z.string().nullable(),
  fundingSource: z.string().nullable(),
  resourceSite: z.string().nullable(),
  legistarUrl: z.url(),
  /** Legistar's own links to related records (e.g. an amendment's original agreement). */
  relatedMatterIds: z.array(z.number()),
})
export type TOfficialMatter = z.infer<typeof OfficialMatter>

/** Working store: everything Legistar has for one vendor (data/consent/legistar/vendors/{key}.json). */
export const VendorLegistarFile = z.object({
  key: z.string(),
  vendorNo: z.string().nullable(),
  matters: z.array(OfficialMatter),
})
export type TVendorLegistarFile = z.infer<typeof VendorLegistarFile>

// ─── Vendor research (AI, from public sources; never official) ──────────────

export const ProfileField = z.enum([
  'legalName', 'summary', 'orgType', 'website', 'phone', 'email', 'address', 'headquarters', 'ein', 'caEntityNumber', 'samUei',
])
export type TProfileField = z.infer<typeof ProfileField>

export const VendorProfile = z.object({
  /** Name as registered (e.g. "Fred Finch Youth & Family Services"). */
  legalName: z.string().nullable(),
  /** 2–3 neutral sentences on what the organization does. */
  summary: z.string().max(600),
  orgType: z.enum(['nonprofit', 'company', 'public_agency', 'other']).nullable(),
  website: z.url().nullable(),
  /** Public business contact only: main line, general inbox, mailing address. */
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  headquarters: z.string().nullable(),
  /** IRS Employer Identification Number, for nonprofits (NN-NNNNNNN). */
  ein: z.string().regex(/^\d{2}-\d{7}$/).nullable(),
  /** California Secretary of State entity number. */
  caEntityNumber: z.string().nullable(),
  /** SAM.gov Unique Entity ID. */
  samUei: z.string().nullable(),
})
export type TVendorProfile = z.infer<typeof VendorProfile>

export const ProfileSource = z.object({
  url: z.url(),
  title: z.string(),
  /** Which profile fields this page supports. */
  supports: z.array(ProfileField),
})
export type TProfileSource = z.infer<typeof ProfileSource>

/** The researcher's output, before checks. */
export const VendorResearch = z.object({
  key: z.string(),
  /** Independent signals tying the found organization to this vendor. */
  identitySignals: z.array(z.string()),
  confidence: z.enum(['high', 'medium', 'low', 'none']),
  profile: VendorProfile.nullable(),
  sources: z.array(ProfileSource),
  notes: z.string().nullable(),
})
export type TVendorResearch = z.infer<typeof VendorResearch>

/** An independent second reading of a research result. */
export const VendorResearchReview = z.object({
  key: z.string(),
  verdict: z.enum(['confirmed', 'rejected']),
  sameOrganization: z.boolean(),
  /** Fields the reviewer could not confirm from the cited sources; they are dropped. */
  unsupportedFields: z.array(ProfileField),
  notes: z.string().nullable(),
})
export type TVendorResearchReview = z.infer<typeof VendorResearchReview>

/** Working store: data/consent/vendor-research/{key}.json. */
export const VendorResearchRecord = z.object({
  key: z.string(),
  researchedAt: IsoDate,
  modelId: z.string(),
  promptVersion: z.string(),
  research: VendorResearch,
  review: VendorResearchReview.nullable(),
  /** Results of the code checks (URLs load, contact details appear verbatim on a cited page). */
  checks: z.array(z.object({ field: z.string(), pass: z.boolean(), detail: z.string().nullable() })),
  /** True only when confidence is high, the review confirmed it, and the hard checks passed. */
  publishable: z.boolean(),
})
export type TVendorResearchRecord = z.infer<typeof VendorResearchRecord>

/** What a vendor page shows: only fields that passed every check. */
export const PublishedVendorProfile = VendorProfile.partial().extend({
  summary: z.string(),
  sources: z.array(ProfileSource),
  researchedAt: IsoDate,
  modelId: z.string(),
})
export type TPublishedVendorProfile = z.infer<typeof PublishedVendorProfile>

export const VendorAppearance = z.object({
  id: z.string(),
  meetingKey: MeetingKey,
  date: IsoDate,
  file: z.string(),
  matterId: z.number(),
  agendaNumber: z.string(),
  title: z.string(),
  headline: z.string().nullable(),
  enriched: z.boolean(),
  category: Category.nullable(),
  actionType: ActionType.nullable(),
  direction: Money.shape.direction.nullable(),
  amountType: Money.shape.amountType,
  thisAction: z.number().nullable(),
  newTotal: z.number().nullable(),
  term: z.object({ start: IsoDate.nullable(), end: IsoDate.nullable() }).nullable(),
  fundingSource: z.string().nullable(),
  outcome: Outcome.nullable(),
  flags: z.array(Flag),
  /** False for an earlier appearance of a file number that was adopted at a later meeting. */
  countsTowardTotals: z.boolean(),
})
export type TVendorAppearance = z.infer<typeof VendorAppearance>

const Tally = z.array(z.object({ name: z.string(), count: z.number() }))

export const VendorFile = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** UID: `v-{OUSD vendor number}`, or `n-{normalized name}` when Legistar has no vendor number. */
  key: z.string(),
  vendorNo: z.string().nullable(),
  /** Display name. For individuals this is a role description, not their name (§15). */
  displayName: z.string(),
  kind: z.enum(['individual', 'organization']).nullable(),
  /** Names as written in the agenda text (extracted by the summarizer). */
  names: z.array(z.string()),
  locations: z.array(z.string()),
  firstSeen: IsoDate,
  lastSeen: IsoDate,
  /** Total not-to-exceed amounts approved (expense, excluding yearly and sales caps). */
  approvedTotal: z.number(),
  yearlyCapsTotal: z.number(),
  revenueTotal: z.number(),
  approvedCount: z.number(),
  pendingAmounts: z.number(),
  fundingSources: z.array(z.string()),
  /** Official Legistar fields across this vendor's records. */
  official: z.object({
    departments: Tally,
    matterTypes: Tally,
    resourceSites: z.array(z.string()),
  }),
  /** The tool's own codebook classification (AI-assigned, then checked). */
  taxonomy: z.object({
    categories: Tally,
    actionTypes: Tally,
  }),
  appearances: z.array(VendorAppearance),
  /** Every Legistar record for this vendor, all years, newest first. */
  legistarHistory: z.array(OfficialMatter),
  /** AI research from public sources; only present when it passed every check. Never official. */
  profile: PublishedVendorProfile.nullable(),
})
export type TVendorFile = z.infer<typeof VendorFile>

export const VendorIndexFile = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  vendors: z.array(
    z.object({
      key: z.string(),
      vendorNo: z.string().nullable(),
      name: z.string(),
      kind: z.enum(['individual', 'organization']).nullable(),
      topCategory: z.string().nullable(),
      meetings: z.number(),
      appearances: z.number(),
      approvedCount: z.number(),
      approvedTotal: z.number(),
      legistarRecords: z.number(),
      lastSeen: IsoDate,
      /** True when the vendor page has a published AI-researched description. */
      hasProfile: z.boolean(),
    }),
  ),
})
export type TVendorIndexFile = z.infer<typeof VendorIndexFile>
