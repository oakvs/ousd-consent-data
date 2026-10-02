/* eslint-disable no-console -- CLI output */
/** The operational CLI commands: alerts, the homelab standby, and the quarterly Legistar check. */
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'

import { LEGISTAR_BASE, USER_AGENT } from '../legistar/client'
import { tryGit } from '../run/git'
import { printSummary, run } from '../run/run'
import { writeJson } from '../store'

import { DEFAULT_REPO, workflowRuns } from './github'
import { failureNotice, runNotices, sendNotice, stepSummary } from './notify'
import { DEFAULT_GRACE_MINUTES, emptyStandbyState, standbyDecision, watchdog } from './standby'

import type { TRunSummary } from '../run/run'
import type { TPriority } from './notify'
import type { TStandbyState } from './standby'

const STATE_FILE = path.join(process.cwd(), '.cache', 'standby.json')

async function sendAll(notices: Parameters<typeof sendNotice>[0][]): Promise<void> {
  for (const n of notices) await sendNotice(n)
}

/** `notify --summary F`: alerts for one run, plus the GitHub Actions step summary. */
export async function notifyFromSummary(file: string): Promise<void> {
  const summary = JSON.parse(await readFile(file, 'utf8')) as TRunSummary
  const notices = runNotices(summary)
  await sendAll(notices)
  const target = process.env.GITHUB_STEP_SUMMARY
  if (target) await appendFile(target, stepSummary(summary, notices))
  console.log(`${notices.length} alert(s)`)
}

/** `notify-failure --previous CONCLUSION`: alert only when the previous run failed too. */
export async function notifyFailure(previous: string): Promise<void> {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env
  const url = GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : null
  const notice = failureNotice(previous, url)
  if (notice) await sendNotice(notice)
  else console.log(`previous run: ${previous || 'none'}; no alert for a single failure`)
}

export async function notifyText(title: string, message: string, priority: TPriority = 'default'): Promise<void> {
  await sendNotice({ title, message, priority, tags: [] })
}

async function readState(): Promise<TStandbyState> {
  try {
    return { ...emptyStandbyState(), ...(JSON.parse(await readFile(STATE_FILE, 'utf8')) as Partial<TStandbyState>) }
  } catch {
    return emptyStandbyState()
  }
}

/**
 * `standby`: the dead-man check, then `consent run` if GitHub Actions hasn't
 * run recently, then a push to the `codeberg` remote if this clone has one.
 */
export async function standby({ repo = DEFAULT_REPO, dryRun = false }: { repo?: string; dryRun?: boolean } = {}): Promise<void> {
  const now = new Date()
  let state = await readState()
  const grace = Number(process.env.CONSENT_STANDBY_GRACE_MIN) || DEFAULT_GRACE_MINUTES

  let runs = null
  try {
    runs = await workflowRuns(repo)
  } catch (error) {
    console.log(`standby: couldn't read CI runs (${(error as Error).message}); running anyway, skipping the watchdog`)
  }
  if (runs) {
    const checked = watchdog(runs, state, now)
    await sendAll(checked.notices)
    state = checked.state
  }

  const decision = runs ? standbyDecision(runs, now, grace) : { run: true, reason: 'CI status unknown' }
  console.log(`standby: ${decision.run ? 'running' : 'skipping'} (${decision.reason})`)
  if (decision.run) {
    try {
      const summary = await run({ dryRun, push: !dryRun, deployHookUrl: process.env.VERCEL_DEPLOY_HOOK_URL })
      printSummary(summary)
      await sendAll(runNotices(summary))
      if (!dryRun) {
        state.lastLocalSuccess = new Date().toISOString()
        if ((await tryGit(['remote', 'get-url', 'codeberg'])).ok) {
          const pushed = await tryGit(['push', '--quiet', 'codeberg', 'HEAD:refs/heads/main', '--tags'])
          console.log(pushed.ok ? 'standby: pushed to codeberg' : `standby: codeberg push failed: ${pushed.stderr}`)
        }
      }
    } catch (error) {
      await sendNotice({ title: 'Standby consent run failed', message: (error as Error).message.slice(0, 500), priority: 'high', tags: ['x'] })
      await writeJson(STATE_FILE, state)
      throw error
    }
  }
  await writeJson(STATE_FILE, state)
}

/** `events-check`: is Legistar's /events endpoint working for OUSD again? (Quarterly.) */
export async function eventsCheck(): Promise<void> {
  const probes = ['/events?$top=1', '/events/5810']
  const statuses: number[] = []
  for (const p of probes) {
    const res = await fetch(`${LEGISTAR_BASE}${p}`, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } })
    statuses.push(res.status)
  }
  const works = statuses.every(s => s === 200)
  console.log(`Legistar /events: ${statuses.join(', ')} → ${works ? 'works' : 'still broken'}`)
  await sendNotice(works
    ? { title: 'Legistar /events works again for OUSD', message: 'Meeting discovery could be simplified (see RUNBOOK → Periodic).', priority: 'high', tags: ['tada'] }
    : { title: 'Legistar /events still broken', message: `HTTP ${statuses.join(', ')}. Next check in three months.`, priority: 'low', tags: ['calendar'] })
}
