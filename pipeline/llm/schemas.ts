/**
 * Reply shapes for the Claude API's structured outputs.
 *
 * Structured outputs need every object closed and every field present, and
 * can't express a free-form map or a tuple. So these mirror `Enrichment` and
 * `VerificationRecord` with two changes: `byYear` is a list of
 * `{ year, amount }`, and `thisActionRange` is a plain list. Formats, lengths
 * and the range's two numbers are checked in code afterwards, against the
 * real schema, and any failure goes back to the model as feedback.
 */
import { z } from 'zod'

import { ActionType, Category, IssueTopic, IssueVerdict, LlmFlag } from '@oakvs/consent-schema/schema'

const Direction = z.enum(['expense', 'revenue', 'decrease', 'no_cost'])
const AmountType = z.enum(['not_to_exceed', 'fixed', 'cumulative', 'per_year', 'sales_cap']).nullable()
const VendorKind = z.enum(['individual', 'organization']).nullable()

export const EnrichmentReply = z.object({
  headline: z.string(),
  summary: z.string(),
  category: Category,
  actionType: ActionType,
  vendor: z.object({ name: z.string().nullable(), location: z.string().nullable(), kind: VendorKind }),
  schools: z.array(z.string()),
  money: z.object({
    direction: Direction,
    amountType: AmountType,
    thisAction: z.number().nullable(),
    thisActionRange: z.array(z.number()).nullable(),
    priorTotal: z.number().nullable(),
    newTotal: z.number().nullable(),
    byYear: z.array(z.object({ year: z.string(), amount: z.number() })),
    evidence: z.string().nullable(),
  }),
  term: z.object({ start: z.string().nullable(), end: z.string().nullable(), addedStart: z.string().nullable() }),
  flags: z.array(LlmFlag),
  sourceIssueCandidate: z.string().nullable(),
  uncertain: z.array(z.string()),
})
export type TEnrichmentReply = z.infer<typeof EnrichmentReply>

/** The reply in the stored `Enrichment` shape, ready for `checkEnrichment`. */
export function toEnrichmentCandidate(reply: TEnrichmentReply): unknown {
  return {
    ...reply,
    money: { ...reply.money, byYear: Object.fromEntries(reply.money.byYear.map(y => [y.year, y.amount])) },
  }
}

export const VerifyReply = z.object({
  money: z.object({
    direction: Direction,
    amountType: AmountType,
    thisAction: z.number().nullable(),
    priorTotal: z.number().nullable(),
    newTotal: z.number().nullable(),
  }).nullable(),
  issue: z.object({
    verdict: IssueVerdict,
    topic: IssueTopic,
    explanation: z.string(),
    quote: z.string().nullable(),
  }).nullable(),
  vendorKind: VendorKind,
  headlineFix: z.string().nullable(),
})
export type TVerifyReply = z.infer<typeof VerifyReply>
