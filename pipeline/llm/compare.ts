/**
 * `consent llm-compare`: re-run the LLM step for one meeting on a scratch
 * copy of data/, then compare the new summaries and second readings with
 * the stored ones, field by field. data/ is never touched. Use it after
 * changing the model or a prompt, as a quick check against what's published.
 */
import { cp, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { oaklandToday } from '@oakvs/consent-schema/format'
import type { TEnrichment, TVerificationRecord } from '@oakvs/consent-schema/schema'

import { getDataRoot, paths, readEnrichments, readRaw, readVerifications, setDataRoot, writeJson } from '../store'

import { llmPhase } from './phase'

import type { ILlm, TUsage } from './client'

/** Enrichment fields compared, as readable paths. */
const FIELDS: [string, (e: TEnrichment) => unknown][] = [
  ['category', e => e.category],
  ['actionType', e => e.actionType],
  ['vendor.name', e => e.vendor.name?.toLowerCase().replace(/[.,]/g, '').trim() ?? null],
  ['vendor.kind', e => e.vendor.kind],
  ['money.direction', e => e.money.direction],
  ['money.amountType', e => e.money.amountType],
  ['money.thisAction', e => e.money.thisAction],
  ['money.priorTotal', e => e.money.priorTotal],
  ['money.newTotal', e => e.money.newTotal],
  ['term.start', e => e.term.start],
  ['term.end', e => e.term.end],
  ['flags', e => [...e.flags].sort()],
  ['schools', e => [...e.schools].map(s => s.toLowerCase()).sort()],
  ['sourceIssue', e => e.sourceIssueCandidate != null],
]

export type TCompareReport = {
  key: string
  items: number
  enriched: number
  failed: string[]
  usage: TUsage | null
  /** Field → how many sampled items agree. */
  agreement: Record<string, { same: number; total: number }>
  differences: { file: string; field: string; stored: unknown; fresh: unknown }[]
  /** Money readings (second reader) on items both runs verified. */
  verificationMoney: { same: number; total: number; differences: { file: string; stored: unknown; fresh: unknown }[] }
  headlines: { file: string; stored: string; fresh: string }[]
  /** Full records for every item with a difference, to judge which reading is right. */
  details: Record<string, { stored: TEnrichment; fresh: TEnrichment; storedVerification: TVerificationRecord | null; freshVerification: TVerificationRecord | null }>
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Every `step`-th item, so a sample spans the whole agenda. */
export function spreadSample<T>(items: T[], n: number | undefined): T[] {
  if (!n || n >= items.length) return items
  const step = items.length / n
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)])
}

export async function compareMeeting(
  key: string,
  { llm, sample, files: only, now = new Date() }: { llm?: ILlm; sample?: number; files?: string[]; now?: Date } = {},
): Promise<TCompareReport> {
  const real = getDataRoot()
  const [raw, storedE, storedV] = await Promise.all([readRaw(key), readEnrichments(key), readVerifications(key)])
  if (!raw || !storedE) throw new Error(`${key}: no raw snapshot or enrichments to compare against`)
  const candidates = raw.items.map(i => i.file).filter(f => storedE.items[f] && (!only || only.includes(f)))
  const files = spreadSample(candidates, sample)

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'consent-compare-'))
  const copy = path.join(scratch, 'data')
  await cp(real, copy, { recursive: true })
  setDataRoot(copy)
  let phase: Awaited<ReturnType<typeof llmPhase>>
  let freshE: typeof storedE | null
  let freshV: typeof storedV
  try {
    // Forget the sampled items' summaries and second readings, then let the real LLM step redo them.
    const e = structuredClone(storedE)
    const v = structuredClone(storedV) ?? { meetingKey: key, items: {} }
    for (const f of files) {
      delete e.items[f]
      delete v.items[f]
    }
    await writeJson(paths.enrichments(key), e)
    await writeJson(paths.verifications(key), v)
    phase = await llmPhase({ llm, today: oaklandToday(now), keys: [key] })
    ;[freshE, freshV] = await Promise.all([readEnrichments(key), readVerifications(key)])
  } finally {
    setDataRoot(real)
    await rm(scratch, { recursive: true, force: true })
  }

  const report: TCompareReport = {
    key,
    items: files.length,
    enriched: 0,
    failed: phase.meetings.flatMap(m => m.enrich.failed.map(f => `${f.file}: ${f.error}`)),
    usage: phase.usage,
    agreement: Object.fromEntries(FIELDS.map(([name]) => [name, { same: 0, total: 0 }])),
    differences: [],
    verificationMoney: { same: 0, total: 0, differences: [] },
    headlines: [],
    details: {},
  }
  for (const f of files) {
    const stored = storedE.items[f]?.output
    const fresh = freshE?.items[f]?.output
    if (!stored || !fresh) continue
    report.enriched++
    for (const [name, get] of FIELDS) {
      const a = get(stored)
      const b = get(fresh)
      report.agreement[name].total++
      if (same(a, b)) report.agreement[name].same++
      else report.differences.push({ file: f, field: name, stored: a, fresh: b })
    }
    report.headlines.push({ file: f, stored: stored.headline, fresh: fresh.headline })

    const sv: TVerificationRecord | undefined = storedV?.items[f]
    const fv: TVerificationRecord | undefined = freshV?.items[f]
    if (report.differences.some(d => d.file === f) || !same(sv?.money ?? null, fv?.money ?? null)) {
      report.details[f] = { stored, fresh, storedVerification: sv ?? null, freshVerification: fv ?? null }
    }
    if (sv?.money && fv?.money) {
      report.verificationMoney.total++
      if (same(sv.money, fv.money)) report.verificationMoney.same++
      else report.verificationMoney.differences.push({ file: f, stored: sv.money, fresh: fv.money })
    }
  }
  return report
}
