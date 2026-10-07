/**
 * Cross-meeting vendor rollups.
 *
 * One file per vendor UID (`v-{vendor number}` or `n-{normalized name}`),
 * combining:
 * - official Legistar data: every record carrying the vendor number in any
 *   year, related records, and the official departments, record types,
 *   funding sources and resource codes on them
 * - this tool's data: every consent appearance, with the summary, money and
 *   outcome, and the codebook classification
 *
 * A file number that appears at several meetings (postponed, deferred,
 * re-agendized) only counts toward totals at its latest appearance, so the
 * June 24 → June 29 deferral is one adoption, not two.
 */
import { SCHEMA_VERSION } from '@oakvs/consent-schema/schema'
import type {
  TMeetingFile,
  TOfficialMatter,
  TVendorAppearance,
  TVendorFile,
  TVendorIndexFile,
  TVendorLegistarFile,
  TVendorResearchRecord,
} from '@oakvs/consent-schema/schema'
import { currentVendorKey, vendorKey } from '@oakvs/consent-schema/vendor-key'
import type { TVendorAliases } from '@oakvs/consent-schema/vendor-key'

import { publishedProfile } from '../research/vendor-research'

const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, none: 0 }

/**
 * Research records are stored under the vendor key they were made for. When
 * vendors merge (a new alias), re-key them to the vendor's current key; if two
 * land on one vendor, keep the publishable one, then the more confident, then
 * the newer, then the first key.
 */
export function researchByCurrentKey(research: Map<string, TVendorResearchRecord>, aliases: TVendorAliases): Map<string, TVendorResearchRecord> {
  const out = new Map<string, TVendorResearchRecord>()
  // Positive when `a` should win over `b`.
  const compare = (a: TVendorResearchRecord, b: TVendorResearchRecord): number =>
    Number(a.publishable) - Number(b.publishable)
    || (CONFIDENCE_RANK[a.research.confidence] ?? 0) - (CONFIDENCE_RANK[b.research.confidence] ?? 0)
    || a.researchedAt.localeCompare(b.researchedAt)
    || b.key.localeCompare(a.key)
  for (const rec of [...research.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const key = currentVendorKey(rec.key, aliases)
    const existing = out.get(key)
    if (!existing || compare(rec, existing) > 0) out.set(key, rec)
  }
  return out
}

type TTally = { name: string; count: number }[]

function tally(values: (string | null | undefined)[]): TTally {
  const counts = new Map<string, number>()
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }))
}

const unique = (values: (string | null | undefined)[]): string[] =>
  [...new Set(values.filter((v): v is string => Boolean(v)))].sort()

const cents = (v: number): number => Math.round(v * 100) / 100

type TGroup = {
  vendorNo: string | null
  names: string[]
  locations: string[]
  kinds: string[]
  departments: string[]
  resourceSites: string[]
  appearances: TVendorAppearance[]
}

export function buildVendors(
  meetings: TMeetingFile[],
  aliases: TVendorAliases,
  legistar: Map<string, TVendorLegistarFile> = new Map(),
  research: Map<string, TVendorResearchRecord> = new Map(),
): { files: TVendorFile[]; index: TVendorIndexFile } {
  research = researchByCurrentKey(research, aliases)
  const sorted = [...meetings].sort((a, b) => a.meeting.key.localeCompare(b.meeting.key))

  const groups = new Map<string, TGroup>()
  for (const m of sorted) {
    for (const item of m.items) {
      const e = item.enrichment
      // The build stamps each item with its vendor UID; recompute only for older inputs.
      const key = item.vendorKey ?? vendorKey(item.vendorNo, e?.vendor.name ?? null, aliases)
      if (!key) continue
      const group = groups.get(key) ?? {
        // The key carries the canonical number after aliasing (v-000453, not 00453).
        vendorNo: key.startsWith('v-') ? key.slice(2) : null,
        names: [], locations: [], kinds: [], departments: [], resourceSites: [], appearances: [],
      }
      if (e?.vendor.name) group.names.push(e.vendor.name)
      if (e?.vendor.location) group.locations.push(e.vendor.location)
      if (e?.vendor.kind) group.kinds.push(e.vendor.kind)
      if (item.presenter) group.departments.push(item.presenter)
      if (item.resourceSite) group.resourceSites.push(item.resourceSite)
      const money = e?.money ?? null
      group.appearances.push({
        id: item.id,
        meetingKey: m.meeting.key,
        date: m.meeting.date,
        file: item.file,
        matterId: item.matterId,
        agendaNumber: item.agendaNumber,
        title: item.title,
        headline: e?.headline ?? null,
        enriched: e != null,
        category: e?.category ?? null,
        actionType: e?.actionType ?? null,
        direction: money?.direction ?? null,
        amountType: money?.amountType ?? null,
        thisAction: money?.thisAction ?? null,
        newTotal: money?.newTotal ?? null,
        term: e ? { start: e.term.start, end: e.term.end } : null,
        fundingSource: item.fundingSource,
        outcome: item.outcome,
        flags: item.flags,
        countsTowardTotals: item.countsTowardTotals,
      })
      groups.set(key, group)
    }
  }

  const files: TVendorFile[] = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => {
      const history: TOfficialMatter[] = legistar.get(key)?.matters ?? []
      const counted = group.appearances.filter(a => a.countsTowardTotals && a.outcome?.adopted)
      const sum = (list: TVendorAppearance[]): number => cents(list.reduce((s, a) => s + (a.thisAction ?? 0), 0))
      const dates = group.appearances.map(a => a.date).sort()
      const names = tally(group.names).map(t => t.name)
      const kind = group.kinds.includes('individual') ? 'individual' : group.kinds.includes('organization') ? 'organization' : null
      const ref = group.vendorNo ? `vendor no. ${group.vendorNo}` : null
      const displayName = kind === 'individual'
        ? `Individual contractor${ref ? ` (${ref})` : ''}`
        : names[0] ?? (ref ? `Vendor ${group.vendorNo}` : key)

      return {
        schemaVersion: SCHEMA_VERSION,
        key,
        vendorNo: group.vendorNo,
        displayName,
        kind,
        names,
        locations: unique(group.locations),
        firstSeen: dates[0],
        lastSeen: dates.at(-1)!,
        approvedTotal: sum(counted.filter(a => a.direction === 'expense' && a.amountType !== 'per_year' && a.amountType !== 'sales_cap')),
        yearlyCapsTotal: sum(counted.filter(a => a.direction === 'expense' && a.amountType === 'per_year')),
        // A grant application isn't money received; it's counted when the award is accepted.
        revenueTotal: sum(counted.filter(a => a.direction === 'revenue' && !a.flags.includes('grant_application'))),
        approvedCount: counted.length,
        pendingAmounts: group.appearances.filter(a => a.countsTowardTotals && !a.enriched).length,
        fundingSources: unique([...group.appearances.map(a => a.fundingSource), ...history.map(h => h.fundingSource)]),
        official: {
          departments: tally(history.length ? history.map(h => h.department) : group.departments),
          matterTypes: tally(history.map(h => h.type)),
          resourceSites: unique([...group.resourceSites, ...history.map(h => h.resourceSite)]),
        },
        taxonomy: {
          categories: tally(group.appearances.filter(a => a.countsTowardTotals).map(a => a.category)),
          actionTypes: tally(group.appearances.filter(a => a.countsTowardTotals).map(a => a.actionType)),
        },
        appearances: group.appearances,
        legistarHistory: history,
        // AI research is published only for organizations, and only when it passed every check.
        profile: kind === 'individual' ? null : (research.has(key) ? publishedProfile(research.get(key)!) : null),
      }
    })

  const index: TVendorIndexFile = {
    schemaVersion: SCHEMA_VERSION,
    vendors: files.map(f => ({
      key: f.key,
      vendorNo: f.vendorNo,
      name: f.displayName,
      kind: f.kind,
      topCategory: f.taxonomy.categories[0]?.name ?? null,
      meetings: new Set(f.appearances.map(a => a.meetingKey)).size,
      appearances: f.appearances.length,
      approvedCount: f.approvedCount,
      approvedTotal: f.approvedTotal,
      legistarRecords: f.legistarHistory.length,
      lastSeen: f.lastSeen,
      hasProfile: f.profile !== null,
    })),
  }

  return { files, index }
}
