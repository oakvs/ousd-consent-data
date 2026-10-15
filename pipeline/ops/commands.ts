/* eslint-disable no-console -- CLI output */
/** The operational CLI commands: alerts and the quarterly Legistar check. */
import { appendFile, readFile } from 'node:fs/promises'

import { LEGISTAR_BASE, USER_AGENT } from '../legistar/client'

import { failureNotice, runNotices, sendNotice, stepSummary } from './notify'

import type { TRunSummary } from '../run/run'
import type { TPriority } from './notify'

async function sendAll(notices: Parameters<typeof sendNotice>[0][]): Promise<void> {
  for (const n of notices) await sendNotice(n)
}

/**
 * A run summary as the alerts step reads it. The summary is written by the run
 * step, which may have loaded older code than this step (a pull mid-run brings
 * new code to disk), so fields added since then get their empty defaults.
 */
export function normalizeRunSummary(raw: Partial<TRunSummary>): TRunSummary {
  return {
    discovered: [],
    resolved: [],
    meetings: [],
    official: [],
    overdueDrafts: [],
    pendingSummaries: 0,
    draftItemsWaiting: 0,
    changedFiles: [],
    ...raw,
  } as TRunSummary
}

/** `notify --summary F`: alerts for one run, plus the GitHub Actions step summary. */
export async function notifyFromSummary(file: string): Promise<void> {
  const summary = normalizeRunSummary(JSON.parse(await readFile(file, 'utf8')) as Partial<TRunSummary>)
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
