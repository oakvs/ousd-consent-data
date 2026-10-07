/**
 * Unattended second readings through the Claude API. Which items get read,
 * and for what, is decided by `tasksForMeeting` exactly as in the agent
 * workflow; the reader never sees the first reading's numbers.
 *
 * Two passes per run: first readings, then follow-ups the first readings
 * call for. A money disagreement that changes totals gets a third,
 * tie-breaking reading from a different model.
 */
import type { TVerificationsFile } from '@oakvs/consent-schema/schema'

import { checkVerification, storeVerification, tasksForMeeting } from '../enrich/verify-io'
import { paths, readEnrichments, readVerifications, writeJson } from '../store'

import { EFFORT, MODELS, mapLimit } from './client'
import { charge, emptyStage, overBudget, readPrompt, serialSaver } from './context'
import { VerifyReply } from './schemas'
import { failureKey, recordFailure, retryDecision } from './state'

import type { TVerifyInputItem } from '../enrich/verify-io'
import type { TLlmContext, TStageResult } from './context'

export const VERIFY_API_PROMPT_VERSION = 'verify.v2.md'
const CONCURRENCY = 4

export async function verifyMeeting(ctx: TLlmContext, key: string): Promise<TStageResult> {
  const result = emptyStage()
  const system = await readPrompt(VERIFY_API_PROMPT_VERSION)

  for (const pass of ['first', 'followUp'] as const) {
    const tasks = (await tasksForMeeting(key)).filter(t => (pass === 'first' ? !t.followUp : t.followUp))
    if (tasks.length === 0) continue
    const enrichments = await readEnrichments(key)
    if (!enrichments) return result
    const file: TVerificationsFile = (await readVerifications(key)) ?? { meetingKey: key, items: {} }
    const save = serialSaver(() => writeJson(paths.verifications(key), file))

    const one = async (task: TVerifyInputItem): Promise<void> => {
      const record = enrichments.items[task.file]
      if (!record) return
      const label = task.followUp ? `${task.file}:${task.followUp}` : task.file
      const fk = failureKey('verify', key, label)
      const decision = retryDecision(ctx.state.failures[fk], record.cacheKey, ctx.today)
      if (decision === 'wait') return void result.waiting.push(label)
      if (decision === 'gave_up') return void result.gaveUp.push(label)
      if (overBudget(ctx)) return

      const tiebreak = task.followUp === 'tiebreak'
      const input = {
        meetingKey: key,
        item: {
          file: task.file,
          agendaNumber: task.agendaNumber,
          title: task.title,
          text: task.text,
          tasks: task.tasks,
          candidate: task.candidate,
          headline: task.headline,
          vendorName: task.vendorName,
        },
      }
      const answer = await ctx.llm.ask({
        model: tiebreak ? MODELS.tiebreak : MODELS.verify,
        effort: tiebreak ? EFFORT.tiebreak : EFFORT.verify,
        system,
        user: JSON.stringify(input, null, 2),
        schema: VerifyReply,
        validate: reply => checkVerification(task, reply).problems,
      })
      charge(ctx, answer.usage)
      const output = answer.reply ? checkVerification(task, answer.reply).output : null
      const stored = output && answer.modelId
        ? storeVerification(file, task.file, record.cacheKey, output, {
          modelId: answer.modelId,
          promptVersion: VERIFY_API_PROMPT_VERSION,
          followUp: task.followUp ?? null,
        })
        : false
      if (!stored) {
        const error = answer.refusal ?? (answer.errors.join('; ') || 'nothing to attach the follow-up reading to')
        recordFailure(ctx.state, fk, record.cacheKey, ctx.today, error)
        ctx.dirty = true
        result.failed.push({ file: label, error })
        return
      }
      if (ctx.state.failures[fk]) {
        delete ctx.state.failures[fk]
        ctx.dirty = true
      }
      result.done.push(label)
      await save()
    }

    await one(tasks[0])
    await mapLimit(tasks.slice(1), CONCURRENCY, one)
  }
  return result
}
