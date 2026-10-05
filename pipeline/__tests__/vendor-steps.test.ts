import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MODELS } from '../llm/client'
import { mergePhase } from '../llm/merge'
import { readLlmState } from '../llm/state'
import { historyCovers, updateVendorHistories } from '../legistar/vendor-history'
import { getDataRoot, setDataRoot, stableStringify } from '../store'

import type { ILlm, TAskRequest, TAskResult } from '../llm/client'
import type { TMergeReply } from '../llm/schemas'

const REAL = getDataRoot()
const FIXTURE = 'n-360-degree-customer' // any published vendor file works as the template
const EMPTY_ALIASES = { generated: { vendorNumbers: {}, names: {} }, manual: { vendorNumbers: {}, names: {} } }

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vendor-steps-'))
  for (const d of ['published/vendors', 'vendors', 'raw', 'enrichments', 'legistar/vendors']) await mkdir(path.join(dir, d), { recursive: true })
  await writeFile(path.join(dir, 'vendors', 'aliases.json'), JSON.stringify(EMPTY_ALIASES))
  setDataRoot(dir)
})
afterEach(() => {
  setDataRoot(REAL)
  vi.unstubAllGlobals()
})

describe('duplicate-vendor judge in consent run', () => {
  const usage = { requests: 1, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.05 }
  const judge = (replies: TMergeReply[]): ILlm & { asked: string[] } => {
    const asked: string[] = []
    return {
      asked,
      async ask<T>(req: TAskRequest<T>): Promise<TAskResult<T>> {
        asked.push(req.model)
        for (const reply of replies) {
          if ((await req.validate(reply as T)).length === 0) return { reply: reply as T, modelId: req.model, attempts: 1, errors: [], refusal: null, usage }
        }
        return { reply: null, modelId: null, attempts: 3, errors: ['into must be one of the group\'s keys'], refusal: null, usage }
      },
    }
  }

  async function vendors(list: { key: string; name: string }[]): Promise<void> {
    const fixture = JSON.parse(await readFile(path.join(REAL, 'published', 'vendors', `${FIXTURE}.json`), 'utf8')) as Record<string, unknown>
    await writeFile(path.join(dir, 'published', 'vendors', 'index.json'), JSON.stringify({ vendors: list.map(v => ({ ...v, kind: 'organization', approvedTotal: 1 })) }))
    for (const v of list) await writeFile(path.join(dir, 'published', 'vendors', `${v.key}.json`), JSON.stringify({ ...fixture, key: v.key, names: [v.name], vendorNo: null }))
  }

  it('merges a near-duplicate as a manual alias, logs the model and reason, and never judges the group again', async () => {
    await vendors([
      { key: 'n-bertrand-fox-elliot-osman-and-wenzel', name: 'Bertrand, Fox, Elliot, Osman & Wenzel' },
      { key: 'n-bertrand-fox-elliott-osman-and-wenzel', name: 'Bertrand, Fox, Elliott, Osman & Wenzel' },
    ])
    const llm = judge([{ into: 'n-bertrand-fox-elliot-osman-and-wenzel', merge: ['n-bertrand-fox-elliott-osman-and-wenzel'], reason: 'The same law firm, with "Elliott" misspelled.' }])
    const r = await mergePhase({ llm, today: '2026-10-14' })
    expect(llm.asked).toEqual([MODELS.merge])
    expect(r.merged).toEqual([{ into: 'n-bertrand-fox-elliot-osman-and-wenzel', from: ['n-bertrand-fox-elliott-osman-and-wenzel'], reason: 'The same law firm, with "Elliott" misspelled.' }])

    const aliases = JSON.parse(await readFile(path.join(dir, 'vendors', 'aliases.json'), 'utf8')) as typeof EMPTY_ALIASES
    expect(aliases.manual.names).toEqual({ 'bertrand fox elliott osman and wenzel': 'bertrand fox elliot osman and wenzel' })
    const log = JSON.parse(await readFile(path.join(dir, 'vendors', 'merge-decisions.json'), 'utf8')) as { merged: { decidedBy: string; decidedOn: string }[] }
    expect(log.merged).toMatchObject([{ decidedBy: MODELS.merge, decidedOn: '2026-10-14' }])
  })

  it('logs a kept-separate decision so the group is skipped next time, and records a failing reply', async () => {
    await vendors([
      { key: 'n-aspire-golden-state-college-prep', name: 'Aspire Golden State College Prep' },
      { key: 'n-aspire-golden-state-college-prep-academy', name: 'Aspire Golden State College Prep Academy' },
    ])
    const keep = judge([{ into: null, merge: [], reason: 'Two different charter schools.' }])
    expect(await mergePhase({ llm: keep, today: '2026-10-14' })).toMatchObject({ kept: 1, merged: [], remaining: 0 })
    const again = judge([])
    expect(await mergePhase({ llm: again, today: '2026-10-15' })).toMatchObject({ remaining: 0 })
    expect(again.asked).toEqual([])

    await writeFile(path.join(dir, 'vendors', 'merge-decisions.json'), JSON.stringify({ merged: [], keptSeparate: [] }))
    const bad = judge([{ into: 'n-someone-else', merge: ['n-aspire-golden-state-college-prep'], reason: 'x' }])
    const r = await mergePhase({ llm: bad, today: '2026-10-16' })
    expect(r.failed).toHaveLength(1)
    expect(Object.keys((await readLlmState()).failures)).toEqual(['merge:n-aspire-golden-state-college-prep|n-aspire-golden-state-college-prep-academy'])
  })
})

describe('vendor histories in consent run', () => {
  // Made-up matter ids and vendor number, so nothing real in the Legistar request cache is touched.
  const CODE = '999901'
  const matter = (id: number, file: string): Record<string, unknown> => ({
    MatterId: id, MatterGuid: `guid-${id}`, MatterFile: file, MatterName: `Agreement ${file}`, MatterTypeName: 'Agreement', MatterStatusName: 'Adopted',
    MatterBodyName: 'Facilities', MatterIntroDate: '2026-09-01T00:00:00', MatterAgendaDate: '2026-10-14T00:00:00', MatterPassedDate: null,
    MatterEnactmentNumber: null, MatterEXText1: CODE, MatterText1: null, MatterEXText3: null,
  })

  async function meeting(items: { matterId: number; file: string }[]): Promise<void> {
    const real = JSON.parse(await readFile(path.join(REAL, 'raw', '2026-09-23.json'), 'utf8')) as { items: Record<string, unknown>[] }
    const template = real.items[0]
    const snapshot = { ...real, meetingKey: '2026-10-14', items: items.map(i => ({ ...template, matterId: i.matterId, file: i.file, vendorNo: CODE })) }
    await writeFile(path.join(dir, 'raw', '2026-10-14.json'), stableStringify(snapshot))
  }

  it('fetches only what a vendor\'s file is missing, keeps what it had, and removes files for merged-away vendors', async () => {
    await meeting([{ matterId: 99_000_001, file: '26-9001' }, { matterId: 99_000_002, file: '26-9002' }])
    const existing = { key: `v-${CODE}`, vendorNo: CODE, matters: [{
      matterId: 99_000_001, file: '26-9001', title: 'Agreement 26-9001', type: 'Agreement', status: 'Adopted', department: 'Facilities',
      introDate: null, agendaDate: '2026-09-23', passedDate: null, enactmentNumber: null, vendorNo: CODE, fundingSource: null, resourceSite: null,
      legistarUrl: 'https://ousd.legistar.com/LegislationDetail.aspx?ID=99000001&GUID=x', relatedMatterIds: [],
    }] }
    await writeFile(path.join(dir, 'legistar', 'vendors', `v-${CODE}.json`), JSON.stringify(existing))
    await writeFile(path.join(dir, 'legistar', 'vendors', 'v-000000-merged-away.json'), JSON.stringify({ ...existing, key: 'v-000000-merged-away' }))
    expect(historyCovers({ vendorNo: CODE, items: [{ matterId: 99_000_001 }, { matterId: 99_000_002 }] as never }, existing as never)).toBe(false)

    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(decodeURIComponent(url))
      const body = url.includes('substringof') ? [matter(99_000_002, '26-9002')]
        : url.endsWith('/relations') ? [{ MatterRelationMatterId: 99_000_003 }]
          : matter(Number(/matters\/(\d+)/.exec(url)![1]), '26-9003')
      return new Response(JSON.stringify(body), { status: 200 })
    })
    const r = await updateVendorHistories({ limit: 10 })
    expect(r).toEqual({ updated: [`v-${CODE}`], removed: ['v-000000-merged-away'], remaining: 0 })
    // Relations only for the item the file didn't cover; nothing for the one it had.
    expect(urls.filter(u => u.includes('/relations'))).toEqual([expect.stringMatching(/\/matters\/99000002\/relations$/)])
    expect(urls.some(u => u.includes('99000001'))).toBe(false)

    const file = JSON.parse(await readFile(path.join(dir, 'legistar', 'vendors', `v-${CODE}.json`), 'utf8')) as { matters: { matterId: number; relatedMatterIds: number[] }[] }
    expect(file.matters.map(m => [m.matterId, m.relatedMatterIds]).sort()).toEqual([[99_000_001, []], [99_000_002, [99_000_003]], [99_000_003, [99_000_002]]])
    expect(await readdir(path.join(dir, 'legistar', 'vendors'))).toEqual([`v-${CODE}.json`])

    // Now covered: the next run does nothing.
    urls.length = 0
    expect(await updateVendorHistories()).toEqual({ updated: [], removed: [], remaining: 0 })
    expect(urls).toEqual([])
  })
})
