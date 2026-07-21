import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { readPinnedVersion } from './consumer.js'
import type { AssociatedPr, CommitWithPrs } from './dependency.js'
import {
  classifySemverChange,
  npmRegistryEnv,
  parseAutoMergeWhenSemver,
  parseSemverList,
  readBooleanInput,
  readInput,
  registryAuthKey,
  run,
  shouldAutoMerge,
  shouldCreatePr,
  slugForBranch,
  type Deps,
  type Inputs
} from './index.js'

const baseInputs: Inputs = {
  package: '@your-org/your-dependency',
  tag: 'dev',
  registry: 'https://npm.pkg.github.com',
  scope: '@your-org',
  token: 'fake-token',
  autoMerge: false,
  autoMergeWhenSemver: [],
  createPrWhenSemver: []
}

function commit(sha: string, message: string, prs: AssociatedPr[] = []): CommitWithPrs {
  return { sha, message, prs }
}

interface Harness {
  deps: Deps
  cwd: string
  installed: string[]
  written: Map<string, string>
  logs: string[]
}

async function makeHarness(overrides: Partial<Deps> = {}): Promise<Harness> {
  const cwd = await mkdtemp(join(tmpdir(), 'aud-test-'))
  const runnerTemp = await mkdtemp(join(tmpdir(), 'aud-runner-'))
  const installed: string[] = []
  const written = new Map<string, string>()
  const logs: string[] = []

  const deps: Deps = {
    cwd,
    runnerTemp,
    readPinnedVersion: vi.fn(async () => '1.0.0-prod.1'),
    readDistTag: vi.fn(async () => '1.0.2-dev.12'),
    readGitHead: vi.fn(async (_pkg, version) =>
      version === '1.0.0-prod.1'
        ? '0173b3fcf5121eed49a3d8ffa3fe839b5ff619e0'
        : 'e4360ace6470bc5b46e1ea98e65a695fd7cca3ed'
    ),
    readRepositoryUrl: vi.fn(async () => 'git+https://github.com/your-org/your-dependency.git'),
    installExact: vi.fn(async (pkg, version) => {
      installed.push(`${pkg}@${version}`)
    }),
    fetchCommitsWithPrs: vi.fn(async () => []),
    writeFile: vi.fn(async (path, contents) => {
      written.set(path, contents)
    }),
    log: vi.fn((msg) => {
      logs.push(msg)
    }),
    ...overrides
  }
  return { deps, cwd, installed, written, logs }
}

let cleanupPaths: string[] = []
beforeEach(() => {
  cleanupPaths = []
})
afterEach(async () => {
  for (const p of cleanupPaths) {
    await rm(p, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Failure cases — every "we couldn't continue" path throws with context.
// ---------------------------------------------------------------------------

describe('run — package.json missing', () => {
  it('throws with the package name and cwd when the dependency is not pinned', async () => {
    const { deps, cwd } = await makeHarness({
      readPinnedVersion: vi.fn(async () => null)
    })
    cleanupPaths.push(cwd, deps.runnerTemp)
    await expect(run(baseInputs, deps)).rejects.toThrow(
      new RegExp(`Could not find @your-org/your-dependency.*${cwd.replace(/\//g, '\\/')}`)
    )
    expect(deps.installExact).not.toHaveBeenCalled()
  })
})

describe('run — dist-tag not found', () => {
  it('throws with the package, tag, and registry when the dist-tag is missing', async () => {
    const { deps, cwd, installed, written } = await makeHarness({
      readDistTag: vi.fn(async () => null)
    })
    cleanupPaths.push(cwd, deps.runnerTemp)
    await expect(run(baseInputs, deps)).rejects.toThrow(
      /dist-tag 'dev' is not set on @your-org\/your-dependency in registry https:\/\/npm\.pkg\.github\.com/
    )
    expect(installed).toEqual([])
    expect(written.size).toBe(0)
  })
})

describe('run — repository.url missing', () => {
  it('throws naming the package@version that lacked the field', async () => {
    const { deps, cwd } = await makeHarness({
      readRepositoryUrl: vi.fn(async () => null)
    })
    cleanupPaths.push(cwd, deps.runnerTemp)
    await expect(run(baseInputs, deps)).rejects.toThrow(
      /@your-org\/your-dependency@1\.0\.2-dev\.12 has no 'repository\.url' field/
    )
  })
})

describe('run — gitHead missing', () => {
  it('throws naming the previous version when its gitHead is missing', async () => {
    const { deps, cwd } = await makeHarness({
      readGitHead: vi.fn(async (_pkg, version) =>
        version === '1.0.2-dev.12' ? 'e4360ace6470bc5b46e1ea98e65a695fd7cca3ed' : null
      )
    })
    cleanupPaths.push(cwd, deps.runnerTemp)
    await expect(run(baseInputs, deps)).rejects.toThrow(
      /@your-org\/your-dependency@1\.0\.0-prod\.1.*previously pinned.*gitHead/
    )
  })

  it('throws naming the new version when its gitHead is missing', async () => {
    const { deps, cwd } = await makeHarness({
      readGitHead: vi.fn(async (_pkg, version) =>
        version === '1.0.0-prod.1' ? '0173b3fcf5121eed49a3d8ffa3fe839b5ff619e0' : null
      )
    })
    cleanupPaths.push(cwd, deps.runnerTemp)
    await expect(run(baseInputs, deps)).rejects.toThrow(
      /@your-org\/your-dependency@1\.0\.2-dev\.12.*new version.*gitHead/
    )
  })
})

describe('run — fetchCommitsWithPrs throws', () => {
  it('propagates the underlying error rather than silently degrading the body', async () => {
    const { deps, cwd, written } = await makeHarness({
      fetchCommitsWithPrs: vi.fn(async () => {
        throw new Error('Bad credentials (HTTP 401)')
      })
    })
    cleanupPaths.push(cwd, deps.runnerTemp)
    await expect(run(baseInputs, deps)).rejects.toThrow(/Bad credentials \(HTTP 401\)/)
    expect(written.size).toBe(0)
  })
})

describe('run — non-github repository', () => {
  it('propagates the descriptive error from extractGitHubSlug', async () => {
    const { deps, cwd } = await makeHarness({
      readRepositoryUrl: vi.fn(async () => 'git+https://gitlab.com/foo/bar.git')
    })
    cleanupPaths.push(cwd, deps.runnerTemp)
    await expect(run(baseInputs, deps)).rejects.toThrow(/Could not extract a GitHub.*gitlab\.com/)
  })
})

// ---------------------------------------------------------------------------
// Success cases
// ---------------------------------------------------------------------------

describe('run — already at latest', () => {
  it('skips when the pinned version equals the dist-tag head', async () => {
    const { deps, cwd, installed } = await makeHarness({
      readPinnedVersion: vi.fn(async () => '1.0.2-dev.12'),
      readDistTag: vi.fn(async () => '1.0.2-dev.12')
    })
    cleanupPaths.push(cwd, deps.runnerTemp)
    const result = await run(baseInputs, deps)
    expect(result.outputs).toMatchObject({
      changed: false,
      current: '1.0.2-dev.12',
      latest: '1.0.2-dev.12'
    })
    expect(installed).toEqual([])
  })
})

describe('run — happy path', () => {
  it('installs, renders, writes the body file, and emits the full output set', async () => {
    const commits: CommitWithPrs[] = [commit('a'.repeat(40), 'oldest'), commit('b'.repeat(40), 'newest')]
    const { deps, cwd, installed, written } = await makeHarness({
      fetchCommitsWithPrs: vi.fn(async () => commits)
    })
    cleanupPaths.push(cwd, deps.runnerTemp)

    const result = await run(baseInputs, deps)

    expect(result.outputs).toMatchObject({
      changed: true,
      current: '1.0.0-prod.1',
      latest: '1.0.2-dev.12',
      prTitle: 'Bump @your-org/your-dependency to 1.0.2-dev.12 (dev)',
      prBranch: 'auto-update/your-org-your-dependency-dev',
      prCommitMessage: 'Track @your-org/your-dependency dev -> 1.0.2-dev.12'
    })
    expect(result.outputs.prBodyPath).toMatch(/auto-update-pr-body\.md$/)

    expect(installed).toEqual(['@your-org/your-dependency@1.0.2-dev.12'])

    const writtenBody = written.get(result.outputs.prBodyPath!)
    expect(writtenBody).toBeDefined()
    expect(writtenBody).toContain('[`@your-org/your-dependency`](https://github.com/your-org/your-dependency)')
    expect(writtenBody).toContain('newest')
    expect(writtenBody).toContain('oldest')
  })

  it('emits shouldAutoMerge from the auto-merge inputs and the classified bump', async () => {
    const { deps, cwd } = await makeHarness({
      // 1.0.0-prod.1 -> 1.0.2-dev.12 is a patch bump (core 1.0.0 -> 1.0.2).
      readPinnedVersion: vi.fn(async () => '1.0.0-prod.1'),
      readDistTag: vi.fn(async () => '1.0.2-dev.12')
    })
    cleanupPaths.push(cwd, deps.runnerTemp)

    const patchAllowed = await run({ ...baseInputs, autoMerge: true, autoMergeWhenSemver: ['patch'] }, deps)
    expect(patchAllowed.outputs.shouldAutoMerge).toBe(true)

    const minorOnly = await run({ ...baseInputs, autoMerge: true, autoMergeWhenSemver: ['minor'] }, deps)
    expect(minorOnly.outputs.shouldAutoMerge).toBe(false)

    const off = await run({ ...baseInputs, autoMerge: false }, deps)
    expect(off.outputs.shouldAutoMerge).toBe(false)
  })

  it('short-circuits before install when the bump type is excluded by create-pr-when-semver', async () => {
    // 1.0.0-prod.1 -> 2.0.0-dev.1 is a MAJOR bump; with create-pr-when-semver
    // = [patch, minor] it must NOT create a PR, NOT install, and NOT render a
    // body — but still report changed + the classified type for observability.
    const { deps, cwd, installed, written } = await makeHarness({
      readPinnedVersion: vi.fn(async () => '1.0.0-prod.1'),
      readDistTag: vi.fn(async () => '2.0.0-dev.1')
    })
    cleanupPaths.push(cwd, deps.runnerTemp)

    const result = await run({ ...baseInputs, createPrWhenSemver: ['patch', 'minor'] }, deps)

    expect(result.outputs).toMatchObject({
      changed: true,
      current: '1.0.0-prod.1',
      latest: '2.0.0-dev.1',
      semverChange: 'major',
      shouldCreatePr: false,
      shouldAutoMerge: false
    })
    expect(result.outputs.prBodyPath).toBeUndefined()
    expect(installed).toEqual([]) // no install for an excluded bump
    expect(written.size).toBe(0) // no changelog body rendered
  })

  it('creates the PR (shouldCreatePr true) when the bump type is included', async () => {
    // patch bump, create-pr-when-semver includes patch -> full PR path.
    const { deps, cwd, installed } = await makeHarness({
      readPinnedVersion: vi.fn(async () => '1.0.0-prod.1'),
      readDistTag: vi.fn(async () => '1.0.2-dev.12')
    })
    cleanupPaths.push(cwd, deps.runnerTemp)

    const result = await run({ ...baseInputs, createPrWhenSemver: ['patch', 'minor'] }, deps)
    expect(result.outputs).toMatchObject({ changed: true, semverChange: 'patch', shouldCreatePr: true })
    expect(installed).toEqual(['@your-org/your-dependency@1.0.2-dev.12'])
  })

  it('writes the rendered body to a real file when writeFile is the real impl', async () => {
    const realCwd = await mkdtemp(join(tmpdir(), 'aud-real-'))
    const realRunnerTemp = await mkdtemp(join(tmpdir(), 'aud-real-runner-'))
    cleanupPaths.push(realCwd, realRunnerTemp)
    await writeFile(
      join(realCwd, 'package.json'),
      JSON.stringify({
        name: 'consumer',
        dependencies: { '@your-org/your-dependency': '1.0.0-prod.1' }
      })
    )

    const { deps } = await makeHarness({
      cwd: realCwd,
      runnerTemp: realRunnerTemp,
      readPinnedVersion,
      writeFile: (path, contents) => writeFile(path, contents, 'utf8'),
      fetchCommitsWithPrs: vi.fn(async () => [commit('a'.repeat(40), 'subject\n\ndetails')])
    })

    const result = await run(baseInputs, deps)
    const onDisk = await readFile(result.outputs.prBodyPath!, 'utf8')
    expect(onDisk).toContain('| Package | Tag | Previous | New |')
    expect(onDisk).toContain('subject')
    expect(onDisk).toContain('<details>')
  })
})

describe('slugForBranch', () => {
  it('strips the leading @ and replaces the / so a scoped name becomes branch-safe', () => {
    expect(slugForBranch('@your-org/your-dependency')).toBe('your-org-your-dependency')
  })

  it('passes through an unscoped name unchanged', () => {
    expect(slugForBranch('lodash')).toBe('lodash')
  })

  it('replaces other branch-unsafe characters with hyphens', () => {
    expect(slugForBranch('@scope/foo bar~baz')).toBe('scope-foo-bar-baz')
  })
})

describe('readInput / readBooleanInput', () => {
  // These read process.env directly rather than via core.getInput, because
  // core.getInput('foo-bar') maps to INPUT_FOO-BAR (hyphen preserved) while
  // action.yml sets INPUT_FOO_BAR (hyphen -> underscore). This is a regression
  // guard for that exact mismatch: a hyphenated input must resolve.
  const saved: Record<string, string | undefined> = {}
  const keys = ['INPUT_AUTO_MERGE', 'INPUT_AUTO_MERGE_WHEN_SEMVER', 'INPUT_NPM_SCOPE', 'INPUT_PACKAGE']
  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('reads a hyphenated input from its underscore INPUT_ env var', () => {
    process.env['INPUT_NPM_SCOPE'] = '@qsrsoft'
    expect(readInput('npm-scope')).toBe('@qsrsoft')
  })

  it('reads a multi-hyphen input name', () => {
    process.env['INPUT_AUTO_MERGE_WHEN_SEMVER'] = 'minor, patch'
    expect(readInput('auto-merge-when-semver')).toBe('minor, patch')
  })

  it('trims whitespace and returns empty string for an unset input', () => {
    process.env['INPUT_PACKAGE'] = '  @scope/pkg  '
    expect(readInput('package')).toBe('@scope/pkg')
    expect(readInput('npm-scope')).toBe('')
  })

  it('throws for a required input that is unset', () => {
    expect(() => readInput('package', { required: true })).toThrow(/Input required and not supplied: package/)
  })

  it('defaults an unset boolean input to false instead of throwing', () => {
    // This is the exact production failure: getBooleanInput threw the "Core
    // Schema" error on the empty string it got from the name mismatch.
    expect(readBooleanInput('auto-merge')).toBe(false)
  })

  it('parses the true/false vocabulary case-insensitively', () => {
    for (const t of ['true', 'True', 'TRUE']) {
      process.env['INPUT_AUTO_MERGE'] = t
      expect(readBooleanInput('auto-merge')).toBe(true)
    }
    for (const f of ['false', 'False', 'FALSE']) {
      process.env['INPUT_AUTO_MERGE'] = f
      expect(readBooleanInput('auto-merge')).toBe(false)
    }
  })

  it('throws on a non-boolean value', () => {
    process.env['INPUT_AUTO_MERGE'] = 'yes'
    expect(() => readBooleanInput('auto-merge')).toThrow(/does not meet the boolean specification/)
  })
})

describe('registryAuthKey', () => {
  it('strips the protocol and trailing slash and appends :_authToken', () => {
    expect(registryAuthKey('https://npm.pkg.github.com')).toBe('//npm.pkg.github.com/:_authToken')
    expect(registryAuthKey('https://npm.pkg.github.com/')).toBe('//npm.pkg.github.com/:_authToken')
    expect(registryAuthKey('http://localhost:4873')).toBe('//localhost:4873/:_authToken')
  })
})

describe('npmRegistryEnv', () => {
  const inputs: Inputs = {
    package: '@qsrsoft/qsr-data-model',
    tag: 'latest',
    registry: 'https://npm.pkg.github.com',
    scope: '@qsrsoft',
    token: 'secret-token',
    autoMerge: false,
    autoMergeWhenSemver: [],
    createPrWhenSemver: []
  }

  it('binds only the scoped registry, never the global default', () => {
    // Setting npm_config_registry would make the private registry the default
    // for every package, so public deps like aws-cdk-lib resolve against it and
    // 404. The action must only associate the scope.
    const env = npmRegistryEnv(inputs)
    expect(env['npm_config_registry']).toBeUndefined()
    expect(env['npm_config_@qsrsoft:registry']).toBe('https://npm.pkg.github.com')
  })

  it('uses the literal @scope:registry key, not the underscore-mangled form npm ignores', () => {
    const env = npmRegistryEnv(inputs)
    // The old `npm_config_<scope>_registry` form was silently unrecognized.
    expect(env['npm_config_qsrsoft_registry']).toBeUndefined()
    expect(Object.keys(env)).toContain('npm_config_@qsrsoft:registry')
  })

  it('binds the auth token to the registry host', () => {
    const env = npmRegistryEnv(inputs)
    expect(env['NODE_AUTH_TOKEN']).toBe('secret-token')
    expect(env['npm_config_//npm.pkg.github.com/:_authToken']).toBe('secret-token')
  })

  it('normalizes a bare scope without a leading @', () => {
    const env = npmRegistryEnv({ ...inputs, scope: 'qsrsoft' })
    expect(env['npm_config_@qsrsoft:registry']).toBe('https://npm.pkg.github.com')
  })

  it('sets only the auth token (no registry binding) when no scope is given', () => {
    // Without a scope there is nothing to associate; we still forward the token
    // via NODE_AUTH_TOKEN but must not touch registry config at all.
    const env = npmRegistryEnv({ ...inputs, scope: '' })
    expect(env['NODE_AUTH_TOKEN']).toBe('secret-token')
    expect(Object.keys(env).some((k) => k.startsWith('npm_config_'))).toBe(false)
  })
})

describe('parseAutoMergeWhenSemver', () => {
  it('returns an empty list for an empty or whitespace-only input', () => {
    expect(parseAutoMergeWhenSemver('')).toEqual([])
    expect(parseAutoMergeWhenSemver('   ')).toEqual([])
  })

  it('parses a comma-separated list, tolerating whitespace and case', () => {
    expect(parseAutoMergeWhenSemver('major, Minor,  PATCH')).toEqual(['major', 'minor', 'patch'])
  })

  it('deduplicates and normalizes to major/minor/patch order regardless of input order', () => {
    expect(parseAutoMergeWhenSemver('patch, patch, major')).toEqual(['major', 'patch'])
  })

  it('throws on an unrecognized token rather than silently dropping it', () => {
    expect(() => parseAutoMergeWhenSemver('minor, prerelease')).toThrow(
      /Invalid 'auto-merge-when-semver' value 'prerelease'/
    )
  })
})

describe('classifySemverChange', () => {
  it('classifies a major, minor, and patch bump', () => {
    expect(classifySemverChange('1.2.3', '2.0.0')).toBe('major')
    expect(classifySemverChange('1.2.3', '1.3.0')).toBe('minor')
    expect(classifySemverChange('1.2.3', '1.2.4')).toBe('patch')
  })

  it('treats a prerelease-only bump (same core) as patch', () => {
    expect(classifySemverChange('1.0.2-dev.11', '1.0.2-dev.12')).toBe('patch')
  })

  it('prioritizes the most significant differing segment', () => {
    // Major differs even though minor/patch also change.
    expect(classifySemverChange('1.9.9', '2.0.0')).toBe('major')
  })

  it('throws naming the offending version when either side is not semver', () => {
    expect(() => classifySemverChange('1.2', '1.3.0')).toThrow(/version '1\.2' is not in major\.minor\.patch form/)
    expect(() => classifySemverChange('1.2.3', 'latest')).toThrow(/version 'latest' is not in major\.minor\.patch form/)
  })
})

describe('shouldAutoMerge', () => {
  const withAutoMerge = (semver: Inputs['autoMergeWhenSemver']): Inputs => ({
    ...baseInputs,
    autoMerge: true,
    autoMergeWhenSemver: semver
  })

  it('is false when auto-merge is off, regardless of the semver filter', () => {
    expect(shouldAutoMerge('1.0.0', '2.0.0', { ...baseInputs, autoMerge: false })).toBe(false)
  })

  it('is true for any bump when auto-merge is on and no semver filter is set', () => {
    // Non-semver versions are allowed through unclassified when the filter is empty.
    expect(shouldAutoMerge('1.0.0-dev.1', 'weird-tag', withAutoMerge([]))).toBe(true)
  })

  it('merges only when the classified change is in the filter', () => {
    expect(shouldAutoMerge('1.0.0', '1.0.1', withAutoMerge(['patch']))).toBe(true)
    expect(shouldAutoMerge('1.0.0', '1.1.0', withAutoMerge(['patch']))).toBe(false)
    expect(shouldAutoMerge('1.0.0', '2.0.0', withAutoMerge(['minor', 'patch']))).toBe(false)
    expect(shouldAutoMerge('1.0.0', '1.1.0', withAutoMerge(['minor', 'patch']))).toBe(true)
  })

  it('throws when the filter is set but a version is not semver', () => {
    expect(() => shouldAutoMerge('1.0.0', 'latest', withAutoMerge(['patch']))).toThrow(
      /not in major\.minor\.patch form/
    )
  })
})

describe('shouldCreatePr', () => {
  const withFilter = (semver: Inputs['createPrWhenSemver']): Inputs => ({
    ...baseInputs,
    createPrWhenSemver: semver
  })

  it('creates a PR for any bump when no filter is set (default)', () => {
    expect(shouldCreatePr('1.0.0-dev.1', 'weird-tag', withFilter([]))).toBe(true)
  })

  it('creates a PR only when the classified change is in the filter', () => {
    expect(shouldCreatePr('1.0.0', '1.0.1', withFilter(['patch', 'minor']))).toBe(true)
    expect(shouldCreatePr('1.0.0', '1.1.0', withFilter(['patch', 'minor']))).toBe(true)
    // Major excluded — left for manual handling.
    expect(shouldCreatePr('1.0.0', '2.0.0', withFilter(['patch', 'minor']))).toBe(false)
  })

  it('throws when the filter is set but a version is not semver', () => {
    expect(() => shouldCreatePr('1.0.0', 'latest', withFilter(['patch']))).toThrow(/not in major\.minor\.patch form/)
  })
})

describe('parseSemverList', () => {
  it('names the offending input in the error message', () => {
    expect(() => parseSemverList('major, bogus', 'create-pr-when-semver')).toThrow(
      /Invalid 'create-pr-when-semver' value 'bogus'/
    )
  })

  it('normalizes and dedupes regardless of order/case/whitespace', () => {
    expect(parseSemverList('PATCH, major,  patch', 'x')).toEqual(['major', 'patch'])
    expect(parseSemverList('', 'x')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// action.yml schema — guards the composite contract
// ---------------------------------------------------------------------------

interface CompositeStep {
  name?: string
  id?: string
  uses?: string
  shell?: string
  run?: string
  if?: string
  with?: Record<string, string>
  env?: Record<string, string>
}

interface ActionYml {
  name: string
  description: string
  inputs: Record<string, { description: string; required?: boolean; default?: string }>
  outputs: Record<string, { description: string; value: string }>
  runs: { using: string; steps: CompositeStep[] }
}

const here = dirname(fileURLToPath(import.meta.url))
const actionYmlPath = join(here, '..', 'action.yml')

async function loadActionYml(): Promise<ActionYml> {
  return parse(await readFile(actionYmlPath, 'utf8')) as ActionYml
}

describe('action.yml — composite shape', () => {
  it('declares using: composite', async () => {
    const yml = await loadActionYml()
    expect(yml.runs.using).toBe('composite')
  })

  it('runs setup-node before the bump and peter-evans after', async () => {
    const yml = await loadActionYml()
    const steps = yml.runs.steps
    const idx = (matcher: (s: CompositeStep) => boolean) => steps.findIndex(matcher)
    const setupIdx = idx((s) => (s.uses ?? '').startsWith('actions/setup-node'))
    const bumpIdx = idx((s) => s.id === 'bump')
    const cprIdx = idx((s) => (s.uses ?? '').startsWith('peter-evans/create-pull-request'))
    expect(setupIdx).toBeGreaterThanOrEqual(0)
    expect(bumpIdx).toBeGreaterThan(setupIdx)
    expect(cprIdx).toBeGreaterThan(bumpIdx)
  })

  it('only runs peter-evans when the bump step says a PR should be created', async () => {
    // should-create-pr subsumes changed: it's only 'true' on the changed path
    // where the bump type passes create-pr-when-semver.
    const yml = await loadActionYml()
    const cpr = yml.runs.steps.find((s) => (s.uses ?? '').startsWith('peter-evans/create-pull-request'))
    expect(cpr).toBeDefined()
    expect(cpr!.if).toMatch(/steps\.bump\.outputs\.should-create-pr\s*==\s*'true'/)
  })
})

describe('action.yml — input/env mapping', () => {
  it('maps each declared input to an INPUT_* env var on the bump step', async () => {
    const yml = await loadActionYml()
    const bump = yml.runs.steps.find((s) => s.id === 'bump')
    expect(bump).toBeDefined()
    const env = bump!.env ?? {}

    // core.getInput('foo-bar') reads INPUT_FOO_BAR — uppercase, hyphens become underscores.
    const required = [
      'INPUT_PACKAGE',
      'INPUT_TAG',
      'INPUT_NPM_REGISTRY',
      'INPUT_NPM_SCOPE',
      'INPUT_TOKEN',
      'INPUT_AUTO_MERGE',
      'INPUT_AUTO_MERGE_WHEN_SEMVER',
      'INPUT_CREATE_PR_WHEN_SEMVER'
    ]
    for (const key of required) {
      expect(env[key], `missing env mapping: ${key}`).toBeDefined()
    }
  })

  it('forwards the token as NODE_AUTH_TOKEN so npm view authenticates', async () => {
    const yml = await loadActionYml()
    const bump = yml.runs.steps.find((s) => s.id === 'bump')
    expect(bump!.env!['NODE_AUTH_TOKEN']).toBeDefined()
  })
})

describe('action.yml — peter-evans wiring', () => {
  it('passes the bump step outputs into peter-evans inputs', async () => {
    const yml = await loadActionYml()
    const cpr = yml.runs.steps.find((s) => (s.uses ?? '').startsWith('peter-evans/create-pull-request'))
    const inputs = cpr!.with!
    expect(inputs['title']).toContain('steps.bump.outputs.pr-title')
    expect(inputs['branch']).toContain('steps.bump.outputs.pr-branch')
    expect(inputs['commit-message']).toContain('steps.bump.outputs.pr-commit-message')
    expect(inputs['body-path']).toContain('steps.bump.outputs.pr-body-path')
  })

  it('falls back to github.ref_name when base-branch input is empty', async () => {
    const yml = await loadActionYml()
    const cpr = yml.runs.steps.find((s) => (s.uses ?? '').startsWith('peter-evans/create-pull-request'))
    expect(cpr!.with!['base']).toMatch(/inputs\.base-branch\s*\|\|\s*github\.ref_name/)
  })
})

describe('action.yml — auto-merge', () => {
  it('runs an auto-merge step after peter-evans, gated on created + auto-merge', async () => {
    const yml = await loadActionYml()
    const steps = yml.runs.steps
    const cprIdx = steps.findIndex((s) => (s.uses ?? '').startsWith('peter-evans/create-pull-request'))
    const mergeIdx = steps.findIndex((s) => (s.run ?? '').includes('gh pr merge'))
    expect(mergeIdx).toBeGreaterThan(cprIdx)
    const merge = steps[mergeIdx]
    expect(merge.if).toMatch(/steps\.cpr\.outputs\.pull-request-operation\s*==\s*'created'/)
    // The bump step computes the semver-aware decision; the gate defers to it
    // rather than re-checking inputs.auto-merge directly.
    expect(merge.if).toMatch(/steps\.bump\.outputs\.should-auto-merge\s*==\s*'true'/)
  })

  it('comments before merging and honors the configured merge method', async () => {
    const yml = await loadActionYml()
    const merge = yml.runs.steps.find((s) => (s.run ?? '').includes('gh pr merge'))
    const run = merge!.run!
    // Comment must precede the merge enable.
    expect(run.indexOf('gh pr comment')).toBeGreaterThanOrEqual(0)
    expect(run.indexOf('gh pr comment')).toBeLessThan(run.indexOf('gh pr merge'))
    expect(run).toContain('--auto')
    expect(run).toContain('$MERGE_METHOD')
  })
})

describe('action.yml — outputs', () => {
  it('exposes pr-number, pr-url, and pr-operation from peter-evans', async () => {
    const yml = await loadActionYml()
    expect(yml.outputs['pr-number'].value).toContain('steps.cpr.outputs.pull-request-number')
    expect(yml.outputs['pr-url'].value).toContain('steps.cpr.outputs.pull-request-url')
    expect(yml.outputs['pr-operation'].value).toContain('steps.cpr.outputs.pull-request-operation')
  })

  it('passes through the bump step outputs (changed, current, latest, semver-change, should-create-pr)', async () => {
    const yml = await loadActionYml()
    expect(yml.outputs['changed'].value).toContain('steps.bump.outputs.changed')
    expect(yml.outputs['current'].value).toContain('steps.bump.outputs.current')
    expect(yml.outputs['latest'].value).toContain('steps.bump.outputs.latest')
    expect(yml.outputs['semver-change'].value).toContain('steps.bump.outputs.semver-change')
    expect(yml.outputs['should-create-pr'].value).toContain('steps.bump.outputs.should-create-pr')
  })
})
