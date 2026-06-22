import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as core from '@actions/core'
import { renderChangelog } from './changelog.js'
import { installExact, readPinnedVersion } from './consumer.js'
import {
  envFromProcess,
  extractGitHubSlug,
  fetchCommitsWithPrs,
  normalizeRepoUrl,
  readDistTag,
  readGitHead,
  readRepositoryUrl,
  type CommitWithPrs,
  type NpmContext
} from './dependency.js'

export interface Inputs {
  package: string
  tag: string
  registry: string
  scope: string
  token: string
}

export interface Outputs {
  changed: boolean
  current?: string
  latest?: string
  prTitle?: string
  prBranch?: string
  prCommitMessage?: string
  prBodyPath?: string
}

export interface Deps {
  cwd: string
  runnerTemp: string
  readPinnedVersion(cwd: string, pkg: string): Promise<string | null>
  readDistTag(pkg: string, tag: string, ctx: NpmContext): Promise<string | null>
  readGitHead(pkg: string, version: string, ctx: NpmContext): Promise<string | null>
  readRepositoryUrl(pkg: string, version: string, ctx: NpmContext): Promise<string | null>
  installExact(pkg: string, version: string, ctx: NpmContext): Promise<void>
  fetchCommitsWithPrs(token: string, slug: string, prevSha: string, nextSha: string): Promise<CommitWithPrs[]>
  writeFile(path: string, contents: string): Promise<void>
  log(msg: string): void
}

export interface RunResult {
  outputs: Outputs
}

export async function run(inputs: Inputs, deps: Deps): Promise<RunResult> {
  const extra: Record<string, string> = {
    NODE_AUTH_TOKEN: inputs.token,
    npm_config_registry: inputs.registry
  }
  if (inputs.scope) {
    extra[`npm_config_${inputs.scope.replace(/^@/, '').replace(/-/g, '_')}_registry`] = inputs.registry
  }
  const npmCtx: NpmContext = { cwd: deps.cwd, env: envFromProcess(extra) }

  const current = await deps.readPinnedVersion(deps.cwd, inputs.package)
  if (!current) {
    throw new Error(`Could not find ${inputs.package} in package.json dependencies or devDependencies at ${deps.cwd}.`)
  }

  const latest = await deps.readDistTag(inputs.package, inputs.tag, npmCtx)
  if (!latest) {
    throw new Error(
      `dist-tag '${inputs.tag}' is not set on ${inputs.package} in registry ${inputs.registry}. ` +
        `Verify the tag exists ('npm dist-tag ls ${inputs.package}') and that the token has read access to the package.`
    )
  }

  if (current === latest) {
    deps.log(`Already at ${latest}. Nothing to do.`)
    return { outputs: { changed: false, current, latest } }
  }

  await deps.installExact(inputs.package, latest, npmCtx)

  const repoUrlRaw = await deps.readRepositoryUrl(inputs.package, latest, npmCtx)
  if (!repoUrlRaw) {
    throw new Error(
      `${inputs.package}@${latest} has no 'repository.url' field in its package metadata. ` +
        `The dependency must declare a GitHub repository URL so the changelog can link to its commits.`
    )
  }
  const repoUrl = normalizeRepoUrl(repoUrlRaw)
  const slug = extractGitHubSlug(repoUrl)

  const prevSha = await deps.readGitHead(inputs.package, current, npmCtx)
  if (!prevSha) {
    throw new Error(
      `${inputs.package}@${current} (the previously pinned version) has no 'gitHead' in its package metadata. ` +
        `gitHead is set automatically by 'npm publish' from a clean git checkout. ` +
        `If the version was unpublished and republished, or built from a dirty tree, the changelog cannot be generated.`
    )
  }
  const nextSha = await deps.readGitHead(inputs.package, latest, npmCtx)
  if (!nextSha) {
    throw new Error(
      `${inputs.package}@${latest} (the new version) has no 'gitHead' in its package metadata. ` +
        `gitHead is set automatically by 'npm publish' from a clean git checkout.`
    )
  }

  const commits = await deps.fetchCommitsWithPrs(inputs.token, slug, prevSha, nextSha)

  const body = renderChangelog(
    {
      package: inputs.package,
      tag: inputs.tag,
      prev: current,
      next: latest,
      prevSha,
      nextSha,
      repoUrl,
      slug
    },
    commits
  )

  const bodyPath = join(deps.runnerTemp, 'auto-update-pr-body.md')
  await deps.writeFile(bodyPath, body)

  return {
    outputs: {
      changed: true,
      current,
      latest,
      prTitle: `Bump ${inputs.package} to ${latest} (${inputs.tag})`,
      prBranch: `auto-update/${slugForBranch(inputs.package)}-${inputs.tag}`,
      prCommitMessage: `Track ${inputs.package} ${inputs.tag} -> ${latest}`,
      prBodyPath: bodyPath
    }
  }
}

export function slugForBranch(pkg: string): string {
  return pkg.replace(/^@/, '').replace(/[^A-Za-z0-9._-]/g, '-')
}

function realDeps(): Deps {
  const cwd = process.env.GITHUB_WORKSPACE ?? process.cwd()
  return {
    cwd,
    runnerTemp: process.env.RUNNER_TEMP ?? cwd,
    readPinnedVersion,
    readDistTag,
    readGitHead,
    readRepositoryUrl,
    installExact,
    fetchCommitsWithPrs,
    writeFile: (path, contents) => writeFile(path, contents, 'utf8'),
    log: (msg) => core.info(msg)
  }
}

function applyOutputs(outputs: Outputs): void {
  core.setOutput('changed', String(outputs.changed))
  if (outputs.current) core.setOutput('current', outputs.current)
  if (outputs.latest) core.setOutput('latest', outputs.latest)
  if (outputs.prTitle) core.setOutput('pr-title', outputs.prTitle)
  if (outputs.prBranch) core.setOutput('pr-branch', outputs.prBranch)
  if (outputs.prCommitMessage) core.setOutput('pr-commit-message', outputs.prCommitMessage)
  if (outputs.prBodyPath) core.setOutput('pr-body-path', outputs.prBodyPath)
}

async function main(): Promise<void> {
  const inputs: Inputs = {
    package: core.getInput('package', { required: true }),
    tag: core.getInput('tag', { required: true }),
    registry: core.getInput('npm-registry') || 'https://npm.pkg.github.com',
    scope: core.getInput('npm-scope'),
    token: core.getInput('token', { required: true })
  }
  const result = await run(inputs, realDeps())
  applyOutputs(result.outputs)
}

// Skip auto-execution under vitest so tests can import `run` without
// invoking the real harness.
if (process.env.VITEST !== 'true') {
  main().catch((err) => {
    // Print the full stack to the Actions log before failing the step, so a
    // reviewer can see exactly where the failure originated rather than just
    // the message.
    if (err instanceof Error && err.stack) {
      core.error(err.stack)
    }
    core.setFailed(err instanceof Error ? err.message : String(err))
  })
}
