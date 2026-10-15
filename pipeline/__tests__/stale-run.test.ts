import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { changedBetween, head } from '../run/git'
import { run } from '../run/run'

const exec = promisify(execFile)
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec('git', args, { cwd })).stdout.trim()

/** A bare "origin", a clone the run works in, and a second clone that pushes changes meanwhile. */
async function repos(): Promise<{ work: string; other: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stale-run-'))
  const origin = path.join(root, 'origin.git')
  await exec('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin])
  const work = path.join(root, 'work')
  const other = path.join(root, 'other')
  await exec('git', ['clone', '--quiet', origin, work])
  await sh(work, 'config', 'user.email', 't@example.org')
  await sh(work, 'config', 'user.name', 'test')
  await sh(work, 'config', 'commit.gpgsign', 'false')
  await mkdir(path.join(work, 'pipeline'), { recursive: true })
  await mkdir(path.join(work, 'data'), { recursive: true })
  await writeFile(path.join(work, 'pipeline', 'x.ts'), 'export const v = 1\n')
  await writeFile(path.join(work, 'data', 'a.json'), '{}\n')
  await writeFile(path.join(work, '.gitignore'), '.cache/\n')
  await sh(work, 'add', '--all')
  await sh(work, 'commit', '--quiet', '-m', 'start')
  await sh(work, 'push', '--quiet', '-u', 'origin', 'main')
  await exec('git', ['clone', '--quiet', origin, other])
  await sh(other, 'config', 'user.email', 't@example.org')
  await sh(other, 'config', 'user.name', 'test')
  await sh(other, 'config', 'commit.gpgsign', 'false')
  return { work, other }
}

async function pushFrom(dir: string, file: string, body: string): Promise<void> {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true })
  await writeFile(path.join(dir, file), body)
  await sh(dir, 'add', '--all')
  await sh(dir, 'commit', '--quiet', '-m', `change ${file}`)
  await sh(dir, 'push', '--quiet')
}

const cwd = process.cwd()
afterEach(() => process.chdir(cwd))

describe('a run never writes data with code older than main', () => {
  it('counts only changes outside data/ and README.md as new code', async () => {
    const { work, other } = await repos()
    const start = await sh(work, 'rev-parse', 'HEAD')
    await pushFrom(other, 'data/b.json', '{}\n')
    await pushFrom(other, 'README.md', '# hi\n')
    await sh(work, 'pull', '--quiet', '--ff-only')
    process.chdir(work)
    expect(await changedBetween(start, await head(), ['data', 'README.md'])).toEqual([])
    await pushFrom(other, 'pipeline/x.ts', 'export const v = 2\n')
    await sh(work, 'pull', '--quiet', '--ff-only')
    expect(await changedBetween(start, await head(), ['data', 'README.md'])).toEqual(['pipeline/x.ts'])
  })

  it('stops before checking Legistar when the first pull brings new code', async () => {
    const { work, other } = await repos()
    await pushFrom(other, 'pipeline/x.ts', 'export const v = 2\n')
    process.chdir(work)
    const summary = await run({ push: true, llm: false })
    expect(summary.staleCode).toMatch(/main has newer code \(pipeline\/x\.ts\)/)
    expect(summary.commit).toBeNull()
    expect(summary.legistarRequests).toBe(0)
    // It pulled, so the next run starts on the new code.
    expect(await sh(work, 'rev-parse', 'HEAD')).toBe(await sh(other, 'rev-parse', 'HEAD'))
  })
})
