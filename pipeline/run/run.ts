/* eslint-disable no-console -- CLI output */
/**
 * `consent run`: one full update cycle, the same on a laptop, in CI or on the
 * homelab. The data repo is the state; there is no database.
 *
 *   1. check (cheap, ~10–20 Legistar requests; most runs stop here)
 *      - future-dated matters → published/upcoming.json, and new meetings
 *        into the registry
 *      - meetings with no EventId yet (from 14 days ago to 14 days ahead):
 *        resolve, probing the EventIds after registry.lastKnownEventId once
 *      - every open (non-final) meeting: re-fetch its event items and compare
 *        a hash; re-ingest only on a change, refreshing outcomes once a day
 *        from the meeting date until it is final
 *   2. fast publish: build → commit → push → deploy hook
 *   3. LLM publish: summaries for new or changed items, then second
 *      readings → vendor aliases → build → the duplicate-vendor judge →
 *      vendor histories from Legistar → build → research for new vendors
 *      (with web search) and an independent review → build → commit → push
 *      → deploy hook. The LLM parts are skipped without ANTHROPIC_API_KEY
 *      and stopped by the monthly cap, which summaries get first; vendor
 *      histories still run. --no-llm skips the whole step.
 *
 * `--dry-run` works on a scratch copy of data/ and prints what would change;
 * it reports what the LLM step would do but never calls the API.
 * `--no-push` commits locally and stops there.
 * If a push is rejected, the run resets to where it started, pulls, and runs
 * again (up to 3 times).
 */
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, open, readdir, readFile, rm, stat, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { oaklandToday } from '@oakvs/consent-schema/format'
import type { TRegistryEntry } from '@oakvs/consent-schema/schema'

import { regenerateAliasFile } from '../build/aliases'
import { buildAll } from '../build/write'
import { addUsage, emptyUsage } from '../llm/client'
import { llmPhase, llmPlan } from '../llm/phase'
import { mergePhase, mergePerRun } from '../llm/merge'
import { researchPhase, researchPerRun } from '../llm/research'
import { candidateGroups } from '../build/vendor-candidates'
import { historyPerRun, updateVendorHistories, vendorHistoriesDue } from '../legistar/vendor-history'
import { unresearchedVendors } from '../research/vendor-research'
import { ingestMeeting } from '../ingest'
import { getEventItems, stats } from '../legistar/client'
import { ANCHOR_EVENT_ID, probeEvents, resolveEventId } from '../legistar/discover'
import { updateUpcoming } from '../legistar/upcoming'
import { isSettled, registerFutureDates } from '../registry/entries'
import { getDataRoot, readRegistry, setDataRoot, stableStringify, writeRegistry } from '../store'

import { changedPaths, git, hasUpstream, head, trackedChanges, tryGit } from './git'
import { commitMessage, llmCommitMessage } from './message'

import type { TBuildSummary } from '../build/write'
import type { TProbedEvents } from '../legistar/discover'
import type { ILlm } from '../llm/client'
import type { TLlmPhaseResult } from '../llm/phase'
import type { TMergePhaseResult } from '../llm/merge'
import type { TResearchPhaseResult } from '../llm/research'
import type { TVendorHistoryUpdate } from '../legistar/vendor-history'
import type { TLlmChanges, TMeetingChange, TRunChanges } from './message'

/** Resolve EventIds for meetings from this many days ago … */
const RESOLVE_BEHIND_DAYS = 14
/** … to this many days ahead (agendas are built a week or two out). */
const RESOLVE_AHEAD_DAYS = 14
const MAX_PUSH_ATTEMPTS = 3
/** What a run may change and commit: the data, and the README's generated numbers. */
const PUBLISH_PATHS = ['data', 'README.md']
const LOCK_FILE = path.join(process.cwd(), '.cache', 'run.lock')
/** A lock older than this is from a crashed run. */
const LOCK_STALE_MS = 2 * 60 * 60 * 1000

export type TRunOptions = {
  dryRun?: boolean
  push?: boolean
  now?: Date
  deployHookUrl?: string
  /** Run the LLM step (default true; it still skips without credentials). */
  llm?: boolean
  /** For tests: a fake in place of the Claude API. */
  llmClient?: ILlm
}

export type TLlmSummary =
  | { status: 'disabled' }
  | {
    status: 'planned'
    plan: { key: string; enrich: number; verify: number }[]
    vendors: { mergeGroups: number; mergePerRun: number; historiesDue: number; historyPerRun: number; research: number; researchPerRun: number }
  }
  | (TLlmPhaseResult & {
    /** The duplicate-vendor judge; null when it didn't run (the summaries failed, were skipped, or hit the cap). */
    merge: TMergePhaseResult | null
    /** Legistar histories for vendors with new items; null if the step failed before them. */
    history: TVendorHistoryUpdate | null
    /** Vendor research, run last; null when it didn't run. */
    research: TResearchPhaseResult | null
    changes: TLlmChanges
    commit: { sha: string; subject: string } | null
    pushed: boolean
    deployed: boolean
    /** Set when the step died part-way; whatever it finished was still committed. */
    error: string | null
  })

export type TRunSummary = TRunChanges & {
  startedAt: string
  dryRun: boolean
  /** Files under data/ the cycle changed. */
  changedFiles: string[]
  publishedChanged: boolean
  commit: { sha: string; subject: string } | null
  pushed: boolean
  deployed: boolean
  legistarRequests: number
  llm: TLlmSummary
}

const addDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export const hashEventItems = (items: unknown): string =>
  createHash('sha256').update(stableStringify(items)).digest('hex').slice(0, 16)

const isOpen = (m: TRegistryEntry): boolean => m.eventId != null && m.status !== 'final' && m.status !== 'skipped'

/** One check → ingest → build pass over the current data root. Writes files; never touches git. */
export async function cycle(now: Date = new Date()): Promise<TRunChanges> {
  const today = oaklandToday(now)
  const registry = await readRegistry()

  // 1a. Future-dated matters: the next meeting, and any new meeting dates.
  const upcoming = await updateUpcoming(now)
  const discovered = registerFutureDates(registry, upcoming.meetings.map(m => m.date)).map(e => e.key)

  // 1b. Meetings near today with no EventId yet. One probe, shared.
  const resolved: TRunChanges['resolved'] = []
  let probed: TProbedEvents | undefined
  const unresolved = registry.meetings.filter(m =>
    m.eventId == null && m.status === 'discovered'
    && m.date >= addDays(today, -RESOLVE_BEHIND_DAYS) && m.date <= addDays(today, RESOLVE_AHEAD_DAYS))
  for (const entry of unresolved) {
    probed ??= await probeEvents(registry.lastKnownEventId ?? ANCHOR_EVENT_ID)
    const r = await resolveEventId(entry.key, entry.date, entry.kind, registry, { useHistory: entry.date < today, probed })
    if (!r) continue
    entry.eventId = r.eventId
    entry.resolvedBy = r.resolvedBy
    registry.lastKnownEventId = Math.max(registry.lastKnownEventId ?? 0, r.eventId)
    resolved.push({ key: entry.key, eventId: r.eventId, resolvedBy: r.resolvedBy })
  }

  // 1c. Open meetings: a cheap hash check, then an incremental ingest when needed.
  const meetings: TMeetingChange[] = []
  for (const entry of registry.meetings.filter(isOpen)) {
    const eventItems = await getEventItems(entry.eventId!, { fresh: true })
    const hash = hashEventItems(eventItems)
    const eventChanged = hash !== entry.eventItemsHash
    const historiesDue = entry.date <= today && entry.historiesCheckedOn !== today
    if (!eventChanged && !historiesDue) continue

    let result: Awaited<ReturnType<typeof ingestMeeting>>
    try {
      result = await ingestMeeting(entry.key, entry.eventId!, { eventItems, reuseUnchanged: true, refreshHistories: historiesDue })
    } catch (error) {
      if (!/No consent section/.test((error as Error).message)) throw error
      entry.eventItemsHash = hash
      // An agenda still being built may not have its consent section yet; only give up once the meeting is past.
      if (entry.date < today) {
        entry.status = 'skipped'
        entry.note = 'No consent section on this agenda.'
      }
      continue
    }
    const { snapshot, changed, diff } = result
    entry.eventItemsHash = hash
    if (historiesDue) entry.historiesCheckedOn = today
    entry.lastIngestedAt = snapshot.fetchedAt
    const final = isSettled(entry, snapshot, now)
    entry.status = final ? 'final' : 'ingested'
    meetings.push({ key: entry.key, eventId: entry.eventId!, items: snapshot.items.length, diff, unchanged: !changed, final })
  }

  await writeRegistry(registry)

  // 2. Rebuild everything. The build is deterministic, so an unchanged input gives byte-identical output.
  const built = await buildAll()
  const pendingSummaries = built.meetings.reduce((n, m) => n + m.totals.items - m.totals.enrichedItems, 0)

  return {
    upcoming: { changed: upcoming.changed, date: upcoming.file.meeting?.date ?? null, consentItems: upcoming.file.meeting?.consentItems ?? null },
    discovered,
    resolved,
    meetings,
    pendingSummaries,
  }
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await git(['rev-parse', '--git-dir']) // fail early outside a repo
  await mkdir(path.dirname(LOCK_FILE), { recursive: true })
  try {
    const age = Date.now() - (await stat(LOCK_FILE)).mtimeMs
    if (age < LOCK_STALE_MS) throw new Error(`another consent run holds ${LOCK_FILE} (${Math.round(age / 60000)} min old)`)
    await unlink(LOCK_FILE)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const handle = await open(LOCK_FILE, 'wx')
  await handle.write(`${process.pid} ${new Date().toISOString()}\n`)
  await handle.close()
  try {
    return await fn()
  } finally {
    await unlink(LOCK_FILE).catch(() => undefined)
  }
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await listFiles(full, base))
    else out.push(path.relative(base, full))
  }
  return out
}

/** Relative paths that were added, removed or changed between two folders. */
export async function diffTrees(before: string, after: string): Promise<string[]> {
  const [a, b] = await Promise.all([listFiles(before), listFiles(after)])
  const all = [...new Set([...a, ...b])].sort()
  const changed: string[] = []
  for (const f of all) {
    const [x, y] = await Promise.all([
      readFile(path.join(before, f)).catch(() => null),
      readFile(path.join(after, f)).catch(() => null),
    ])
    if (!x || !y || !x.equals(y)) changed.push(f)
  }
  return changed
}

async function dryRun(now: Date): Promise<TRunSummary> {
  const startedAt = new Date().toISOString()
  const real = getDataRoot()
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'consent-dry-run-'))
  const copy = path.join(scratch, 'data')
  await cp(real, copy, { recursive: true })
  setDataRoot(copy)
  try {
    const changes = await cycle(now)
    const changedFiles = (await diffTrees(real, copy)).map(f => path.join('data', f))
    const plan = await llmPlan()
    const vendors = {
      mergeGroups: (await candidateGroups()).length,
      mergePerRun: mergePerRun(),
      historiesDue: (await vendorHistoriesDue()).length,
      historyPerRun: historyPerRun(),
      research: (await unresearchedVendors()).length,
      researchPerRun: researchPerRun(),
    }
    return {
      ...changes,
      llm: { status: 'planned', plan, vendors },
      startedAt,
      dryRun: true,
      changedFiles,
      publishedChanged: changedFiles.some(f => f.startsWith('data/published/')),
      commit: null,
      pushed: false,
      deployed: false,
      legistarRequests: stats.network,
    }
  } finally {
    setDataRoot(real)
    await rm(scratch, { recursive: true, force: true })
  }
}

async function deploy(url: string): Promise<boolean> {
  const res = await fetch(url, { method: 'POST' })
  if (!res.ok) console.log(`deploy hook: HTTP ${res.status}`)
  return res.ok
}

/** Summary numbers for the LLM commit, with how many items the build flagged per meeting. */
export type TVendorSteps = { merge?: TMergePhaseResult | null; history?: TVendorHistoryUpdate | null; research?: TResearchPhaseResult | null }

export function toLlmChanges(phase: TLlmPhaseResult, built: TBuildSummary, { merge = null, history = null, research = null }: TVendorSteps = {}): TLlmChanges {
  const paid = [merge, research].filter((x): x is TMergePhaseResult | TResearchPhaseResult => x?.usage != null)
  return {
    meetings: phase.meetings.map(m => {
      const meeting = built.meetings.find(b => b.meeting.key === m.key)
      return {
        key: m.key,
        summaries: m.enrich.done.length,
        secondReadings: m.verify.done.length,
        failed: m.enrich.failed.length + m.verify.failed.length,
        waiting: m.enrich.waiting.length + m.verify.waiting.length,
        gaveUp: m.enrich.gaveUp.length + m.verify.gaveUp.length,
        flagged: meeting?.items.filter(i => i.review.status === 'needs_review' || i.review.status === 'blocked').length ?? 0,
      }
    }),
    vendors: merge || history || research
      ? {
        merged: merge?.merged ?? [],
        keptSeparate: merge?.kept ?? 0,
        mergeGroupsLeft: merge?.remaining ?? 0,
        historiesUpdated: history?.updated.length ?? 0,
        historiesRemoved: history?.removed.length ?? 0,
        historiesLeft: history?.remaining ?? 0,
        researched: research?.researched.length ?? 0,
        published: research?.reviewed.filter(r => r.publishable).length ?? 0,
        reviewed: research?.reviewed.length ?? 0,
        failed: (research?.failed.length ?? 0) + (merge?.failed.length ?? 0),
        gaveUp: (research?.gaveUp.length ?? 0) + (merge?.gaveUp.length ?? 0),
        remaining: research?.remaining ?? 0,
      }
      : null,
    costUsd: (phase.usage?.costUsd ?? 0) + paid.reduce((n, x) => n + x.usage!.costUsd, 0),
    // Each step reads the ledger the one before it wrote, so the last paid step has the month's total.
    monthSpendUsd: paid.at(-1)?.monthSpendUsd ?? phase.monthSpendUsd,
    capUsd: phase.capUsd,
    capped: phase.status === 'capped' || merge?.status === 'capped' || research?.status === 'capped',
  }
}

async function commitData(subject: string, body: string): Promise<{ sha: string; subject: string }> {
  await git(['add', '--all', '--', ...PUBLISH_PATHS])
  await git(['commit', '--quiet', '-m', subject, '-m', body])
  return { sha: await head(), subject }
}

/** Step 1–2: check, ingest, build, commit, push. Re-runs from scratch if the push is rejected. */
async function fastPublish(now: Date, push: boolean, deployHookUrl: string | undefined, startedAt: string): Promise<TRunSummary> {
  for (let attempt = 1; ; attempt++) {
    const base = await head()
    const changes = await cycle(now)
    const changedFiles = (await changedPaths(...PUBLISH_PATHS)).map(l => l.slice(3))
    const summary: TRunSummary = {
      ...changes,
      startedAt,
      dryRun: false,
      changedFiles,
      publishedChanged: changedFiles.some(f => f.startsWith('data/published/')),
      commit: null,
      pushed: false,
      deployed: false,
      legistarRequests: stats.network,
      llm: { status: 'disabled' },
    }
    if (changedFiles.length === 0) return summary

    const { subject, body } = commitMessage(changes)
    summary.commit = await commitData(subject, body)
    if (!push) return summary

    const pushed = await tryGit(['push', '--quiet'])
    if (pushed.ok) {
      summary.pushed = true
      if (deployHookUrl && summary.publishedChanged) summary.deployed = await deploy(deployHookUrl)
      return summary
    }
    if (attempt >= MAX_PUSH_ATTEMPTS) throw new Error(`push rejected ${attempt} times: ${pushed.stderr}`)
    console.log(`push rejected (attempt ${attempt}); resetting to ${base.slice(0, 7)}, pulling and running again`)
    // Safe: the tree was clean when the run started, so this only drops this run's own commit and files.
    await git(['reset', '--quiet', '--hard', base])
    await git(['clean', '--quiet', '-fd', '--', 'data'])
    await git(['pull', '--ff-only'])
  }
}

/**
 * Step 3: the LLM publish. Its work is paid for, so a rejected push is
 * rebased rather than thrown away. If the step dies part-way, what it
 * finished is still committed and pushed, then the error is re-thrown.
 */
async function llmPublish(now: Date, push: boolean, deployHookUrl: string | undefined, llmClient: ILlm | undefined): Promise<TLlmSummary> {
  const today = oaklandToday(now)
  let phase: TLlmPhaseResult | null = null
  let merge: TMergePhaseResult | null = null
  let history: TVendorHistoryUpdate | null = null
  let research: TResearchPhaseResult | null = null
  let failure: unknown = null
  try {
    phase = await llmPhase({ llm: llmClient, today })
  } catch (error) {
    failure = error
  }
  // The paid vendor steps run only after the summaries finished, within the cap.
  const paidOk = (): boolean => !failure && phase?.status === 'ran' && merge?.status !== 'capped'

  // New summaries can name new vendors: fold obvious name variants into known vendors first.
  await regenerateAliasFile()
  let built = await buildAll()
  if (paidOk()) {
    try {
      merge = await mergePhase({ llm: llmClient, today })
    } catch (error) {
      failure = error
    }
  }
  if (!failure) {
    try {
      // After the judge, so histories are filed under the merged vendor keys.
      history = await updateVendorHistories()
    } catch (error) {
      failure = error
    }
  }
  if (merge?.merged.length || history?.updated.length || history?.removed.length) built = await buildAll()
  if (paidOk()) {
    try {
      research = await researchPhase({ llm: llmClient, today })
      if (research.researched.length || research.reviewed.length) built = await buildAll()
    } catch (error) {
      failure = error
    }
  }

  const result: TLlmPhaseResult = phase ?? { status: 'ran', reason: null, meetings: [], usage: null, monthSpendUsd: 0, capUsd: 0 }
  const changes = toLlmChanges(result, built, { merge, history, research })
  let usage = result.usage
  for (const step of [merge, research]) {
    if (!step?.usage) continue
    usage = { ...(usage ?? emptyUsage()) }
    addUsage(usage, step.usage)
  }
  const cappedBy = [result, merge, research].find(x => x?.status === 'capped')
  const summary: TLlmSummary = {
    ...result,
    status: cappedBy ? 'capped' : result.status,
    reason: cappedBy?.reason ?? result.reason,
    usage,
    monthSpendUsd: changes.monthSpendUsd,
    merge,
    history,
    research,
    changes,
    commit: null,
    pushed: false,
    deployed: false,
    error: failure ? (failure as Error).message : null,
  }

  const changedFiles = (await changedPaths(...PUBLISH_PATHS)).map(l => l.slice(3))
  if (changedFiles.length) {
    const { subject, body } = llmCommitMessage(changes)
    summary.commit = await commitData(failure ? `${subject} (partial: LLM step failed)` : subject, body)
    if (push) {
      let pushed = await tryGit(['push', '--quiet'])
      if (!pushed.ok) {
        await git(['pull', '--rebase', '--quiet'])
        pushed = await tryGit(['push', '--quiet'])
      }
      if (!pushed.ok) throw new Error(`LLM publish: push rejected after a rebase: ${pushed.stderr}`)
      summary.pushed = true
      if (deployHookUrl && changedFiles.some(f => f.startsWith('data/published/'))) summary.deployed = await deploy(deployHookUrl)
    }
  }
  if (failure) throw failure
  return summary
}

async function liveRun(now: Date, push: boolean, deployHookUrl: string | undefined, llm: boolean, llmClient: ILlm | undefined): Promise<TRunSummary> {
  const startedAt = new Date().toISOString()
  const dirty = await trackedChanges()
  if (dirty.length) throw new Error(`work tree has uncommitted changes; commit or stash first:\n${dirty.join('\n')}`)
  const strayData = await changedPaths('data')
  if (strayData.length) throw new Error(`data/ has untracked files; commit or remove them first:\n${strayData.join('\n')}`)
  if (push && !(await hasUpstream())) throw new Error('this branch has no upstream to push to; set one or use --no-push')
  if (push) await git(['pull', '--ff-only'])

  const summary = await fastPublish(now, push, deployHookUrl, startedAt)
  if (llm) summary.llm = await llmPublish(now, push, deployHookUrl, llmClient)
  return summary
}

export async function run({ dryRun: dry = false, push = true, now = new Date(), deployHookUrl, llm = true, llmClient }: TRunOptions = {}): Promise<TRunSummary> {
  return withLock(() => (dry ? dryRun(now) : liveRun(now, push, deployHookUrl, llm, llmClient)))
}

export function printSummary(s: TRunSummary): void {
  const { subject, body } = commitMessage(s)
  console.log(`consent run${s.dryRun ? ' (dry run)' : ''}: ${s.legistarRequests} Legistar request(s)`)
  if (s.changedFiles.length === 0) {
    console.log('no changes')
  } else {
    console.log(`${s.changedFiles.length} file(s) changed${s.publishedChanged ? ', including published/' : ' (bookkeeping only)'}`)
    console.log(`${s.commit ? `commit ${s.commit.sha.slice(0, 7)}` : 'would commit'}: ${subject}`)
    console.log(body)
  }
  if (s.pushed) console.log(`pushed${s.deployed ? ', deploy hook called' : ''}`)

  const llm = s.llm
  if (llm.status === 'disabled') return
  if (llm.status === 'planned') {
    const enrich = llm.plan.reduce((n, p) => n + p.enrich, 0)
    const verify = llm.plan.reduce((n, p) => n + p.verify, 0)
    console.log(enrich || verify ? `LLM step would run: ${enrich} summar${enrich === 1 ? 'y' : 'ies'}, ${verify} second reading(s)` : 'LLM step: nothing to do')
    const v = llm.vendors
    if (v.mergeGroups) console.log(`duplicate-vendor judge would run: ${Math.min(v.mergeGroups, v.mergePerRun)} of ${v.mergeGroups} group(s)`)
    if (v.historiesDue) console.log(`vendor histories would update: ${Math.min(v.historiesDue, v.historyPerRun)} of ${v.historiesDue} vendor(s)`)
    if (v.research) console.log(`vendor research would run: ${Math.min(v.research, v.researchPerRun)} of ${v.research} new vendor(s) (plus any from new summaries)`)
    return
  }
  if (llm.status === 'skipped') console.log(`LLM step skipped: ${llm.reason}`)
  if (llm.meetings.length === 0 && !llm.commit && !llm.error) return void (llm.status !== 'skipped' && console.log('LLM step: nothing to do'))
  const m = llmCommitMessage(llm.changes)
  if (llm.commit) console.log(`LLM commit ${llm.commit.sha.slice(0, 7)}: ${llm.commit.subject}`)
  console.log(m.body)
  if (llm.error) console.log(`LLM step failed: ${llm.error}`)
}
