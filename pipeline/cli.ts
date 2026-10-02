/* eslint-disable no-console -- CLI output */
/**
 * Consent Tracker pipeline CLI.
 *
 *   tsx pipeline/cli.ts <command> [options]
 *
 * Commands:
 *   run [--dry-run] [--no-push] [--summary F] One full update cycle: check → ingest → build → commit → push → deploy hook
 *   discover --date YYYY-MM-DD [--key K]      Resolve a meeting's EventId; prints it and the consent item count
 *   ingest --key K [--event N]                Fetch a meeting from Legistar into data/raw
 *   backfill --from D --to D [--limit N]      resolve → ingest for every registry meeting in range, then build
 *   import-prototype [--dir <dir>]            Seed 2026-06-24 from the v1 prototype files
 *   build                                     Rebuild every published file
 *   enrich-export [--key K] [--size 30]       Write agent input chunks for unenriched items (.cache/enrich)
 *   enrich-check --chunk ID                   Validate one agent output chunk (exit 1 on errors)
 *   enrich-import [--key K] --model M         Merge validated chunk outputs into data/enrichments
 *   verify-export [--key K] [--size 30]       Write second-reading chunks (.cache/verify)
 *   verify-check --chunk ID                   Validate one second-reading output chunk (exit 1 on errors)
 *   verify-import [--key K] --model M         Merge second readings into data/verifications
 *   vendor-aliases                            Regenerate vendor aliases (leading-zero typos, number-less names)
 *   vendor-history [--force]                  Fetch every Legistar record per vendor (cached; --force refetches)
 *   research-export [--top N] [--key K]       Write vendor research inputs (organizations only) to .cache/research
 *   research-check --key K                    Validate one research output: schema + fetch every cited page
 *   research-import --model M [--date D]      Run checks and store research in data/vendor-research
 *   review-export                             Write independent-review inputs for high-confidence research
 *   review-check --key K                      Validate one review output
 *   review-import                             Store reviews; mark profiles publishable
 *   upcoming                                  Detect the next Board meeting from future-dated items → published/upcoming.json
 */
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { formatMoney } from '@oakvs/consent-schema/format'
import type { TMeetingFile, TRegistry, TRegistryEntry } from '@oakvs/consent-schema/schema'

import { regenerateAliasFile } from './build/aliases'
import { buildAll } from './build/write'
import { checkChunk, exportChunks, importChunks } from './enrich/agent-io'
import { checkVerifyChunk, exportVerifyChunks, importVerifyChunks } from './enrich/verify-io'
import { importPrototype } from './import/prototype'
import { ingestMeeting } from './ingest'
import { stats } from './legistar/client'
import { resolveEventId } from './legistar/discover'
import { fetchVendorHistories } from './legistar/vendor-history'
import { blankEntry, isSettled, upsert } from './registry/entries'
import {
  checkResearchOutput,
  checkReviewOutput,
  exportResearch,
  exportReviews,
  importResearch,
  importReviews,
} from './research/vendor-research'
import { readRegistry, writeJson, writeRegistry } from './store'

const DEFAULT_PROTOTYPE_DIR = path.join(os.homedir(), 'ousd-mseg', 'consent-prototype')

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    date: { type: 'string' },
    key: { type: 'string' },
    event: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    limit: { type: 'string' },
    dir: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'no-push': { type: 'boolean', default: false },
    summary: { type: 'string' },
    force: { type: 'boolean', default: false },
    size: { type: 'string' },
    chunk: { type: 'string' },
    model: { type: 'string' },
    top: { type: 'string' },
  },
})

function printMeeting(m: TMeetingFile): void {
  const t = m.totals
  const flags = Object.entries(t.flagCounts).map(([k, v]) => `${k}=${v}`).join(' ')
  console.log(
    `${m.meeting.key}  items=${t.items} enriched=${t.enrichedItems}  spending=${formatMoney(t.spendingTotal)} (${t.spendingItems})`
    + `  yearlyCaps=${formatMoney(t.yearlyCapsTotal)} (${t.yearlyCapItems})  revenue=${formatMoney(t.revenueTotal)} (${t.revenueItems})`,
  )
  if (flags) console.log(`    flags: ${flags}`)
  const review = m.items.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.review.status]: (acc[i.review.status] ?? 0) + 1 }), {})
  console.log(`    review: ${Object.entries(review).map(([k, v]) => `${k}=${v}`).join(' ')}`)
}

async function build(): Promise<void> {
  const summary = await buildAll()
  for (const m of summary.meetings) printMeeting(m)
  console.log(`built ${summary.meetings.length} meeting(s), ${summary.vendors} vendor file(s)`)
}

/** Resolve (if needed) and ingest one registry entry; mutates `entry`. */
async function resolveAndIngest(registry: TRegistry, entry: TRegistryEntry): Promise<void> {
  if (entry.eventId == null) {
    const resolved = await resolveEventId(entry.key, entry.date, entry.kind, registry)
    if (!resolved) {
      console.log(`  ${entry.key}: could not resolve an EventId`)
      return
    }
    entry.eventId = resolved.eventId
    entry.resolvedBy = resolved.resolvedBy
    registry.lastKnownEventId = Math.max(registry.lastKnownEventId ?? 0, resolved.eventId)
  }
  let result: Awaited<ReturnType<typeof ingestMeeting>>
  try {
    result = await ingestMeeting(entry.key, entry.eventId, { fresh: entry.status !== 'final' })
  } catch (error) {
    if (/No consent section/.test((error as Error).message)) {
      entry.status = 'skipped'
      entry.note = 'No consent section on this agenda.'
      console.log(`  ${entry.key}: event ${entry.eventId} has no consent section — skipped`)
      return
    }
    throw error
  }
  const { snapshot, changed } = result
  entry.lastIngestedAt = snapshot.fetchedAt
  const settled = isSettled(entry, snapshot)
  entry.status = settled ? 'final' : 'ingested'
  console.log(`  ${entry.key}: event ${entry.eventId} (${entry.resolvedBy}) → ${snapshot.items.length} consent items${changed ? '' : ' (unchanged)'}${settled ? ' [final]' : ''}`)
}

async function main(): Promise<void> {
  const [command] = positionals
  switch (command) {
    case 'import-prototype': {
      const dir = values.dir ?? DEFAULT_PROTOTYPE_DIR
      const { raw, enrichments, overrides } = await importPrototype(
        '2026-06-24',
        path.join(dir, 'OUSD-BOE_2026-06-24_consent_raw.json'),
        path.join(dir, 'OUSD-BOE_2026-06-24_consent_enriched.json'),
      )
      const registry = await readRegistry()
      const entry = registry.meetings.find(m => m.key === '2026-06-24') ?? blankEntry('2026-06-24')
      upsert(registry, {
        ...entry,
        eventId: raw.eventId,
        resolvedBy: entry.resolvedBy ?? 'prototype',
        status: 'final',
      })
      await writeRegistry(registry)
      console.log(`imported ${raw.items.length} items, ${Object.keys(enrichments.items).length} enrichments, ${Object.keys(overrides.items).length} overrides`)
      break
    }
    case 'run': {
      const { printSummary, run } = await import('./run/run')
      const summary = await run({
        dryRun: values['dry-run'],
        push: !values['no-push'],
        deployHookUrl: process.env.VERCEL_DEPLOY_HOOK_URL,
      })
      printSummary(summary)
      if (values.summary) await writeJson(path.resolve(values.summary), summary)
      break
    }
    case 'discover': {
      if (!values.date) throw new Error('--date is required')
      const registry = await readRegistry()
      const key = values.key ?? values.date
      const entry = registry.meetings.find(m => m.key === key) ?? blankEntry(key)
      const resolved = await resolveEventId(key, values.date, entry.kind, registry)
      if (!resolved) {
        console.log(`${key}: no EventId found`)
        process.exitCode = 1
        break
      }
      const { findConsentRows } = await import('./normalize/sections')
      const { getEventItems } = await import('./legistar/client')
      const rows = findConsentRows(await getEventItems(resolved.eventId, { fresh: true }))
      console.log(`${key}: EventId ${resolved.eventId} (via ${resolved.resolvedBy}), ${rows.length} consent items`)
      upsert(registry, { ...entry, eventId: resolved.eventId, resolvedBy: resolved.resolvedBy })
      registry.lastKnownEventId = Math.max(registry.lastKnownEventId ?? 0, resolved.eventId)
      await writeRegistry(registry)
      break
    }
    case 'ingest': {
      if (!values.key) throw new Error('--key is required')
      const registry = await readRegistry()
      const entry = registry.meetings.find(m => m.key === values.key) ?? blankEntry(values.key)
      if (values.event) {
        entry.eventId = Number(values.event)
        entry.resolvedBy = 'manual'
      }
      upsert(registry, entry)
      await resolveAndIngest(registry, entry)
      await writeRegistry(registry)
      break
    }
    case 'backfill': {
      const registry = await readRegistry()
      const from = values.from ?? '0000-00-00'
      const to = values.to ?? '9999-99-99'
      const limit = values.limit ? Number(values.limit) : Infinity
      const targets = registry.meetings
        .filter(m => m.date >= from && m.date <= to && m.status !== 'skipped')
        .filter(m => values.force || m.status !== 'final')
        .slice(0, limit)
      console.log(`backfill: ${targets.length} meeting(s) from ${from} to ${to}`)
      for (const entry of targets) {
        try {
          await resolveAndIngest(registry, entry)
        } catch (error) {
          console.log(`  ${entry.key}: ${(error as Error).message}`)
        }
        await writeRegistry(registry)
      }
      await build()
      break
    }
    case 'build':
      await build()
      break
    case 'enrich-export': {
      const manifest = await exportChunks(values.key ? [values.key] : null, Number(values.size ?? 30))
      const items = manifest.reduce((sum, m) => sum + m.items, 0)
      console.log(`exported ${manifest.length} chunk(s), ${items} item(s) → .cache/enrich/manifest.json`)
      break
    }
    case 'enrich-check': {
      if (!values.chunk) throw new Error('--chunk is required')
      const problems = await checkChunk(values.chunk)
      const errors = problems.filter(p => p.severity === 'error')
      for (const p of problems) console.log(`${p.severity.toUpperCase()} ${p.agendaNumber ?? ''} ${p.file ?? ''}: ${p.message}`)
      console.log(errors.length ? `FAIL: ${errors.length} error(s), ${problems.length - errors.length} warning(s)` : `PASS (${problems.length} warning(s))`)
      process.exitCode = errors.length ? 1 : 0
      break
    }
    case 'enrich-import': {
      if (!values.model) throw new Error('--model is required')
      for (const s of await importChunks(values.key ? [values.key] : null, values.model)) {
        console.log(`${s.meetingKey}: imported ${s.imported}, rejected ${s.rejected}`)
      }
      break
    }
    case 'vendor-aliases': {
      const a = await regenerateAliasFile()
      console.log(`aliases: ${Object.keys(a.vendorNumbers).length} vendor-number alias(es), ${Object.keys(a.names).length} name alias(es) → data/vendors/aliases.json`)
      for (const [from, to] of Object.entries(a.vendorNumbers)) console.log(`  number ${from} → ${to}`)
      break
    }
    case 'upcoming': {
      const { updateUpcoming } = await import('./legistar/upcoming')
      const { file: { meeting } } = await updateUpcoming()
      console.log(meeting
        ? `next meeting: ${meeting.date} · ${meeting.consentItems} consent item(s) filed so far (${meeting.boardItems} Board items)`
        : 'next meeting: none confirmed yet')
      break
    }
    case 'vendor-history': {
      const r = await fetchVendorHistories({ fresh: values.force })
      console.log(`vendor history: ${r.vendors} vendor(s), ${r.matters} Legistar record(s) → data/legistar/vendors`)
      break
    }
    case 'research-export': {
      const keys = await exportResearch({ keys: values.key ? [values.key] : undefined, top: values.top ? Number(values.top) : undefined })
      console.log(`exported ${keys.length} vendor research input(s) → .cache/research/manifest.json`)
      break
    }
    case 'research-check': {
      if (!values.key) throw new Error('--key is required')
      const checks = await checkResearchOutput(values.key)
      for (const c of checks.filter(x => !x.pass)) console.log(`${c.severity.toUpperCase()} ${c.field}: ${c.detail}`)
      const errors = checks.filter(c => !c.pass && c.severity === 'error')
      console.log(errors.length ? `FAIL: ${errors.length} error(s)` : `PASS (${checks.filter(c => !c.pass).length} warning(s))`)
      process.exitCode = errors.length ? 1 : 0
      break
    }
    case 'research-import': {
      if (!values.model) throw new Error('--model is required')
      const rows = await importResearch(values.model, values.date ?? new Date().toISOString().slice(0, 10))
      for (const r of rows) console.log(`${r.key}: ${r.confidence}${r.failed ? `, ${r.failed} check(s) failed` : ''}`)
      break
    }
    case 'review-export': {
      const keys = await exportReviews()
      console.log(`exported ${keys.length} review input(s): ${keys.join(' ')}`)
      break
    }
    case 'review-check': {
      if (!values.key) throw new Error('--key is required')
      const problems = await checkReviewOutput(values.key)
      for (const p of problems) console.log(`ERROR ${p}`)
      console.log(problems.length ? `FAIL: ${problems.length} error(s)` : 'PASS')
      process.exitCode = problems.length ? 1 : 0
      break
    }
    case 'review-import': {
      for (const r of await importReviews()) console.log(`${r.key}: ${r.publishable ? 'publishable' : 'not published'}`)
      break
    }
    case 'verify-export': {
      const manifest = await exportVerifyChunks(values.key ? [values.key] : null, Number(values.size ?? 30))
      console.log(`exported ${manifest.length} chunk(s), ${manifest.reduce((n, m) => n + m.items, 0)} item(s) → .cache/verify/manifest.json`)
      break
    }
    case 'verify-check': {
      if (!values.chunk) throw new Error('--chunk is required')
      const problems = await checkVerifyChunk(values.chunk)
      for (const p of problems) console.log(`ERROR ${p.agendaNumber ?? ''}: ${p.message}`)
      console.log(problems.length ? `FAIL: ${problems.length} error(s)` : 'PASS')
      process.exitCode = problems.length ? 1 : 0
      break
    }
    case 'verify-import': {
      if (!values.model) throw new Error('--model is required')
      for (const r of await importVerifyChunks(values.key ? [values.key] : null, values.model)) {
        console.log(`${r.meetingKey}: imported ${r.imported}`)
      }
      break
    }
    default:
      console.log('usage: tsx pipeline/cli.ts <command> [options] — see the header of pipeline/cli.ts')
      process.exitCode = command ? 1 : 0
  }
  if (stats.network || stats.cache) console.log(`legistar: ${stats.network} network request(s), ${stats.cache} cache hit(s)`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
