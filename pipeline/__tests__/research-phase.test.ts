import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { VendorResearchRecord } from '@oakvs/consent-schema/schema'

import { MODELS } from '../llm/client'
import { API_RESEARCH_PROMPT_VERSION, researchPhase, toResearch, WEB_TOOLS } from '../llm/research'
import { readLlmState } from '../llm/state'
import { llmCommitMessage } from '../run/message'
import { htmlToText } from '../research/vendor-research'
import { getDataRoot, setDataRoot } from '../store'

import type { ILlm, TAskRequest, TAskResult } from '../llm/client'
import type { TResearchReply, TReviewReply } from '../llm/schemas'
import type { TPage } from '../research/vendor-research'

const REAL = getDataRoot()
const FIXTURE = 'n-360-degree-customer' // any published vendor file works as the template

const SITE = 'https://example.org/'
const pageFor = (url: string): TPage => {
  const html = url === SITE ? '<h1>Example Org</h1><p>Call (510) 555-0100. 1 Main St, Oakland, CA 94612</p>' : ''
  return { url, ok: url === SITE, status: url === SITE ? 200 : 404, finalUrl: url, html, text: htmlToText(html) }
}

const goodReply: TResearchReply = {
  identitySignals: ['name matches', 'located in Oakland'],
  confidence: 'high',
  profile: {
    legalName: null, summary: 'A nonprofit that runs after-school programs.', orgType: 'nonprofit', website: SITE,
    phone: '(510) 555-0100', email: null, address: null, headquarters: 'Oakland, CA', ein: null, caEntityNumber: null, samUei: null,
  },
  sources: [{ url: SITE, title: 'Home', supports: ['summary', 'website', 'phone', 'orgType', 'headquarters'] }],
  notes: null,
}

type TAsked = { model: string; user: string; tools: boolean }

/** Research replies by vendor key; the review model confirms unless told otherwise. */
function fakeLlm(research: Record<string, TResearchReply | null>, review: Partial<TReviewReply> = {}): ILlm & { asked: TAsked[] } {
  const asked: TAsked[] = []
  return {
    asked,
    async ask<T>(req: TAskRequest<T>): Promise<TAskResult<T>> {
      asked.push({ model: req.model, user: req.user, tools: Boolean(req.tools?.length) })
      const usage = { requests: 1, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.2 }
      const parsed = JSON.parse(req.user) as { key?: string; vendor?: { key: string } }
      const key = parsed.key ?? parsed.vendor!.key
      const reply = req.model === MODELS.review
        ? { verdict: 'confirmed', sameOrganization: true, unsupportedFields: [], notes: null, ...review }
        : research[key]
      if (!reply) return { reply: null, modelId: null, attempts: 3, errors: ['sources.0.url: Invalid URL'], refusal: null, usage }
      const errors = await req.validate(reply as T)
      return errors.length
        ? { reply: null, modelId: null, attempts: 3, errors, refusal: null, usage, lastReply: reply as T }
        : { reply: reply as T, modelId: req.model, attempts: 1, errors: [], refusal: null, usage }
    },
  }
}

describe('vendor research in consent run', () => {
  let dir: string
  const vendors = [
    { key: 'v-big', kind: 'organization', approvedTotal: 900_000 },
    { key: 'v-small', kind: null, approvedTotal: 1_000 },
    { key: 'v-person', kind: 'individual', approvedTotal: 5_000_000 },
    { key: 'v-done', kind: 'organization', approvedTotal: 2_000_000 },
  ]

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'research-phase-'))
    const fixture = JSON.parse(await readFile(path.join(REAL, 'published', 'vendors', `${FIXTURE}.json`), 'utf8')) as Record<string, unknown>
    await mkdir(path.join(dir, 'published', 'vendors'), { recursive: true })
    await mkdir(path.join(dir, 'vendor-research'), { recursive: true })
    await mkdir(path.join(dir, 'vendors'), { recursive: true })
    await writeFile(path.join(dir, 'vendors', 'aliases.json'), JSON.stringify({ generated: { vendorNumbers: {}, names: {} }, manual: { vendorNumbers: {}, names: {} } }))
    await writeFile(path.join(dir, 'published', 'vendors', 'index.json'), JSON.stringify({ vendors }))
    for (const v of vendors) await writeFile(path.join(dir, 'published', 'vendors', `${v.key}.json`), JSON.stringify({ ...fixture, key: v.key, kind: v.kind }))
    await writeFile(path.join(dir, 'vendor-research', 'v-done.json'), JSON.stringify(VendorResearchRecord.parse({
      key: 'v-done', researchedAt: '2026-10-01', modelId: 'sonnet-agent', promptVersion: 'vendor-research.v2.md',
      research: { key: 'v-done', identitySignals: [], confidence: 'none', profile: null, sources: [], notes: null },
      review: null, checks: [], publishable: false,
    })))
    setDataRoot(dir)
  })
  afterEach(() => setDataRoot(REAL))

  it('researches new organizations largest first (never individuals or vendors already done), stores checked research, reviews high-confidence results with another model, and publishes only confirmed ones', async () => {
    const llm = fakeLlm({ 'v-big': goodReply, 'v-small': { ...goodReply, confidence: 'medium' } })
    const r = await researchPhase({ llm, today: '2026-10-14', fetcher: async u => pageFor(u) })

    // Two workers: the research calls can start in either order; the review follows its research.
    const calls = llm.asked.map(a => [a.model, (JSON.parse(a.user) as { key?: string; vendor?: { key: string } }).key ?? 'review'])
    expect(calls.slice(0, 2).sort()).toEqual([[MODELS.research, 'v-big'], [MODELS.research, 'v-small']])
    expect(calls[2]).toEqual([MODELS.review, 'review'])
    expect(llm.asked.every(a => a.tools)).toBe(true)
    expect(r.researched).toEqual([{ key: 'v-big', confidence: 'high' }, { key: 'v-small', confidence: 'medium' }])
    expect(r.reviewed).toEqual([{ key: 'v-big', publishable: true }])
    expect(r.remaining).toBe(0)
    expect(r.usage?.costUsd).toBeCloseTo(0.6)

    const big = VendorResearchRecord.parse(JSON.parse(await readFile(path.join(dir, 'vendor-research', 'v-big.json'), 'utf8')))
    expect(big).toMatchObject({ modelId: MODELS.research, promptVersion: API_RESEARCH_PROMPT_VERSION, researchedAt: '2026-10-14', publishable: true })
    expect(big.review).toMatchObject({ key: 'v-big', verdict: 'confirmed' })
    expect((await readLlmState()).spend['2026-10']).toBeCloseTo(0.6)

    const msg = llmCommitMessage({ meetings: [], vendors: { merged: [], keptSeparate: 0, mergeGroupsLeft: 0, historiesUpdated: 0, historiesRemoved: 0, historiesLeft: 0, researched: 2, published: 1, reviewed: 1, failed: 0, gaveUp: 0, remaining: 0 }, costUsd: 0.6, monthSpendUsd: 0.6, capUsd: 25, capped: false })
    expect(msg.subject).toBe('Vendors: 2 researched, 1 profile published')
  })

  it('keeps a reply that fails some checks (the build drops those fields), and a rejected review is not published', async () => {
    const wrongPhone = { ...goodReply, profile: { ...goodReply.profile!, phone: '(510) 555-0199' } }
    const llm = fakeLlm({ 'v-big': wrongPhone, 'v-small': null }, { verdict: 'rejected', sameOrganization: false })
    const r = await researchPhase({ llm, today: '2026-10-14', fetcher: async u => pageFor(u) })

    const big = VendorResearchRecord.parse(JSON.parse(await readFile(path.join(dir, 'vendor-research', 'v-big.json'), 'utf8')))
    expect(big.checks.find(c => c.field === 'phone')?.pass).toBe(false)
    expect(big.publishable).toBe(false)
    expect(r.failed).toEqual([{ key: 'v-small', error: 'sources.0.url: Invalid URL' }])
    expect((await readLlmState()).failures['research:v-small']).toMatchObject({ attempts: 1, lastTriedOn: '2026-10-14' })

    // Same day: the failed vendor waits instead of costing another call.
    const again = fakeLlm({ 'v-small': null })
    const r2 = await researchPhase({ llm: again, today: '2026-10-14', fetcher: async u => pageFor(u) })
    expect(r2.waiting).toEqual(['v-small'])
    expect(again.asked).toEqual([])
  })

  it('does nothing, and needs no API key, when every vendor is researched', async () => {
    await writeFile(path.join(dir, 'published', 'vendors', 'index.json'), JSON.stringify({ vendors: vendors.filter(v => v.key === 'v-person') }))
    const r = await researchPhase({ today: '2026-10-14' })
    expect(r).toMatchObject({ status: 'ran', researched: [], remaining: 0 })
  })

  it('checks reply shape in code', () => {
    expect(toResearch('k', { ...goodReply, confidence: 'none' }).errors).toEqual(['confidence "none" needs profile: null and sources: []'])
    expect(toResearch('k', { ...goodReply, sources: [{ url: 'not a url', title: 'x', supports: [] }] }).errors[0]).toMatch(/^sources\.0\.url/)
    expect(toResearch('k', { ...goodReply, profile: { ...goodReply.profile!, summary: 'x'.repeat(601) } }).errors[0]).toMatch(/^profile\.summary/)
    expect(toResearch('k', goodReply).research?.key).toBe('k')
    expect(WEB_TOOLS.map(t => t.type)).toEqual(['web_search_20260318', 'web_fetch_20260318'])
  })
})
