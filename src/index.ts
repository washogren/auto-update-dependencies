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
  autoMerge: boolean
  autoMergeWhenSemver: SemverChange[]
}

export interface Outputs {
  changed: boolean
  current?: string
  latest?: string
  shouldAutoMerge?: boolean
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
  const npmCtx: NpmContext = { cwd: deps.cwd, env: envFromProcess(npmRegistryEnv(inputs)) }

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
      shouldAutoMerge: shouldAutoMerge(current, latest, inputs),
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

// Build the npm config env vars for every npm invocation. The action only ever
// needs a SCOPED association to the (possibly private) registry, never a global
// default: setting `npm_config_registry` makes that registry the default for
// EVERY package, so public deps like `aws-cdk-lib` get resolved against it and
// 404. Instead we bind only `@scope:registry` and the host auth token, leaving
// the default registry (registry.npmjs.org) untouched.
//
// npm reads config from env vars named `npm_config_<key>`, where <key> is the
// literal .npmrc key — including `@scope:registry` and `//host/:_authToken`.
// (The earlier `npm_config_<scope>_registry` form was silently ignored by npm.)
export function npmRegistryEnv(inputs: Inputs): Record<string, string> {
  const env: Record<string, string> = { NODE_AUTH_TOKEN: inputs.token }
  if (inputs.scope) {
    const scope = inputs.scope.startsWith('@') ? inputs.scope : `@${inputs.scope}`
    env[`npm_config_${scope}:registry`] = inputs.registry
    env[`npm_config_${registryAuthKey(inputs.registry)}`] = inputs.token
  }
  return env
}

// Derive the .npmrc auth key for a registry URL: the host + path with the
// protocol stripped and a trailing slash, e.g.
// https://npm.pkg.github.com -> //npm.pkg.github.com/:_authToken
export function registryAuthKey(registry: string): string {
  const withoutProtocol = registry.replace(/^https?:/, '').replace(/\/+$/, '')
  return `${withoutProtocol}/:_authToken`
}

export type SemverChange = 'major' | 'minor' | 'patch'

const SEMVER_CHANGES: readonly SemverChange[] = ['major', 'minor', 'patch']

// Match major.minor.patch with an optional prerelease and/or build segment.
// Only the core X.Y.Z is captured; the prerelease/build tail is intentionally
// ignored (see classifySemverChange).
const SEMVER_CORE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/

// Parse the auto-merge-when-semver input: a comma/whitespace-separated list of
// major/minor/patch. Throws on any unrecognized token so a typo fails loudly
// rather than silently narrowing what auto-merges.
export function parseAutoMergeWhenSemver(raw: string): SemverChange[] {
  const tokens = raw
    .split(/[\s,]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0)
  const seen = new Set<SemverChange>()
  for (const token of tokens) {
    if (!SEMVER_CHANGES.includes(token as SemverChange)) {
      throw new Error(
        `Invalid 'auto-merge-when-semver' value '${token}'. ` +
          `Expected a comma-separated list of: ${SEMVER_CHANGES.join(', ')}.`
      )
    }
    seen.add(token as SemverChange)
  }
  return SEMVER_CHANGES.filter((c) => seen.has(c))
}

// Classify a version bump as major/minor/patch by comparing the core X.Y.Z.
// A prerelease-only change (same core, e.g. 1.0.2-dev.11 -> 1.0.2-dev.12) is a
// patch: the dist-tag is what pins dev/staging/prod, so the prerelease segment
// is noise below the patch level. Throws if either version is not semver, since
// classification is impossible without it.
export function classifySemverChange(prev: string, next: string): SemverChange {
  const prevMatch = SEMVER_CORE.exec(prev)
  const nextMatch = SEMVER_CORE.exec(next)
  if (!prevMatch || !nextMatch) {
    const offender = !prevMatch ? prev : next
    throw new Error(
      `Cannot classify the semver change: version '${offender}' is not in major.minor.patch form. ` +
        `'auto-merge-when-semver' requires both the pinned and resolved versions to be valid semver.`
    )
  }
  const [, prevMajor, prevMinor] = prevMatch
  const [, nextMajor, nextMinor] = nextMatch
  if (prevMajor !== nextMajor) return 'major'
  if (prevMinor !== nextMinor) return 'minor'
  return 'patch'
}

// Decide whether the bump from prev -> next should auto-merge, given the inputs.
// - auto-merge off        -> never
// - no semver filter set  -> always (no semver enforcement)
// - semver filter set     -> only when the classified change is in the filter
//                            (throws via classifySemverChange if not semver)
export function shouldAutoMerge(prev: string, next: string, inputs: Inputs): boolean {
  if (!inputs.autoMerge) return false
  if (inputs.autoMergeWhenSemver.length === 0) return true
  const change = classifySemverChange(prev, next)
  return inputs.autoMergeWhenSemver.includes(change)
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
  if (outputs.shouldAutoMerge !== undefined) core.setOutput('should-auto-merge', String(outputs.shouldAutoMerge))
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
    token: core.getInput('token', { required: true }),
    autoMerge: core.getBooleanInput('auto-merge'),
    autoMergeWhenSemver: parseAutoMergeWhenSemver(core.getInput('auto-merge-when-semver'))
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
