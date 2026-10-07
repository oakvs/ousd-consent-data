/**
 * `consent category-diff`: compare the enrichments snapshotted by
 * `enrich-export --all` (.cache/enrich/previous) with the current
 * data/enrichments, item by item. Pure code, no LLM; both sides are read
 * without validation because the snapshot predates the current schema.
 *
 * Spending here is `spendingAmount(money)` straight from each record; the
 * build's counting flags (budget allocations, payment ratifications) aren't
 * applied, so treat the dollar figures as "about", for review.
 */
import { readdir } from 'node:fs/promises'
import path from 'node:path'

import { spendingAmount } from '@oakvs/consent-schema/format'
import type { TMoney } from '@oakvs/consent-schema/schema'

import { getDataRoot, readJsonLoose } from '../store'

import { previousDir } from './agent-io'

import type { TLooseEnrichmentsFile } from './agent-io'

type TBucket = { items: number; spending: number }

export type TCategoryDiff = {
  compared: number
  changed: number
  /** from → to → items and spending (current record's money). Only off-diagonal cells. */
  matrix: Record<string, Record<string, TBucket>>
  /** Special education sub-categories in the current records. */
  subcategories: Record<string, TBucket>
  /** Every item whose category changed, sorted by id. */
  movers: { id: string; headline: string; from: string; to: string; subcategory: string | null }[]
  onlyPrevious: string[]
  onlyCurrent: string[]
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '(none)')
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const spend = (output: Record<string, unknown>): number => spendingAmount((output.money ?? null) as TMoney | null)
const add = (b: TBucket | undefined, spending: number): TBucket => ({ items: (b?.items ?? 0) + 1, spending: (b?.spending ?? 0) + spending })
const sortKeys = <T,>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))

export function diffEnrichments(previous: Map<string, TLooseEnrichmentsFile>, current: Map<string, TLooseEnrichmentsFile>): TCategoryDiff {
  const d: TCategoryDiff = { compared: 0, changed: 0, matrix: {}, subcategories: {}, movers: [], onlyPrevious: [], onlyCurrent: [] }
  const keys = [...new Set([...previous.keys(), ...current.keys()])].sort()
  for (const key of keys) {
    const before = previous.get(key)?.items ?? {}
    const after = current.get(key)?.items ?? {}
    for (const file of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const id = `${key}:${file}`
      const a = before[file]
      const b = after[file]
      if (!a) {
        d.onlyCurrent.push(id)
        continue
      }
      if (!b) {
        d.onlyPrevious.push(id)
        continue
      }
      d.compared++
      const from = str(a.output.category)
      const to = str(b.output.category)
      const subcategory = strOrNull(b.output.subcategory)
      const spending = spend(b.output)
      if (to === 'Special education' && subcategory) d.subcategories[subcategory] = add(d.subcategories[subcategory], spending)
      if (from === to) continue
      d.changed++
      d.matrix[from] = { ...d.matrix[from], [to]: add(d.matrix[from]?.[to], spending) }
      d.movers.push({ id, headline: str(b.output.headline), from, to, subcategory })
    }
  }
  d.matrix = sortKeys(Object.fromEntries(Object.entries(d.matrix).map(([k, v]) => [k, sortKeys(v)])))
  d.subcategories = sortKeys(d.subcategories)
  return d
}

async function readLooseDir(dir: string): Promise<Map<string, TLooseEnrichmentsFile>> {
  const out = new Map<string, TLooseEnrichmentsFile>()
  let files: string[]
  try {
    files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  } catch {
    return out
  }
  for (const f of files.sort()) {
    const value = await readJsonLoose<TLooseEnrichmentsFile>(path.join(dir, f))
    if (value) out.set(f.replace(/\.json$/, ''), value)
  }
  return out
}

/** Compare the snapshot with the live enrichments. */
export async function categoryDiff(): Promise<TCategoryDiff> {
  const [previous, current] = await Promise.all([readLooseDir(previousDir()), readLooseDir(path.join(getDataRoot(), 'enrichments'))])
  if (previous.size === 0) throw new Error(`no snapshot in ${previousDir()}; run enrich-export --all first`)
  return diffEnrichments(previous, current)
}

const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`

export function formatCategoryDiff(d: TCategoryDiff): string {
  const lines = [`${d.compared} items compared, ${d.changed} changed category; ${d.onlyPrevious.length} only before, ${d.onlyCurrent.length} only after`, '']
  lines.push('Moves (from → to: items, spending of the new records):')
  for (const [from, tos] of Object.entries(d.matrix)) {
    for (const [to, b] of Object.entries(tos)) lines.push(`  ${from} → ${to}: ${b.items} (${money(b.spending)})`)
  }
  lines.push('', 'Special education sub-categories:')
  for (const [sub, b] of Object.entries(d.subcategories)) lines.push(`  ${sub}: ${b.items} items (${money(b.spending)})`)
  return lines.join('\n')
}
