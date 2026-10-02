import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { TEnrichment, TRawSnapshot, TVerifiedMoney } from '@oakvs/consent-schema/schema'

import { enrichmentCacheKey } from '../import/prototype'
import { anthropicLlm, MODELS } from '../llm/client'
import { needsEnrichment } from '../llm/enrich'
import { llmPhase } from '../llm/phase'
import { EnrichmentReply, toEnrichmentCandidate } from '../llm/schemas'
import { readLlmState, retryDecision } from '../llm/state'
import { llmCommitMessage } from '../run/message'
import { getDataRoot, listRawKeys, readEnrichments, readRaw, readVerifications, setDataRoot, stableStringify } from '../store'

import type Anthropic from '@anthropic-ai/sdk'
import type { ILlm, TAskRequest, TAskResult } from '../llm/client'
import type { TEnrichmentReply } from '../llm/schemas'

const REAL = getDataRoot()

/** A stored enrichment in the API reply shape (the inverse of toEnrichmentCandidate). */
function toReply(e: TEnrichment): TEnrichmentReply {
  return EnrichmentReply.parse({
    ...e,
    money: { ...e.money, byYear: Object.entries(e.money.byYear).map(([year, amount]) => ({ year, amount })) },
  })
}

describe('API reply shape', () => {
  it('round-trips every stored enrichment exactly', async () => {
    const { checkEnrichment } = await import('../enrich/agent-io')
    let n = 0
    for (const key of await listRawKeys()) {
      const [raw, enrichments] = await Promise.all([readRaw(key), readEnrichments(key)])
      for (const item of raw!.items) {
        const stored = enrichments!.items[item.file].output
        const back = checkEnrichment(item.text, toEnrichmentCandidate(toReply(stored))).enrichment
        expect(stableStringify(back)).toBe(stableStringify(stored))
        n++
      }
    }
    expect(n).toBe(2149)
  })
})

describe('stale summaries', () => {
  it('needs a new summary when the text or title changes', () => {
    const record = { modelId: 'm', promptVersion: 'p', cacheKey: enrichmentCacheKey('text', 'title', 'p', 'm'), output: {} as TEnrichment }
    expect(needsEnrichment({ text: 'text', title: 'title' }, record)).toBe(false)
    expect(needsEnrichment({ text: 'text, amended', title: 'title' }, record)).toBe(true)
    expect(needsEnrichment({ text: 'text', title: 'title' }, undefined)).toBe(true)
  })
})

describe('retry ledger', () => {
  it('tries once a day and gives up after three days; new text starts over', () => {
    const f = { cacheKey: 'k', attempts: 1, lastTriedOn: '2026-10-14', lastError: 'x' }
    expect(retryDecision(undefined, 'k', '2026-10-14')).toBe('try')
    expect(retryDecision(f, 'k', '2026-10-14')).toBe('wait')
    expect(retryDecision(f, 'k', '2026-10-15')).toBe('try')
    expect(retryDecision({ ...f, attempts: 3 }, 'k', '2026-10-20')).toBe('gave_up')
    expect(retryDecision({ ...f, attempts: 3 }, 'other', '2026-10-20')).toBe('try')
  })
})

describe('Claude API wrapper', () => {
  type TParams = Record<string, unknown> & { messages: { content: string }[] }
  const response = (parsed: unknown, extra: Record<string, unknown> = {}): unknown => ({
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    stop_details: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 },
    parsed_output: parsed,
    ...extra,
  })
  const fakeClient = (responses: unknown[], calls: TParams[]): Anthropic =>
    ({ beta: { messages: { parse: async (p: TParams) => (calls.push(p), responses.shift()) } } }) as unknown as Anthropic

  const ask = (llm: ILlm): Promise<TAskResult<{ n: number }>> => llm.ask({
    model: 'claude-opus-5-5',
    effort: 'high',
    system: 'rules',
    user: '{"item":1}',
    schema: EnrichmentReply as never,
    validate: (r: { n: number }) => (r.n === 2 ? [] : [`n must be 2, got ${r.n}`]),
  } as TAskRequest<{ n: number }>)

  it('feeds check failures back and records the model that served the reply', async () => {
    const calls: TParams[] = []
    const result = await ask(anthropicLlm(fakeClient([response({ n: 1 }), response({ n: 2 }, { model: 'claude-opus-5' })], calls)))
    expect(result.reply).toEqual({ n: 2 })
    expect(result.modelId).toBe('claude-opus-5')
    expect(result.attempts).toBe(2)
    expect(result.usage.requests).toBe(2)
    expect(calls[1].messages[0].content).toContain('n must be 2, got 1')
    expect(calls[0]).toMatchObject({
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: [{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }],
    })
  })

  it('returns a refusal without retrying', async () => {
    const calls: TParams[] = []
    const result = await ask(anthropicLlm(fakeClient([response(null, { stop_reason: 'refusal', stop_details: { category: 'cyber' } })], calls)))
    expect(result).toMatchObject({ reply: null, refusal: 'declined (cyber)', attempts: 1 })
    expect(calls).toHaveLength(1)
  })

  it('gives up after three failed attempts', async () => {
    const calls: TParams[] = []
    const result = await ask(anthropicLlm(fakeClient([response({ n: 1 }), response({ n: 3 }), response({ n: 4 })], calls)))
    expect(result).toMatchObject({ reply: null, attempts: 3, errors: ['n must be 2, got 4'] })
  })
})

describe('LLM step', () => {
  const KEY = '2026-09-09'
  const FILES = ['26-1734', '26-1786'] // a $2.0M decrease and a $255K expense
  let stored: Record<string, TEnrichment>

  beforeEach(async () => {
    const raw = (await readRaw(KEY))!
    const enrichments = (await readEnrichments(KEY))!
    stored = Object.fromEntries(FILES.map(f => [f, enrichments.items[f].output]))
    const dir = await mkdtemp(path.join(os.tmpdir(), 'llm-test-'))
    const snapshot: TRawSnapshot = { ...raw, items: raw.items.filter(i => FILES.includes(i.file)) }
    await mkdir(path.join(dir, 'raw'), { recursive: true })
    await writeFile(path.join(dir, 'raw', `${KEY}.json`), stableStringify(snapshot))
    setDataRoot(dir)
  })

  afterEach(() => {
    setDataRoot(REAL)
    delete process.env.CONSENT_LLM_MONTHLY_CAP_USD
  })

  /** Answers like a careful model: the stored enrichment, and second readings that agree (or not). */
  function fakeLlm(opts: { secondReading?: (file: string, m: TVerifiedMoney, model: string) => TVerifiedMoney; fail?: string[] } = {}): ILlm & { asked: { model: string; file: string; tasks?: string[] }[] } {
    const asked: { model: string; file: string; tasks?: string[] }[] = []
    return {
      asked,
      async ask<T>(req: TAskRequest<T>): Promise<TAskResult<T>> {
        const { item } = JSON.parse(req.user) as { item: { file: string; tasks?: string[] } }
        asked.push({ model: req.model, file: item.file, tasks: item.tasks })
        const usage = { requests: 1, inputTokens: 100, outputTokens: 500, cacheReadTokens: 2500, cacheWriteTokens: 0, costUsd: 0.01 }
        if (opts.fail?.includes(item.file)) return { reply: null, modelId: null, attempts: 3, errors: ['evidence_substring: nope'], refusal: null, usage }
        const e = stored[item.file]
        const { direction, amountType, thisAction, priorTotal, newTotal } = e.money
        const money = { direction, amountType, thisAction, priorTotal, newTotal }
        const reply = item.tasks
          ? { money: opts.secondReading ? opts.secondReading(item.file, money, req.model) : money, issue: null, vendorKind: null, headlineFix: null }
          : toReply(e)
        const errors = req.validate(reply as T)
        if (errors.length) throw new Error(`fake reply failed checks: ${errors.join('; ')}`)
        return { reply: reply as T, modelId: req.model, attempts: 1, errors: [], refusal: null, usage }
      },
    }
  }

  it('writes summaries and second readings, with models, prompt versions and spend', async () => {
    const llm = fakeLlm()
    const phase = await llmPhase({ llm, today: '2026-10-14', keys: [KEY] })
    expect(phase.status).toBe('ran')
    expect(phase.meetings[0].enrich.done.sort()).toEqual(FILES)

    const enrichments = (await readEnrichments(KEY))!
    for (const f of FILES) {
      expect(enrichments.items[f]).toMatchObject({ modelId: MODELS.enrich, promptVersion: 'enrich.v4.md' })
      expect(stableStringify(enrichments.items[f].output)).toBe(stableStringify(stored[f]))
    }
    const verifications = (await readVerifications(KEY))!
    expect(Object.values(verifications.items).map(v => v.modelId)).toEqual(FILES.map(() => MODELS.verify))
    expect(llm.asked.filter(a => a.tasks).every(a => a.model === MODELS.verify)).toBe(true)
    expect((await readLlmState()).spend['2026-10']).toBeCloseTo(0.04)

    // A second run has nothing left to do.
    const again = fakeLlm()
    await llmPhase({ llm: again, today: '2026-10-14', keys: [KEY] })
    expect(again.asked).toEqual([])
  })

  it('asks a different model for a third reading when two readings disagree on totals', async () => {
    // The second reader (only) misreads one amount; the tie-breaker reads it like the first reader.
    const llm = fakeLlm({ secondReading: (file, m, model) => (file === '26-1786' && model === MODELS.verify ? { ...m, thisAction: 155_000 } : m) })
    await llmPhase({ llm, today: '2026-10-14', keys: [KEY] })
    const third = llm.asked.filter(a => a.model === MODELS.tiebreak && a.tasks)
    expect(third.map(a => a.file)).toEqual(['26-1786'])
    expect((await readVerifications(KEY))!.items['26-1786'].tiebreakMoney?.thisAction).toBe(255_000)
  })

  it('records failures, waits until tomorrow, and stops at the monthly cap', async () => {
    const failing = fakeLlm({ fail: ['26-1786'] })
    const first = await llmPhase({ llm: failing, today: '2026-10-14', keys: [KEY] })
    expect(first.meetings[0].enrich.failed.map(f => f.file)).toEqual(['26-1786'])
    expect((await readLlmState()).failures['enrich:2026-09-09:26-1786']).toMatchObject({ attempts: 1, lastTriedOn: '2026-10-14' })

    const sameDay = fakeLlm()
    const second = await llmPhase({ llm: sameDay, today: '2026-10-14', keys: [KEY] })
    expect(second.meetings[0].enrich.waiting).toEqual(['26-1786'])
    expect(sameDay.asked.filter(a => !a.tasks)).toEqual([])

    process.env.CONSENT_LLM_MONTHLY_CAP_USD = '0.001'
    const capped = fakeLlm()
    const third = await llmPhase({ llm: capped, today: '2026-10-15', keys: [KEY] })
    expect(third.status).toBe('capped')
    expect(capped.asked).toEqual([])
  })
})

describe('LLM commit message', () => {
  it('names summaries, second readings, flags and cost', () => {
    const m = llmCommitMessage({
      meetings: [{ key: '2026-10-14', summaries: 87, secondReadings: 24, failed: 1, waiting: 0, gaveUp: 0, flagged: 2 }],
      costUsd: 3.214,
      monthSpendUsd: 3.214,
      capUsd: 25,
      capped: false,
    })
    expect(m.subject).toBe('2026-10-14: summaries — 87 items, 24 second readings (2 flagged for review)')
    expect(m.body).toContain('1 item failed the checks (retried tomorrow)')
    expect(m.body).toContain('LLM cost $3.21 (this month $3.21 of $25.00)')
  })
})
