/**
 * Official Legistar history per vendor.
 *
 * Legistar has no vendor profile: a vendor exists only as the vendor number
 * on each matter (MatterEXText1). For every vendor in our data we collect:
 *   1. every matter carrying its vendor number, in any year, consent or not
 *   2. Legistar's own related-record links from each of its consent items
 *      (e.g. Amendment No. 3 → Amendment No. 2 → the original agreement)
 * and store the official fields in data/legistar/vendors/{key}.json.
 *
 * `vendor-history` rebuilds every file (from the request cache unless
 * --force); `consent run` calls `updateVendorHistories`, which only touches
 * vendors with consent items their file doesn't cover yet.
 */
import { readdir, unlink } from 'node:fs/promises'
import path from 'node:path'

import type { TOfficialMatter, TRawItem, TVendorLegistarFile } from '@oakvs/consent-schema/schema'
import { vendorKey } from '@oakvs/consent-schema/vendor-key'

import { withoutEmails } from '../normalize/privacy'
import { legistarItemUrl, normalizeCode, normalizeVendorNo } from '../normalize/raw-item'
import { listRawKeys, paths, readEnrichments, readRaw, readVendorAliases, readVendorLegistar, writeJson } from '../store'

import { getMatter, getMatterRelations, getMattersByVendorNo, mapConcurrent } from './client'

import type { TLegistarMatter } from './client'

const isoDay = (v: string | null | undefined): string | null => v?.slice(0, 10) ?? null
const clean = (v: string | null | undefined): string | null => v?.replace(/\s+/g, ' ').trim() || null

export function toOfficialMatter(m: TLegistarMatter, relatedMatterIds: number[]): TOfficialMatter {
  return {
    matterId: m.MatterId,
    file: m.MatterFile.trim(),
    title: clean(m.MatterName) ?? m.MatterFile,
    type: clean(m.MatterTypeName),
    status: clean(m.MatterStatusName),
    department: clean(m.MatterBodyName),
    introDate: isoDay(m.MatterIntroDate),
    agendaDate: isoDay(m.MatterAgendaDate),
    passedDate: isoDay(m.MatterPassedDate),
    enactmentNumber: clean(m.MatterEnactmentNumber),
    vendorNo: normalizeVendorNo(m.MatterEXText1),
    fundingSource: withoutEmails(clean(m.MatterText1)),
    resourceSite: normalizeCode(m.MatterEXText3),
    legistarUrl: legistarItemUrl(m.MatterId),
    relatedMatterIds: [...new Set(relatedMatterIds)].sort((a, b) => a - b),
  }
}

/** True when a matter's vendor-number field contains one of these codes exactly. */
export function sameVendorNo(field: string | null | undefined, codes: string[]): boolean {
  const theirs = normalizeVendorNo(field)?.split(' ') ?? []
  return theirs.some(c => codes.includes(c))
}

const sortKey = (m: TOfficialMatter): string => m.passedDate ?? m.agendaDate ?? m.introDate ?? ''

export type TVendorHistorySummary = { vendors: number; matters: number }

type TVendorGroup = { vendorNo: string | null; items: TRawItem[]; codes: Set<string>; lastSeen: string }

/** Every consent item, grouped by the same vendor key the build uses. */
async function vendorGroups(): Promise<Map<string, TVendorGroup>> {
  const aliases = await readVendorAliases()
  const groups = new Map<string, TVendorGroup>()
  for (const key of await listRawKeys()) {
    const [raw, enrichments] = await Promise.all([readRaw(key), readEnrichments(key)])
    for (const item of raw?.items ?? []) {
      const name = enrichments?.items[item.file]?.output.vendor.name ?? null
      const vKey = vendorKey(item.vendorNo, name, aliases)
      if (!vKey) continue
      const group = groups.get(vKey) ?? { vendorNo: vKey.startsWith('v-') ? vKey.slice(2) : null, items: [], codes: new Set<string>(), lastSeen: key }
      for (const code of item.vendorNo?.split(' ') ?? []) group.codes.add(code)
      group.items.push(item)
      if (key > group.lastSeen) group.lastSeen = key
      groups.set(vKey, group)
    }
  }
  return groups
}

/**
 * One vendor's official history. With `existing`, only the consent items it
 * doesn't cover yet get their related-record links fetched; everything with
 * the vendor number is always re-read (one query per number variant), so
 * statuses and new non-consent records stay current.
 */
async function historyFor(key: string, group: TVendorGroup, { fresh = false, existing = null }: { fresh?: boolean; existing?: TVendorLegistarFile | null } = {}): Promise<TVendorLegistarFile> {
  const official = new Map<number, TOfficialMatter>((existing?.matters ?? []).map(m => [m.matterId, m]))
  const linked = new Map<number, Set<number>>()
  const link = (a: number, b: number): void => {
    linked.set(a, (linked.get(a) ?? new Set()).add(b))
    linked.set(b, (linked.get(b) ?? new Set()).add(a))
  }
  for (const m of existing?.matters ?? []) for (const r of m.relatedMatterIds) link(m.matterId, r)
  const fetched = new Map<number, TLegistarMatter>()

  // 1. Everything carrying this vendor number, any year. The API query is a
  //    substring match (so doubled values like "005403\r\n005403" are found);
  //    keep only exact code matches, or "1201" would also pull in "001201".
  // Every variant of a merged vendor's number (e.g. "00453" and "000453"), plus the canonical one.
  const codes = [...new Set([...group.codes, ...(group.vendorNo ? [group.vendorNo] : [])])].sort()
  for (const code of codes) {
    for (const m of await getMattersByVendorNo(code, { fresh }).catch(() => [])) {
      if (sameVendorNo(m.MatterEXText1, codes)) fetched.set(m.MatterId, m)
    }
  }

  // 2. Legistar's related-record links from each consent item not covered yet, and the records they point to.
  const itemIds = [...new Set(group.items.map(i => i.matterId))].filter(id => !official.has(id))
  const relations = new Map<number, number[]>()
  await mapConcurrent(itemIds, async id => {
    const rel = await getMatterRelations(id, { fresh }).catch(() => [])
    relations.set(id, rel.map(r => r.MatterRelationMatterId))
  })
  // Relations are symmetric for display: an original agreement lists its amendments too.
  for (const [from, tos] of relations) for (const to of tos) link(from, to)
  const wanted = new Set([...itemIds, ...[...relations.values()].flat()])
  await mapConcurrent([...wanted].filter(id => !fetched.has(id) && !official.has(id)), async id => {
    const m = await getMatter(id, { fresh }).catch(() => null)
    if (m) fetched.set(id, m)
  })

  for (const m of fetched.values()) official.set(m.MatterId, toOfficialMatter(m, []))
  const matters = [...official.values()]
    .map(m => ({ ...m, relatedMatterIds: [...(linked.get(m.matterId) ?? [])].sort((a, b) => a - b) }))
    .sort((a, b) => sortKey(b).localeCompare(sortKey(a)) || b.matterId - a.matterId)
  return { key, vendorNo: group.vendorNo, matters }
}

export async function fetchVendorHistories({ fresh = false }: { fresh?: boolean } = {}): Promise<TVendorHistorySummary> {
  const groups = await vendorGroups()
  let total = 0
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const file = await historyFor(key, group, { fresh })
    await writeJson(paths.vendorLegistar(key), file)
    total += file.matters.length
  }
  return { vendors: groups.size, matters: total }
}

/** True when the history file has every consent item of the vendor, under the same vendor number. */
export function historyCovers(group: Pick<TVendorGroup, 'vendorNo' | 'items'>, file: TVendorLegistarFile | null): boolean {
  if (!file || file.vendorNo !== group.vendorNo) return false
  const have = new Set(file.matters.map(m => m.matterId))
  return group.items.every(i => have.has(i.matterId))
}

/** Vendors updated per run by default; the rest wait. Override with CONSENT_VENDOR_HISTORY_PER_RUN. */
export const DEFAULT_HISTORY_PER_RUN = 40

export function historyPerRun(): number {
  const raw = Number(process.env.CONSENT_VENDOR_HISTORY_PER_RUN)
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_HISTORY_PER_RUN
}

export type TVendorHistoryUpdate = { updated: string[]; removed: string[]; remaining: number }

/**
 * For `consent run`: bring vendor histories up to date incrementally.
 * Vendors whose history doesn't cover all their consent items (new vendors,
 * new items, or a vendor number that changed with a merge) are updated, most
 * recently seen first, at most `limit` per run, always live from Legistar.
 * Files for vendor keys that no longer exist (merged away) are removed.
 */
type TDue = { key: string; group: TVendorGroup; existing: TVendorLegistarFile | null }

/** Vendors whose history is missing or behind, most recently seen first. */
export async function vendorHistoriesDue(groups?: Map<string, TVendorGroup>): Promise<TDue[]> {
  const due: TDue[] = []
  for (const [key, group] of groups ?? await vendorGroups()) {
    const existing = await readVendorLegistar(key)
    if (!historyCovers(group, existing)) due.push({ key, group, existing })
  }
  return due.sort((a, b) => b.group.lastSeen.localeCompare(a.group.lastSeen) || a.key.localeCompare(b.key))
}

export async function updateVendorHistories({ limit = historyPerRun() }: { limit?: number } = {}): Promise<TVendorHistoryUpdate> {
  const groups = await vendorGroups()
  const due = await vendorHistoriesDue(groups)

  const updated: string[] = []
  for (const { key, group, existing } of due.slice(0, limit)) {
    // A file under an old vendor number is rebuilt from scratch.
    const base = existing?.vendorNo === group.vendorNo ? existing : null
    await writeJson(paths.vendorLegistar(key), await historyFor(key, group, { fresh: true, existing: base }))
    updated.push(key)
  }

  const removed: string[] = []
  const dir = path.dirname(paths.vendorLegistar('x'))
  for (const f of (await readdir(dir).catch(() => [])).filter(n => n.endsWith('.json'))) {
    const key = f.replace(/\.json$/, '')
    if (groups.has(key)) continue
    await unlink(path.join(dir, f))
    removed.push(key)
  }
  return { updated: updated.sort(), removed: removed.sort(), remaining: due.length - updated.length }
}
