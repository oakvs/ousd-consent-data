/**
 * Keeps the README's numbers in step with the data. The build rewrites
 * whatever sits between `<!-- generated:NAME -->` and
 * `<!-- /generated:NAME -->` markers (GitHub doesn't display them), so the
 * prose around them stays hand-written:
 *
 *   since    the month coverage starts, e.g. "August 2025" (inline)
 *   stats    the "As of …" sentence: meetings, items, money, vendors
 *   review   the review-status counts
 *   models   the table of which models wrote which records
 *
 * Everything comes from the data, so the output is deterministic. The
 * README sits next to the data folder; when there's none (a scratch copy
 * of data/), nothing is written.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { formatDate } from '@oakvs/consent-schema/format'
import type { TIndexFile, TMeetingFile, TVendorIndexFile } from '@oakvs/consent-schema/schema'

import { getDataRoot } from '../store'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const monthYear = (iso: string): string => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`
const n = (x: number): string => x.toLocaleString('en-US')
const dollars = (x: number): string =>
  x >= 1_000_000_000 ? `$${(x / 1_000_000_000).toFixed(2)} billion` : `$${(x / 1_000_000).toFixed(1)} million`

const MODEL_LABELS: Record<string, string> = {
  'sonnet-agent': 'Claude Sonnet, run as Claude Code agents',
  'prototype-v1': 'An earlier prototype',
  'claude-opus-5-5': 'Claude Opus 5.5 through the Claude API',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 through the Claude API',
  'claude-opus-5': 'Claude Opus 5 through the Claude API (refusal fallback)',
  'claude-opus-4-8': 'Claude Opus 4.8 through the Claude API (refusal fallback)',
  'claude-sonnet-5': 'Claude Sonnet 5 through the Claude API (refusal fallback)',
}
const label = (modelId: string, promptVersion?: string): string =>
  `${MODEL_LABELS[modelId] ?? modelId} (\`${modelId}\`${promptVersion ? `, prompt \`${promptVersion.replace(/\.md$/, '')}\`` : ''})`

const range = (keys: string[]): string => {
  const sorted = [...keys].sort()
  const [a, b] = [monthYear(sorted[0]), monthYear(sorted.at(-1)!)]
  return a === b ? a : `${a} – ${b}`
}

export type TReadmeInputs = {
  index: TIndexFile
  meetings: Pick<TMeetingFile, 'items'>[]
  vendors: TVendorIndexFile
  /** One entry per enrichment record: [meetingKey, modelId, promptVersion]. */
  enrichments: [string, string, string][]
  verifications: [string, string, string][]
  research: { modelId: string; publishable: boolean }[]
}

export function readmeSections({ index, meetings, vendors, enrichments, verifications, research }: TReadmeInputs): Record<string, string> {
  const ms = [...index.meetings].sort((a, b) => a.key.localeCompare(b.key))
  const first = ms[0]
  const last = ms.at(-1)!
  const sum = (f: 'items' | 'spendingTotal' | 'spendingItems' | 'revenueTotal'): number => ms.reduce((t, m) => t + m[f], 0)
  const asOf = ms.map(m => m.updatedAt).sort().at(-1)!.slice(0, 10)

  const stats = `As of ${formatDate(asOf, 'long')}, it covers ${n(ms.length)} Board meetings, from ${formatDate(first.date, 'long')} to ${formatDate(last.date, 'long')}. `
    + `That's ${n(sum('items'))} consent items authorizing ${dollars(sum('spendingTotal'))} in spending, plus ${dollars(sum('revenueTotal'))} in grants and other money coming in, `
    + `across ${n(vendors.vendors.length)} vendors and partners.`

  const counts: Record<string, number> = {}
  for (const m of meetings) for (const i of m.items) counts[i.review.status] = (counts[i.review.status] ?? 0) + 1
  const order = ['auto_ok', 'human_reviewed', 'needs_review', 'blocked', 'pending']
  const parts = order.filter(s => counts[s]).map((s, i) => {
    const c = counts[s]
    const noun = i === 0 ? (c === 1 ? ' item' : ' items') : ''
    return `${n(c)}${noun} ${c === 1 ? 'is' : 'are'} \`${s}\``
  })
  const review = `Right now ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]}.`

  const group = (rows: [string, string, string][]): { modelId: string; promptVersion: string; keys: string[] }[] => {
    const by = new Map<string, { modelId: string; promptVersion: string; keys: string[] }>()
    for (const [key, modelId, promptVersion] of rows) {
      const g = by.get(`${modelId}\u0000${promptVersion}`) ?? { modelId, promptVersion, keys: [] }
      g.keys.push(key)
      by.set(`${modelId}\u0000${promptVersion}`, g)
    }
    return [...by.values()].sort((a, b) => [...a.keys].sort()[0].localeCompare([...b.keys].sort()[0]) || a.modelId.localeCompare(b.modelId))
  }
  const lines = ['| Records | Model |', '|---|---|']
  for (const g of group(enrichments)) lines.push(`| Summaries, ${range(g.keys)} (${n(g.keys.length)} items) | ${label(g.modelId, g.promptVersion)} |`)
  for (const g of group(verifications)) lines.push(`| Second readings, ${range(g.keys)} (${n(g.keys.length)} items) | ${label(g.modelId, g.promptVersion)} |`)
  const byModel = new Map<string, { total: number; published: number }>()
  for (const r of research) {
    const e = byModel.get(r.modelId) ?? { total: 0, published: 0 }
    e.total++
    if (r.publishable) e.published++
    byModel.set(r.modelId, e)
  }
  for (const [modelId, e] of [...byModel.entries()].sort()) lines.push(`| Vendor research (${n(e.total)} vendors, ${n(e.published)} published) | ${label(modelId)} |`)

  return { since: monthYear(first.date), stats, review, models: lines.join('\n') }
}

/** Replace each marked section; markers whose name has no section are left alone. */
export function applySections(readme: string, sections: Record<string, string>): string {
  return readme.replace(/(<!-- generated:([a-z]+) -->)([\s\S]*?)(<!-- \/generated:\2 -->)/g, (whole, open: string, name: string, body: string, close: string) => {
    const value = sections[name]
    if (value == null) return whole
    // Block sections sit on their own lines; inline ones stay inline.
    return body.startsWith('\n') ? `${open}\n${value}\n${close}` : `${open}${value}${close}`
  })
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T
}

/** Gather everything the sections need from the current data root. */
export async function readmeInputs(dataRoot: string = getDataRoot()): Promise<TReadmeInputs> {
  const published = path.join(dataRoot, 'published')
  const meetingFiles = (await readdir(path.join(published, 'meetings'))).filter(f => f.endsWith('.json') && !f.endsWith('.list.json')).sort()
  const meetings = await Promise.all(meetingFiles.map(f => readJson<TMeetingFile>(path.join(published, 'meetings', f))))
  const records = async (dir: string): Promise<[string, string, string][]> => {
    const out: [string, string, string][] = []
    for (const f of (await readdir(path.join(dataRoot, dir)).catch(() => [])).filter(x => x.endsWith('.json')).sort()) {
      const file = await readJson<{ meetingKey: string; items: Record<string, { modelId: string; promptVersion: string }> }>(path.join(dataRoot, dir, f))
      for (const r of Object.values(file.items)) out.push([file.meetingKey, r.modelId, r.promptVersion])
    }
    return out
  }
  const research: { modelId: string; publishable: boolean }[] = []
  for (const f of (await readdir(path.join(dataRoot, 'vendor-research')).catch(() => [])).filter(x => x.endsWith('.json')).sort()) {
    const r = await readJson<{ modelId: string; publishable: boolean }>(path.join(dataRoot, 'vendor-research', f))
    research.push({ modelId: r.modelId, publishable: r.publishable })
  }
  return {
    index: await readJson<TIndexFile>(path.join(published, 'index.json')),
    meetings,
    vendors: await readJson<TVendorIndexFile>(path.join(published, 'vendors', 'index.json')),
    enrichments: await records('enrichments'),
    verifications: await records('verifications'),
    research,
  }
}

export const readmePath = (dataRoot: string = getDataRoot()): string => path.join(dataRoot, '..', 'README.md')

/** Rewrite the README's generated sections. Returns false when there's no README next to the data. */
export async function updateReadme(dataRoot: string = getDataRoot()): Promise<boolean> {
  let readme: string
  try {
    readme = await readFile(readmePath(dataRoot), 'utf8')
  } catch {
    return false
  }
  const next = applySections(readme, readmeSections(await readmeInputs(dataRoot)))
  if (next !== readme) await writeFile(readmePath(dataRoot), next)
  return true
}
