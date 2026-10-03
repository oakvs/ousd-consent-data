/**
 * AI vendor research from public sources (never official data).
 *
 * Flow, per vendor (organizations only; individuals are never researched):
 *   research-export  → .cache/research/{key}.input.json
 *   (agent researches, writes {key}.output.json, self-checks with research-check)
 *   research-import  → data/vendor-research/{key}.json  (with code checks)
 *   review-export    → .cache/research/{key}.review.input.json   (high-confidence only)
 *   (independent agent writes {key}.review.output.json)
 *   review-import    → sets review + publishable
 *
 * Code checks fetch every cited page. Contact details, registry IDs and the
 * legal name must appear verbatim on a page cited for them, or the field is
 * dropped. A profile is published only when the researcher reported high
 * confidence with 2+ identity signals, an independent reviewer confirmed the
 * same organization, and at least one cited page loaded.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { VendorFile, VendorResearch, VendorResearchRecord, VendorResearchReview } from '@oakvs/consent-schema/schema'
import type {
  TProfileField,
  TPublishedVendorProfile,
  TVendorFile,
  TVendorResearch,
  TVendorResearchRecord,
} from '@oakvs/consent-schema/schema'
import { siteConfig } from '../config'

import { getDataRoot, writeJson } from '../store'

export const RESEARCH_DIR = path.join(process.cwd(), '.cache', 'research')
const PAGES_DIR = path.join(RESEARCH_DIR, 'pages')
export const RESEARCH_PROMPT_VERSION = 'vendor-research.v2.md'
export const REVIEW_PROMPT_VERSION = 'vendor-review.v1.md'
const recordsDir = (): string => path.join(getDataRoot(), 'vendor-research')
const publishedVendors = (): string => path.join(getDataRoot(), 'published', 'vendors')
const USER_AGENT = `Mozilla/5.0 (compatible; oakvs-consent-tracker/0.1; +${siteConfig.url}/consent-tracker/about)`

const recordPath = (key: string): string => path.join(recordsDir(), `${key}.json`)
const io = (key: string, kind: 'input' | 'output' | 'review.input' | 'review.output'): string =>
  path.join(RESEARCH_DIR, `${key}.${kind}.json`)

// ─── Inputs ──────────────────────────────────────────────────────────────────

export type TResearchInput = {
  key: string
  vendorNo: string | null
  namesInAgendaText: string[]
  locationsInAgendaText: string[]
  whatOusdContractsThemFor: string[]
  presentingOffices: string[]
  officialTitles: string[]
  fundingSources: string[]
}

async function readVendor(key: string): Promise<TVendorFile> {
  return VendorFile.parse(JSON.parse(await readFile(path.join(publishedVendors(), `${key}.json`), 'utf8')))
}

function toInput(v: TVendorFile): TResearchInput {
  const titles = [...new Set([...v.appearances.map(a => a.title), ...v.legistarHistory.map(m => m.title)])]
  return {
    key: v.key,
    vendorNo: v.vendorNo,
    namesInAgendaText: v.names,
    locationsInAgendaText: v.locations,
    whatOusdContractsThemFor: v.taxonomy.categories.map(c => c.name),
    presentingOffices: v.official.departments.map(d => d.name),
    officialTitles: titles.slice(0, 10),
    fundingSources: v.fundingSources.slice(0, 5),
  }
}

/** Organizations only, largest approved totals first. */
export async function exportResearch({ keys, top, skipExisting = true }: { keys?: string[]; top?: number; skipExisting?: boolean }): Promise<string[]> {
  await mkdir(RESEARCH_DIR, { recursive: true })
  const index = JSON.parse(await readFile(path.join(publishedVendors(), 'index.json'), 'utf8')) as {
    vendors: { key: string; kind: string | null; approvedTotal: number }[]
  }
  const existing = new Set(skipExisting ? (await readdir(recordsDir()).catch(() => [])).map(f => f.replace(/\.json$/, '')) : [])
  let candidates = index.vendors.filter(v => v.kind !== 'individual' && !existing.has(v.key))
  if (keys?.length) candidates = candidates.filter(v => keys.includes(v.key))
  candidates.sort((a, b) => b.approvedTotal - a.approvedTotal || a.key.localeCompare(b.key))
  const chosen = candidates.slice(0, top ?? candidates.length)
  for (const { key } of chosen) {
    const vendor = await readVendor(key)
    if (vendor.kind === 'individual') continue
    await writeFile(io(key, 'input'), `${JSON.stringify(toInput(vendor), null, 2)}\n`)
  }
  await writeFile(path.join(RESEARCH_DIR, 'manifest.json'), `${JSON.stringify(chosen.map(c => c.key), null, 2)}\n`)
  return chosen.map(c => c.key)
}

// ─── Page fetching (cached) ──────────────────────────────────────────────────

export type TPage = { url: string; ok: boolean; status: number; finalUrl: string; html: string; text: string }

const decode = (s: string): string => s
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;|&#8217;/g, "'")
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))

export function htmlToText(html: string): string {
  return decode(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

export async function fetchPage(url: string): Promise<TPage> {
  await mkdir(PAGES_DIR, { recursive: true })
  const file = path.join(PAGES_DIR, `${createHash('sha256').update(url).digest('hex').slice(0, 32)}.json`)
  try {
    return JSON.parse(await readFile(file, 'utf8')) as TPage
  } catch {
    // not cached
  }
  let page: TPage
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(20_000) })
    const html = res.ok ? await res.text() : ''
    page = { url, ok: res.ok, status: res.status, finalUrl: res.url, html: html.slice(0, 2_000_000), text: htmlToText(html).slice(0, 500_000) }
  } catch (error) {
    page = { url, ok: false, status: 0, finalUrl: url, html: '', text: `fetch failed: ${(error as Error).message}` }
  }
  await writeFile(file, JSON.stringify(page))
  return page
}

// ─── Verbatim checks ─────────────────────────────────────────────────────────

const digits = (s: string): string => s.replace(/\D/g, '')

/** Phone: the 10 digits must appear as one phone-shaped run on the page. */
export function phoneOnPage(phone: string, page: TPage): boolean {
  const want = digits(phone).slice(-10)
  if (want.length !== 10) return false
  const runs = `${page.text} ${page.html}`.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) ?? []
  return runs.some(r => digits(r).slice(-10) === want)
}

const ADDRESS_WORDS: Record<string, string> = {
  street: 'st', avenue: 'ave', boulevard: 'blvd', road: 'rd', drive: 'dr', suite: 'ste', floor: 'fl',
  north: 'n', south: 's', east: 'e', west: 'w', place: 'pl', lane: 'ln', court: 'ct', parkway: 'pkwy',
}
const normAddress = (s: string): string => s.toLowerCase()
  .replace(/[.,#]/g, ' ')
  .split(/\s+/).filter(Boolean).map(w => ADDRESS_WORDS[w] ?? w).join(' ')

/** Address: the street line (number + street) and the ZIP, if given, must appear on the page. */
export function addressOnPage(address: string, page: TPage): boolean {
  const text = normAddress(page.text)
  const street = normAddress(address.split(',')[0] ?? '')
  const zip = /\b\d{5}\b/.exec(address)?.[0]
  return street.length > 4 && text.includes(street) && (!zip || text.includes(zip))
}

const normName = (s: string): string => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim()

export function fieldOnPage(field: TProfileField, value: string, page: TPage): boolean {
  switch (field) {
    case 'phone': return phoneOnPage(value, page)
    case 'email': return `${page.text} ${page.html}`.toLowerCase().includes(value.toLowerCase())
    case 'address': return addressOnPage(value, page)
    case 'ein': return `${page.text} ${page.finalUrl} ${page.url}`.replace(/-/g, '').includes(digits(value))
    case 'caEntityNumber':
    case 'samUei': return `${page.text} ${page.finalUrl}`.toUpperCase().includes(value.toUpperCase())
    case 'legalName': return normName(page.text).includes(normName(value))
    default: return true
  }
}

const VERBATIM_FIELDS: TProfileField[] = ['phone', 'email', 'address', 'ein', 'caEntityNumber', 'samUei', 'legalName']

export type TResearchCheck = { field: string; pass: boolean; detail: string | null; severity: 'error' | 'warning' }

export async function runResearchChecks(research: TVendorResearch): Promise<TResearchCheck[]> {
  const checks: TResearchCheck[] = []
  const pages = new Map<string, TPage>()
  for (const s of research.sources) pages.set(s.url, await fetchPage(s.url))
  for (const s of research.sources) {
    const p = pages.get(s.url)!
    checks.push({ field: `source:${s.url}`, pass: p.ok, detail: p.ok ? null : `HTTP ${p.status || 'error'} (fields supported only by this page will be dropped)`, severity: 'warning' })
  }
  const profile = research.profile
  if (!profile) return checks

  for (const field of VERBATIM_FIELDS) {
    const value = profile[field]
    if (!value) continue
    const cited = research.sources.filter(s => s.supports.includes(field))
    if (cited.length === 0) {
      checks.push({ field, pass: false, detail: `no source cites "${field}"`, severity: 'error' })
      continue
    }
    const loaded = cited.map(s => pages.get(s.url)!).filter(p => p.ok)
    if (loaded.length === 0) {
      checks.push({ field, pass: false, detail: `every page cited for "${field}" failed to load`, severity: 'warning' })
      continue
    }
    const found = loaded.some(p => fieldOnPage(field, value, p))
    checks.push({ field, pass: found, detail: found ? null : `${JSON.stringify(value)} not found on the page(s) cited for it`, severity: 'error' })
  }

  if (profile.website) {
    const site = await fetchPage(profile.website)
    const host = (u: string): string => new URL(u).hostname.replace(/^www\./, '')
    const listed = research.sources.some(s => host(s.url) === host(profile.website!))
    checks.push({ field: 'website', pass: site.ok && listed, detail: !site.ok ? `website returned HTTP ${site.status || 'error'}` : listed ? null : 'website is not among the cited sources', severity: site.ok ? 'error' : 'warning' })
  }
  if (research.confidence === 'high' && research.identitySignals.length < 2) {
    checks.push({ field: 'identity', pass: false, detail: 'high confidence needs at least 2 independent identity signals', severity: 'error' })
  }
  return checks
}

/** For the agent's self-check: schema plus code checks. */
export async function checkResearchOutput(key: string): Promise<TResearchCheck[]> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(io(key, 'output'), 'utf8'))
  } catch (error) {
    return [{ field: 'file', pass: false, detail: `output missing or invalid JSON: ${(error as Error).message}`, severity: 'error' }]
  }
  const parsed = VendorResearch.safeParse(raw)
  if (!parsed.success) {
    return parsed.error.issues.map(i => ({ field: i.path.join('.') || 'root', pass: false, detail: i.message, severity: 'error' as const }))
  }
  if (parsed.data.key !== key) return [{ field: 'key', pass: false, detail: `key must be "${key}"`, severity: 'error' }]
  return runResearchChecks(parsed.data)
}

// ─── Import ──────────────────────────────────────────────────────────────────

/**
 * Percent-encode characters RFC 3986 doesn't allow in a URL (Legistar links
 * carry "Options=ID|Text|"). Browsers accept them, but the published JSON
 * Schema's "uri" format doesn't.
 */
export const toRfc3986 = (url: string): string =>
  url.replace(/[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/g, ch => encodeURIComponent(ch))

function withRfc3986Urls(research: TVendorResearch): TVendorResearch {
  const profile = research.profile
  return {
    ...research,
    sources: research.sources.map(s => ({ ...s, url: toRfc3986(s.url) })),
    profile: profile ? { ...profile, website: profile.website ? toRfc3986(profile.website) : profile.website } : profile,
  }
}

export async function importResearch(modelId: string, researchedAt: string): Promise<{ key: string; confidence: string; failed: number }[]> {
  await mkdir(recordsDir(), { recursive: true })
  const out: { key: string; confidence: string; failed: number }[] = []
  for (const f of (await readdir(RESEARCH_DIR)).filter(n => n.endsWith('.output.json') && !n.includes('.review.'))) {
    const key = f.replace(/\.output\.json$/, '')
    const parsed = VendorResearch.safeParse(JSON.parse(await readFile(path.join(RESEARCH_DIR, f), 'utf8')))
    if (!parsed.success) continue
    const research = withRfc3986Urls(parsed.data)
    const checks = await runResearchChecks(research)
    const record: TVendorResearchRecord = VendorResearchRecord.parse({
      key,
      researchedAt,
      modelId,
      promptVersion: RESEARCH_PROMPT_VERSION,
      research,
      review: null,
      checks: checks.map(({ severity: _s, ...c }) => c),
      publishable: false,
    })
    await writeJson(recordPath(key), record)
    out.push({ key, confidence: research.confidence, failed: checks.filter(c => !c.pass).length })
  }
  return out
}

export async function exportReviews(): Promise<string[]> {
  const keys: string[] = []
  for (const f of await readdir(recordsDir())) {
    const rec = VendorResearchRecord.parse(JSON.parse(await readFile(path.join(recordsDir(), f), 'utf8')))
    if (rec.research.confidence !== 'high' || !rec.research.profile || rec.review) continue
    const vendor = toInput(await readVendor(rec.key))
    await writeFile(io(rec.key, 'review.input'), `${JSON.stringify({ vendor, candidate: rec.research }, null, 2)}\n`)
    keys.push(rec.key)
  }
  return keys.sort()
}

export async function checkReviewOutput(key: string): Promise<string[]> {
  try {
    const parsed = VendorResearchReview.safeParse(JSON.parse(await readFile(io(key, 'review.output'), 'utf8')))
    if (!parsed.success) return parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)
    return parsed.data.key === key ? [] : [`key must be "${key}"`]
  } catch (error) {
    return [`review output missing or invalid JSON: ${(error as Error).message}`]
  }
}

export async function importReviews(): Promise<{ key: string; publishable: boolean }[]> {
  const out: { key: string; publishable: boolean }[] = []
  for (const f of (await readdir(RESEARCH_DIR)).filter(n => n.endsWith('.review.output.json'))) {
    const key = f.replace(/\.review\.output\.json$/, '')
    const review = VendorResearchReview.safeParse(JSON.parse(await readFile(path.join(RESEARCH_DIR, f), 'utf8')))
    if (!review.success) continue
    const rec = VendorResearchRecord.parse(JSON.parse(await readFile(recordPath(key), 'utf8')))
    const anySourceLoaded = rec.checks.some(c => c.field.startsWith('source:') && c.pass)
    const identityOk = rec.research.identitySignals.length >= 2 && !rec.checks.some(c => c.field === 'identity' && !c.pass)
    const publishable = rec.research.confidence === 'high'
      && review.data.verdict === 'confirmed' && review.data.sameOrganization && identityOk && anySourceLoaded
    await writeJson(recordPath(key), { ...rec, review: review.data, publishable })
    out.push({ key, publishable })
  }
  return out
}

// ─── Build ───────────────────────────────────────────────────────────────────

/** The published profile: only fields that passed every check and the review. */
export function publishedProfile(rec: TVendorResearchRecord): TPublishedVendorProfile | null {
  const p = rec.research.profile
  if (!rec.publishable || !p) return null
  const failed = new Set(rec.checks.filter(c => !c.pass).map(c => c.field))
  const dropped = new Set<string>([...failed, ...(rec.review?.unsupportedFields ?? [])])
  // A field supported only by pages that failed to load is dropped too.
  const loaded = new Set(rec.checks.filter(c => c.field.startsWith('source:') && c.pass).map(c => c.field.slice(7)))
  const supportedByLoaded = (field: TProfileField): boolean =>
    rec.research.sources.some(s => s.supports.includes(field) && loaded.has(s.url))
  const keep = <T>(field: TProfileField, value: T | null): T | undefined =>
    value != null && !dropped.has(field) && supportedByLoaded(field) ? value : undefined
  if (!supportedByLoaded('summary') || dropped.has('summary')) return null
  return {
    summary: p.summary,
    legalName: keep('legalName', p.legalName),
    orgType: keep('orgType', p.orgType),
    website: keep('website', p.website),
    phone: keep('phone', p.phone),
    email: keep('email', p.email),
    address: keep('address', p.address),
    headquarters: keep('headquarters', p.headquarters),
    ein: keep('ein', p.ein),
    caEntityNumber: keep('caEntityNumber', p.caEntityNumber),
    samUei: keep('samUei', p.samUei),
    sources: rec.research.sources.filter(s => loaded.has(s.url)),
    researchedAt: rec.researchedAt,
    modelId: rec.modelId,
  }
}

export async function readAllResearch(): Promise<Map<string, TVendorResearchRecord>> {
  const out = new Map<string, TVendorResearchRecord>()
  let files: string[] = []
  try {
    files = await readdir(recordsDir())
  } catch {
    return out
  }
  for (const f of files.filter(n => n.endsWith('.json'))) {
    const rec = VendorResearchRecord.parse(JSON.parse(await readFile(path.join(recordsDir(), f), 'utf8')))
    out.set(rec.key, rec)
  }
  return out
}
