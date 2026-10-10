import { beforeAll, describe, expect, it } from 'vitest'

import { RETRY, announceReady, announceTest, campaignName, checkList, findCampaigns, isAnnounced, isReady, listmonkConfig, listmonkConfigProblems, renderEmail, scheduleCampaign } from '../ops/announce'

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

beforeAll(() => {
  RETRY.delaysMs = [0, 0]
  RETRY.sleep = async () => undefined
})

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

  it('finds campaigns by exact name; only a campaign past draft counts as announced', async () => {
    const calls: string[] = []
    const fake = (async (url: string) => {
      calls.push(url)
      return reply({ results: [{ id: 1, name: 'consent-2026-10-14-special', status: 'finished' }, { id: 2, name: campaignName('2026-10-14'), status: 'draft' }] })
    }) as typeof fetch
    const found = await findCampaigns(cfg, campaignName('2026-10-14'), fake)
    expect(found).toEqual([{ id: 2, name: 'consent-2026-10-14', status: 'draft' }])
    expect(calls[0]).toBe('https://lists.example.org/api/campaigns?query=consent-2026-10-14&per_page=all')
    expect(isAnnounced(found)).toBe(false)
    for (const status of ['scheduled', 'running', 'finished', 'paused', 'cancelled']) expect(isAnnounced([{ id: 3, name: 'x', status }])).toBe(true)
  })

  it('retries a connection failure or a 5xx, but not a 4xx', async () => {
    let tries = 0
    const flaky = (async () => {
      tries++
      if (tries === 1) throw new TypeError('fetch failed')
      if (tries === 2) return new Response('{}', { status: 502 })
      return reply({ name: 'OUSD Consent Report', type: 'public', optin: 'double', subscriber_count: 2 })
    }) as unknown as typeof fetch
    expect((await checkList(cfg, flaky)).name).toBe('OUSD Consent Report')
    expect(tries).toBe(3)

    tries = 0
    const down = (async () => { tries++; throw new TypeError('fetch failed') }) as unknown as typeof fetch
    await expect(checkList(cfg, down)).rejects.toThrow('Listmonk GET /lists/7: fetch failed (after 3 tries)')
    expect(tries).toBe(3)

    tries = 0
    const denied = (async () => { tries++; return new Response(JSON.stringify({ message: 'forbidden' }), { status: 403 }) }) as unknown as typeof fetch
    await expect(checkList(cfg, denied)).rejects.toThrow('HTTP 403')
    expect(tries).toBe(1)
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

describe('announce --test', () => {
  const cfg: TListmonkConfig = { url: 'https://lists.example.org', user: 'bot', token: 't', listId: 7 }
  const reply = (data: unknown): Response => new Response(JSON.stringify({ data }), { status: 200 })

  function listmonk(statuses: { status: string; sent: number }[], subscribers = 1): typeof fetch & { calls: { method: string; url: string; body: Record<string, unknown> | null }[] } {
    const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = []
    const fake = (async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET'
      calls.push({ method, url, body: init.body ? JSON.parse(init.body as string) : null })
      if (url.endsWith('/lists/7')) return reply({ name: 'OUSD Consent Report', type: 'public', optin: 'double', subscriber_count: subscribers })
      if (method === 'POST') return reply({ id: 99 })
      if (method === 'PUT') return reply(true)
      const st = statuses.shift() ?? { status: 'scheduled', sent: 0 }
      return reply({ ...st, to_send: 1 })
    }) as typeof fetch & { calls: typeof calls }
    fake.calls = calls
    return fake
  }

  it('sends a [Test] campaign for a published meeting under its own name, and waits for it to finish', async () => {
    const fake = listmonk([{ status: 'scheduled', sent: 0 }, { status: 'running', sent: 0 }, { status: 'finished', sent: 1 }])
    const r = await announceTest({ key: '2026-09-23', now: new Date('2026-10-09T05:00:00Z'), config: cfg, fetch: fake, sleep: async () => undefined })
    expect(r).toMatchObject({ id: 99, status: 'finished', sent: 1, name: 'consent-test-2026-09-23-20261009T0500' })
    const created = fake.calls.find(c => c.method === 'POST')!.body!
    expect(created.subject).toMatch(/^\[Test\] OUSD consent report for Wednesday, September 23, 2026/)
    expect(created).toMatchObject({ lists: [7], tags: ['consent-report', 'test'], send_at: '2026-10-09T05:01:00Z' })
    expect(created.name).not.toBe(campaignName('2026-09-23'))
  })

  it('fails when nothing was sent, or nobody is subscribed', async () => {
    const stuck = listmonk([{ status: 'paused', sent: 0 }])
    await expect(announceTest({ key: '2026-09-23', config: cfg, fetch: stuck, sleep: async () => undefined })).rejects.toThrow('ended as "paused" with 0 sent')
    await expect(announceTest({ key: '2026-09-23', config: cfg, fetch: listmonk([], 0), sleep: async () => undefined })).rejects.toThrow('no subscribers')
  })
})

describe('announce: failures between creating and scheduling', () => {
  const cfg: TListmonkConfig = { url: 'https://lists.example.org', user: 'bot', token: 't', listId: 7 }
  const reply = (data: unknown): Response => new Response(JSON.stringify({ data }), { status: 200 })
  // The day before the Sept 23 meeting, whose summaries are all in.
  const BEFORE = new Date('2026-09-22T19:00:00Z')

  type TCall = { method: string; url: string; body: Record<string, unknown> | null }
  function listmonk(campaigns: { id: number; name: string; status: string }[], opts: { postFails?: 'lost-reply' } = {}): typeof fetch & { calls: TCall[] } {
    const calls: TCall[] = []
    const fake = (async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET'
      calls.push({ method, url: url.replace('https://lists.example.org/api', ''), body: init.body ? JSON.parse(init.body as string) : null })
      if (url.endsWith('/lists/7')) return reply({ name: 'OUSD Consent Report', type: 'public', optin: 'double', subscriber_count: 2 })
      if (url.includes('/campaigns?query=')) return reply({ results: campaigns })
      if (method === 'POST') {
        // The server creates the campaign, but the reply never arrives.
        campaigns.push({ id: 41, name: 'consent-2026-09-23', status: 'draft' })
        if (opts.postFails) throw new TypeError('fetch failed')
        return reply({ id: 41 })
      }
      return reply(true)
    }) as typeof fetch & { calls: TCall[] }
    fake.calls = calls
    return fake
  }
  const writes = (calls: TCall[]): string[] => calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.url}`)

  it('schedules a draft that an earlier run left behind, instead of treating it as sent', async () => {
    const fake = listmonk([{ id: 5, name: 'consent-2026-09-23', status: 'draft' }])
    expect(await announceReady({ now: BEFORE, config: cfg, fetch: fake })).toEqual(['2026-09-23'])
    expect(writes(fake.calls)).toEqual(['PUT /campaigns/5', 'PUT /campaigns/5/status'])
    expect(fake.calls.find(c => c.url === '/campaigns/5')!.body).toMatchObject({ name: 'consent-2026-09-23', lists: [7], send_at: '2026-09-22T19:20:00Z' })
  })

  it('leaves a meeting alone once its campaign is scheduled, sent, or stopped by a person', async () => {
    for (const status of ['scheduled', 'finished', 'cancelled']) {
      const fake = listmonk([{ id: 5, name: 'consent-2026-09-23', status }])
      expect(await announceReady({ now: BEFORE, config: cfg, fetch: fake })).toEqual([])
      expect(writes(fake.calls)).toEqual([])
    }
  })

  it('when the reply to creating a campaign is lost, finds the new draft and schedules it, without a second campaign', async () => {
    const fake = listmonk([], { postFails: 'lost-reply' })
    expect(await announceReady({ now: BEFORE, config: cfg, fetch: fake })).toEqual(['2026-09-23'])
    expect(writes(fake.calls)).toEqual(['POST /campaigns', 'PUT /campaigns/41', 'PUT /campaigns/41/status'])
  })
})
