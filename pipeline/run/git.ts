/** Thin wrappers over the git CLI for `consent run`. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export type TGitResult = { ok: boolean; stdout: string; stderr: string }

export async function tryGit(args: string[]): Promise<TGitResult> {
  try {
    const { stdout, stderr } = await exec('git', args, { maxBuffer: 64 * 1024 * 1024 })
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string }
    return { ok: false, stdout: e.stdout?.trim() ?? '', stderr: e.stderr?.trim() || e.message }
  }
}

export async function git(args: string[]): Promise<string> {
  const r = await tryGit(args)
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

const lines = (s: string): string[] => s.split('\n').filter(Boolean)

/** Paths under these that differ from HEAD, untracked files included. */
export const changedPaths = async (...paths: string[]): Promise<string[]> =>
  lines(await git(['status', '--porcelain', '--untracked-files=all', '--', ...paths]))

/** Tracked files modified anywhere in the work tree. */
export const trackedChanges = async (): Promise<string[]> =>
  lines(await git(['status', '--porcelain', '--untracked-files=no']))

export const hasUpstream = async (): Promise<boolean> =>
  (await tryGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).ok

export const head = (): Promise<string> => git(['rev-parse', 'HEAD'])
