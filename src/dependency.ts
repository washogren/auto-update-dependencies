// Reads about the dependency package: registry metadata (dist-tags, gitHead,
// repository URL) via the npm CLI, and the dependency's git history via the
// GitHub API. Read-only with respect to all systems — no writes here.
//
// Failure policy:
//   * System errors (npm non-zero exit, GitHub API errors) bubble up as thrown
//     exceptions with the underlying stderr/message preserved.
//   * "Lookup miss" results (the field/tag genuinely isn't there but the tool
//     ran fine) return null. The orchestrator decides whether a miss is fatal
//     and throws a descriptive error with full context.

import { getExecOutput } from '@actions/exec'
import { getOctokit } from '@actions/github'

export interface NpmContext {
  cwd: string
  env: Record<string, string>
}

export function envFromProcess(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v
  }
  return { ...out, ...extra }
}

export async function readDistTag(pkg: string, tag: string, ctx: NpmContext): Promise<string | null> {
  // `npm dist-tag ls` is used instead of `npm view <pkg> dist-tags` because the
  // latter silently emits no output against GitHub Packages. A non-zero exit
  // (auth error, registry down, package missing) throws with stderr preserved.
  const result = await getExecOutput('npm', ['dist-tag', 'ls', pkg], {
    cwd: ctx.cwd,
    env: ctx.env,
    silent: true
  })
  for (const line of result.stdout.split('\n')) {
    const match = line.match(/^([^:]+):\s*(.+)$/)
    if (match && match[1] === tag) return match[2].trim()
  }
  return null
}

export async function readGitHead(pkg: string, version: string, ctx: NpmContext): Promise<string | null> {
  return readNpmField(`${pkg}@${version}`, 'gitHead', ctx)
}

export async function readRepositoryUrl(pkg: string, version: string, ctx: NpmContext): Promise<string | null> {
  // Pin to a specific version because the unpinned form returns empty against
  // GitHub Packages.
  return readNpmField(`${pkg}@${version}`, 'repository.url', ctx)
}

async function readNpmField(spec: string, field: string, ctx: NpmContext): Promise<string | null> {
  const result = await getExecOutput('npm', ['view', spec, field], {
    cwd: ctx.cwd,
    env: ctx.env,
    silent: true
  })
  const value = result.stdout.trim()
  return value.length > 0 ? value : null
}

export function normalizeRepoUrl(raw: string): string {
  return raw
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^git:\/\//, 'https://')
}

export function extractGitHubSlug(repoUrl: string): string {
  const match = repoUrl.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)/)
  if (!match) {
    throw new Error(
      `Could not extract a GitHub owner/repo slug from repository URL '${repoUrl}'. ` +
        `This action only supports dependencies hosted on github.com.`
    )
  }
  return match[1]
}

export interface AssociatedPr {
  number: number
  title: string
  html_url: string
  body: string | null
}

export interface CommitWithPrs {
  sha: string
  message: string
  prs: AssociatedPr[]
}

export async function fetchCommitsWithPrs(
  token: string,
  slug: string,
  prevSha: string,
  nextSha: string
): Promise<CommitWithPrs[]> {
  const [owner, repo] = slug.split('/')
  const octokit = getOctokit(token)

  const compare = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${prevSha}...${nextSha}`
  })

  const enriched: CommitWithPrs[] = []
  for (const c of compare.data.commits) {
    const res = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      owner,
      repo,
      commit_sha: c.sha
    })
    // The endpoint method's response type doesn't infer through .map under
    // moduleResolution: bundler with @octokit/plugin-rest-endpoint-methods v17,
    // so the element type is declared inline.
    const prs: AssociatedPr[] = (res.data as PrAssociation[]).map((pr) => ({
      number: pr.number,
      title: pr.title,
      html_url: pr.html_url,
      body: pr.body ?? null
    }))
    enriched.push({
      sha: c.sha,
      message: c.commit.message,
      prs
    })
  }
  return enriched
}

interface PrAssociation {
  number: number
  title: string
  html_url: string
  body: string | null
}
