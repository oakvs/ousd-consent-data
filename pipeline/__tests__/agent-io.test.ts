import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SCHEMA_VERSION } from '@oakvs/consent-schema/schema'
import type { TRawItem, TRawSnapshot } from '@oakvs/consent-schema/schema'

import { exportChunks, importChunks, outputPath, previousDir } from '../enrich/agent-io'
import { getDataRoot, paths, readJsonLoose, setDataRoot, writeJson } from '../store'

import { makeEnrichment } from './helpers'

import type { TLooseEnrichmentsFile } from '../enrich/agent-io'

const REAL = getDataRoot()
const KEY = '2026-01-14'
const TEXT_A = 'Approval of an agreement with Acme, in an amount not to exceed $100,000.00, for tutoring.'
const TEXT_B = 'Approval of an agreement with Zum, in an amount not to exceed $50,000.00, for special education busing.'
let tmp: string

const rawItem = (file: string, title: string, text: string): TRawItem => ({
  agendaNumber: 'R.-1', agendaSequence: 1, consentSection: 'general', group: 'Chief Academic Officer', file, matterId: 1,
  matterGuid: null, title, text, matterType: 'Agreement or Contract', presenter: null, vendorNo: null, resourceSite: null,
  fundingSource: null, introDate: null, attachments: [], history: [],
})

/** A record written under the old codebook: an enum value v2 no longer has, and no sub-category. */
const OLD_RECORD = {
  modelId: 'sonnet-agent',
  promptVersion: 'enrich.v3.md',
  cacheKey: 'old',
  output: { ...makeEnrichment(), category: 'Legal, insurance & risk', subcategory: undefined },
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'agent-io-'))
  setDataRoot(path.join(tmp, 'data'))
  process.env.CONSENT_ENRICH_DIR = path.join(tmp, 'enrich')
  const snapshot: TRawSnapshot = {
    schemaVersion: SCHEMA_VERSION, meetingKey: KEY, eventId: null, fetchedAt: '2026-01-14T00:00:00Z', source: 'legistar', consentVotes: [],
    items: [rawItem('26-0001', 'Acme tutoring', TEXT_A), rawItem('26-0002', 'Zum busing', TEXT_B)],
  }
  await writeJson(paths.raw(KEY), snapshot)
  await writeJson(paths.enrichments(KEY), { meetingKey: KEY, items: { '26-0001': OLD_RECORD } })
})

afterEach(async () => {
  setDataRoot(REAL)
  delete process.env.CONSENT_ENRICH_DIR
  await rm(tmp, { recursive: true, force: true })
})

const writeOutput = async (chunk: string, items: Record<string, unknown>[]): Promise<void> =>
  writeFile(outputPath(chunk), JSON.stringify({ chunk, items }))

const newA = { file: '26-0001', ...makeEnrichment({ money: { evidence: 'not to exceed $100,000.00' } }) }
const newB = {
  file: '26-0002',
  ...makeEnrichment({
    headline: 'Pays Zum up to $50,000 for special education busing',
    category: 'Special education',
    subcategory: 'Transportation',
    vendor: { name: 'Zum', location: null, kind: 'organization' },
    money: { thisAction: 50_000, evidence: 'not to exceed $50,000.00' },
  }),
}

describe('enrich-export', () => {
  it('exports only items without a record by default', async () => {
    const manifest = await exportChunks([KEY], 30)
    expect(manifest).toHaveLength(1)
    expect(manifest[0].items).toBe(1)
    const input = JSON.parse(await readFile(manifest[0].input, 'utf8')) as { items: { file: string }[] }
    expect(input.items.map(i => i.file)).toEqual(['26-0002'])
  })

  it('with all, exports every item and snapshots the previous enrichments once', async () => {
    const manifest = await exportChunks([KEY], 30, { all: true })
    expect(manifest[0].items).toBe(2)
    const snap = await readJsonLoose<TLooseEnrichmentsFile>(path.join(previousDir(), `${KEY}.json`))
    expect(snap?.items['26-0001'].cacheKey).toBe('old')

    // A second export after records changed must keep the original snapshot.
    await writeJson(paths.enrichments(KEY), { meetingKey: KEY, items: { '26-0001': { ...OLD_RECORD, cacheKey: 'changed' } } })
    await exportChunks([KEY], 30, { all: true })
    const again = await readJsonLoose<TLooseEnrichmentsFile>(path.join(previousDir(), `${KEY}.json`))
    expect(again?.items['26-0001'].cacheKey).toBe('old')
  })
})

describe('enrich-import', () => {
  it('skips items that already have a record unless replace is set', async () => {
    await exportChunks([KEY], 30, { all: true })
    await writeOutput(`${KEY}.01`, [newA, newB])

    const [kept] = await importChunks([KEY], 'sonnet-agent')
    expect(kept).toEqual({ meetingKey: KEY, imported: 1, rejected: 0 })
    let file = await readJsonLoose<TLooseEnrichmentsFile>(paths.enrichments(KEY))
    expect(file?.items['26-0001'].cacheKey).toBe('old')
    expect(file?.items['26-0002'].promptVersion).toBe('enrich.v5.md')

    const [replaced] = await importChunks([KEY], 'sonnet-agent', { replace: true })
    expect(replaced).toEqual({ meetingKey: KEY, imported: 2, rejected: 0 })
    file = await readJsonLoose<TLooseEnrichmentsFile>(paths.enrichments(KEY))
    expect(file?.items['26-0001'].promptVersion).toBe('enrich.v5.md')
    expect(file?.items['26-0001'].modelId).toBe('sonnet-agent')
  })

  it('rejects an item that fails the schema and keeps the rest', async () => {
    await exportChunks([KEY], 30, { all: true })
    await writeOutput(`${KEY}.01`, [newA, { ...newB, subcategory: null }])
    const [summary] = await importChunks([KEY], 'sonnet-agent', { replace: true })
    expect(summary).toEqual({ meetingKey: KEY, imported: 1, rejected: 1 })
  })
})
