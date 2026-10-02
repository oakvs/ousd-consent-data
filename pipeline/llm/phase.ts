/**
 * The LLM step of `consent run` (BRIEF §3, step 3): summaries for new or
 * changed items, then second readings, for every meeting. Raw data is
 * already public by now; if this step fails or is capped, the next run
 * retries it.
 */
import { tasksForMeeting } from '../enrich/verify-io'
import { listRawKeys } from '../store'

import { anthropicLlm, hasLlmCredentials } from './client'
import { monthSpend, newContext } from './context'
import { enrichMeeting, pendingEnrichments } from './enrich'
import { monthlyCap, readLlmState, writeLlmState } from './state'
import { verifyMeeting } from './verify'

import type { ILlm, TUsage } from './client'
import type { TStageResult } from './context'

export type TLlmMeetingResult = { key: string; enrich: TStageResult; verify: TStageResult }

export type TLlmPhaseResult = {
  status: 'ran' | 'skipped' | 'capped'
  reason: string | null
  meetings: TLlmMeetingResult[]
  usage: TUsage | null
  monthSpendUsd: number
  capUsd: number
}

const active = (s: TStageResult): boolean => s.done.length + s.failed.length + s.waiting.length + s.gaveUp.length > 0

export async function llmPhase({ llm, today, keys }: { llm?: ILlm; today: string; keys?: string[] }): Promise<TLlmPhaseResult> {
  const state = await readLlmState()
  const capUsd = monthlyCap()
  if (!llm && !hasLlmCredentials()) {
    return { status: 'skipped', reason: 'no ANTHROPIC_API_KEY', meetings: [], usage: null, monthSpendUsd: state.spend[today.slice(0, 7)] ?? 0, capUsd }
  }
  const ctx = newContext(llm ?? anthropicLlm(), state, today, capUsd)
  const meetings: TLlmMeetingResult[] = []
  try {
    for (const key of keys ?? await listRawKeys()) {
      const enrich = await enrichMeeting(ctx, key)
      const verify = await verifyMeeting(ctx, key)
      if (active(enrich) || active(verify)) meetings.push({ key, enrich, verify })
      if (ctx.capped) break
    }
  } finally {
    // Keep spend and failures even when the step dies part-way (e.g. an API outage).
    if (ctx.dirty) await writeLlmState(ctx.state)
  }
  return {
    status: ctx.capped ? 'capped' : 'ran',
    reason: ctx.capped ? `monthly cap of $${capUsd} reached` : null,
    meetings,
    usage: ctx.usage,
    monthSpendUsd: monthSpend(ctx),
    capUsd,
  }
}

/** What the LLM step would do now, without calling the API (for --dry-run). */
export async function llmPlan(keys?: string[]): Promise<{ key: string; enrich: number; verify: number }[]> {
  const out: { key: string; enrich: number; verify: number }[] = []
  for (const key of keys ?? await listRawKeys()) {
    const [enrich, verify] = await Promise.all([pendingEnrichments(key), tasksForMeeting(key)])
    if (enrich.length || verify.length) out.push({ key, enrich: enrich.length, verify: verify.length })
  }
  return out
}
