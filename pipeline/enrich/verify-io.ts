/**
 * Automated second reading ("verification") I/O, parallel to agent-io.ts.
 *
 * Which items get a second reading, and for what:
 * - money:    top 20 by amount in each meeting, any amount not found in the
 *             text even after the misprint reader, and any failed money
 *             check that can distort totals (yearly cap, direction)
 * - issue:    every AI-suggested problem in the official text
 * - headline: headlines that name an individual
 *
 * The money reading is independent: the verifier never sees the primary
 * values, and code compares the two.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { VerificationRecord } from '@oakvs/consent-schema/schema'
import type { TRawItem, TVerificationsFile } from '@oakvs/consent-schema/schema'
import type { z } from 'zod'

import { applyOverride, currentVerification, highValueFiles } from '../build/meeting'
import { listRawKeys, paths, readEnrichments, readOverrides, readRaw, readVerifications, writeJson } from '../store'
import { totalsDisagreements } from '../validate/alerts'
import { MONEY_SOFT_CHECKS, runChecks } from '../validate/checks'

export const VERIFY_DIR = path.join(process.cwd(), '.cache', 'verify')
export const VERIFY_PROMPT_VERSION = 'verify.v1.md'

export type TVerifyTask = 'money' | 'issue' | 'headline'

export type TVerifyInputItem = Pick<TRawItem, 'file' | 'agendaNumber' | 'title' | 'text'> & {
  tasks: TVerifyTask[]
  /** For the issue task: the problem the first reader suggested. */
  candidate: string | null
  /** For the headline task: the current headline and the individual's name. */
  headline: string | null
  vendorName: string | null
  /** Follow-up reading on an item already verified: a third money reading, or a missing money reading. */
  followUp?: 'tiebreak' | 'money'
}

export type TVerifyChunk = { chunk: string; meetingKey: string; items: TVerifyInputItem[] }

const inputPath = (chunk: string): string => path.join(VERIFY_DIR, `${chunk}.input.json`)
const outputPath = (chunk: string): string => path.join(VERIFY_DIR, `${chunk}.output.json`)

export async function tasksForMeeting(key: string): Promise<TVerifyInputItem[]> {
  const [raw, enrichments, overrides, verifications] = await Promise.all([
    readRaw(key), readEnrichments(key), readOverrides(key), readVerifications(key),
  ])
  if (!raw || !enrichments) return []
  const merged = raw.items.map(item => {
    const record = enrichments.items[item.file] ?? null
    const override = overrides?.items[item.file] ?? null
    return { item, record, override, enrichment: applyOverride(record?.output ?? null, override) }
  })
  const highValue = highValueFiles(merged.map(m => ({ file: m.item.file, enrichment: m.enrichment })))

  const out: TVerifyInputItem[] = []
  for (const { item, record, override, enrichment } of merged) {
    if (!enrichment || !record) continue
    const existing = currentVerification(verifications?.items[item.file], record.cacheKey)
    if (existing) {
      // Already read twice: only a totals-changing disagreement needs a third reading.
      const base = { file: item.file, agendaNumber: item.agendaNumber, title: item.title, text: item.text, candidate: null, headline: null, vendorName: null }
      if (existing.money && !existing.tiebreakMoney && totalsDisagreements(enrichment.money, existing.money).length) {
        out.push({ ...base, tasks: ['money'], followUp: 'tiebreak' })
      } else if (!existing.money && existing.issue?.topic === 'money') {
        // A money problem was judged without a money reading; read the money so code can check the arithmetic.
        out.push({ ...base, tasks: ['money'], followUp: 'money' })
      }
      continue
    }
    const { checks } = runChecks({ text: item.text, enrichment, sourceIssue: null })
    const failed = new Set(checks.filter(c => !c.pass).map(c => c.name))
    const tasks: TVerifyTask[] = []
    if (highValue.has(item.file) || failed.has('amounts_in_text') || [...MONEY_SOFT_CHECKS].some(n => failed.has(n))) {
      tasks.push('money')
    }
    if (enrichment.sourceIssueCandidate && !override?.sourceIssue) {
      tasks.push('issue')
      // Any suspected problem gets an independent money reading too, so code can check the arithmetic itself.
      if (!tasks.includes('money')) tasks.push('money')
    }
    if (failed.has('person_in_headline')) tasks.push('headline')
    if (tasks.length === 0) continue
    out.push({
      file: item.file,
      agendaNumber: item.agendaNumber,
      title: item.title,
      text: item.text,
      tasks,
      candidate: tasks.includes('issue') ? enrichment.sourceIssueCandidate : null,
      headline: tasks.includes('headline') ? enrichment.headline : null,
      vendorName: tasks.includes('headline') ? enrichment.vendor.name : null,
    })
  }
  return out
}

export async function exportVerifyChunks(keys: string[] | null, size: number): Promise<{ chunk: string; items: number }[]> {
  await mkdir(VERIFY_DIR, { recursive: true })
  const manifest: { chunk: string; items: number }[] = []
  for (const key of keys ?? await listRawKeys()) {
    const all = await tasksForMeeting(key)
    const groups = [
      ['v', all.filter(i => !i.followUp)],
      ['t', all.filter(i => i.followUp === 'tiebreak')],
      ['m', all.filter(i => i.followUp === 'money')],
    ] as const
    for (const [prefix, todo] of groups) {
      for (let start = 0, n = 1; start < todo.length; start += size, n++) {
        const chunk = `${key}.${prefix}${String(n).padStart(2, '0')}`
        const body: TVerifyChunk = { chunk, meetingKey: key, items: todo.slice(start, start + size) }
        await writeFile(inputPath(chunk), `${JSON.stringify(body, null, 2)}\n`)
        manifest.push({ chunk, items: body.items.length })
      }
    }
  }
  await writeFile(path.join(VERIFY_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export const OutputItem = VerificationRecord.pick({ money: true, issue: true, vendorKind: true, headlineFix: true })
export type TVerifyOutput = z.infer<typeof OutputItem>

export type TVerifyProblem = { agendaNumber: string | null; message: string }

export async function checkVerifyChunk(chunk: string): Promise<TVerifyProblem[]> {
  const input = JSON.parse(await readFile(inputPath(chunk), 'utf8')) as TVerifyChunk
  let output: { items?: unknown }
  try {
    output = JSON.parse(await readFile(outputPath(chunk), 'utf8')) as { items?: unknown }
  } catch (error) {
    return [{ agendaNumber: null, message: `output missing or not valid JSON: ${(error as Error).message}` }]
  }
  if (!Array.isArray(output.items)) return [{ agendaNumber: null, message: 'output must be { "chunk": …, "items": [ … ] }' }]
  const byFile = new Map((output.items as { file?: string }[]).map(i => [i.file, i]))
  const problems: TVerifyProblem[] = []

  for (const src of input.items) {
    const raw = byFile.get(src.file) as Record<string, unknown> | undefined
    if (!raw) {
      problems.push({ agendaNumber: src.agendaNumber, message: 'missing from output' })
      continue
    }
    for (const message of checkVerification(src, raw).problems) problems.push({ agendaNumber: src.agendaNumber, message })
  }
  return problems
}

/**
 * The checks every second reading must pass, whoever wrote it: the schema,
 * exactly the requested tasks filled in, quotes copied verbatim, and no
 * individual's name left in a fixed headline. Shared by `verify-check` and
 * the API verification.
 */
export function checkVerification(src: TVerifyInputItem, candidate: unknown): { output: TVerifyOutput | null; problems: string[] } {
  const parsed = OutputItem.safeParse({ money: null, issue: null, vendorKind: null, headlineFix: null, ...(candidate as object) })
  if (!parsed.success) return { output: null, problems: parsed.error.issues.map(issue => `schema: ${issue.path.join('.')}: ${issue.message}`) }
  const v = parsed.data
  const problems: string[] = []
  for (const task of ['money', 'issue'] as const) {
    if (src.tasks.includes(task) && v[task] == null) problems.push(`task "${task}" requested but missing`)
    if (!src.tasks.includes(task) && v[task] != null) problems.push(`task "${task}" not requested; set it to null`)
  }
  if (src.tasks.includes('headline')) {
    if (v.vendorKind == null) problems.push('task "headline" requires vendorKind ("individual" or "organization")')
    if (v.vendorKind === 'individual' && !v.headlineFix) problems.push('vendorKind is "individual" but headlineFix is missing')
    if (v.vendorKind === 'organization' && v.headlineFix) problems.push('vendorKind is "organization": organizations stay named, so headlineFix must be null')
  } else if (v.vendorKind != null || v.headlineFix != null) {
    problems.push('task "headline" not requested; set vendorKind and headlineFix to null')
  }
  if (v.issue?.quote && !src.text.includes(v.issue.quote) && !src.title.includes(v.issue.quote)) {
    problems.push(`issue.quote is not an exact substring of the title or text: ${JSON.stringify(v.issue.quote)}`)
  }
  if (v.headlineFix && src.vendorName && v.headlineFix.includes(src.vendorName)) problems.push('headlineFix still names the individual')
  return { output: v, problems }
}

/**
 * Store one reading. A follow-up (tiebreak or missing money reading) attaches
 * to the existing record for the same enrichment; anything else replaces it.
 * Returns false when there is nothing current to attach a follow-up to.
 */
export function storeVerification(
  file: TVerificationsFile,
  fileNo: string,
  enrichmentCacheKey: string,
  output: TVerifyOutput,
  { modelId, promptVersion, followUp }: { modelId: string; promptVersion: string; followUp: TVerifyInputItem['followUp'] | null },
): boolean {
  if (followUp) {
    const existing = file.items[fileNo]
    if (existing?.enrichmentCacheKey !== enrichmentCacheKey || !output.money) return false
    file.items[fileNo] = { ...existing, [followUp === 'tiebreak' ? 'tiebreakMoney' : 'money']: output.money }
    return true
  }
  file.items[fileNo] = VerificationRecord.parse({ modelId, promptVersion, enrichmentCacheKey, ...output })
  return true
}

export async function importVerifyChunks(keys: string[] | null, modelId: string): Promise<{ meetingKey: string; imported: number }[]> {
  const files = (await readdir(VERIFY_DIR)).filter(f => f.endsWith('.output.json'))
  const byKey = new Map<string, string[]>()
  for (const f of files) {
    const chunk = f.replace(/\.output\.json$/, '')
    const key = chunk.replace(/\.[vtm]\d+$/, '')
    if (keys && !keys.includes(key)) continue
    byKey.set(key, [...(byKey.get(key) ?? []), chunk])
  }
  const summary: { meetingKey: string; imported: number }[] = []
  for (const [key, chunks] of [...byKey.entries()].sort()) {
    const enrichments = await readEnrichments(key)
    if (!enrichments) continue
    const file: TVerificationsFile = (await readVerifications(key)) ?? { meetingKey: key, items: {} }
    let imported = 0
    for (const chunk of chunks.sort()) {
      const out = JSON.parse(await readFile(outputPath(chunk), 'utf8')) as { items: Record<string, unknown>[] }
      for (const raw of out.items) {
        const fileNo = raw.file as string
        const record = enrichments.items[fileNo]
        const parsed = OutputItem.safeParse({ money: null, issue: null, vendorKind: null, headlineFix: null, ...raw })
        if (!record || !parsed.success) continue
        const followUp = /\.t\d+$/.test(chunk) ? 'tiebreak' : /\.m\d+$/.test(chunk) ? 'money' : null
        if (storeVerification(file, fileNo, record.cacheKey, parsed.data, { modelId, promptVersion: VERIFY_PROMPT_VERSION, followUp })) imported++
      }
    }
    await writeJson(paths.verifications(key), file)
    summary.push({ meetingKey: key, imported })
  }
  return summary
}
