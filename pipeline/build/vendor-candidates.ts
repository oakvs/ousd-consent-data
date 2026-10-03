/**
 * Possible duplicate vendors, for the merge judge (`consent vendor-candidates`).
 *
 * The alias generator merges only what's certain (see aliases.ts). This finds
 * the rest of the likely duplicates among organizations, for a judge (an AI
 * agent with prompts/vendor-merge.v1.md, or a person) to decide:
 *
 * - names that match once filler words are dropped, using a looser list than
 *   the generator's (it also drops "services", "group" and acronyms in
 *   parentheses), including groups that span two OUSD vendor numbers
 * - names where one extends the other ("Bay Area Medical Academy" and
 *   "Bay Area Medical Academy (BAMA)")
 * - names within two letters of each other ("Bertrand, Fox, Elliot…" and
 *   "Bertrand, Fox, Elliott…")
 *
 * Pairs a judge has already decided (data/vendors/merge-decisions.json) are
 * left out. Output: .cache/vendor-merge/candidates.json, plus batch inputs.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { TVendorFile, TVendorIndexFile } from '@oakvs/consent-schema/schema'

import { getDataRoot } from '../store'

export const MERGE_DIR = path.join(process.cwd(), '.cache', 'vendor-merge')
const LOOSE_FILLER = new Set(['the', 'of', 'and', 'a', 'an', 'for', 'in', 'at', 'on', 'by', 'its', 'behalf', 'law', 'firm', 'offices', 'attorneys', 'professional', 'corporation', 'corp', 'company', 'co', 'inc', 'llc', 'dba', 'aka', 'formerly', 'services', 'service', 'group'])

const looseTokens = (name: string): string[] =>
  name.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(t => t && !LOOSE_FILLER.has(t))

export type TVendorEvidence = {
  key: string
  names: string[]
  vendorNo: string | null
  locations: string[]
  categories: string[]
  departments: string[]
  items: number
  firstSeen: string | null
  lastSeen: string | null
  sampleTitles: string[]
  profile: { summary: string; website: string | null } | null
}

export type TMergeDecision = { from: string; into: string; reason: string; decidedBy: string; decidedOn: string }
export type TSeparateDecision = { keys: string[]; reason: string; decidedBy: string; decidedOn: string }
export type TMergeLog = { merged: TMergeDecision[]; keptSeparate: TSeparateDecision[] }

export const decisionsPath = (): string => path.join(getDataRoot(), 'vendors', 'merge-decisions.json')

export async function readMergeLog(): Promise<TMergeLog> {
  try {
    return JSON.parse(await readFile(decisionsPath(), 'utf8')) as TMergeLog
  } catch {
    return { merged: [], keptSeparate: [] }
  }
}

async function evidence(key: string): Promise<TVendorEvidence> {
  const v = JSON.parse(await readFile(path.join(getDataRoot(), 'published', 'vendors', `${key}.json`), 'utf8')) as TVendorFile
  const titles = [...new Set([...v.appearances.map(a => a.title), ...v.legistarHistory.map(m => m.title)])]
  return {
    key,
    names: v.names,
    vendorNo: v.vendorNo,
    locations: v.locations,
    categories: v.taxonomy.categories.map(c => c.name),
    departments: v.official.departments.map(d => d.name).slice(0, 4),
    items: v.appearances.length,
    firstSeen: v.firstSeen,
    lastSeen: v.lastSeen,
    sampleTitles: titles.slice(0, 6),
    profile: v.profile ? { summary: v.profile.summary, website: v.profile.website ?? null } : null,
  }
}

/** Levenshtein distance, stopping early once it exceeds 2. */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      best = Math.min(best, row[j])
    }
    if (best > 2) return best
    prev = row
  }
  return prev[b.length]
}

/** Union-find over vendor keys. */
function components(pairs: [string, string][]): string[][] {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    while (parent.get(x) !== x) x = parent.get(x)!
    return x
  }
  for (const [a, b] of pairs) {
    if (!parent.has(a)) parent.set(a, a)
    if (!parent.has(b)) parent.set(b, b)
    parent.set(find(a), find(b))
  }
  const groups = new Map<string, string[]>()
  for (const k of parent.keys()) groups.set(find(k), [...(groups.get(find(k)) ?? []), k])
  return [...groups.values()].map(g => g.sort()).sort((a, b) => a[0].localeCompare(b[0]))
}

export async function findVendorCandidates(batchSize = 8): Promise<{ groups: number; vendors: number; batches: string[] }> {
  const index = JSON.parse(await readFile(path.join(getDataRoot(), 'published', 'vendors', 'index.json'), 'utf8')) as TVendorIndexFile
  const orgs = index.vendors.filter(v => v.kind !== 'individual')
  const log = await readMergeLog()
  const decided = new Set(log.keptSeparate.map(d => [...d.keys].sort().join('|')))

  const tokens = new Map(orgs.map(v => [v.key, looseTokens(v.name)]))
  const pairs: [string, string][] = []
  const bySig = new Map<string, string[]>()
  for (const v of orgs) {
    const sig = tokens.get(v.key)!.join(' ')
    if (sig) bySig.set(sig, [...(bySig.get(sig) ?? []), v.key])
  }
  for (const keys of bySig.values()) for (let i = 1; i < keys.length; i++) pairs.push([keys[0], keys[i]])
  for (const a of orgs) {
    const ta = tokens.get(a.key)!
    if (ta.length < 2) continue
    for (const b of orgs) {
      const tb = tokens.get(b.key)!
      if (a.key !== b.key && tb.length > ta.length && ta.every((t, i) => tb[i] === t)) pairs.push([a.key, b.key])
    }
  }
  // Near-identical names: one or two typos ("Elliot" / "Elliott"), on names long enough that a
  // two-letter difference can't turn one real name into another.
  const sigs = orgs.map(v => ({ key: v.key, sig: tokens.get(v.key)!.join(' ') })).filter(x => x.sig.length >= 12)
  for (let i = 0; i < sigs.length; i++) {
    for (let j = i + 1; j < sigs.length; j++) {
      const a = sigs[i].sig
      const b = sigs[j].sig
      if (a !== b && Math.abs(a.length - b.length) <= 2 && editDistance(a, b) <= 2) pairs.push([sigs[i].key, sigs[j].key])
    }
  }
  const groups = components(pairs).filter(g => g.length <= 6 && !decided.has(g.join('|')))

  await mkdir(MERGE_DIR, { recursive: true })
  const withEvidence = []
  for (const [i, keys] of groups.entries()) withEvidence.push({ group: `g${String(i + 1).padStart(3, '0')}`, vendors: await Promise.all(keys.map(evidence)) })
  await writeFile(path.join(MERGE_DIR, 'candidates.json'), `${JSON.stringify(withEvidence, null, 2)}\n`)
  const batches: string[] = []
  for (let start = 0, n = 1; start < withEvidence.length; start += batchSize, n++) {
    const id = `batch-${String(n).padStart(2, '0')}`
    await writeFile(path.join(MERGE_DIR, `${id}.input.json`), `${JSON.stringify({ batch: id, groups: withEvidence.slice(start, start + batchSize) }, null, 2)}\n`)
    batches.push(id)
  }
  return { groups: withEvidence.length, vendors: withEvidence.reduce((n, g) => n + g.vendors.length, 0), batches }
}

// ─── Judge output: check and apply ───────────────────────────────────────────

export const MERGE_PROMPT_VERSION = 'vendor-merge.v1.md'

type TJudgeDecision = { group: string; into: string | null; merge: string[]; reason: string }
type TBatchInput = { batch: string; groups: { group: string; vendors: TVendorEvidence[] }[] }

async function readBatch(batch: string): Promise<{ input: TBatchInput; output: unknown }> {
  const input = JSON.parse(await readFile(path.join(MERGE_DIR, `${batch}.input.json`), 'utf8')) as TBatchInput
  let output: unknown = null
  try {
    output = JSON.parse(await readFile(path.join(MERGE_DIR, `${batch}.output.json`), 'utf8'))
  } catch {
    // missing or invalid; reported by the check
  }
  return { input, output }
}

/** Problems with one judge output; an empty list means it passes. */
export async function checkMergeBatch(batch: string): Promise<string[]> {
  const { input, output } = await readBatch(batch)
  if (!output) return ['output file missing or not valid JSON']
  const decisions = (output as { decisions?: TJudgeDecision[] }).decisions
  if (!Array.isArray(decisions)) return ['output must be { "batch": …, "decisions": [ … ] }']
  const problems: string[] = []
  if (decisions.length !== input.groups.length) problems.push(`expected ${input.groups.length} decisions, got ${decisions.length}`)
  for (const g of input.groups) {
    const d = decisions.find(x => x?.group === g.group)
    if (!d) {
      problems.push(`${g.group}: missing`)
      continue
    }
    const keys = new Set(g.vendors.map(v => v.key))
    if (!Array.isArray(d.merge)) problems.push(`${g.group}: merge must be a list`)
    if (typeof d.reason !== 'string' || !d.reason.trim()) problems.push(`${g.group}: reason is required`)
    if (!d.merge?.length) {
      if (d.into != null) problems.push(`${g.group}: into must be null when merge is empty`)
      continue
    }
    if (!d.into || !keys.has(d.into)) problems.push(`${g.group}: into must be one of the group's keys`)
    for (const k of d.merge) {
      if (!keys.has(k)) problems.push(`${g.group}: ${k} is not in the group`)
      if (k === d.into) problems.push(`${g.group}: ${k} can't be merged into itself`)
    }
    if (d.into?.startsWith('n-') && d.merge.some(k => k.startsWith('v-'))) problems.push(`${g.group}: a vendor with a number (v-) can't merge into a name-only vendor; use a v- key as into`)
  }
  return problems
}

/**
 * Turn passing judge outputs into manual aliases and a decisions log. Merges
 * become `manual` entries in aliases.json (which always win); every decision,
 * merged or not, is logged in data/vendors/merge-decisions.json so the same
 * group isn't judged again.
 */
export async function applyMergeBatches(batches: string[], decidedBy: string, decidedOn: string): Promise<{ merged: number; kept: number }> {
  const aliasesFile = path.join(getDataRoot(), 'vendors', 'aliases.json')
  const aliases = JSON.parse(await readFile(aliasesFile, 'utf8')) as { manual: { vendorNumbers: Record<string, string>; names: Record<string, string> } }
  const log = await readMergeLog()
  let merged = 0
  let kept = 0
  for (const batch of batches) {
    if ((await checkMergeBatch(batch)).length) throw new Error(`${batch} doesn't pass vendor-merge-check`)
    const { input, output } = await readBatch(batch)
    for (const d of (output as { decisions: TJudgeDecision[] }).decisions) {
      const keys = input.groups.find(g => g.group === d.group)!.vendors.map(v => v.key)
      if (!d.merge.length || !d.into) {
        log.keptSeparate.push({ keys: [...keys].sort(), reason: d.reason, decidedBy, decidedOn })
        kept++
        continue
      }
      for (const from of d.merge) {
        const target = d.into.slice(2)
        if (from.startsWith('v-')) aliases.manual.vendorNumbers[from.slice(2)] = target
        else aliases.manual.names[from.slice(2).replace(/-/g, ' ')] = d.into.startsWith('v-') ? target : target.replace(/-/g, ' ')
        log.merged.push({ from, into: d.into, reason: d.reason, decidedBy, decidedOn })
        merged++
      }
      const rest = keys.filter(k => k !== d.into && !d.merge.includes(k))
      if (rest.length) log.keptSeparate.push({ keys: [...new Set([d.into, ...rest])].sort(), reason: d.reason, decidedBy, decidedOn })
    }
  }
  const { stableStringify } = await import('../store')
  await writeFile(aliasesFile, stableStringify(aliases))
  await writeFile(decisionsPath(), stableStringify(log))
  return { merged, kept }
}
