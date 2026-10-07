/**
 * Claude API access for the unattended LLM steps.
 *
 * - Pinned models: Opus writes summaries, Sonnet does the
 *   independent second reading, Opus breaks money ties. Override with
 *   CONSENT_ENRICH_MODEL / CONSENT_VERIFY_MODEL / CONSENT_TIEBREAK_MODEL.
 * - Structured outputs constrain the reply's shape; code checks the values,
 *   and a failed check goes back to the model, up to 3 attempts.
 * - The long system prompt is cached; each request carries one item.
 * - Server-side refusal fallbacks (`fallbacks: "default"`) are on. A reply
 *   served by a fallback model records that model's id, never the requested one.
 * - Vendor research also gets the server-side web tools (search and fetch).
 *   Those requests are a conversation: a paused tool loop (`pause_turn`) is
 *   continued, and failed checks go back as a new turn, so the pages already
 *   read aren't fetched again.
 */
import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'

import type { z } from 'zod'

export const MODELS = {
  enrich: process.env.CONSENT_ENRICH_MODEL ?? 'claude-opus-5-5',
  verify: process.env.CONSENT_VERIFY_MODEL ?? 'claude-sonnet-5-5',
  tiebreak: process.env.CONSENT_TIEBREAK_MODEL ?? 'claude-opus-5-5',
  /** Vendor research with web search; a different model does the independent review. */
  research: process.env.CONSENT_RESEARCH_MODEL ?? 'claude-sonnet-5-5',
  review: process.env.CONSENT_REVIEW_MODEL ?? 'claude-opus-5-5',
  /** Duplicate-vendor judge: a wrong merge puts one organization's contracts on another's page. */
  merge: process.env.CONSENT_MERGE_MODEL ?? 'claude-opus-5-5',
} as const

export type TEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Effort is set explicitly: Opus 5.5 defaults to `medium`, and these readings decide what gets published as fact. */
export const EFFORT: Record<keyof typeof MODELS, TEffort> = { enrich: 'high', verify: 'high', tiebreak: 'high', research: 'high', review: 'high', merge: 'high' }

/** USD per web search (web fetch has no per-use charge, only tokens). */
export const WEB_SEARCH_USD = 0.01

/** USD per million tokens. Cache writes (5-minute TTL) cost 1.25× input. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  // Possible fallback targets.
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
}

export type TUsage = { requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }

export const emptyUsage = (): TUsage => ({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 })

export function addUsage(into: TUsage, add: TUsage): void {
  into.requests += add.requests
  into.inputTokens += add.inputTokens
  into.outputTokens += add.outputTokens
  into.cacheReadTokens += add.cacheReadTokens
  into.cacheWriteTokens += add.cacheWriteTokens
  into.costUsd += add.costUsd
}

export function costOf(model: string, u: Omit<TUsage, 'costUsd' | 'requests'>): number {
  const p = PRICES[model] ?? PRICES['claude-opus-5-5']
  return (u.inputTokens * p.input + u.cacheWriteTokens * p.input * 1.25 + u.cacheReadTokens * p.cacheRead + u.outputTokens * p.output) / 1_000_000
}

export type TAskRequest<T> = {
  model: string
  effort: TEffort
  system: string
  /** The item, as the user message. */
  user: string
  schema: z.ZodType<T>
  /** Value checks on a schema-valid reply; an empty list means it passes. */
  validate: (reply: T) => string[] | Promise<string[]>
  maxAttempts?: number
  /** Server-side tools (web search and fetch) the model may use. */
  tools?: Anthropic.Beta.BetaToolUnion[]
}

export type TAskResult<T> = {
  reply: T | null
  /** The model that actually served the accepted reply (a fallback model, if one ran). */
  modelId: string | null
  attempts: number
  /** The last attempt's problems, when no reply was accepted. */
  errors: string[]
  /** The last schema-valid reply, even when it failed the checks. */
  lastReply?: T | null
  /** Set when the model (and any fallback) declined. */
  refusal: string | null
  usage: TUsage
}

/** The seam the enrichment and verification code talks to; tests pass a fake. */
export interface ILlm {
  ask<T>(request: TAskRequest<T>): Promise<TAskResult<T>>
}

const MAX_TOKENS = 16_000
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
/** How many times a paused server-tool loop is continued before the attempt counts as failed. */
const MAX_CONTINUATIONS = 4

function retryMessage(user: string, previous: unknown, errors: string[]): string {
  return `${user}\n\nA previous reply for this item failed these checks:\n${errors.map(e => `- ${e}`).join('\n')}\n\nThe previous reply was:\n${JSON.stringify(previous, null, 2)}\n\nFix every problem and reply with the corrected object.`
}

/** Add a reply to the conversation; a turn continued after `pause_turn` stays one assistant message. */
function appendAssistant(messages: Anthropic.Beta.BetaMessageParam[], content: Anthropic.Beta.BetaContentBlockParam[]): void {
  const last = messages.at(-1)
  if (last?.role === 'assistant' && Array.isArray(last.content)) last.content = [...last.content, ...content]
  else messages.push({ role: 'assistant', content })
}

/** True when credentials for the Claude API are configured in the environment. */
export const hasLlmCredentials = (): boolean => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)

export function anthropicLlm(client: Anthropic = new Anthropic({ maxRetries: 4 })): ILlm {
  return {
    async ask<T>({ model, effort, system, user, schema, validate, maxAttempts = 3, tools }: TAskRequest<T>): Promise<TAskResult<T>> {
      const usage = emptyUsage()
      let errors: string[] = []
      let lastReply: T | null = null
      // Without tools, each retry is a fresh single-turn request that quotes the failed reply, so no
      // thinking blocks are ever replayed. With tools, the conversation continues instead (blocks are
      // sent back unchanged), so the model keeps the pages it already read.
      const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: user }]
      let continuations = 0
      for (let attempt = 1; attempt <= maxAttempts;) {
        let response
        try {
          response = await client.beta.messages.parse({
            model,
            max_tokens: MAX_TOKENS,
            betas: [FALLBACK_BETA],
            fallbacks: 'default',
            thinking: { type: 'adaptive' },
            output_config: { effort, format: betaZodOutputFormat(schema) },
            system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
            messages: [...messages],
            ...(tools ? { tools } : {}),
          })
        } catch (error) {
          // API failures (auth, persistent 429/5xx after the SDK's retries) stop the step.
          if (error instanceof Anthropic.APIError) throw error
          // Anything else is the reply failing to parse against the schema.
          errors = [`reply did not match the schema: ${(error as Error).message}`]
          attempt++
          continue
        }
        const served = response.model
        const u = response.usage
        const tokens = {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        }
        const searches = u.server_tool_use?.web_search_requests ?? 0
        addUsage(usage, { requests: 1, ...tokens, costUsd: costOf(served, tokens) + searches * WEB_SEARCH_USD })

        if (response.stop_reason === 'refusal') {
          const category = response.stop_details?.category ?? 'unspecified'
          return { reply: null, modelId: null, attempts: attempt, errors: [], refusal: `declined (${category})`, usage, lastReply }
        }
        if (response.stop_reason === 'pause_turn' && tools && continuations < MAX_CONTINUATIONS) {
          continuations++
          appendAssistant(messages, response.content as Anthropic.Beta.BetaContentBlockParam[])
          continue
        }
        const reply = response.parsed_output
        errors = response.stop_reason === 'max_tokens'
          ? ['reply was cut off (max_tokens)']
          : reply == null ? ['reply did not match the schema'] : await validate(reply)
        if (reply != null && response.stop_reason !== 'max_tokens') lastReply = reply
        if (errors.length === 0 && reply != null) return { reply, modelId: served, attempts: attempt, errors: [], refusal: null, usage, lastReply }
        attempt++
        if (tools) {
          appendAssistant(messages, response.content as Anthropic.Beta.BetaContentBlockParam[])
          messages.push({ role: 'user', content: `Your reply failed these checks:\n${errors.map(e => `- ${e}`).join('\n')}\n\nFix every problem and reply with the corrected object.` })
        } else if (reply != null) {
          messages[0] = { role: 'user', content: retryMessage(user, reply, errors) }
        }
      }
      return { reply: null, modelId: null, attempts: maxAttempts, errors, refusal: null, usage, lastReply }
    },
  }
}

/** Run `fn` over `items`, at most `limit` at a time, in order of completion. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
