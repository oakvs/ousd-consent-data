/**
 * The homelab (or laptop) standby: the same `consent run`, from cron, only
 * when GitHub Actions hasn't run recently. It is also the dead-man switch,
 * because an alert sent from inside CI can't fire when CI never runs.
 *
 * Decisions are pure functions of the workflow-run history, the clock and a
 * small local state file, so they can be tested.
 */
import type { TNotice } from './notify'
import type { TWorkflowRun } from './github'

/** Skip when a CI run started within this many minutes (scheduled runs often start late). */
export const DEFAULT_GRACE_MINUTES = 40
/** Alert when nothing has succeeded for this long. */
export const DEAD_AFTER_HOURS = 6
/** While still down, repeat the alert this often. */
const REPEAT_HOURS = 6

export type TStandbyState = {
  /** Last time a standby run succeeded on this machine. */
  lastLocalSuccess: string | null
  /** When the "nothing has run" alert last went out (null once recovered). */
  deadAlertedAt: string | null
  /** When the "CI is down, the standby is covering" alert last went out. */
  ciAlertedAt: string | null
}

export const emptyStandbyState = (): TStandbyState => ({ lastLocalSuccess: null, deadAlertedAt: null, ciAlertedAt: null })

const started = (r: TWorkflowRun): number => Date.parse(r.run_started_at ?? r.created_at)
const hours = (ms: number): number => ms / 3_600_000

/** Run unless CI has a run in flight or a successful one that started within the grace period. */
export function standbyDecision(runs: TWorkflowRun[], now: Date, graceMinutes = DEFAULT_GRACE_MINUTES): { run: boolean; reason: string } {
  const recent = runs.find(r => now.getTime() - started(r) < graceMinutes * 60_000 && (r.status !== 'completed' || r.conclusion === 'success'))
  if (recent) {
    const ago = Math.round((now.getTime() - started(recent)) / 60_000)
    return { run: false, reason: `CI run ${recent.id} started ${ago} min ago (${recent.status === 'completed' ? recent.conclusion : recent.status})` }
  }
  return { run: true, reason: `no healthy CI run in the last ${graceMinutes} min` }
}

export const lastCiSuccess = (runs: TWorkflowRun[]): string | null =>
  runs.filter(r => r.conclusion === 'success').map(r => r.updated_at).sort().at(-1) ?? null

/** The dead-man switch. Returns the alerts to send and the new state. */
export function watchdog(runs: TWorkflowRun[], state: TStandbyState, now: Date): { notices: TNotice[]; state: TStandbyState } {
  const next = { ...state }
  const notices: TNotice[] = []
  const ci = lastCiSuccess(runs)
  const latest = [ci, state.lastLocalSuccess].filter((t): t is string => t != null).sort().at(-1) ?? null
  const since = (iso: string | null): number => (iso ? hours(now.getTime() - Date.parse(iso)) : Infinity)
  const due = (alertedAt: string | null): boolean => since(alertedAt) >= REPEAT_HOURS

  if (since(latest) >= DEAD_AFTER_HOURS) {
    if (due(state.deadAlertedAt)) {
      notices.push({
        title: 'No successful consent run in 6 hours',
        message: latest ? `Last success: ${latest}. Neither GitHub Actions nor the standby is getting through.` : 'No successful run on record.',
        priority: 'urgent',
        tags: ['skull'],
      })
      next.deadAlertedAt = now.toISOString()
    }
  } else if (state.deadAlertedAt) {
    notices.push({ title: 'consent runs are succeeding again', message: `Last success: ${latest}.`, priority: 'default', tags: ['white_check_mark'] })
    next.deadAlertedAt = null
  }

  if (since(ci) >= DEAD_AFTER_HOURS && since(state.lastLocalSuccess) < DEAD_AFTER_HOURS) {
    if (since(state.ciAlertedAt) >= 24) {
      notices.push({
        title: 'GitHub Actions has stopped running consent run',
        message: `No successful scheduled run since ${ci ?? 'ever'}. The homelab standby is covering. Check the workflow (GitHub disables schedules on inactive repos).`,
        priority: 'high',
        tags: ['warning'],
      })
      next.ciAlertedAt = now.toISOString()
    }
  } else if (since(ci) < DEAD_AFTER_HOURS) {
    next.ciAlertedAt = null
  }
  return { notices, state: next }
}
