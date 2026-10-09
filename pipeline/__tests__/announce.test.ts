import { describe, expect, it } from 'vitest'

import { campaignExists, campaignName, checkList, isReady, listmonkConfig, listmonkConfigProblems, renderEmail, scheduleCampaign } from '../ops/announce'

import type { TListmonkConfig } from '../ops/announce'
import type { TIndexEntry } from '@oakvs/consent-schema/schema'

const meeting = (over: Partial<TIndexEntry> = {}): TIndexEntry => ({
  key: '2026-10-14',
  date: '2026-10-14',
  kind: 'regular',
  title: 'Board of Education',
  schoolYear: '2026-27',
  items: 87,
  enrichedItems: 87,
  spendingTotal: 12_400_000,
  spendingItems: 60,
  revenueTotal: 2_300_000,
  revenueItems: 4,
  flagCounts: { pulled_from_consent: 2, after_work_began: 31 },
  consentVotes: [],
  revision: 1,
  updatedAt: '2026-10-11T20:00:00Z',
  ...over,
})

// Sunday Oct 11, 2026, 1 p.m. in Oakland: three days before a 4 p.m. Wednesday meeting.
const SUNDAY = new Date('2026-10-11T20:00:00Z')

describe('isReady', () => {
  it('sends once every item has a summary, before the meeting', () => {
    expect(isReady(meeting(), SUNDAY)).toBe(true)
  })

  it('waits while summaries are missing, unless the meeting is within a day', () => {
    const partial = meeting({ enrichedItems: 80 })
    expect(isReady(partial, SUNDAY)).toBe(false)
    expect(isReady(partial, new Date('2026-10-14T00:00:00Z'))).toBe(true) // Tue 5 p.m., 23 hours out
  })

  it('never sends without any summaries, or once the meeting has started', () => {
    expect(isReady(meeting({ enrichedItems: 0 }), new Date('2026-10-14T00:00:00Z'))).toBe(false)
    expect(isReady(meeting(), new Date('2026-10-14T23:30:00Z'))).toBe(false) // 4:30 p.m. on the day
    expect(isReady(meeting({ key: '2026-09-23', date: '2026-09-23' }), SUNDAY)).toBe(false)
  })
})

describe('renderEmail', () => {
  it('leads with the date, count and spending, and links to the meeting', () => {
    const email = renderEmail(meeting())
    expect(email.subject).toBe('OUSD consent report for Wednesday, October 14, 2026: 87 items, $12.4M going out')
    expect(email.html).toContain('href="https://oakvs.world/consent-tracker/2026-10-14"')
    expect(email.text).toContain('2 items voted on separately, 31 items approved after work began')
    expect(email.text).not.toContain('pending')
    expect(email.text).toContain('written by AI')
  })

  it('says how many summaries are still pending', () => {
    expect(renderEmail(meeting({ enrichedItems: 85 })).text).toContain('2 summaries are still pending')
    expect(renderEmail(meeting({ enrichedItems: 86 })).text).toContain('1 summary is still pending')
  })
})

describe('listmonkConfig', () => {
  it('needs every setting, and a numeric list id', () => {
    const env = { LISTMONK_URL: 'https://lists.example.org/', LISTMONK_API_USER: 'bot', LISTMONK_API_TOKEN: 't', LISTMONK_CONSENT_LIST_ID: '7' }
    expect(listmonkConfig(env)).toEqual({ url: 'https://lists.example.org', user: 'bot', token: 't', listId: 7 })
    expect(listmonkConfig({ ...env, LISTMONK_CONSENT_LIST_ID: 'abc' })).toBeNull()
    expect(listmonkConfig({ ...env, LISTMONK_API_TOKEN: '' })).toBeNull()
  })
})

describe('listmonkConfigProblems', () => {
  it('names what is missing or malformed, never the values', () => {
    const env = { LISTMONK_URL: 'https://listmonk.example.org', LISTMONK_API_USER: 'bot', LISTMONK_API_TOKEN: 'secret-token', LISTMONK_CONSENT_LIST_ID: '4e99214a-bf27-4e81-a8f8-dc5d9f6d551c' }
    const problems = listmonkConfigProblems(env)
    expect(problems).toEqual(["LISTMONK_CONSENT_LIST_ID must be the list's numeric id (Listmonk → Lists, the ID column), not its UUID"])
    expect(problems.join(' ')).not.toContain('secret-token')
    expect(listmonkConfigProblems({ ...env, LISTMONK_CONSENT_LIST_ID: '3' })).toEqual([])
    expect(listmonkConfigProblems({ ...env, LISTMONK_URL: 'listmonk.example.org', LISTMONK_CONSENT_LIST_ID: '3' })).toEqual(['LISTMONK_URL must start with https://'])
    expect(listmonkConfigProblems({})).toHaveLength(4)
  })
})

describe('Listmonk calls', () => {
  const cfg: TListmonkConfig = { url: 'https://lists.example.org', user: 'bot', token: 't', listId: 7 }
  const reply = (data: unknown, status = 200): Response => new Response(JSON.stringify({ data }), { status })

  it('treats an exact name match as already announced', async () => {
    const calls: string[] = []
    const fake = (async (url: string) => {
      calls.push(url)
      return reply({ results: [{ name: 'consent-2026-10-14-special' }, { name: campaignName('2026-10-14') }] })
    }) as typeof fetch
    expect(await campaignExists(cfg, campaignName('2026-10-14'), fake)).toBe(true)
    expect(await campaignExists(cfg, campaignName('2026-10-28'), fake)).toBe(false)
    expect(calls[0]).toBe('https://lists.example.org/api/campaigns?query=consent-2026-10-14&per_page=all')
  })

  it('creates a draft for the list, then schedules it', async () => {
    const requests: { url: string; method: string; body: unknown; auth: string | null }[] = []
    const fake = (async (url: string, init: RequestInit) => {
      requests.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body as string) : null, auth: new Headers(init.headers).get('Authorization') })
      return reply(init.method === 'POST' ? { id: 42 } : true)
    }) as typeof fetch
    const id = await scheduleCampaign(cfg, 'consent-2026-10-14', renderEmail(meeting()), new Date('2026-10-11T20:20:00.000Z'), fake)
    expect(id).toBe(42)
    expect(requests.map(r => `${r.method} ${r.url}`)).toEqual([
      'POST https://lists.example.org/api/campaigns',
      'PUT https://lists.example.org/api/campaigns/42/status',
    ])
    expect(requests[0].body).toMatchObject({ name: 'consent-2026-10-14', lists: [7], type: 'regular', content_type: 'html', send_at: '2026-10-11T20:20:00Z' })
    expect(requests[1].body).toEqual({ status: 'scheduled' })
    expect(requests[0].auth).toBe(`Basic ${Buffer.from('bot:t').toString('base64')}`)
  })

  it('checks the list with the API credentials, and fails on a missing list or bad credentials', async () => {
    const urls: string[] = []
    const ok = (async (url: string) => (urls.push(url), reply({ id: 7, name: 'OUSD Consent Report', type: 'public', optin: 'double', subscriber_count: 12 }))) as typeof fetch
    expect(await checkList(cfg, ok)).toEqual({ name: 'OUSD Consent Report', type: 'public', optin: 'double', subscribers: 12 })
    expect(urls).toEqual(['https://lists.example.org/api/lists/7'])
    const missing = (async () => reply(null)) as unknown as typeof fetch
    await expect(checkList(cfg, missing)).rejects.toThrow('list 7 not found')
    const denied = (async () => new Response(JSON.stringify({ message: 'invalid API credentials' }), { status: 403 })) as unknown as typeof fetch
    await expect(checkList(cfg, denied)).rejects.toThrow('HTTP 403 (invalid API credentials)')
  })

  it('reports Listmonk errors with the status and message', async () => {
    const fake = (async () => new Response(JSON.stringify({ message: 'invalid list' }), { status: 400 })) as unknown as typeof fetch
    await expect(scheduleCampaign(cfg, 'x', renderEmail(meeting()), new Date(), fake)).rejects.toThrow('HTTP 400 (invalid list)')
  })
})
