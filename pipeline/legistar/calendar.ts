/**
 * Is a meeting's agenda official yet? Read from Legistar's public web pages.
 *
 * OUSD's Legistar never configured "Agenda Draft Status", so the API returns
 * event items while staff are still building an agenda, and `/events` (where
 * agenda status would normally come from) errors. The public site is the
 * source of truth instead: a meeting appears on Calendar.aspx once it's
 * published, and its MeetingDetail page says "Agenda status: Final" and links
 * the agenda PDF. Both pages are ASP.NET; the calendar's range and body filters
 * are a form postback, so we GET the page for its hidden fields and POST back.
 *
 * Always live, never cached. Parsing is regex on the few elements we need.
 */
import { LEGISTAR_WEB, USER_AGENT, withSlot } from './client'
import { MIN_OVERLAP, overlap } from './discover'

/** Calendar ranges as Legistar's own dropdown names them, or a year. */
export type TCalendarRange = 'This Month' | 'Next Month' | 'Last Month' | `${number}`

export type TCalendarRow = {
  body: string
  /** ISO date. */
  date: string
  /** e.g. "4:00 PM", or null. */
  time: string | null
  meetingDetailId: number
  meetingDetailGuid: string
  /** Absolute View.ashx?M=A link, or null when the calendar shows no agenda. */
  agendaUrl: string | null
}

export type TMeetingDetail = {
  /** The text after "Agenda status:", e.g. "Final" or "Draft"; null if the page doesn't say. */
  agendaStatus: string | null
  agendaUrl: string | null
  /** File numbers of every item on the agenda. */
  fileNumbers: string[]
}

export const BOARD_BODY = 'Board of Education'
const MAX_TRIES = 4

const decode = (s: string): string =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')

const text = (html: string): string => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

const absolute = (href: string): string => (href.startsWith('http') ? href : `${LEGISTAR_WEB}/${decode(href).replace(/^\//, '')}`)

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Fetch a Legistar web page as text, retrying 429/5xx like the API client. */
async function webGet(url: string, init: RequestInit = {}): Promise<string> {
  return withSlot(async () => {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, {
        ...init,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html', ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(60_000),
      })
      if (res.ok) return res.text()
      const retryable = res.status === 429 || res.status >= 500
      if (!retryable || attempt >= MAX_TRIES) throw new Error(`Legistar web ${res.status} for ${url}`)
      await sleep(500 * 2 ** (attempt - 1))
    }
  })
}

/** "10/14/2026" → "2026-10-14". */
function isoDate(us: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(us.trim())
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null
}

/** The ASP.NET hidden fields a postback has to send back. */
export function hiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const tag of html.match(/<input[^>]*type="hidden"[^>]*>/g) ?? []) {
    const name = /name="([^"]+)"/.exec(tag)?.[1]
    if (name) fields[decode(name)] = decode(/value="([^"]*)"/.exec(tag)?.[1] ?? '')
  }
  return fields
}

/** A Telerik combo box only takes a postback value along with its matching client state. */
const comboState = (value: string): string =>
  JSON.stringify({ logEntries: [], value, text: value, enabled: true, checkedIndices: [], checkedItemsTextOverflows: false })

/** The form a "Search Calendar" click posts, for one range and one body. */
export function calendarSearchForm(pageHtml: string, range: TCalendarRange, body: string = BOARD_BODY): URLSearchParams {
  const form = new URLSearchParams(hiddenFields(pageHtml))
  form.set('__EVENTTARGET', '')
  form.set('__EVENTARGUMENT', '')
  form.set('ctl00$ContentPlaceHolder1$lstYears', range)
  form.set('ctl00_ContentPlaceHolder1_lstYears_ClientState', comboState(range))
  form.set('ctl00$ContentPlaceHolder1$lstBodies', body)
  form.set('ctl00_ContentPlaceHolder1_lstBodies_ClientState', comboState(body))
  form.set('ctl00$ContentPlaceHolder1$btnSearch', 'Search Calendar')
  return form
}

export function parseCalendarRows(html: string): TCalendarRow[] {
  const rows: TCalendarRow[] = []
  for (const [, row] of html.matchAll(/<tr[^>]*class="rg(?:Alt)?Row"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => text(c[1]))
    const date = isoDate(cells[1] ?? '')
    const detail = /MeetingDetail\.aspx\?ID=(\d+)&(?:amp;)?GUID=([0-9A-Fa-f-]+)/.exec(row)
    if (!date || !detail) continue
    const agenda = /href="(View\.ashx\?M=A&(?:amp;)?ID=\d+[^"]*)"/.exec(row)
    rows.push({
      body: cells[0],
      date,
      time: /\d{1,2}:\d{2}\s*[AP]M/i.exec(cells[3] ?? cells[2] ?? '')?.[0] ?? null,
      meetingDetailId: Number(detail[1]),
      meetingDetailGuid: detail[2],
      agendaUrl: agenda ? absolute(agenda[1]) : null,
    })
  }
  return rows
}

export function parseMeetingDetail(html: string): TMeetingDetail {
  const status = /id="ctl00_ContentPlaceHolder1_lblAgendaStatus"[^>]*>([\s\S]*?)<\/span>/.exec(html)
  const agenda = /id="ctl00_ContentPlaceHolder1_hypAgenda"[^>]*href="([^"]+)"/.exec(html)
    ?? /href="([^"]+)"[^>]*id="ctl00_ContentPlaceHolder1_hypAgenda"/.exec(html)
  // Legistar serves different markup by user agent (with or without <font> wrappers), so take the anchor's text.
  const files = [...html.matchAll(/id="[^"]*_hypFile"[^>]*>([\s\S]*?)<\/a>/g)].map(m => text(m[1])).filter(Boolean)
  return {
    agendaStatus: status ? text(status[1]) || null : null,
    agendaUrl: agenda && /View\.ashx\?M=A&/.test(decode(agenda[1])) ? absolute(agenda[1]) : null,
    fileNumbers: [...new Set(files)],
  }
}

/** Board meetings on the public calendar for one range. Two requests: the page, then the search. */
export async function fetchBoardCalendar(range: TCalendarRange): Promise<TCalendarRow[]> {
  const url = `${LEGISTAR_WEB}/Calendar.aspx`
  const page = await webGet(url)
  const results = await webGet(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: calendarSearchForm(page, range).toString(),
  })
  return parseCalendarRows(results).filter(r => r.body === BOARD_BODY)
}

export const meetingDetailUrl = (id: number, guid: string | null): string =>
  `${LEGISTAR_WEB}/MeetingDetail.aspx?ID=${id}${guid ? `&GUID=${guid}` : ''}`

export async function fetchMeetingDetail(id: number, guid: string): Promise<TMeetingDetail> {
  return parseMeetingDetail(await webGet(meetingDetailUrl(id, guid)))
}

export type TOfficialAgenda = {
  meetingDetailId: number
  meetingDetailGuid: string
  agendaPdfUrl: string
}

export type TOfficialCheck =
  | { official: true; agenda: TOfficialAgenda }
  | { official: false; reason: string }

/**
 * Is this meeting's agenda official? It has to be on the public calendar on its
 * date with an agenda link, its MeetingDetail page has to say Final, and that
 * page's items have to cover the snapshot's file numbers (which also picks the
 * right meeting when two share a date). `getDetail` is injectable for tests.
 */
export async function checkOfficial(
  date: string,
  rawFiles: ReadonlySet<string>,
  rows: readonly TCalendarRow[],
  getDetail: (id: number, guid: string) => Promise<TMeetingDetail> = fetchMeetingDetail,
): Promise<TOfficialCheck> {
  const onDate = rows.filter(r => r.date === date && r.body === BOARD_BODY)
  if (onDate.length === 0) return { official: false, reason: 'not on the public calendar' }
  const withAgenda = onDate.filter(r => r.agendaUrl)
  if (withAgenda.length === 0) return { official: false, reason: 'on the calendar without an agenda' }

  let best: { row: TCalendarRow; detail: TMeetingDetail; share: number } | null = null
  for (const row of withAgenda) {
    const detail = await getDetail(row.meetingDetailId, row.meetingDetailGuid)
    const share = overlap(new Set(rawFiles), new Set(detail.fileNumbers))
    if (!best || share > best.share) best = { row, detail, share }
  }
  if (!best || best.share < MIN_OVERLAP) return { official: false, reason: 'no calendar meeting matches its items' }
  if (!/^final$/i.test(best.detail.agendaStatus ?? '')) {
    return { official: false, reason: `agenda status is ${best.detail.agendaStatus ?? 'not shown'}` }
  }
  return {
    official: true,
    agenda: {
      meetingDetailId: best.row.meetingDetailId,
      meetingDetailGuid: best.row.meetingDetailGuid,
      agendaPdfUrl: best.detail.agendaUrl ?? best.row.agendaUrl!,
    },
  }
}
