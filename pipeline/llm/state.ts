/**
 * LLM bookkeeping in `data/llm-state.json` (committed, never published):
 *
 * - spend per month, so a monthly cap can stop the LLM step
 * - items (and vendors being researched) whose reply kept failing the checks (or was declined). Each is
 *   retried at most once a day, and given up on after GIVE_UP_AFTER days, so
 *   one stubborn item can't cost money every 30 minutes. A change to the
 *   item's text (a new cache key) starts over.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { IsoDate } from '@oakvs/consent-schema/schema'
import { z } from 'zod'

import { getDataRoot, writeJson } from '../store'

export const GIVE_UP_AFTER = 3
/** Default monthly cap in USD; override with CONSENT_LLM_MONTHLY_CAP_USD. */
export const DEFAULT_MONTHLY_CAP_USD = 25

const Failure = z.object({
  /** What was being processed: the item's enrichment cache key (enrich) or its enrichment's (verify). */
  cacheKey: z.string(),
  attempts: z.number(),
  lastTriedOn: IsoDate,
  lastError: z.string(),
})
export type TFailure = z.infer<typeof Failure>

const LlmState = z.object({
  /** "YYYY-MM" → estimated USD. */
  spend: z.record(z.string(), z.number()),
  /** `${stage}:${meetingKey}:${file}` (or `${stage}:${vendorKey}` for vendor research) → the latest failure. */
  failures: z.record(z.string(), Failure),
})
export type TLlmState = z.infer<typeof LlmState>

const statePath = (): string => path.join(getDataRoot(), 'llm-state.json')

export async function readLlmState(): Promise<TLlmState> {
  try {
    return LlmState.parse(JSON.parse(await readFile(statePath(), 'utf8')))
  } catch {
    return { spend: {}, failures: {} }
  }
}

export const writeLlmState = (state: TLlmState): Promise<void> => writeJson(statePath(), state)

export const failureKey = (stage: 'enrich' | 'verify', meetingKey: string, file: string): string => `${stage}:${meetingKey}:${file}`

/** `${stage}:${vendorKey}`, for vendor research and its review. */
export const vendorFailureKey = (stage: 'research' | 'review', vendorKey: string): string => `${stage}:${vendorKey}`

export type TRetryDecision = 'try' | 'wait' | 'gave_up'

/** Whether to spend a call on an item that may have failed before. */
export function retryDecision(failure: TFailure | undefined, cacheKey: string, today: string): TRetryDecision {
  if (!failure || failure.cacheKey !== cacheKey) return 'try'
  if (failure.attempts >= GIVE_UP_AFTER) return 'gave_up'
  return failure.lastTriedOn === today ? 'wait' : 'try'
}

export function recordFailure(state: TLlmState, key: string, cacheKey: string, today: string, error: string): TFailure {
  const previous = state.failures[key]
  const attempts = previous?.cacheKey === cacheKey ? previous.attempts + 1 : 1
  const failure = { cacheKey, attempts, lastTriedOn: today, lastError: error.slice(0, 500) }
  state.failures[key] = failure
  return failure
}

export const monthOf = (today: string): string => today.slice(0, 7)

export function monthlyCap(): number {
  const raw = Number(process.env.CONSENT_LLM_MONTHLY_CAP_USD)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MONTHLY_CAP_USD
}
