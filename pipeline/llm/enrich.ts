/**
 * Unattended enrichment through the Claude API: one item per request, the
 * same checks as the agent workflow (`checkEnrichment`), up to 3 attempts
 * with the errors fed back. An item needs enrichment when it has no record,
 * or when its text or title changed since its record was written.
 */
import type { TEnrichmentRecord, TEnrichmentsFile, TRawItem } from '@oakvs/consent-schema/schema'

import { checkEnrichment } from '../enrich/agent-io'
import { enrichmentCacheKey } from '../import/prototype'
import { paths, readEnrichments, readRaw, writeJson } from '../store'

import { EFFORT, MODELS, mapLimit } from './client'
import { charge, emptyStage, overBudget, readPrompt, serialSaver } from './context'
import { EnrichmentReply, toEnrichmentCandidate } from './schemas'
import { failureKey, recordFailure, retryDecision } from './state'

import type { TLlmContext, TStageResult } from './context'
import type { TEnrichmentReply } from './schemas'

export const ENRICH_PROMPT_VERSION = 'enrich.v6.md'
const CONCURRENCY = 4

/** True when the item has no record, or its record was written for different text or title. */
export function needsEnrichment(item: Pick<TRawItem, 'text' | 'title'>, record: TEnrichmentRecord | undefined): boolean {
  return !record || enrichmentCacheKey(item.text, item.title, record.promptVersion, record.modelId) !== record.cacheKey
}

export async function pendingEnrichments(key: string): Promise<TRawItem[]> {
  const [raw, existing] = await Promise.all([readRaw(key), readEnrichments(key)])
  return raw?.items.filter(i => needsEnrichment(i, existing?.items[i.file])) ?? []
}

const errorsOf = (text: string, reply: TEnrichmentReply): string[] =>
  checkEnrichment(text, toEnrichmentCandidate(reply)).problems.filter(p => p.severity === 'error').map(p => p.message)

export async function enrichMeeting(ctx: TLlmContext, key: string): Promise<TStageResult> {
  const result = emptyStage()
  const todo = await pendingEnrichments(key)
  if (todo.length === 0) return result
  const system = await readPrompt(ENRICH_PROMPT_VERSION)
  const file: TEnrichmentsFile = (await readEnrichments(key)) ?? { meetingKey: key, items: {} }
  const save = serialSaver(() => writeJson(paths.enrichments(key), file))

  const one = async (item: TRawItem): Promise<void> => {
    const fk = failureKey('enrich', key, item.file)
    // Model-independent identity of what is being summarized, for the failure ledger.
    const textKey = enrichmentCacheKey(item.text, item.title, ENRICH_PROMPT_VERSION, '')
    const decision = retryDecision(ctx.state.failures[fk], textKey, ctx.today)
    if (decision === 'wait') return void result.waiting.push(item.file)
    if (decision === 'gave_up') return void result.gaveUp.push(item.file)
    if (overBudget(ctx)) return

    const input = {
      meetingKey: key,
      meetingDate: key.slice(0, 10),
      item: {
        file: item.file,
        agendaNumber: item.agendaNumber,
        title: item.title,
        text: item.text,
        matterType: item.matterType,
        presenter: item.presenter,
        group: item.group,
        fundingSource: item.fundingSource,
      },
    }
    const answer = await ctx.llm.ask({
      model: MODELS.enrich,
      effort: EFFORT.enrich,
      system,
      user: JSON.stringify(input, null, 2),
      schema: EnrichmentReply,
      validate: reply => errorsOf(item.text, reply),
    })
    charge(ctx, answer.usage)
    const enrichment = answer.reply ? checkEnrichment(item.text, toEnrichmentCandidate(answer.reply)).enrichment : null
    if (!answer.reply || !answer.modelId || !enrichment) {
      const error = answer.refusal ?? answer.errors.join('; ')
      recordFailure(ctx.state, fk, textKey, ctx.today, error)
      ctx.dirty = true
      result.failed.push({ file: item.file, error })
      return
    }
    file.items[item.file] = {
      modelId: answer.modelId,
      promptVersion: ENRICH_PROMPT_VERSION,
      cacheKey: enrichmentCacheKey(item.text, item.title, ENRICH_PROMPT_VERSION, answer.modelId),
      output: enrichment,
    }
    if (ctx.state.failures[fk]) {
      delete ctx.state.failures[fk]
      ctx.dirty = true
    }
    result.done.push(item.file)
    await save()
  }

  // The first request writes the prompt cache; the rest can then read it.
  await one(todo[0])
  await mapLimit(todo.slice(1), CONCURRENCY, one)
  return result
}
