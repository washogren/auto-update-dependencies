import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { readPinnedVersion } from './consumer.js'
import type { AssociatedPr, CommitWithPrs } from './dependency.js'
import { run, slugForBranch, type Deps, type Inputs } from './index.js'

const baseInputs: Inputs = {
  package: '@your-org/your-dependency',
  tag: 'dev',
  registry: 'https://npm.pkg.github.com',
  scope: '@your-org',
  token: 'fake-token'
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

  it('only runs peter-evans when the bump step reports changed', async () => {
    const yml = await loadActionYml()
    const cpr = yml.runs.steps.find((s) => (s.uses ?? '').startsWith('peter-evans/create-pull-request'))
    expect(cpr).toBeDefined()
    expect(cpr!.if).toMatch(/steps\.bump\.outputs\.changed\s*==\s*'true'/)
  })
})

describe('action.yml — input/env mapping', () => {
  it('maps each declared input to an INPUT_* env var on the bump step', async () => {
    const yml = await loadActionYml()
    const bump = yml.runs.steps.find((s) => s.id === 'bump')
    expect(bump).toBeDefined()
    const env = bump!.env ?? {}

    // core.getInput('foo-bar') reads INPUT_FOO_BAR — uppercase, hyphens become underscores.
    const required = ['INPUT_PACKAGE', 'INPUT_TAG', 'INPUT_NPM_REGISTRY', 'INPUT_NPM_SCOPE', 'INPUT_TOKEN']
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

describe('action.yml — outputs', () => {
  it('exposes pr-number, pr-url, and pr-operation from peter-evans', async () => {
    const yml = await loadActionYml()
    expect(yml.outputs['pr-number'].value).toContain('steps.cpr.outputs.pull-request-number')
    expect(yml.outputs['pr-url'].value).toContain('steps.cpr.outputs.pull-request-url')
    expect(yml.outputs['pr-operation'].value).toContain('steps.cpr.outputs.pull-request-operation')
  })

  it('passes through the bump step outputs (changed, current, latest)', async () => {
    const yml = await loadActionYml()
    expect(yml.outputs['changed'].value).toContain('steps.bump.outputs.changed')
    expect(yml.outputs['current'].value).toContain('steps.bump.outputs.current')
    expect(yml.outputs['latest'].value).toContain('steps.bump.outputs.latest')
  })
})
