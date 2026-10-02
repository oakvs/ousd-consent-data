/**
 * Seed the meeting registry from agenda PDF filenames, e.g.
 *   OUSD-BOE_2025-08-07_1100_Special_Agenda.pdf
 *   OUSD-BOE_2026-06-24_1610_Agenda.pdf
 *   OUSD-BOE_2026-01-05_1100_Organizational_Agenda.pdf
 *   OUSD-BOE_2025-12-03_canceled_Special_Agenda.pdf
 *
 * Key rule: the bare date, unless two meetings share the day, in which case
 * the non-regular one gets a suffix (`2026-09-23-special`).
 */
import { readdir } from 'node:fs/promises'

import type { TMeetingKind, TRegistry, TRegistryEntry } from '@oakvs/consent-schema/schema'

const FILENAME = /^OUSD-BOE_(\d{4}-\d{2}-\d{2})_(\d{4}|canceled)_(?:(Special|Organizational)_)?Agenda\.pdf$/i

export type TParsedAgenda = { date: string; time: string | null; kind: TMeetingKind; canceled: boolean }

export function parseAgendaFilename(name: string): TParsedAgenda | null {
  const match = FILENAME.exec(name)
  if (!match) return null
  const [, date, time, kindRaw] = match
  const canceled = time.toLowerCase() === 'canceled'
  return {
    date,
    time: canceled ? null : `${time.slice(0, 2)}:${time.slice(2)}`,
    kind: (kindRaw?.toLowerCase() as TMeetingKind | undefined) ?? 'regular',
    canceled,
  }
}

export function assignKeys(agendas: TParsedAgenda[]): (TParsedAgenda & { key: string })[] {
  const byDate = new Map<string, TParsedAgenda[]>()
  for (const a of agendas) byDate.set(a.date, [...(byDate.get(a.date) ?? []), a])
  return [...byDate.values()].flatMap(list => {
    if (list.length === 1) return [{ ...list[0], key: list[0].date }]
    return list.map(a => ({ ...a, key: a.kind === 'regular' ? a.date : `${a.date}-${a.kind}` }))
  })
}

export async function seedRegistryFromAgendas(registry: TRegistry, dir: string): Promise<number> {
  const parsed = (await readdir(dir)).map(parseAgendaFilename).filter((a): a is TParsedAgenda => a != null)
  let added = 0
  for (const a of assignKeys(parsed)) {
    const existing = registry.meetings.find(m => m.key === a.key)
    if (existing) {
      existing.time ??= a.time
      existing.kind = a.kind
      continue
    }
    const entry: TRegistryEntry = {
      key: a.key,
      date: a.date,
      time: a.time,
      kind: a.kind,
      eventId: null,
      resolvedBy: null,
      meetingDetailId: null,
      agendaPdfUrl: null,
      status: a.canceled ? 'skipped' : 'discovered',
      lastIngestedAt: null,
      note: a.canceled ? 'Canceled' : null,
    }
    registry.meetings.push(entry)
    added++
  }
  return added
}
