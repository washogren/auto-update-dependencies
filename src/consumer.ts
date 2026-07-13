// Reads from and writes to the consumer's repository checkout: package.json
// inspection, and `npm install` of the new dependency version.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { exec } from '@actions/exec'
import type { NpmContext } from './dependency.js'

export async function readPinnedVersion(cwd: string, packageName: string): Promise<string | null> {
  const path = join(cwd, 'package.json')
  const raw = await readFile(path, 'utf8')
  const json = JSON.parse(raw) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  return json.dependencies?.[packageName] ?? json.devDependencies?.[packageName] ?? null
}

export async function installExact(pkg: string, version: string, ctx: NpmContext): Promise<void> {
  // Bumping a single pin only needs package.json rewritten and the lockfile
  // resolved — not the whole dependency tree downloaded and built. --save-exact
  // pins without a caret; --package-lock-only refreshes package.json + the
  // lockfile without populating node_modules; --ignore-scripts and --no-audit
  // avoid running arbitrary install scripts and the audit round-trip. This also
  // shrinks the blast radius: we no longer resolve every transitive public dep,
  // so an unrelated registry hiccup can't fail the bump.
  await exec(
    'npm',
    ['install', '--save-exact', '--package-lock-only', '--ignore-scripts', '--no-audit', `${pkg}@${version}`],
    {
      cwd: ctx.cwd,
      env: ctx.env
    }
  )
}
