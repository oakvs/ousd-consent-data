/**
 * The duplicate-vendor judge in `consent run`: the same candidates and
 * checks as `vendor-candidates` / `vendor-merge-check` / `vendor-merge-apply`,
 * one group per Claude API request.
 *
 * Candidate groups come from the built vendor index, minus groups already
 * decided (data/vendors/merge-decisions.json). Each decision is checked in
 * code; merges become `manual` aliases and every decision is logged with the
 * model that made it, so a group is judged once. The prompt is conservative:
 * a wrong merge is much worse than a missed one.
 */
import { applyDecisions, candidateGroups, checkDecision } from '../build/vendor-candidates'

import { EFFORT, MODELS, anthropicLlm, hasLlmCredentials, mapLimit } from './client'
import { charge, monthSpend, newContext, overBudget, readPrompt } from './context'
import { MergeReply } from './schemas'
import { monthlyCap, readLlmState, recordFailure, retryDecision, vendorFailureKey, writeLlmState } from './state'

import type { TCandidateGroup, TJudgeDecision } from '../build/vendor-candidates'
import type { ILlm, TUsage } from './client'

export const API_MERGE_PROMPT_VERSION = 'vendor-merge.v2.md'
/** Groups judged per run; the rest wait. Override with CONSENT_MERGE_PER_RUN. */
export const DEFAULT_MERGE_PER_RUN = 10
const CONCURRENCY = 3

export function mergePerRun(): number {
  const raw = Number(process.env.CONSENT_MERGE_PER_RUN)
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_MERGE_PER_RUN
}

export type TMergePhaseResult = {
  status: 'ran' | 'skipped' | 'capped'
  reason: string | null
  /** Each merge: the vendors folded in, the one they joined, and why. */
  merged: { into: string; from: string[]; reason: string }[]
  /** Groups the judge kept separate. */
  kept: number
  failed: { key: string; error: string }[]
  waiting: string[]
  gaveUp: string[]
  /** Undecided groups left for later runs. */
  remaining: number
  usage: TUsage | null
  monthSpendUsd: number
  capUsd: number
}

const groupId = (g: TCandidateGroup): string => g.vendors.map(v => v.key).sort().join('|')

/** Run after a build, so candidates include vendors from this run's new summaries. */
export async function mergePhase({ llm, today, limit = mergePerRun() }: { llm?: ILlm; today: string; limit?: number }): Promise<TMergePhaseResult> {
  const state = await readLlmState()
  const capUsd = monthlyCap()
  const groups = await candidateGroups()
  const result: TMergePhaseResult = {
    status: 'ran', reason: null, merged: [], kept: 0, failed: [], waiting: [], gaveUp: [],
    remaining: groups.length, usage: null, monthSpendUsd: state.spend[today.slice(0, 7)] ?? 0, capUsd,
  }
  if (groups.length === 0 || limit === 0) return result
  if (!llm && !hasLlmCredentials()) return { ...result, status: 'skipped', reason: 'no ANTHROPIC_API_KEY' }

  const ctx = newContext(llm ?? anthropicLlm(), state, today, capUsd)
  const system = await readPrompt(API_MERGE_PROMPT_VERSION)
  const accepted: { group: TCandidateGroup; decision: Omit<TJudgeDecision, 'group'>; modelId: string }[] = []
  try {
    await mapLimit(groups.slice(0, limit), CONCURRENCY, async group => {
      const id = groupId(group)
      const fk = vendorFailureKey('merge', id)
      const decision = retryDecision(ctx.state.failures[fk], API_MERGE_PROMPT_VERSION, today)
      if (decision === 'wait') return void result.waiting.push(id)
      if (decision === 'gave_up') return void result.gaveUp.push(id)
      if (overBudget(ctx)) return

      const answer = await ctx.llm.ask({
        model: MODELS.merge,
        effort: EFFORT.merge,
        system,
        user: JSON.stringify(group, null, 2),
        schema: MergeReply,
        validate: reply => checkDecision(group, reply),
      })
      charge(ctx, answer.usage)
      if (!answer.reply || !answer.modelId) {
        const error = answer.refusal ?? answer.errors.join('; ')
        recordFailure(ctx.state, fk, API_MERGE_PROMPT_VERSION, today, error)
        ctx.dirty = true
        result.failed.push({ key: id, error })
        return
      }
      if (ctx.state.failures[fk]) {
        delete ctx.state.failures[fk]
        ctx.dirty = true
      }
      accepted.push({ group, decision: answer.reply, modelId: answer.modelId })
    })
  } finally {
    if (ctx.dirty) await writeLlmState(ctx.state)
  }

  // Apply in candidate order, so the log and aliases come out the same however the workers finished.
  accepted.sort((a, b) => a.group.group.localeCompare(b.group.group))
  for (const modelId of [...new Set(accepted.map(a => a.modelId))].sort()) {
    await applyDecisions(accepted.filter(a => a.modelId === modelId), modelId, today)
  }
  for (const { decision: d } of accepted) {
    if (d.merge.length && d.into) result.merged.push({ into: d.into, from: [...d.merge].sort(), reason: d.reason })
    else result.kept++
  }
  result.remaining = groups.length - accepted.length
  result.status = ctx.capped ? 'capped' : 'ran'
  result.reason = ctx.capped ? `monthly cap of $${capUsd} reached` : null
  result.usage = ctx.usage
  result.monthSpendUsd = monthSpend(ctx)
  return result
}
