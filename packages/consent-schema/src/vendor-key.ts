/**
 * Cross-meeting vendor identity (§12).
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

/** The canonical form of one vendor-number code. */
export function canonicalVendorNo(code: string, aliases: TVendorAliases = NO_ALIASES): string {
  return aliases.vendorNumbers[code] ?? code
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
  const alias = aliases.names[normalized]
  if (alias) return /^\d+$/.test(alias) ? `v-${canonicalVendorNo(alias, aliases)}` : `n-${alias.replace(/\s+/g, '-')}`
  return `n-${normalized.replace(/\s+/g, '-')}`
}
