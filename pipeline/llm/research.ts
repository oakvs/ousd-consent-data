/**
 * Vendor research in `consent run`: the same two steps as the agent workflow
 * (research, then an independent review of high-confidence results), through
 * the Claude API with its server-side web search and fetch.
 *
 * - Research: organizations (and vendors of unknown kind) with no research
 *   record, largest approved totals first, at most `limit` per run. The reply
 *   goes through the same code checks as `research-import` (every cited page
 *   is fetched; contact details and registry IDs must appear on a page cited
 *   for them), and failures go back to the model. A reply that still fails
 *   some checks is stored anyway: the build drops every field that failed.
 * - Review: a different model, for every high-confidence record with a
 *   profile and no review yet (also at most `limit` left over from earlier runs). Only `isPublishable` records reach a page.
 *
 * Individuals are never researched: vendors the summaries or second readings
 * call individuals are skipped, and the prompt stops on any it finds.
 */
import { VendorResearch } from '@oakvs/consent-schema/schema'
import type { TVendorResearch, TVendorResearchRecord } from '@oakvs/consent-schema/schema'

import {
  fetchPage,
  isPublishable,
  pendingReviews,
  readVendorInput,
  runResearchChecks,
  toResearchRecord,
  unresearchedVendors,
  withRfc3986Urls,
  writeResearchRecord,
} from '../research/vendor-research'

import { EFFORT, MODELS, anthropicLlm, hasLlmCredentials, mapLimit } from './client'
import { charge, monthSpend, newContext, overBudget, readPrompt } from './context'
import { ResearchReply, ReviewReply } from './schemas'
import { monthlyCap, readLlmState, recordFailure, retryDecision, vendorFailureKey, writeLlmState } from './state'

import type { TPageFetcher } from '../research/vendor-research'
import type { Anthropic } from '@anthropic-ai/sdk'
import type { ILlm, TUsage } from './client'
import type { TLlmContext } from './context'
import type { TResearchReply } from './schemas'

export const API_RESEARCH_PROMPT_VERSION = 'vendor-research.v3.md'
export const API_REVIEW_PROMPT_VERSION = 'vendor-review.v2.md'
/** New vendors researched per run; the rest wait for the next run. Override with CONSENT_RESEARCH_PER_RUN. */
export const DEFAULT_RESEARCH_PER_RUN = 4
const CONCURRENCY = 2

/** Caps a little above what the prompt asks for ("usually 2–4 searches, at most about 6 fetches"). */
export const WEB_TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  { type: 'web_search_20260318', name: 'web_search', max_uses: 6 },
  { type: 'web_fetch_20260318', name: 'web_fetch', max_uses: 10, max_content_tokens: 12_000 },
]

export function researchPerRun(): number {
  const raw = Number(process.env.CONSENT_RESEARCH_PER_RUN)
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_RESEARCH_PER_RUN
}

export type TResearchPhaseResult = {
  status: 'ran' | 'skipped' | 'capped'
  reason: string | null
  researched: { key: string; confidence: string }[]
  reviewed: { key: string; publishable: boolean }[]
  failed: { key: string; error: string }[]
  /** Failed earlier today; retried tomorrow. */
  waiting: string[]
  /** Failed on GIVE_UP_AFTER days; needs a human. */
  gaveUp: string[]
  /** Unresearched vendors left for later runs. */
  remaining: number
  usage: TUsage | null
  monthSpendUsd: number
  capUsd: number
}

/** The reply in the stored shape, or the schema problems that stop it. */
export function toResearch(key: string, reply: TResearchReply): { research: TVendorResearch | null; errors: string[] } {
  const parsed = VendorResearch.safeParse({ key, ...reply })
  if (!parsed.success) return { research: null, errors: parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`) }
  if (parsed.data.confidence === 'none' && (parsed.data.profile || parsed.data.sources.length)) {
    return { research: null, errors: ['confidence "none" needs profile: null and sources: []'] }
  }
  return { research: withRfc3986Urls(parsed.data), errors: [] }
}

type TDeps = { ctx: TLlmContext; fetcher: TPageFetcher; result: TResearchPhaseResult }

function skipForRetry({ ctx, result }: TDeps, fk: string, cacheKey: string, key: string): boolean {
  const decision = retryDecision(ctx.state.failures[fk], cacheKey, ctx.today)
  if (decision === 'wait') result.waiting.push(key)
  if (decision === 'gave_up') result.gaveUp.push(key)
  return decision !== 'try'
}

function fail({ ctx, result }: TDeps, fk: string, cacheKey: string, key: string, error: string): void {
  recordFailure(ctx.state, fk, cacheKey, ctx.today, error)
  ctx.dirty = true
  result.failed.push({ key, error })
}

function clearFailure(ctx: TLlmContext, fk: string): void {
  if (!ctx.state.failures[fk]) return
  delete ctx.state.failures[fk]
  ctx.dirty = true
}

async function researchOne(deps: TDeps, system: string, key: string): Promise<TVendorResearchRecord | null> {
  const { ctx, fetcher, result } = deps
  const fk = vendorFailureKey('research', key)
  if (skipForRetry(deps, fk, API_RESEARCH_PROMPT_VERSION, key) || overBudget(ctx)) return null

  const input = await readVendorInput(key)
  const answer = await ctx.llm.ask({
    model: MODELS.research,
    effort: EFFORT.research,
    system,
    user: JSON.stringify(input, null, 2),
    schema: ResearchReply,
    tools: WEB_TOOLS,
    validate: async reply => {
      const { research, errors } = toResearch(key, reply)
      if (!research) return errors
      return (await runResearchChecks(research, fetcher)).filter(c => !c.pass && c.severity === 'error').map(c => `${c.field}: ${c.detail}`)
    },
  })
  charge(ctx, answer.usage)
  // A reply that passed the schema but not every check is still kept; the build drops the failed fields.
  const reply = answer.reply ?? answer.lastReply ?? null
  const research = reply ? toResearch(key, reply).research : null
  const modelId = answer.modelId ?? (research ? MODELS.research : null)
  if (!research || !modelId) {
    fail(deps, fk, API_RESEARCH_PROMPT_VERSION, key, answer.refusal ?? answer.errors.join('; '))
    return null
  }
  const checks = await runResearchChecks(research, fetcher)
  const rec = toResearchRecord(research, checks, modelId, API_RESEARCH_PROMPT_VERSION, ctx.today)
  await writeResearchRecord(rec)
  clearFailure(ctx, fk)
  result.researched.push({ key, confidence: research.confidence })
  return rec
}

async function reviewOne(deps: TDeps, system: string, rec: TVendorResearchRecord): Promise<void> {
  const { ctx, result } = deps
  const fk = vendorFailureKey('review', rec.key)
  if (skipForRetry(deps, fk, API_REVIEW_PROMPT_VERSION, rec.key) || overBudget(ctx)) return

  const vendor = await readVendorInput(rec.key)
  const answer = await ctx.llm.ask({
    model: MODELS.review,
    effort: EFFORT.review,
    system,
    user: JSON.stringify({ vendor, candidate: rec.research }, null, 2),
    schema: ReviewReply,
    tools: WEB_TOOLS,
    validate: () => [],
  })
  charge(ctx, answer.usage)
  if (!answer.reply) {
    fail(deps, fk, API_REVIEW_PROMPT_VERSION, rec.key, answer.refusal ?? answer.errors.join('; '))
    return
  }
  const review = { key: rec.key, ...answer.reply }
  const publishable = isPublishable(rec, review)
  await writeResearchRecord({ ...rec, review, publishable })
  clearFailure(ctx, fk)
  result.reviewed.push({ key: rec.key, publishable })
}

/** Run after a build, so the vendor index includes vendors from this run's new summaries. */
export async function researchPhase({ llm, today, limit = researchPerRun(), fetcher = fetchPage }: { llm?: ILlm; today: string; limit?: number; fetcher?: TPageFetcher }): Promise<TResearchPhaseResult> {
  const state = await readLlmState()
  const capUsd = monthlyCap()
  const pending = await unresearchedVendors()
  const result: TResearchPhaseResult = {
    status: 'ran', reason: null, researched: [], reviewed: [], failed: [], waiting: [], gaveUp: [],
    remaining: pending.length, usage: null, monthSpendUsd: state.spend[today.slice(0, 7)] ?? 0, capUsd,
  }
  const reviews = await pendingReviews()
  if (pending.length === 0 && reviews.length === 0) return result
  if (!llm && !hasLlmCredentials()) return { ...result, status: 'skipped', reason: 'no ANTHROPIC_API_KEY' }

  const ctx = newContext(llm ?? anthropicLlm(), state, today, capUsd)
  const deps: TDeps = { ctx, fetcher, result }
  try {
    // Review anything left unreviewed by an earlier run first, then research and review the new ones.
    if (reviews.length) {
      const system = await readPrompt(API_REVIEW_PROMPT_VERSION)
      await mapLimit(reviews.slice(0, limit), CONCURRENCY, rec => reviewOne(deps, system, rec))
    }
    if (pending.length && limit > 0) {
      const [researchSystem, reviewSystem] = await Promise.all([readPrompt(API_RESEARCH_PROMPT_VERSION), readPrompt(API_REVIEW_PROMPT_VERSION)])
      await mapLimit(pending.slice(0, limit), CONCURRENCY, async key => {
        const rec = await researchOne(deps, researchSystem, key)
        if (rec?.research.confidence === 'high' && rec.research.profile) await reviewOne(deps, reviewSystem, rec)
      })
    }
  } finally {
    if (ctx.dirty) await writeLlmState(ctx.state)
  }
  // Workers finish in any order; report in queue order (largest vendors first).
  const order = new Map(pending.map((k, i) => [k, i]))
  result.researched.sort((a, b) => order.get(a.key)! - order.get(b.key)!)
  result.reviewed.sort((a, b) => a.key.localeCompare(b.key))
  result.remaining = pending.length - result.researched.length
  result.status = ctx.capped ? 'capped' : 'ran'
  result.reason = ctx.capped ? `monthly cap of $${capUsd} reached` : null
  result.usage = ctx.usage
  result.monthSpendUsd = monthSpend(ctx)
  return result
}
