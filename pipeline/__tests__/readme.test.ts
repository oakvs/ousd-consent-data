import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { applySections, readmeInputs, readmeSections } from '../build/readme'

describe('README generated sections', () => {
  it('replaces inline and block sections and leaves unknown ones alone', () => {
    const text = 'Since <!-- generated:since -->old<!-- /generated:since -->.\n<!-- generated:models -->\nold table\n<!-- /generated:models -->\n<!-- generated:other -->keep<!-- /generated:other -->'
    expect(applySections(text, { since: 'May 2024', models: '| a |' })).toBe(
      'Since <!-- generated:since -->May 2024<!-- /generated:since -->.\n<!-- generated:models -->\n| a |\n<!-- /generated:models -->\n<!-- generated:other -->keep<!-- /generated:other -->',
    )
  })

  it('are current (run npm run consent:build if this fails)', async () => {
    const readme = await readFile(path.join(process.cwd(), 'README.md'), 'utf8')
    expect(readme).toContain('<!-- generated:stats -->')
    expect(applySections(readme, readmeSections(await readmeInputs(path.join(process.cwd(), 'data'))))).toBe(readme)
  })
})
