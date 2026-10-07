/**
 * Agent-based enrichment I/O.
 *
 * A one-off way to backfill summaries with parallel agents instead of API
 * calls: `exportChunks` writes small input files, each agent writes an output
 * file and validates it with `checkChunk`, and `importChunks` merges validated
 * output into `data/enrichments/{key}.json`. The build then applies
 * overrides, the full deterministic checks and review routing as usual.
 */
import { access, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { Enrichment } from '@oakvs/consent-schema/schema'
import type { TEnrichment, TEnrichmentRecord, TRawItem } from '@oakvs/consent-schema/schema'

import { enrichmentCacheKey } from '../import/prototype'
import { getDataRoot, listRawKeys, paths, readJsonLoose, readRaw, writeJson } from '../store'
import { runChecks } from '../validate/checks'

/** Where chunk inputs and outputs live; `CONSENT_ENRICH_DIR` redirects it (tests). */
export const enrichDir = (): string => process.env.CONSENT_ENRICH_DIR ?? path.join(process.cwd(), '.cache', 'enrich')
/** Snapshot of data/enrichments taken by the first `enrich-export --all`, for `category-diff`. */
export const previousDir = (): string => path.join(enrichDir(), 'previous')
export const AGENT_PROMPT_VERSION = 'enrich.v6.md'

/** An enrichments file read without validation: during a re-run, stored records may predate the schema. */
export type TLooseEnrichmentsFile = {
  meetingKey: string
  items: Record<string, { modelId: string; promptVersion: string; cacheKey: string; output: Record<string, unknown> }>
}

export type TChunkInput = {
  chunk: string
  meetingKey: string
  meetingDate: string
  items: Pick<TRawItem, 'file' | 'agendaNumber' | 'title' | 'text' | 'matterType' | 'presenter' | 'group' | 'fundingSource'>[]
}

export type TManifestEntry = { chunk: string; meetingKey: string; items: number; input: string; output: string }

const inputPath = (chunk: string): string => path.join(enrichDir(), `${chunk}.input.json`)
export const outputPath = (chunk: string): string => path.join(enrichDir(), `${chunk}.output.json`)

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false)

/** Copy data/enrichments to the snapshot folder, once; later exports keep the original baseline. */
async function snapshotPrevious(): Promise<void> {
  if (await exists(previousDir())) return
  const src = path.join(getDataRoot(), 'enrichments')
  if (await exists(src)) await cp(src, previousDir(), { recursive: true })
}

/**
 * Write chunk inputs. By default only items with no enrichment; with `all`, every item
 * (a full re-run), after snapshotting the current records for `category-diff`.
 */
export async function exportChunks(keys: string[] | null, size: number, opts: { all?: boolean } = {}): Promise<TManifestEntry[]> {
  await mkdir(enrichDir(), { recursive: true })
  if (opts.all) await snapshotPrevious()
  const manifest: TManifestEntry[] = []
  for (const key of keys ?? await listRawKeys()) {
    const [raw, existing] = await Promise.all([readRaw(key), readJsonLoose<TLooseEnrichmentsFile>(paths.enrichments(key))])
    if (!raw) continue
    const todo = opts.all ? raw.items : raw.items.filter(i => !existing?.items[i.file])
    for (let start = 0, n = 1; start < todo.length; start += size, n++) {
      const chunk = `${key}.${String(n).padStart(2, '0')}`
      const input: TChunkInput = {
        chunk,
        meetingKey: key,
        meetingDate: key.slice(0, 10),
        items: todo.slice(start, start + size).map(i => ({
          file: i.file,
          agendaNumber: i.agendaNumber,
          title: i.title,
          text: i.text,
          matterType: i.matterType,
          presenter: i.presenter,
          group: i.group,
          fundingSource: i.fundingSource,
        })),
      }
      await writeFile(inputPath(chunk), `${JSON.stringify(input, null, 2)}\n`)
      manifest.push({ chunk, meetingKey: key, items: input.items.length, input: inputPath(chunk), output: outputPath(chunk) })
    }
  }
  await writeFile(path.join(enrichDir(), 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export type TChunkProblem = { file: string | null; agendaNumber: string | null; severity: 'error' | 'warning'; message: string }

const BLOCKING_CHECKS = new Set(['evidence_substring', 'amounts_in_text'])
const WARNING_CHECKS = new Set(['amendment_math', 'per_year_detection', 'headline_amount', 'jargon', 'term_dates', 'direction_consistency'])

/** Validate one agent output against its input. Errors must be fixed; warnings are advisory. */
export async function checkChunk(chunk: string): Promise<TChunkProblem[]> {
  const input = JSON.parse(await readFile(inputPath(chunk), 'utf8')) as TChunkInput
  let output: unknown
  try {
    output = JSON.parse(await readFile(outputPath(chunk), 'utf8'))
  } catch (error) {
    return [{ file: null, agendaNumber: null, severity: 'error', message: `output file missing or not valid JSON: ${(error as Error).message}` }]
  }
  const items = (output as { items?: unknown }).items
  if (!Array.isArray(items)) return [{ file: null, agendaNumber: null, severity: 'error', message: 'output must be { "chunk": …, "items": [ … ] }' }]

  const problems: TChunkProblem[] = []
  const byFile = new Map(items.map((i: unknown) => [(i as { file?: string }).file, i]))
  if (items.length !== input.items.length) {
    problems.push({ file: null, agendaNumber: null, severity: 'error', message: `expected ${input.items.length} items, got ${items.length}` })
  }

  for (const source of input.items) {
    const candidate = byFile.get(source.file) as Record<string, unknown> | undefined
    const at = { file: source.file, agendaNumber: source.agendaNumber }
    if (!candidate) {
      problems.push({ ...at, severity: 'error', message: 'missing from output' })
      continue
    }
    const { file: _file, ...rest } = candidate
    for (const p of checkEnrichment(source.text, rest).problems) problems.push({ ...at, ...p })
  }
  return problems
}

export type TEnrichmentCheck = {
  /** The parsed enrichment, when it passes the schema (it may still have errors from the checks). */
  enrichment: TEnrichment | null
  problems: { severity: 'error' | 'warning'; message: string }[]
}

/**
 * The checks every enrichment must pass, whoever wrote it: the schema, every
 * `evidence` an exact substring of the text, every amount present in the
 * text. Errors must be fixed; warnings are advisory. Shared by the agent
 * workflow (`enrich-check`) and the API enrichment.
 */
export function checkEnrichment(text: string, candidate: unknown): TEnrichmentCheck {
  const parsed = Enrichment.safeParse(candidate)
  if (!parsed.success) {
    return {
      enrichment: null,
      problems: parsed.error.issues.map(issue => ({ severity: 'error' as const, message: `schema: ${issue.path.join('.') || '(root)'}: ${issue.message}` })),
    }
  }
  const problems: TEnrichmentCheck['problems'] = []
  const { checks } = runChecks({ text, enrichment: parsed.data, sourceIssue: null })
  for (const c of checks.filter(x => !x.pass)) {
    // A stated misprint excuses an amount that can't be found verbatim.
    const explained = c.name === 'amounts_in_text' && parsed.data.sourceIssueCandidate
    if (BLOCKING_CHECKS.has(c.name) && !explained) problems.push({ severity: 'error', message: `${c.name}: ${c.detail}` })
    else if (WARNING_CHECKS.has(c.name) || explained) problems.push({ severity: 'warning', message: `${c.name}: ${c.detail}` })
  }
  return { enrichment: parsed.data, problems }
}

export type TImportSummary = { meetingKey: string; imported: number; rejected: number }

/**
 * Merge every chunk output for these meetings into data/enrichments. Items failing the
 * schema are rejected. An item that already has a record is skipped unless `replace`.
 */
export async function importChunks(keys: string[] | null, modelId: string, opts: { replace?: boolean } = {}): Promise<TImportSummary[]> {
  const files = (await readdir(enrichDir())).filter(f => f.endsWith('.output.json'))
  const chunksByKey = new Map<string, string[]>()
  for (const f of files) {
    const chunk = f.replace(/\.output\.json$/, '')
    const key = chunk.replace(/\.\d+$/, '')
    if (keys && !keys.includes(key)) continue
    chunksByKey.set(key, [...(chunksByKey.get(key) ?? []), chunk])
  }

  const summaries: TImportSummary[] = []
  for (const [key, chunks] of [...chunksByKey.entries()].sort()) {
    const raw = await readRaw(key)
    if (!raw) continue
    const rawByFile = new Map(raw.items.map(i => [i.file, i]))
    const file: TLooseEnrichmentsFile = (await readJsonLoose<TLooseEnrichmentsFile>(paths.enrichments(key))) ?? { meetingKey: key, items: {} }
    let imported = 0
    let rejected = 0
    for (const chunk of chunks.sort()) {
      const out = JSON.parse(await readFile(outputPath(chunk), 'utf8')) as { items: Record<string, unknown>[] }
      for (const candidate of out.items) {
        const { file: fileNo, ...rest } = candidate as { file: string }
        const source = rawByFile.get(fileNo)
        const parsed = Enrichment.safeParse(rest)
        if (!source || !parsed.success) {
          rejected++
          continue
        }
        if (file.items[fileNo] && !opts.replace) continue
        const record: TEnrichmentRecord = {
          modelId,
          promptVersion: AGENT_PROMPT_VERSION,
          cacheKey: enrichmentCacheKey(source.text, source.title, AGENT_PROMPT_VERSION, modelId),
          output: parsed.data,
        }
        file.items[fileNo] = record
        imported++
      }
    }
    await writeJson(paths.enrichments(key), file)
    summaries.push({ meetingKey: key, imported, rejected })
  }
  return summaries
}
