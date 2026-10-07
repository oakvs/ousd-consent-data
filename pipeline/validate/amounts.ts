/**
 * Amount-format matcher (`amounts_in_text`).
 *
 * Pulls every dollar-like figure out of a string so we can check an LLM's
 * numbers against the official text. Handles `$1,234.56`, `1,234`, `1234.56`,
 * `$1.2 million`, `$1.02M` and `$248K`.
 */

export type TExtractedAmount = {
  value: number
  /** Half a unit of the stated precision: 0 for exact figures, 50,000 for "$1.2 million". */
  tolerance: number
  raw: string
}

const AMOUNT = /\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(million|billion|m\b|b\b|k\b)?/gi

/**
 * OUSD's text sometimes has a stray space after a thousands comma
 * ("$811, 391.00", "$5, 141,095.00"). Close it up, but only right after a
 * dollar sign, so lists of plain numbers ("1, 234") are left alone.
 */
const STRAY_SPACE = /(\$\s?\d{1,3}(?:,\d{3})*),[ \u00a0](?=\d{3}(?!\d))/g
const closeStraySpaces = (text: string): string => {
  let prev: string
  let next = text
  do {
    prev = next
    next = prev.replace(STRAY_SPACE, '$1,')
  } while (next !== prev)
  return next
}

export function extractAmounts(text: string): TExtractedAmount[] {
  const out: TExtractedAmount[] = []
  for (const match of closeStraySpaces(text).matchAll(AMOUNT)) {
    const [raw, whole, decimals = '', unitRaw] = match
    const hasDollar = raw.trimStart().startsWith('$')
    const unit = unitRaw?.toLowerCase()
    // Bare integers without a $ or unit are usually dates, counts or section numbers.
    if (!hasDollar && !unit && !whole.includes(',') && !decimals) continue
    const base = Number(`${whole.replace(/,/g, '')}${decimals}`)
    if (!Number.isFinite(base)) continue
    const multiplier = unit?.startsWith('b') ? 1e9 : unit?.startsWith('m') ? 1e6 : unit === 'k' ? 1e3 : 1
    const value = base * multiplier
    let tolerance = 0
    if (multiplier > 1) {
      // "$1.2 million" could be anything that rounds to 1.2 at that precision.
      const places = decimals ? decimals.length - 1 : 0
      tolerance = 0.5 * 10 ** -places * multiplier
    }
    out.push({ value, tolerance, raw: raw.trim() })
  }
  return out
}

/** True when `value` appears in `text` in some common format. */
export function amountInText(value: number, text: string): boolean {
  return extractAmounts(text).some(({ value: found, tolerance }) => {
    if (tolerance === 0) return Math.abs(found - value) < 0.005
    return Math.abs(found - value) < tolerance
  })
}

/** True when `text` contains an amount within `relative` (default 1%) of `value`. */
export function amountNear(value: number, text: string, relative = 0.01): boolean {
  return extractAmounts(text).some(({ value: found, tolerance }) =>
    Math.abs(found - value) <= Math.max(value * relative, tolerance))
}

/**
 * Misprint-tolerant reading of a printed dollar figure. OUSD's text sometimes
 * swaps or doubles separators ("$8,273.319.00", "$354.673.80", "$35,000. 00",
 * "$1,000,000,00"). Read the last separator as the decimal point when exactly
 * two digits follow it, and drop every other separator.
 */
export function readLenient(printed: string): number | null {
  const digits = printed.replace(/[$\s]/g, '')
  if (!/^\d[\d.,]*\d$/.test(digits)) return null
  const last = Math.max(digits.lastIndexOf('.'), digits.lastIndexOf(','))
  const hasCents = last >= 0 && digits.length - last - 1 === 2
  const whole = (hasCents ? digits.slice(0, last) : digits).replace(/[.,]/g, '')
  const value = Number(hasCents ? `${whole}.${digits.slice(last + 1)}` : whole)
  return Number.isFinite(value) ? value : null
}

const PRINTED_DOLLARS = /\$\s?\d[\d.,]*(?:\s\d{2}\b)?/g

/**
 * When `value` isn't in `text` verbatim but a misprinted figure reads as it,
 * returns how it was printed (e.g. "$8,273.319.00"). Otherwise null.
 */
export function findMisprint(value: number, text: string): string | null {
  if (amountInText(value, text)) return null
  for (const match of text.matchAll(PRINTED_DOLLARS)) {
    const printed = match[0].replace(/[.,]$/, '').trim()
    const read = readLenient(printed)
    if (read != null && Math.abs(read - value) < 0.005) return printed
  }
  return null
}
