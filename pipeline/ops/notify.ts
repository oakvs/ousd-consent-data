/**
 * Alerts (BRIEF §7), sent to ntfy.
 *
 *   new agenda posted, with counts            default priority
 *   agenda revised                            low
 *   summaries published, and how many flagged default, high when any are flagged
 *   items still failing after 3 days          high
 *   LLM step failed part-way, or capped       high
 *   80% of the monthly LLM cap reached        default
 *   two failed runs in a row                  urgent  (notifyFailure)
 *   no successful run in 6 hours              urgent  (the standby's watchdog)
 *
 * Configure with NTFY_TOPIC (required to send anything), NTFY_SERVER
 * (default https://ntfy.sh) and NTFY_TOKEN (for a protected topic).
 */
import { formatDate } from '@oakvs/consent-schema/format'

import type { TRunSummary } from '../run/run'

export type TPriority = 'min' | 'low' | 'default' | 'high' | 'urgent'

export type TNotice = { title: string; message: string; priority: TPriority; tags: string[]; click?: string }

const PRIORITY: Record<TPriority, number> = { min: 1, low: 2, default: 3, high: 4, urgent: 5 }
const SITE = 'https://oakvs.world/consent-tracker'
/** Alert once the month's LLM spend crosses this share of the cap. */
export const SPEND_WARNING_SHARE = 0.8

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const meetingLabel = (key: string): string => `${formatDate(key.slice(0, 10), 'long')}${key.length > 10 ? ` (${key.slice(11)})` : ''}`

export function runNotices(s: TRunSummary): TNotice[] {
  if (s.dryRun) return []
  const notices: TNotice[] = []
  for (const m of s.meetings) {
    if (m.unchanged) continue
    if (!m.diff) {
      notices.push({
        title: `${meetingLabel(m.key)} agenda posted`,
        message: `${plural(m.items, 'consent item')}. The official text is live; summaries follow.`,
        priority: 'default',
        tags: ['page_facing_up'],
        click: SITE,
      })
    } else if (m.diff.added.length || m.diff.removed.length || m.diff.revised.length) {
      const parts = [
        m.diff.added.length ? `${m.diff.added.length} added` : null,
        m.diff.removed.length ? `${m.diff.removed.length} removed` : null,
        m.diff.revised.length ? `${m.diff.revised.length} revised` : null,
      ].filter(Boolean).join(', ')
      notices.push({ title: `${meetingLabel(m.key)} agenda revised`, message: `${parts}.`, priority: 'low', tags: ['pencil2'], click: SITE })
    }
  }

  const llm = s.llm
  if (llm.status === 'disabled' || llm.status === 'planned' || llm.status === 'skipped') return notices
  for (const m of llm.changes.meetings) {
    if (m.summaries || m.secondReadings) {
      notices.push({
        title: `${meetingLabel(m.key)} summaries published`,
        message: `${m.summaries} summar${m.summaries === 1 ? 'y' : 'ies'}, ${plural(m.secondReadings, 'second reading')}. `
          + (m.flagged ? `${plural(m.flagged, 'item')} flagged for review.` : 'Nothing flagged for review.'),
        priority: m.flagged ? 'high' : 'default',
        tags: m.flagged ? ['warning'] : ['white_check_mark'],
        click: SITE,
      })
    }
    if (m.gaveUp) {
      notices.push({
        title: `${meetingLabel(m.key)}: ${plural(m.gaveUp, 'item')} ${m.gaveUp === 1 ? 'needs' : 'need'} a human`,
        message: 'Summaries or second readings still fail their checks after 3 days. See data/llm-state.json and the RUNBOOK.',
        priority: 'high',
        tags: ['construction'],
      })
    }
  }
  if (llm.error) notices.push({ title: 'LLM step failed part-way', message: `${llm.error}\nWhat it finished was committed; the next run continues.`, priority: 'high', tags: ['x'] })
  if (llm.status === 'capped') {
    notices.push({ title: 'LLM monthly cap reached', message: `Summaries are paused until next month (cap $${llm.capUsd}). Raise CONSENT_LLM_MONTHLY_CAP_USD to resume.`, priority: 'high', tags: ['money_with_wings'] })
  } else {
    const before = llm.monthSpendUsd - (llm.usage?.costUsd ?? 0)
    const line = SPEND_WARNING_SHARE * llm.capUsd
    if (llm.capUsd > 0 && before < line && llm.monthSpendUsd >= line) {
      notices.push({ title: 'LLM spend at 80% of the monthly cap', message: `$${llm.monthSpendUsd.toFixed(2)} of $${llm.capUsd} this month.`, priority: 'default', tags: ['money_with_wings'] })
    }
  }
  return notices
}

/** Only the second failure in a row alerts; a single failed run usually fixes itself. */
export function failureNotice(previousConclusion: string, runUrl: string | null): TNotice | null {
  if (previousConclusion !== 'failure') return null
  return {
    title: 'consent run failed twice in a row',
    message: `The last two scheduled runs failed.${runUrl ? ` Logs: ${runUrl}` : ''}`,
    priority: 'urgent',
    tags: ['rotating_light'],
    ...(runUrl ? { click: runUrl } : {}),
  }
}

export type TNtfyConfig = { server: string; topic: string | undefined; token: string | undefined }

export const ntfyConfig = (): TNtfyConfig => ({
  server: (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, ''),
  topic: process.env.NTFY_TOPIC || undefined,
  token: process.env.NTFY_TOKEN || undefined,
})

/** Publish one notice (ntfy's JSON form, so titles can carry any characters). False when not configured or it failed. */
export async function sendNotice(n: TNotice, config: TNtfyConfig = ntfyConfig()): Promise<boolean> {
  if (!config.topic) {
    console.log(`(ntfy not configured) ${n.title}: ${n.message}`)
    return false
  }
  const res = await fetch(config.server, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}) },
    body: JSON.stringify({ topic: config.topic, title: n.title, message: n.message, priority: PRIORITY[n.priority], tags: n.tags, ...(n.click ? { click: n.click } : {}) }),
  })
  if (!res.ok) console.log(`ntfy: HTTP ${res.status} for "${n.title}"`)
  return res.ok
}

/** A short Markdown report for the GitHub Actions run page. */
export function stepSummary(s: TRunSummary, notices: TNotice[]): string {
  const lines = [`### consent run${s.dryRun ? ' (dry run)' : ''}`, '', `- Legistar requests: ${s.legistarRequests}`]
  lines.push(s.commit ? `- Commit: \`${s.commit.sha.slice(0, 7)}\` ${s.commit.subject}` : `- ${s.changedFiles.length ? `${s.changedFiles.length} file(s) would change` : 'No changes'}`)
  const llm = s.llm
  if (llm.status === 'planned') lines.push(`- LLM step would run for ${llm.plan.length} meeting(s)`)
  else if (llm.status === 'skipped') lines.push(`- LLM step skipped: ${llm.reason}`)
  else if (llm.status !== 'disabled') {
    if (llm.commit) lines.push(`- LLM commit: \`${llm.commit.sha.slice(0, 7)}\` ${llm.commit.subject}`)
    lines.push(`- LLM cost: $${(llm.usage?.costUsd ?? 0).toFixed(2)} (this month $${llm.monthSpendUsd.toFixed(2)} of $${llm.capUsd})`)
  }
  for (const n of notices) lines.push(`- Alert: **${n.title}**: ${n.message}`)
  return `${lines.join('\n')}\n`
}
