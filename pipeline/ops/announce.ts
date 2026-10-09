/* eslint-disable no-console -- CLI output */
/**
 * Subscriber emails: one Listmonk campaign per meeting, scheduled once that
 * meeting's summaries are ready.
 *
 * A meeting is ready when it hasn't started yet and every item has a summary,
 * or when it starts within a day and at least one does (so a single stuck item
 * doesn't hold up the email). The campaign is named `consent-<key>`; an
 * existing campaign with that name means the meeting was already announced,
 * so no state is kept here. It's scheduled a few minutes out, so the site
 * rebuild that the run's deploy hook started lands before the email does.
 *
 * Configure with LISTMONK_URL, LISTMONK_API_USER, LISTMONK_API_TOKEN (a
 * Listmonk API user with campaign permissions) and LISTMONK_CONSENT_LIST_ID
 * (the numeric id of the double opt-in list). Without them it only reports
 * what it would send.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { BOARD_START_TIME, formatDate, formatMoney, oaklandInstant } from '@oakvs/consent-schema/format'

import { paths } from '../store'

import { sendNotice } from './notify'

import type { TIndexEntry, TIndexFile, TMeetingKind } from '@oakvs/consent-schema/schema'

const SITE = 'https://oakvs.world/consent-tracker'
/** Minutes between scheduling and sending: time for the site rebuild. */
export const SEND_DELAY_MINUTES = 20
/** Send with summaries still missing once the meeting is this close. */
const NEARLY_DUE_HOURS = 24

const KIND: Record<TMeetingKind, string> = { regular: 'Regular', special: 'Special', organizational: 'Organizational' }
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export const campaignName = (key: string): string => `consent-${key}`

/** Should this meeting's email go out now? */
export function isReady(m: TIndexEntry, now: Date): boolean {
  if (m.items === 0 || m.enrichedItems === 0) return false
  const untilStart = oaklandInstant(m.date, BOARD_START_TIME).getTime() - now.getTime()
  if (untilStart <= 0) return false
  return m.enrichedItems >= m.items || untilStart <= NEARLY_DUE_HOURS * 3_600_000
}

export type TEmail = { subject: string; html: string; text: string }

/** The subject and body for one meeting. Listmonk's template adds the footer and unsubscribe link. */
export function renderEmail(m: TIndexEntry): TEmail {
  const url = `${SITE}/${m.key}`
  const date = formatDate(m.date, 'full')
  const spending = formatMoney(m.spendingTotal) || '$0'
  const revenue = formatMoney(m.revenueTotal) || '$0'
  const notes = [
    [m.flagCounts.pulled_from_consent ?? 0, 'voted on separately'],
    [m.flagCounts.after_work_began ?? 0, 'approved after work began'],
    [m.flagCounts.no_competitive_bid ?? 0, 'without a competitive bid'],
  ].filter(([n]) => (n as number) > 0).map(([n, text]) => `${plural(n as number, 'item')} ${text}`)
  const pending = m.items - m.enrichedItems

  const lines = [
    `The General Consent Report for the OUSD Board of Education's ${KIND[m.kind].toLowerCase()} meeting on ${date}, is posted, with plain-English summaries.`,
    `${plural(m.items, 'item')}: ${spending} going out and ${revenue} coming in.`,
    ...(notes.length ? [`Worth a look: ${notes.join(', ')}.`] : []),
    ...(pending > 0 ? [`${pending} ${pending === 1 ? 'summary is' : 'summaries are'} still pending; the official text for every item is up.`] : []),
  ]
  const disclaimer = 'Summaries are written by AI from the official text and can be wrong. Always check the official record on Legistar.'

  const html = [
    ...lines.map(l => `<p>${l}</p>`),
    `<p><a href="${url}" style="font-weight:bold">Read the ${formatDate(m.date, 'long')} consent report</a></p>`,
    `<p style="font-size:12px;color:#666">${disclaimer}</p>`,
  ].join('\n')
  const text = [...lines, '', `Read it: ${url}`, '', disclaimer].join('\n')

  return {
    subject: `OUSD consent report for ${date}: ${plural(m.items, 'item')}, ${spending} going out`,
    html,
    text,
  }
}

export type TListmonkConfig = { url: string; user: string; token: string; listId: number }

export function listmonkConfig(env: NodeJS.ProcessEnv = process.env): TListmonkConfig | null {
  const { LISTMONK_URL, LISTMONK_API_USER, LISTMONK_API_TOKEN, LISTMONK_CONSENT_LIST_ID } = env
  const listId = Number(LISTMONK_CONSENT_LIST_ID)
  if (!LISTMONK_URL || !LISTMONK_API_USER || !LISTMONK_API_TOKEN || !Number.isInteger(listId) || listId <= 0) return null
  return { url: LISTMONK_URL.replace(/\/$/, ''), user: LISTMONK_API_USER, token: LISTMONK_API_TOKEN, listId }
}

/** What's missing or malformed in the Listmonk settings, by name only (never the values). */
export function listmonkConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = []
  for (const name of ['LISTMONK_URL', 'LISTMONK_API_USER', 'LISTMONK_API_TOKEN', 'LISTMONK_CONSENT_LIST_ID'] as const) {
    if (!env[name]) problems.push(`${name} is not set`)
  }
  if (env.LISTMONK_URL && !/^https?:\/\//.test(env.LISTMONK_URL)) problems.push('LISTMONK_URL must start with https://')
  const id = env.LISTMONK_CONSENT_LIST_ID
  if (id && !(Number.isInteger(Number(id)) && Number(id) > 0)) {
    problems.push(`LISTMONK_CONSENT_LIST_ID must be the list's numeric id (Listmonk → Lists, the ID column)${/^[0-9a-f-]{36}$/i.test(id.trim()) ? ', not its UUID' : ''}`)
  }
  return problems
}

type TFetch = typeof fetch

async function api<T>(cfg: TListmonkConfig, method: string, route: string, body: unknown, doFetch: TFetch): Promise<T> {
  const res = await doFetch(`${cfg.url}/api${route}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.token}`).toString('base64')}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json().catch(() => null)) as { data?: T; message?: string } | null
  if (!res.ok) throw new Error(`Listmonk ${method} ${route}: HTTP ${res.status}${json?.message ? ` (${json.message})` : ''}`)
  return json?.data as T
}

export type TListInfo = { name: string; type: string; optin: string; subscribers: number }

/**
 * The subscriber list, read with the API credentials. Run on every announce, so a wrong URL,
 * token or list id fails the step (and alerts) right away, not on the day an email is due.
 */
export async function checkList(cfg: TListmonkConfig, doFetch: TFetch = fetch): Promise<TListInfo> {
  const list = await api<{ name?: string; type?: string; optin?: string; subscriber_count?: number }>(cfg, 'GET', `/lists/${cfg.listId}`, undefined, doFetch)
  if (!list?.name) throw new Error(`Listmonk list ${cfg.listId} not found`)
  return { name: list.name, type: list.type ?? '?', optin: list.optin ?? '?', subscribers: list.subscriber_count ?? 0 }
}

/** Has this meeting already been announced (a campaign with its exact name exists)? */
export async function campaignExists(cfg: TListmonkConfig, name: string, doFetch: TFetch = fetch): Promise<boolean> {
  const data = await api<{ results?: { name: string }[] }>(cfg, 'GET', `/campaigns?query=${encodeURIComponent(name)}&per_page=all`, undefined, doFetch)
  return (data?.results ?? []).some(c => c.name === name)
}

/** Create the campaign as a draft, then schedule it. Returns its id. */
export async function scheduleCampaign(cfg: TListmonkConfig, name: string, email: TEmail, sendAt: Date, doFetch: TFetch = fetch, tags: string[] = ['consent-report']): Promise<number> {
  const created = await api<{ id: number }>(cfg, 'POST', '/campaigns', {
    name,
    subject: email.subject,
    lists: [cfg.listId],
    type: 'regular',
    content_type: 'html',
    body: email.html,
    altbody: email.text,
    send_at: sendAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    tags,
  }, doFetch)
  await api(cfg, 'PUT', `/campaigns/${created.id}/status`, { status: 'scheduled' }, doFetch)
  return created.id
}

export type TAnnounceOptions = { dryRun?: boolean; now?: Date; config?: TListmonkConfig | null; fetch?: TFetch }

/** `announce [--dry-run]`: schedule an email for each meeting that's ready and not yet announced. */
export async function announceReady(options: TAnnounceOptions = {}): Promise<string[]> {
  const now = options.now ?? new Date()
  const cfg = options.config === undefined ? listmonkConfig() : options.config
  const doFetch = options.fetch ?? fetch
  if (!cfg && options.config === undefined) {
    const problems = listmonkConfigProblems()
    const partly = problems.length < 4 || problems.some(p => !p.endsWith('is not set'))
    console.log(`Listmonk not configured${partly ? ` (${problems.join('; ')})` : ''}; emails are only logged`)
    // Some settings present but wrong is a mistake, not a choice: fail so the run alerts.
    if (partly && !options.dryRun) throw new Error(`Listmonk settings incomplete: ${problems.join('; ')}`)
  }
  if (cfg && !options.dryRun) {
    const list = await checkList(cfg, doFetch)
    console.log(`Listmonk OK at ${cfg.url}: list "${list.name}" (${list.type}, ${list.optin} opt-in, ${plural(list.subscribers, 'subscriber')})`)
    if (list.optin !== 'double') console.log(`warning: list "${list.name}" is not double opt-in`)
  }
  const index = JSON.parse(await readFile(path.join(paths.published, 'index.json'), 'utf8')) as TIndexFile
  const ready = index.meetings.filter(m => isReady(m, now))
  const scheduled: string[] = []

  for (const m of ready) {
    const email = renderEmail(m)
    const name = campaignName(m.key)
    if (options.dryRun || !cfg) {
      console.log(`${options.dryRun ? '(dry run)' : '(Listmonk not configured)'} would announce ${m.key}\n  ${email.subject}\n\n${email.text}\n`)
      continue
    }
    if (await campaignExists(cfg, name, doFetch)) {
      console.log(`${m.key}: already announced`)
      continue
    }
    const sendAt = new Date(now.getTime() + SEND_DELAY_MINUTES * 60_000)
    const id = await scheduleCampaign(cfg, name, email, sendAt, doFetch)
    scheduled.push(m.key)
    console.log(`${m.key}: campaign ${id} scheduled for ${sendAt.toISOString()}`)
    await sendNotice({
      title: `${formatDate(m.date, 'long')} subscriber email scheduled`,
      message: `Campaign ${name} goes out in ${SEND_DELAY_MINUTES} minutes.`,
      priority: 'low',
      tags: ['email'],
    })
  }
  if (!ready.length) console.log('no meetings ready to announce')
  return scheduled
}

// ─── Test send ───────────────────────────────────────────────────────────────

export type TCampaignStatus = { status: string; sent: number; toSend: number }

export async function campaignStatus(cfg: TListmonkConfig, id: number, doFetch: TFetch = fetch): Promise<TCampaignStatus> {
  const c = await api<{ status?: string; sent?: number; to_send?: number }>(cfg, 'GET', `/campaigns/${id}`, undefined, doFetch)
  return { status: c?.status ?? '?', sent: c?.sent ?? 0, toSend: c?.to_send ?? 0 }
}

/** Minutes between scheduling a test email and sending it: long enough to go through Listmonk's scheduler. */
export const TEST_SEND_DELAY_MINUTES = 1

export type TAnnounceTestOptions = {
  /** Meeting to send; default: the latest meeting with any summaries. */
  key?: string
  now?: Date
  config?: TListmonkConfig | null
  fetch?: TFetch
  pollMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

/**
 * `announce --test [--key K]`: send a real email for an already-published meeting to the live
 * list, through the same rendering and scheduling as `announce`, then wait until Listmonk reports
 * the campaign finished. The subject says [Test] and the campaign is named consent-test-…, so it
 * never stands in for the meeting's real announcement. Fails unless at least one email went out.
 */
export async function announceTest(options: TAnnounceTestOptions = {}): Promise<TCampaignStatus & { id: number; name: string }> {
  const now = options.now ?? new Date()
  const cfg = options.config === undefined ? listmonkConfig() : options.config
  const doFetch = options.fetch ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  if (!cfg) throw new Error(`Listmonk not configured: ${listmonkConfigProblems().join('; ') || 'unknown problem'}`)

  const list = await checkList(cfg, doFetch)
  console.log(`Listmonk OK at ${cfg.url}: list "${list.name}" (${list.type}, ${list.optin} opt-in, ${plural(list.subscribers, 'subscriber')})`)
  if (list.subscribers === 0) throw new Error(`list "${list.name}" has no subscribers; confirm a subscription first`)

  const index = JSON.parse(await readFile(path.join(paths.published, 'index.json'), 'utf8')) as TIndexFile
  const m = options.key
    ? index.meetings.find(x => x.key === options.key)
    : [...index.meetings].filter(x => x.enrichedItems > 0).sort((a, b) => b.key.localeCompare(a.key))[0]
  if (!m) throw new Error(options.key ? `no meeting ${options.key} in the published index` : 'no meeting with summaries to send')

  const real = renderEmail(m)
  const note = 'This is a test of the OUSD consent report email alerts. The meeting below may already have happened.'
  const email: TEmail = {
    subject: `[Test] ${real.subject}`,
    html: `<p><em>${note}</em></p>\n${real.html}`,
    text: `${note}\n\n${real.text}`,
  }
  const name = `consent-test-${m.key}-${now.toISOString().replace(/[-:]/g, '').slice(0, 13)}`
  const sendAt = new Date(now.getTime() + TEST_SEND_DELAY_MINUTES * 60_000)
  const id = await scheduleCampaign(cfg, name, email, sendAt, doFetch, ['consent-report', 'test'])
  console.log(`${name}: campaign ${id} scheduled for ${sendAt.toISOString()} to "${list.name}"\n  ${email.subject}`)

  const deadline = Date.now() + (options.timeoutMs ?? 8 * 60_000)
  let st = await campaignStatus(cfg, id, doFetch)
  while (!['finished', 'cancelled', 'paused'].includes(st.status) && Date.now() < deadline) {
    await sleep(options.pollMs ?? 15_000)
    st = await campaignStatus(cfg, id, doFetch)
    console.log(`  status ${st.status}, sent ${st.sent} of ${st.toSend}`)
  }
  if (st.status !== 'finished' || st.sent === 0) {
    throw new Error(`test campaign ${id} ended as "${st.status}" with ${st.sent} sent; check Listmonk → Campaigns and Settings → SMTP`)
  }
  console.log(`test email sent: ${plural(st.sent, 'email')} to "${list.name}"`)
  return { id, name, ...st }
}
