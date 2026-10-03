import { describe, expect, it } from 'vitest'

import { currentVendorKey, vendorKey } from '@oakvs/consent-schema/vendor-key'
import type { TVendorResearchRecord } from '@oakvs/consent-schema/schema'

import { generateAliases, nameSignature } from '../build/aliases'
import { researchByCurrentKey } from '../build/vendors'
import { toRfc3986 } from '../research/vendor-research'

describe('rule 3: name variants', () => {
  it('merges names that match once filler words are dropped', () => {
    const a = generateAliases([
      { codes: [], name: 'liebert cassidy and whitmore' },
      { codes: [], name: 'liebert cassidy and whitmore' },
      { codes: [], name: 'liebert cassidy whitmore a professional' },
      { codes: [], name: 'liebert cassidy whitmore law firm' },
    ])
    expect(a.names).toEqual({
      'liebert cassidy whitmore a professional': 'liebert cassidy and whitmore',
      'liebert cassidy whitmore law firm': 'liebert cassidy and whitmore',
    })
  })

  it('joins a name-only variant to the one vendor number its group has', () => {
    const a = generateAliases([{ codes: ['005396'], name: 'lozano smith' }, { codes: [], name: 'lozano smith law firm' }])
    expect(a.names['lozano smith law firm']).toBe('005396')
  })

  it('never joins two different vendor numbers, and keeps words like "group" and "services"', () => {
    const a = generateAliases([{ codes: ['000624'], name: 'bay area community resources' }, { codes: ['000634'], name: 'bay area community resources' }, { codes: [], name: 'bay area community resources law firm' }])
    expect(a.names['bay area community resources law firm']).toBeUndefined()
    expect(nameSignature('genesis group')).toBe('genesis group')
  })
})

describe('alias chains and moved records', () => {
  const aliases = { vendorNumbers: { '000634': '000624' }, names: { 'lozano smith law firm': 'lozano smith', 'lozano smith': '005396', 'old name': 'newer name' } }

  it('follows chains to the final vendor', () => {
    expect(vendorKey('000634', null, aliases)).toBe('v-000624')
    expect(vendorKey(null, 'Lozano Smith Law Firm', aliases)).toBe('v-005396')
    expect(currentVendorKey('n-lozano-smith-law-firm', aliases)).toBe('v-005396')
    expect(currentVendorKey('v-000634', aliases)).toBe('v-000624')
    expect(currentVendorKey('n-old-name', aliases)).toBe('n-newer-name')
  })

  it('moves research to the merged vendor, keeping the publishable record on a collision', () => {
    const rec = (key: string, publishable: boolean, confidence = 'high'): TVendorResearchRecord =>
      ({ key, publishable, researchedAt: '2026-10-02', research: { confidence } }) as unknown as TVendorResearchRecord
    const out = researchByCurrentKey(new Map([
      ['n-lozano-smith-law-firm', rec('n-lozano-smith-law-firm', false, 'medium')],
      ['v-005396', rec('v-005396', true)],
      ['v-000634', rec('v-000634', true)],
    ]), aliases)
    expect([...out.keys()].sort()).toEqual(['v-000624', 'v-005396'])
    expect(out.get('v-005396')!.publishable).toBe(true)
    expect(out.get('v-000624')!.key).toBe('v-000634')
  })
})

describe('research import', () => {
  it('percent-encodes characters the "uri" format rejects, and leaves valid URLs alone', () => {
    expect(toRfc3986('https://ousd.legistar.com/LegislationDetail.aspx?ID=1&Options=ID|Text|&Search=kipp'))
      .toBe('https://ousd.legistar.com/LegislationDetail.aspx?ID=1&Options=ID%7CText%7C&Search=kipp')
    const ok = 'https://example.org/a-b_c.d~e/?q=1&r=%20#frag'
    expect(toRfc3986(ok)).toBe(ok)
  })
})
