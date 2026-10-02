import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { STAFF_EMAIL, withoutEmails } from '../normalize/privacy'

describe('withoutEmails', () => {
  it('drops a field that is only an email', () => {
    expect(withoutEmails('first.last@ousd.org')).toBeNull()
  })

  it('keeps the rest of a field that contains an email', () => {
    expect(withoutEmails('0000 - General Purpose (ask jane.doe@example.org)')).toBe('0000 - General Purpose (ask )')
  })

  it('leaves ordinary values and null alone', () => {
    expect(withoutEmails('Title I-Basic Grant Low Income')).toBe('Title I-Basic Grant Low Income')
    expect(withoutEmails(null)).toBeNull()
  })
})

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else yield full
  }
}

describe('committed data', () => {
  it('contains no OUSD staff email addresses', async () => {
    const offenders: string[] = []
    for await (const file of walk(path.join(process.cwd(), 'data'))) {
      const match = (await readFile(file, 'utf8')).match(STAFF_EMAIL)
      if (match) offenders.push(`${path.relative(process.cwd(), file)}: ${match[0]}`)
    }
    expect(offenders).toEqual([])
  })
})
