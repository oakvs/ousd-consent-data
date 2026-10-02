/**
 * WF-6 Build: regenerate every published file from raw + enrichments + overrides.
 *
 * Always rebuilds all meetings, because the cross-meeting pieces (lineage,
 * vendors, index) depend on every meeting. The output is deterministic: the
 * same inputs give byte-identical files.
 */
import { rm } from 'node:fs/promises'
import path from 'node:path'

import { schoolYearOf, summarizeConsentVotes } from '@oakvs/consent-schema/format'
import { IndexFile, ListItem, MeetingFile, MeetingListFile, SCHEMA_VERSION, VendorFile } from '@oakvs/consent-schema/schema'
import type { TIndexFile, TMeetingFile, TMeetingListFile, TOverride, TRawSnapshot } from '@oakvs/consent-schema/schema'

import { readAllResearch } from '../research/vendor-research'
import {
  listRawKeys,
  paths,
  readEnrichments,
  readOverrides,
  readRaw,
  readRegistry,
  readAllVendorLegistar,
  readVendorAliases,
  readVerifications,
  writeJson,
} from '../store'

import { writeExports } from './exports'
import { buildMeeting, overrideKey } from './meeting'
import { buildVendors } from './vendors'

export function toListFile(file: TMeetingFile): TMeetingListFile {
  return {
    schemaVersion: file.schemaVersion,
    meeting: file.meeting,
    totals: file.totals,
    items: file.items.map(i => ListItem.parse(i)),
  }
}

export type TBuildSummary = { meetings: TMeetingFile[]; vendors: number }

export async function buildAll(): Promise<TBuildSummary> {
  const [keys, registry, aliases] = await Promise.all([listRawKeys(), readRegistry(), readVendorAliases()])
  const raws = (await Promise.all(keys.map(readRaw))).filter((r): r is TRawSnapshot => r != null)

  const fileAppearances = new Map<string, string[]>()
  for (const raw of raws) {
    for (const item of raw.items) {
      const list = fileAppearances.get(item.file) ?? []
      list.push(raw.meetingKey)
      fileAppearances.set(item.file, list)
    }
  }

  // Human overrides follow an item to every meeting where it appears with identical text.
  const sharedOverrides = new Map<string, TOverride>()
  for (const raw of raws) {
    const overrides = await readOverrides(raw.meetingKey)
    for (const item of raw.items) {
      const o = overrides?.items[item.file]
      if (o && !sharedOverrides.has(overrideKey(item.file, item.text))) sharedOverrides.set(overrideKey(item.file, item.text), o)
    }
  }

  const meetings: TMeetingFile[] = []
  for (const raw of raws) {
    const [enrichments, overrides, verifications] = await Promise.all([
      readEnrichments(raw.meetingKey),
      readOverrides(raw.meetingKey),
      readVerifications(raw.meetingKey),
    ])
    const entry = registry.meetings.find(m => m.key === raw.meetingKey) ?? null
    meetings.push(MeetingFile.parse(buildMeeting({ raw, enrichments, overrides, verifications, sharedOverrides, vendorAliases: aliases, registry: entry, fileAppearances })))
  }

  const out = paths.published
  await rm(path.join(out, 'meetings'), { recursive: true, force: true })
  await rm(path.join(out, 'vendors'), { recursive: true, force: true })

  for (const m of meetings) {
    await writeJson(path.join(out, 'meetings', `${m.meeting.key}.json`), m)
    await writeJson(path.join(out, 'meetings', `${m.meeting.key}.list.json`), MeetingListFile.parse(toListFile(m)))
  }

  const index: TIndexFile = IndexFile.parse({
    schemaVersion: SCHEMA_VERSION,
    meetings: meetings
      .map(m => ({
        key: m.meeting.key,
        date: m.meeting.date,
        kind: m.meeting.kind,
        title: m.meeting.title,
        schoolYear: schoolYearOf(m.meeting.date),
        items: m.totals.items,
        enrichedItems: m.totals.enrichedItems,
        spendingTotal: m.totals.spendingTotal,
        spendingItems: m.totals.spendingItems,
        revenueTotal: m.totals.revenueTotal,
        revenueItems: m.totals.revenueItems,
        flagCounts: m.totals.flagCounts,
        consentVotes: summarizeConsentVotes(m.meeting.consentVotes),
        revision: m.meeting.revision,
        updatedAt: m.meeting.updatedAt,
      }))
      .sort((a, b) => b.key.localeCompare(a.key)),
  })
  await writeJson(path.join(out, 'index.json'), index)

  const vendors = buildVendors(meetings, aliases, await readAllVendorLegistar(), await readAllResearch())
  for (const v of vendors.files) await writeJson(path.join(out, 'vendors', `${v.key}.json`), VendorFile.parse(v))
  await writeJson(path.join(out, 'vendors', 'index.json'), vendors.index)

  await writeExports(meetings, vendors.index)

  return { meetings, vendors: vendors.files.length }
}
