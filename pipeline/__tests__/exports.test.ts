import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'

import { jsonSchemas } from '@oakvs/consent-schema/json-schema'
import { MeetingFile, VendorIndexFile } from '@oakvs/consent-schema/schema'

import { ITEM_COLUMNS, MEETING_COLUMNS, VENDOR_COLUMNS, dataPackage, toCsv } from '../build/exports'
import { buildAll } from '../build/write'
import { diffTrees } from '../run/run'
import { getDataRoot, setDataRoot } from '../store'

const ROOT = process.cwd()
const read = async (p: string): Promise<string> => readFile(path.join(ROOT, p), 'utf8')
const json = async (p: string): Promise<unknown> => JSON.parse(await read(p))

/** A small RFC 4180 reader, to check the writer's quoting. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++ } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' } else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' } else field += ch
  }
  return rows
}

describe('CSV writer', () => {
  it('quotes commas, quotes and line breaks, and leaves nulls empty', () => {
    const cols = [{ name: 'a', type: 'string' as const, description: '', get: (r: { a: string | null }) => r.a }]
    const csv = toCsv(cols, [{ a: 'plain' }, { a: 'has, comma' }, { a: 'say "hi"' }, { a: 'two\nlines' }, { a: null }])
    expect(parseCsv(csv)).toEqual([['a'], ['plain'], ['has, comma'], ['say "hi"'], ['two\nlines'], ['']])
  })
})

describe('deterministic build', () => {
  it('consent:build reproduces data/published and data/exports byte for byte', async () => {
    const real = getDataRoot()
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'rebuild-'))
    const copy = path.join(scratch, 'data')
    await cp(real, copy, { recursive: true })
    await rm(path.join(copy, 'published'), { recursive: true })
    await rm(path.join(copy, 'exports'), { recursive: true })
    setDataRoot(copy)
    try {
      await buildAll()
    } finally {
      setDataRoot(real)
    }
    // upcoming.json comes from Legistar, not the build; carry it over before comparing.
    await cp(path.join(real, 'published', 'upcoming.json'), path.join(copy, 'published', 'upcoming.json'))
    expect(await diffTrees(path.join(real, 'published'), path.join(copy, 'published'))).toEqual([])
    expect(await diffTrees(path.join(real, 'exports'), path.join(copy, 'exports'))).toEqual([])
    await rm(scratch, { recursive: true, force: true })
  }, 60_000)
})

describe('committed exports', () => {
  it('match the published JSON (run consent:build if this fails)', async () => {
    const files = (await readdir(path.join(ROOT, 'data/published/meetings'))).filter(f => !f.endsWith('.list.json')).sort()
    const meetings = await Promise.all(files.map(async f => MeetingFile.parse(await json(`data/published/meetings/${f}`))))
    const rows = meetings.flatMap(m => [...m.items].sort((a, b) => a.agendaSequence - b.agendaSequence).map(item => ({ meeting: m.meeting, item })))
    expect(await read('data/exports/items.csv')).toBe(toCsv(ITEM_COLUMNS, rows))
    expect(await read('data/exports/meetings.csv')).toBe(toCsv(MEETING_COLUMNS, meetings))
    const vendors = VendorIndexFile.parse(await json('data/published/vendors/index.json'))
    expect(await read('data/exports/vendors.csv')).toBe(toCsv(VENDOR_COLUMNS, [...vendors.vendors].sort((a, b) => a.key.localeCompare(b.key))))
    expect(parseCsv(await read('data/exports/items.csv'))).toHaveLength(rows.length + 1)
  })

  it('describe every CSV column in datapackage.json', async () => {
    const pkg = (await json('data/exports/datapackage.json')) as { resources: { path: string; schema: { fields: { name: string }[] } }[] }
    expect(pkg).toEqual(dataPackage())
    for (const r of pkg.resources) {
      const header = parseCsv(await read(`data/exports/${r.path}`))[0]
      expect(header).toEqual(r.schema.fields.map(f => f.name))
    }
  })
})

describe('JSON Schema', () => {
  it('committed schema/ is up to date (run npm run schema if this fails)', async () => {
    const schemas = jsonSchemas()
    expect((await readdir(path.join(ROOT, 'schema'))).sort()).toEqual(Object.keys(schemas).sort())
    for (const [file, schema] of Object.entries(schemas)) expect(await json(`schema/${file}`)).toEqual(schema)
  })

  it('validates every committed data file', async () => {
    const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }))
    const schemas = jsonSchemas()
    const check = async (schemaFile: string, dir: string, filter: (f: string) => boolean = () => true): Promise<number> => {
      const validate = ajv.compile(schemas[schemaFile])
      const files = dir.endsWith('.json') ? [dir] : (await readdir(path.join(ROOT, dir))).filter(f => f.endsWith('.json') && filter(f)).map(f => `${dir}/${f}`)
      for (const f of files) {
        const ok = validate(await json(f))
        expect(ok, `${f}: ${ajv.errorsText(validate.errors)}`).toBe(true)
      }
      return files.length
    }
    let n = 0
    n += await check('meeting.schema.json', 'data/published/meetings', f => !f.endsWith('.list.json'))
    n += await check('meeting-list.schema.json', 'data/published/meetings', f => f.endsWith('.list.json'))
    n += await check('index.schema.json', 'data/published/index.json')
    n += await check('vendor.schema.json', 'data/published/vendors', f => f !== 'index.json')
    n += await check('vendor-index.schema.json', 'data/published/vendors/index.json')
    n += await check('upcoming.schema.json', 'data/published/upcoming.json')
    n += await check('raw-snapshot.schema.json', 'data/raw')
    n += await check('enrichments.schema.json', 'data/enrichments')
    n += await check('verifications.schema.json', 'data/verifications')
    n += await check('overrides.schema.json', 'data/overrides')
    n += await check('registry.schema.json', 'data/meetings.json')
    n += await check('vendor-legistar.schema.json', 'data/legistar/vendors')
    n += await check('vendor-research.schema.json', 'data/vendor-research')
    expect(n).toBeGreaterThan(2000)
  })
})
