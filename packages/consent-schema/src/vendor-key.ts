/**
 * Cross-meeting vendor identity.
 *
 * The OUSD vendor number wins when present. Otherwise we fall back to a
 * normalized name, which the hand-edited alias table can map onto a vendor
 * number or a canonical name key.
 */

const SUFFIXES = /\b(inc|incorporated|llc|l\.l\.c|llp|lp|ltd|corp|corporation|co|company|dba|pc|p\.c|pllc|the)\b\.?/g

export function normalizeVendorName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(SUFFIXES, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * Vendor aliases (data/consent/vendors/aliases.json).
 * - vendorNumbers: a typo'd vendor number → its canonical number ("00453" → "000453")
 * - names: a normalized name for items with no vendor number → a vendor number or canonical name
 */
export type TVendorAliases = {
  vendorNumbers: Record<string, string>
  names: Record<string, string>
}

export const NO_ALIASES: TVendorAliases = { vendorNumbers: {}, names: {} }

/** The canonical form of one vendor-number code, following alias chains ("1201" → "001201" → …). */
export function canonicalVendorNo(code: string, aliases: TVendorAliases = NO_ALIASES): string {
  let current = code
  for (let i = 0; i < 8 && aliases.vendorNumbers[current] && aliases.vendorNumbers[current] !== current; i++) current = aliases.vendorNumbers[current]
  return current
}

/** Where a normalized name points after aliases: a vendor number, or a canonical name. Follows chains. */
function resolveName(normalized: string, aliases: TVendorAliases): { vendorNo: string } | { name: string } {
  let name = normalized
  for (let i = 0; i < 8; i++) {
    const alias = aliases.names[name]
    if (!alias || alias === name) break
    if (/^\d+$/.test(alias)) return { vendorNo: canonicalVendorNo(alias, aliases) }
    name = alias
  }
  return { name }
}

/**
 * Returns a URL-safe key: `v-006530` for vendor numbers, `n-bay-area-community-resources` for names.
 */
export function vendorKey(
  vendorNo: string | null | undefined,
  name: string | null | undefined,
  aliases: TVendorAliases = NO_ALIASES,
): string | null {
  // Multi-code values ("005403 001582") key on the first code.
  const primaryNo = vendorNo?.trim().split(/\s+/).find(code => /^\d+$/.test(code))
  if (primaryNo) return `v-${canonicalVendorNo(primaryNo, aliases)}`
  if (!name?.trim()) return null
  const normalized = normalizeVendorName(name)
  if (!normalized) return null
  const resolved = resolveName(normalized, aliases)
  return 'vendorNo' in resolved ? `v-${resolved.vendorNo}` : `n-${resolved.name.replace(/\s+/g, '-')}`
}

/**
 * Where an existing vendor key points under the current aliases. Records
 * stored under a vendor key (like vendor research) follow merges with this,
 * so merging two vendors never orphans them.
 */
export function currentVendorKey(key: string, aliases: TVendorAliases = NO_ALIASES): string {
  if (key.startsWith('v-')) return `v-${canonicalVendorNo(key.slice(2), aliases)}`
  if (key.startsWith('n-')) return vendorKey(null, key.slice(2).replace(/-/g, ' '), aliases) ?? key
  return key
}
