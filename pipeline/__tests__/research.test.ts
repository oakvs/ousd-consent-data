import { describe, expect, it } from 'vitest'

import type { TVendorResearchRecord } from '@oakvs/consent-schema/schema'

import { addressOnPage, fieldOnPage, htmlToText, phoneOnPage, publishedProfile } from '../research/vendor-research'

import type { TPage } from '../research/vendor-research'

const page = (html: string, url = 'https://example.org/contact'): TPage =>
  ({ url, ok: true, status: 200, finalUrl: url, html, text: htmlToText(html) })

describe('verbatim checks', () => {
  const contact = page(`
    <footer><p>Fred Finch Youth &amp; Family Services</p>
    <p>3800 Coolidge Avenue, Oakland, CA 94602</p>
    <p>Main: <a href="tel:5104822244">(510) 482-2244</a> · <a href="mailto:info@fredfinch.org">info@fredfinch.org</a></p>
    <script>var x = "999-999-9999"</script></footer>`)

  it('matches phones by digits, in any common format', () => {
    expect(phoneOnPage('510.482.2244', contact)).toBe(true)
    expect(phoneOnPage('+1 (510) 482-2244', contact)).toBe(true)
    expect(phoneOnPage('(510) 482-2245', contact)).toBe(false)
  })

  it('ignores numbers that only appear in scripts', () => {
    expect(htmlToText(contact.html)).not.toContain('999-999-9999')
  })

  it('matches addresses by street line and ZIP, tolerating abbreviations', () => {
    expect(addressOnPage('3800 Coolidge Ave., Oakland, CA 94602', contact)).toBe(true)
    expect(addressOnPage('3800 Coolidge Avenue, Oakland, CA 94612', contact)).toBe(false)
    expect(addressOnPage('3801 Coolidge Ave, Oakland, CA 94602', contact)).toBe(false)
  })

  it('matches emails, legal names and EINs', () => {
    expect(fieldOnPage('email', 'INFO@fredfinch.org', contact)).toBe(true)
    expect(fieldOnPage('legalName', 'Fred Finch Youth and Family Services', contact)).toBe(true)
    const propublica = page('<h1>Fred Finch Youth Center</h1><p>EIN: 94-1156339</p>', 'https://projects.propublica.org/nonprofits/organizations/941156339')
    expect(fieldOnPage('ein', '94-1156339', propublica)).toBe(true)
    expect(fieldOnPage('ein', '94-1156330', propublica)).toBe(false)
  })
})

describe('what gets published', () => {
  const base: TVendorResearchRecord = {
    key: 'v-000001',
    researchedAt: '2026-10-01',
    modelId: 'sonnet-agent',
    promptVersion: 'vendor-research.v1.md',
    research: {
      key: 'v-000001',
      identitySignals: ['name matches registry', 'located in Oakland'],
      confidence: 'high',
      profile: {
        legalName: 'Example Org', summary: 'A nonprofit that runs after-school programs.', orgType: 'nonprofit',
        website: 'https://example.org/', phone: '(510) 555-0100', email: 'info@example.org', address: null,
        headquarters: 'Oakland, CA', ein: '94-1234567', caEntityNumber: null, samUei: null,
      },
      sources: [
        { url: 'https://example.org/', title: 'Home', supports: ['summary', 'website', 'orgType'] },
        { url: 'https://example.org/contact', title: 'Contact', supports: ['phone', 'email'] },
        { url: 'https://blocked.example/ein', title: 'Registry', supports: ['ein', 'legalName'] },
      ],
      notes: null,
    },
    review: { key: 'v-000001', verdict: 'confirmed', sameOrganization: true, unsupportedFields: ['email'], notes: null },
    checks: [
      { field: 'source:https://example.org/', pass: true, detail: null },
      { field: 'source:https://example.org/contact', pass: true, detail: null },
      { field: 'source:https://blocked.example/ein', pass: false, detail: 'HTTP 403' },
      { field: 'phone', pass: true, detail: null },
    ],
    publishable: true,
  }

  it('drops fields the reviewer could not confirm and fields only on pages that failed to load', () => {
    const p = publishedProfile(base)!
    expect(p.summary).toContain('after-school')
    expect(p.phone).toBe('(510) 555-0100')
    expect(p.email).toBeUndefined() // reviewer: unsupported
    expect(p.ein).toBeUndefined() // only cited on a page that 403'd
    expect(p.legalName).toBeUndefined()
    expect(p.sources.map(s => s.title)).toEqual(['Home', 'Contact'])
  })

  it('drops a field whose verbatim check failed', () => {
    const p = publishedProfile({ ...base, checks: [...base.checks, { field: 'phone', pass: false, detail: 'not found' }] })!
    expect(p.phone).toBeUndefined()
  })

  it('publishes nothing unless the record is publishable', () => {
    expect(publishedProfile({ ...base, publishable: false })).toBeNull()
  })
})
