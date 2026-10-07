/**
 * File-based working store — the local stand-in for Postgres and the
 * published data repo. Layout lives under `data/`.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  EnrichmentsFile,
  OverridesFile,
  RawSnapshot,
  Registry,
  VendorLegistarFile,
  VerificationsFile,
} from '@oakvs/consent-schema/schema'
import type {
  TEnrichmentsFile,
  TOverridesFile,
  TRawSnapshot,
  TRegistry,
  TVendorLegistarFile,
  TVerificationsFile,
} from '@oakvs/consent-schema/schema'
import type { TVendorAliases } from '@oakvs/consent-schema/vendor-key'

import type { z } from 'zod'

let dataRoot = path.join(process.cwd(), 'data')

/** The data folder every read and write goes through (`data/` unless redirected). */
export const getDataRoot = (): string => dataRoot

/** Redirect all reads and writes, e.g. to a scratch copy for `consent run --dry-run`. */
export function setDataRoot(dir: string): void {
  dataRoot = dir
}

export const paths = {
  get registry(): string {
    return path.join(dataRoot, 'meetings.json')
  },
  raw: (key: string): string => path.join(dataRoot, 'raw', `${key}.json`),
  enrichments: (key: string): string => path.join(dataRoot, 'enrichments', `${key}.json`),
  overrides: (key: string): string => path.join(dataRoot, 'overrides', `${key}.json`),
  verifications: (key: string): string => path.join(dataRoot, 'verifications', `${key}.json`),
  get vendorAliases(): string {
    return path.join(dataRoot, 'vendors', 'aliases.json')
  },
  vendorLegistar: (key: string): string => path.join(dataRoot, 'legistar', 'vendors', `${key}.json`),
  get published(): string {
    return path.join(dataRoot, 'published')
  },
}

/** Stable JSON: object keys sorted, 2-space indent, trailing newline — so Git diffs stay meaningful. */
export function stableStringify(value: unknown): string {
  return `${JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    }
    return v
  }, 2)}\n`
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, stableStringify(value))
}

/**
 * A file's JSON without validation, or null when it doesn't exist. For migrations and
 * comparisons, where stored records may predate the current schema.
 */
export async function readJsonLoose<T>(file: string): Promise<T | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return null
  }
  return JSON.parse(text) as T
}

async function readParsed<T extends z.ZodType>(file: string, schema: T): Promise<z.infer<T> | null> {
  const value = await readJsonLoose<unknown>(file)
  return value === null ? null : schema.parse(value)
}

export const readRegistry = async (): Promise<TRegistry> =>
  (await readParsed(paths.registry, Registry)) ?? { lastKnownEventId: null, meetings: [] }

export const writeRegistry = (registry: TRegistry): Promise<void> =>
  writeJson(paths.registry, {
    ...registry,
    meetings: [...registry.meetings].sort((a, b) => a.key.localeCompare(b.key)),
  })

export const readRaw = (key: string): Promise<TRawSnapshot | null> => readParsed(paths.raw(key), RawSnapshot)
export const readEnrichments = (key: string): Promise<TEnrichmentsFile | null> =>
  readParsed(paths.enrichments(key), EnrichmentsFile)
export const readOverrides = (key: string): Promise<TOverridesFile | null> =>
  readParsed(paths.overrides(key), OverridesFile)

export const readVerifications = (key: string): Promise<TVerificationsFile | null> =>
  readParsed(paths.verifications(key), VerificationsFile)

export const readVendorLegistar = (key: string): Promise<TVendorLegistarFile | null> =>
  readParsed(paths.vendorLegistar(key), VendorLegistarFile)

/** Every fetched vendor history, keyed by vendor UID. */
export async function readAllVendorLegistar(): Promise<Map<string, TVendorLegistarFile>> {
  const dir = path.join(dataRoot, 'legistar', 'vendors')
  const out = new Map<string, TVendorLegistarFile>()
  let names: string[] = []
  try {
    names = (await readdir(dir)).filter(f => f.endsWith('.json'))
  } catch {
    return out
  }
  for (const f of names) {
    const file = await readParsed(path.join(dir, f), VendorLegistarFile)
    if (file) out.set(file.key, file)
  }
  return out
}

export type TAliasFile = { generated: TVendorAliases; manual: TVendorAliases }

export async function readAliasFile(): Promise<TAliasFile> {
  try {
    const raw = JSON.parse(await readFile(paths.vendorAliases, 'utf8')) as Partial<TAliasFile>
    const part = (a: Partial<TVendorAliases> | undefined): TVendorAliases => ({ vendorNumbers: a?.vendorNumbers ?? {}, names: a?.names ?? {} })
    return { generated: part(raw.generated), manual: part(raw.manual) }
  } catch {
    return { generated: { vendorNumbers: {}, names: {} }, manual: { vendorNumbers: {}, names: {} } }
  }
}

/** Generated aliases with manual entries on top (manual always wins). */
export async function readVendorAliases(): Promise<TVendorAliases> {
  const { generated, manual } = await readAliasFile()
  return {
    vendorNumbers: { ...generated.vendorNumbers, ...manual.vendorNumbers },
    names: { ...generated.names, ...manual.names },
  }
}

/** Meeting keys that have a raw snapshot. */
export async function listRawKeys(): Promise<string[]> {
  try {
    return (await readdir(path.join(dataRoot, 'raw')))
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''))
      .sort()
  } catch {
    return []
  }
}
