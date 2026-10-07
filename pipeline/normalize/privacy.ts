/**
 * Staff emails are never kept. Legistar's free-text fields are
 * filled in by hand, and staff sometimes type their own address into one
 * (e.g. file 21-3054 has an email as its funding source). Strip
 * email-shaped text from every Legistar field we store.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/** Staff domain: any address here in `data/` is a privacy bug. */
export const STAFF_EMAIL = /[A-Za-z0-9._%+-]+@ousd\.org/i

/** Removes email addresses; returns null when nothing else is left. */
export function withoutEmails(value: string | null): string | null {
  if (value === null) return null
  return value.replace(EMAIL, ' ').replace(/\s+/g, ' ').trim() || null
}
