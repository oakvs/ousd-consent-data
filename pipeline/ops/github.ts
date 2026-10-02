/** Read-only GitHub API calls for the standby and watchdog. The repo is public, so no token is needed. */
export const DEFAULT_REPO = 'oakvs/ousd-consent-data'
export const RUN_WORKFLOW = 'run.yml'

export type TWorkflowRun = {
  id: number
  status: string
  conclusion: string | null
  event: string
  created_at: string
  run_started_at?: string
  updated_at: string
  html_url: string
}

/** The latest runs of the scheduled workflow, newest first. */
export async function workflowRuns(repo: string = DEFAULT_REPO, workflow: string = RUN_WORKFLOW): Promise<TWorkflowRun[]> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs?per_page=30`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ousd-consent-standby',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${repo} ${workflow}: ${(await res.text()).slice(0, 200)}`)
  return ((await res.json()) as { workflow_runs: TWorkflowRun[] }).workflow_runs
}
