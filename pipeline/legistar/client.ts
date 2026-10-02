/**
 * Polite Legistar Web API client (§4.4).
 *
 * - Identifies itself with a User-Agent carrying the site URL.
 * - Caps concurrency, backs off exponentially on 429/5xx (max 5 tries).
 * - Caches every response on disk by URL, so backfills are re-runnable
 *   without re-hitting Legistar. Pass `{ fresh: true }` for live data
 *   (e.g. histories for meetings that aren't final yet).
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { siteConfig } from '../config'

export const LEGISTAR_BASE = 'https://webapi.legistar.com/v1/ousd'
export const LEGISTAR_WEB = 'https://ousd.legistar.com'

const CACHE_DIR = path.join(process.cwd(), '.cache', 'legistar')
const USER_AGENT = `oakvs-consent-tracker/0.1 (+${siteConfig.url}/consent-tracker/about)`
const MAX_CONCURRENCY = 4
const MAX_TRIES = 5

export const stats = { network: 0, cache: 0 }

let active = 0
const queue: (() => void)[] = []

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENCY) await new Promise<void>(resolve => queue.push(resolve))
  active++
  try {
    return await fn()
  } finally {
    active--
    queue.shift()?.()
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function cachePath(url: string): string {
  return path.join(CACHE_DIR, `${createHash('sha256').update(url).digest('hex').slice(0, 32)}.json`)
}

export type TFetchOptions = { fresh?: boolean }

export async function legistarGet<T = unknown>(pathAndQuery: string, options: TFetchOptions = {}): Promise<T> {
  const url = pathAndQuery.startsWith('http') ? pathAndQuery : `${LEGISTAR_BASE}${pathAndQuery}`
  const file = cachePath(url)

  if (!options.fresh) {
    try {
      const cached = JSON.parse(await readFile(file, 'utf8')) as { url: string; body: T }
      stats.cache++
      return cached.body
    } catch {
      // cache miss
    }
  }

  const body = await withSlot(async () => {
    for (let attempt = 1; ; attempt++) {
      stats.network++
      const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } })
      if (res.ok) return (await res.json()) as T
      const retryable = res.status === 429 || res.status >= 500
      if (!retryable || attempt >= MAX_TRIES) {
        throw new Error(`Legistar ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`)
      }
      await sleep(500 * 2 ** (attempt - 1))
    }
  })

  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(file, JSON.stringify({ url, fetchedAt: new Date().toISOString(), body }))
  return body
}

/** Run `fn` over `items` with the client's concurrency cap doing the throttling. */
export function mapConcurrent<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  return Promise.all(items.map(fn))
}

// ─── Raw Legistar shapes (only the fields we read) ───────────────────────────

export type TLegistarEventItem = {
  EventItemId: number
  EventItemAgendaSequence: number | null
  EventItemMinutesSequence?: number | null
  EventItemAgendaNumber: string | null
  EventItemTitle: string | null
  EventItemMatterId: number | null
  EventItemMatterFile: string | null
  EventItemMatterName: string | null
  EventItemMatterType: string | null
  EventItemMatterStatus: string | null
  EventItemConsent: number | null
  EventItemActionName: string | null
  EventItemActionText?: string | null
  EventItemMover?: string | null
  EventItemSeconder?: string | null
  EventItemPassedFlagName?: string | null
  EventItemLastModifiedUtc: string | null
  EventItemMatterAttachments?: { MatterAttachmentName: string; MatterAttachmentHyperlink: string }[]
}

export type TLegistarMatter = {
  MatterId: number
  MatterGuid: string
  MatterFile: string
  MatterName: string | null
  MatterTitle: string | null
  MatterTypeName: string | null
  MatterStatusName: string | null
  MatterBodyName: string | null
  MatterIntroDate: string | null
  MatterAgendaDate: string | null
  MatterEXText1: string | null
  MatterEXText3: string | null
  MatterText1: string | null
  MatterPassedDate?: string | null
  MatterEnactmentNumber?: string | null
}

export type TLegistarRelation = { MatterRelationMatterId: number; MatterRelationFlag: number | null }

export type TLegistarHistory = {
  MatterHistoryId?: number | null
  MatterHistoryActionDate: string | null
  MatterHistoryActionName: string | null
  MatterHistoryActionText?: string | null
  MatterHistoryActionBodyName: string | null
  MatterHistoryEventId: number | null
  MatterHistoryPassedFlagName: string | null
  MatterHistoryConsent?: number | null
  MatterHistoryMoverName?: string | null
  MatterHistorySeconderName?: string | null
}

export type TLegistarVote = { VotePersonName: string | null; VoteValueName: string | null }

/** Roll call for one action (the history id is the event item id). */
export const getVotes = (eventItemId: number, options?: TFetchOptions): Promise<TLegistarVote[]> =>
  legistarGet(`/eventitems/${eventItemId}/votes`, options)

export const getEventItems = (eventId: number, options?: TFetchOptions): Promise<TLegistarEventItem[]> =>
  legistarGet(`/events/${eventId}/eventitems?AgendaNote=1&Attachments=1`, options)

export const getMatter = (matterId: number): Promise<TLegistarMatter> => legistarGet(`/matters/${matterId}`)

export const getHistories = (matterId: number, options?: TFetchOptions): Promise<TLegistarHistory[]> =>
  legistarGet(`/matters/${matterId}/histories`, options)

export const getMattersByAgendaDate = (date: string, options?: TFetchOptions): Promise<TLegistarMatter[]> =>
  legistarGet(`/matters?$filter=MatterAgendaDate eq datetime'${date}'`.replace(/ /g, '%20'), options)

export const getMatterRelations = (matterId: number, options?: TFetchOptions): Promise<TLegistarRelation[]> =>
  legistarGet(`/matters/${matterId}/relations`, options)

/** Every matter whose vendor-number field contains this code (handles "005403\r\n005403"). */
export const getMattersByVendorNo = (vendorNo: string, options?: TFetchOptions): Promise<TLegistarMatter[]> =>
  legistarGet(`/matters?$filter=substringof('${vendorNo.replace(/'/g, "''")}',MatterEXText1)`.replace(/ /g, '%20'), options)
