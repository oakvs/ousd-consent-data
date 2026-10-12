import { afterEach, describe, expect, it, vi } from 'vitest'

import { PROBE_BEHIND, probeEvents } from '../legistar/discover'

// Made-up EventIds, so nothing real in the Legistar request cache is touched.
const LAST_KNOWN = 990_100

describe('probing for a new meeting\'s EventId', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('also checks unclaimed ids just below the last known one: events are numbered by creation, not date', async () => {
    // 990090 was created before the last known event but is for a later meeting (like Oct 14, 2026 = 5815 < 5818).
    // 990095 is a claimed meeting; 990101 is a committee meeting after the last known one.
    const withItems = new Set([990_090, 990_095, 990_101])
    const asked: number[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      const id = Number(/events\/(\d+)\/eventitems/.exec(url)?.[1])
      asked.push(id)
      const items = withItems.has(id) ? [{ EventItemId: id, EventItemMatterFile: `26-${id}` }] : []
      return new Response(JSON.stringify(items), { status: 200 })
    })
    const found = await probeEvents(LAST_KNOWN, new Set([990_095, LAST_KNOWN]))
    expect([...found.keys()].sort()).toEqual([990_090, 990_101])
    expect(asked).not.toContain(990_095)
    expect(asked).not.toContain(LAST_KNOWN)
    expect(Math.min(...asked)).toBe(LAST_KNOWN - PROBE_BEHIND + 1)
  })
})
