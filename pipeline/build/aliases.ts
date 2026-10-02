/**
 * Generated vendor aliases (data/vendors/aliases.json → "generated").
 *
 * Built from the source data (raw items + the summarizer's vendor names), so
 * it is deterministic and safe to regenerate. Hand edits go in "manual",
 * which always wins.
 *
 * Rules:
 * 1. Vendor numbers that differ only by leading zeros ("00453", "000453",
 *    "0000453") are the same vendor ONLY if they also share a vendor name.
 *    (Same digits alone isn't enough: Cumming's "1201" is not Cordoba's "001201".)
 *    The canonical form is the 6-digit one (OUSD's standard), else the most used.
 * 2. An item with no vendor number joins a numbered vendor when its normalized
 *    name matches exactly one canonical vendor number's names.
 * 3. Names that are the same once legal-form and filler words are dropped
 *    ("Liebert Cassidy Whitmore, a Professional Corporation" and "Liebert
 *    Cassidy Whitmore Law Firm") are one vendor, as long as that wouldn't
 *    join two different vendor numbers. Those cases are left to a person (or
 *    the AI judge) and the "manual" section.
 */
import { normalizeVendorName } from '@oakvs/consent-schema/vendor-key'
import type { TVendorAliases } from '@oakvs/consent-schema/vendor-key'

import { listRawKeys, paths, readAliasFile, readEnrichments, readRaw, writeJson } from '../store'

type TObservation = { codes: string[]; name: string | null }

/** Words that don't distinguish one organization from another. "group" and "services" are kept on purpose. */
const FILLER = new Set(['the', 'of', 'and', 'a', 'an', 'law', 'firm', 'offices', 'professional', 'corporation', 'corp', 'company', 'co', 'inc', 'llc', 'dba', 'aka'])

/** A normalized name with filler words dropped: the comparison key for rule 3. */
export const nameSignature = (normalized: string): string =>
  normalized.split(' ').filter(w => w && !FILLER.has(w)).join(' ')

const sorted = (r: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)))

export function generateAliases(observations: TObservation[]): TVendorAliases {
  // Names seen with each code, and how often each code is used.
  const namesByCode = new Map<string, Set<string>>()
  const uses = new Map<string, number>()
  for (const o of observations) {
    for (const code of o.codes) {
      uses.set(code, (uses.get(code) ?? 0) + 1)
      if (o.name) namesByCode.set(code, (namesByCode.get(code) ?? new Set()).add(o.name))
    }
  }

  // Rule 1: group codes by numeric value, merge those that share a name.
  const vendorNumbers: Record<string, string> = {}
  const byValue = new Map<string, string[]>()
  for (const code of uses.keys()) byValue.set(String(Number(code)), [...(byValue.get(String(Number(code))) ?? []), code])
  for (const codes of byValue.values()) {
    if (codes.length < 2) continue
    const canonical = [...codes].sort((a, b) =>
      Number(b.length === 6) - Number(a.length === 6) || (uses.get(b)! - uses.get(a)!) || b.length - a.length || a.localeCompare(b))[0]
    const canonicalNames = namesByCode.get(canonical) ?? new Set<string>()
    for (const code of codes) {
      if (code === canonical) continue
      const theirs = namesByCode.get(code) ?? new Set<string>()
      const shared = [...theirs].some(n => canonicalNames.has(n))
      if (shared) vendorNumbers[code] = canonical
    }
  }

  // Rule 2: number-less names that match exactly one canonical number.
  const canonicalOf = (code: string): string => vendorNumbers[code] ?? code
  const numbersByName = new Map<string, Set<string>>()
  for (const [code, names] of namesByCode) {
    for (const n of names) numbersByName.set(n, (numbersByName.get(n) ?? new Set()).add(canonicalOf(code)))
  }
  const names: Record<string, string> = {}
  for (const o of observations) {
    if (o.codes.length || !o.name) continue
    const candidates = numbersByName.get(o.name)
    if (candidates?.size === 1) names[o.name] = [...candidates][0]
  }

  // Rule 3: names equal by signature, unless that would join two vendor numbers.
  const observedNames = new Map<string, number>()
  for (const o of observations) if (o.name) observedNames.set(o.name, (observedNames.get(o.name) ?? 0) + 1)
  const bySignature = new Map<string, string[]>()
  for (const n of observedNames.keys()) {
    const sig = nameSignature(n)
    if (sig.split(' ').length < 2 && sig.length < 6) continue // too short to be distinctive
    bySignature.set(sig, [...(bySignature.get(sig) ?? []), n])
  }
  for (const group of bySignature.values()) {
    if (group.length < 2) continue
    const numbers = new Set(group.flatMap(n => [...(numbersByName.get(n) ?? [])]))
    if (numbers.size > 1) continue
    if (numbers.size === 1) {
      const [number] = numbers
      for (const n of group) if (!numbersByName.has(n) && !names[n]) names[n] = number
      continue
    }
    // No vendor number: point every variant at the most-used name (then the shortest, then alphabetical).
    const canonical = [...group].sort((a, b) => observedNames.get(b)! - observedNames.get(a)! || a.length - b.length || a.localeCompare(b))[0]
    for (const n of group) if (n !== canonical && !names[n]) names[n] = canonical
  }

  return { vendorNumbers: sorted(vendorNumbers), names: sorted(names) }
}

export async function regenerateAliasFile(): Promise<TVendorAliases> {
  const observations: TObservation[] = []
  for (const key of await listRawKeys()) {
    const [raw, enrichments] = await Promise.all([readRaw(key), readEnrichments(key)])
    for (const item of raw?.items ?? []) {
      const name = enrichments?.items[item.file]?.output.vendor.name ?? null
      observations.push({ codes: item.vendorNo?.split(' ').filter(Boolean) ?? [], name: name ? normalizeVendorName(name) : null })
    }
  }
  const generated = generateAliases(observations)
  const { manual } = await readAliasFile()
  await writeJson(paths.vendorAliases, {
    about: 'Vendor aliases. "generated" is rebuilt by `npm run consent:vendor-aliases`; put hand edits in "manual", which always wins.',
    generated,
    manual,
  })
  return generated
}
