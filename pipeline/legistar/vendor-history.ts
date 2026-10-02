/**
 * Official Legistar history per vendor.
 *
 * Legistar has no vendor profile: a vendor exists only as the vendor number
 * on each matter (MatterEXText1). For every vendor in our data we collect:
 *   1. every matter carrying its vendor number, in any year, consent or not
 *   2. Legistar's own related-record links from each of its consent items
 *      (e.g. Amendment No. 3 → Amendment No. 2 → the original agreement)
 * and store the official fields in data/legistar/vendors/{key}.json.
 */
import type { TOfficialMatter, TRawItem, TVendorLegistarFile } from '@oakvs/consent-schema/schema'
import { vendorKey } from '@oakvs/consent-schema/vendor-key'

import { withoutEmails } from '../normalize/privacy'
import { legistarItemUrl, normalizeCode, normalizeVendorNo } from '../normalize/raw-item'
import { listRawKeys, paths, readEnrichments, readRaw, readVendorAliases, writeJson } from '../store'

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
    legistarUrl: legistarItemUrl(m.MatterId, m.MatterGuid),
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

export async function fetchVendorHistories({ fresh = false }: { fresh?: boolean } = {}): Promise<TVendorHistorySummary> {
  const aliases = await readVendorAliases()

  // Group every consent item by the same vendor key the build uses.
  const groups = new Map<string, { vendorNo: string | null; items: TRawItem[]; codes: Set<string> }>()
  for (const key of await listRawKeys()) {
    const [raw, enrichments] = await Promise.all([readRaw(key), readEnrichments(key)])
    for (const item of raw?.items ?? []) {
      const name = enrichments?.items[item.file]?.output.vendor.name ?? null
      const vKey = vendorKey(item.vendorNo, name, aliases)
      if (!vKey) continue
      const group = groups.get(vKey) ?? { vendorNo: vKey.startsWith('v-') ? vKey.slice(2) : null, items: [], codes: new Set<string>() }
      for (const code of item.vendorNo?.split(' ') ?? []) group.codes.add(code)
      group.items.push(item)
      groups.set(vKey, group)
    }
  }

  let total = 0
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const matters = new Map<number, TLegistarMatter>()
    const relations = new Map<number, number[]>()

    // 1. Everything carrying this vendor number, any year. The API query is a
    //    substring match (so doubled values like "005403\r\n005403" are found);
    //    keep only exact code matches, or "1201" would also pull in "001201".
    // Every variant of a merged vendor's number (e.g. "00453" and "000453"), plus the canonical one.
    const codes = [...new Set([...group.codes, ...(group.vendorNo ? [group.vendorNo] : [])])].sort()
    for (const code of codes) {
      for (const m of await getMattersByVendorNo(code, { fresh }).catch(() => [])) {
        if (sameVendorNo(m.MatterEXText1, codes)) matters.set(m.MatterId, m)
      }
    }

    // 2. Legistar's related-record links from each consent item, and the records they point to.
    const itemIds = [...new Set(group.items.map(i => i.matterId))]
    await mapConcurrent(itemIds, async id => {
      const rel = await getMatterRelations(id, { fresh }).catch(() => [])
      relations.set(id, rel.map(r => r.MatterRelationMatterId))
    })
    const wanted = new Set([...itemIds, ...[...relations.values()].flat()])
    await mapConcurrent([...wanted].filter(id => !matters.has(id)), async id => {
      const m = await getMatter(id).catch(() => null)
      if (m) matters.set(id, m)
    })

    // Relations are symmetric for display: an original agreement lists its amendments too.
    const linked = new Map<number, Set<number>>()
    for (const [from, tos] of relations) {
      for (const to of tos) {
        linked.set(from, (linked.get(from) ?? new Set()).add(to))
        linked.set(to, (linked.get(to) ?? new Set()).add(from))
      }
    }

    const official = [...matters.values()]
      .map(m => toOfficialMatter(m, [...(linked.get(m.MatterId) ?? [])]))
      .sort((a, b) => sortKey(b).localeCompare(sortKey(a)) || b.matterId - a.matterId)
    const file: TVendorLegistarFile = { key, vendorNo: group.vendorNo, matters: official }
    await writeJson(paths.vendorLegistar(key), file)
    total += official.length
  }
  return { vendors: groups.size, matters: total }
}
