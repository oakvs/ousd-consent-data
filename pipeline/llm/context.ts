/** Shared state for one LLM step: the client, the ledger, spend and the monthly cap. */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { addUsage, emptyUsage } from './client'
import { monthOf } from './state'

import type { ILlm, TUsage } from './client'
import type { TLlmState } from './state'

export type TLlmContext = {
  llm: ILlm
  state: TLlmState
  today: string
  capUsd: number
  usage: TUsage
  /** Set once the monthly cap stops further calls. */
  capped: boolean
  /** Whether `state` changed and needs writing. */
  dirty: boolean
}

export function newContext(llm: ILlm, state: TLlmState, today: string, capUsd: number): TLlmContext {
  return { llm, state, today, capUsd, usage: emptyUsage(), capped: false, dirty: false }
}

export const monthSpend = (ctx: TLlmContext): number => ctx.state.spend[monthOf(ctx.today)] ?? 0

/** True (and marks the step capped) once this month's spend has reached the cap. */
export function overBudget(ctx: TLlmContext): boolean {
  if (monthSpend(ctx) >= ctx.capUsd) ctx.capped = true
  return ctx.capped
}

export function charge(ctx: TLlmContext, usage: TUsage): void {
  if (usage.requests === 0) return
  addUsage(ctx.usage, usage)
  const month = monthOf(ctx.today)
  ctx.state.spend[month] = Math.round((monthSpend(ctx) + usage.costUsd) * 10_000) / 10_000
  ctx.dirty = true
}

export const readPrompt = (name: string): Promise<string> => readFile(path.join(process.cwd(), 'pipeline', 'prompts', name), 'utf8')

/** Serialize writes to one file from concurrent workers. */
export function serialSaver(save: () => Promise<void>): () => Promise<void> {
  let chain = Promise.resolve()
  return () => (chain = chain.then(save))
}

export type TStageResult = {
  done: string[]
  failed: { file: string; error: string }[]
  /** Failed earlier today; retried tomorrow. */
  waiting: string[]
  /** Failed on GIVE_UP_AFTER days; needs a human. */
  gaveUp: string[]
}

export const emptyStage = (): TStageResult => ({ done: [], failed: [], waiting: [], gaveUp: [] })
