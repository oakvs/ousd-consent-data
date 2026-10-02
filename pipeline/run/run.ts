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
 *   3. LLM publish: not yet (BRIEF step 5); the run reports how many items
 *      are waiting for summaries.
 *
 * `--dry-run` works on a scratch copy of data/ and prints what would change.
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

import { buildAll } from '../build/write'
import { ingestMeeting } from '../ingest'
import { getEventItems, stats } from '../legistar/client'
import { ANCHOR_EVENT_ID, probeEvents, resolveEventId } from '../legistar/discover'
import { updateUpcoming } from '../legistar/upcoming'
import { isSettled, registerFutureDates } from '../registry/entries'
import { getDataRoot, readRegistry, setDataRoot, stableStringify, writeRegistry } from '../store'

import { changedPaths, git, hasUpstream, head, trackedChanges, tryGit } from './git'
import { commitMessage } from './message'

import type { TProbedEvents } from '../legistar/discover'
import type { TMeetingChange, TRunChanges } from './message'

/** Resolve EventIds for meetings from this many days ago … */
const RESOLVE_BEHIND_DAYS = 14
/** … to this many days ahead (agendas are built a week or two out). */
const RESOLVE_AHEAD_DAYS = 14
const MAX_PUSH_ATTEMPTS = 3
const LOCK_FILE = path.join(process.cwd(), '.cache', 'run.lock')
/** A lock older than this is from a crashed run. */
const LOCK_STALE_MS = 2 * 60 * 60 * 1000

export type TRunOptions = {
  dryRun?: boolean
  push?: boolean
  now?: Date
  deployHookUrl?: string
}

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
    return {
      ...changes,
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

async function liveRun(now: Date, push: boolean, deployHookUrl: string | undefined): Promise<TRunSummary> {
  const startedAt = new Date().toISOString()
  const dirty = await trackedChanges()
  if (dirty.length) throw new Error(`work tree has uncommitted changes; commit or stash first:\n${dirty.join('\n')}`)
  const strayData = await changedPaths('data')
  if (strayData.length) throw new Error(`data/ has untracked files; commit or remove them first:\n${strayData.join('\n')}`)
  if (push && !(await hasUpstream())) throw new Error('this branch has no upstream to push to; set one or use --no-push')
  if (push) await git(['pull', '--ff-only'])

  for (let attempt = 1; ; attempt++) {
    const base = await head()
    const changes = await cycle(now)
    const changedFiles = (await changedPaths('data')).map(l => l.slice(3))
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
    }
    if (changedFiles.length === 0) return summary

    const { subject, body } = commitMessage(changes)
    await git(['add', '--all', '--', 'data'])
    await git(['commit', '--quiet', '-m', subject, '-m', body])
    summary.commit = { sha: await head(), subject }
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

export async function run({ dryRun: dry = false, push = true, now = new Date(), deployHookUrl }: TRunOptions = {}): Promise<TRunSummary> {
  return withLock(() => (dry ? dryRun(now) : liveRun(now, push, deployHookUrl)))
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
}
