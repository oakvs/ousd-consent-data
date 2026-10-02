/** Write `schema/*.schema.json` at the repo root from the zod schemas. */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { jsonSchemas } from '../src/json-schema'

async function main(): Promise<void> {
  const out = path.join(process.cwd(), 'schema')
  await mkdir(out, { recursive: true })
  const schemas = jsonSchemas()
  for (const stale of (await readdir(out)).filter(f => f.endsWith('.schema.json') && !schemas[f])) await rm(path.join(out, stale))
  for (const [file, schema] of Object.entries(schemas)) await writeFile(path.join(out, file), `${JSON.stringify(schema, null, 2)}\n`)
  console.log(`wrote ${Object.keys(schemas).length} schema file(s) → schema/`)
}

void main()
