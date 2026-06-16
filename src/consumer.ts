// Reads from and writes to the consumer's repository checkout: package.json
// inspection, and `npm install` of the new dependency version.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exec } from '@actions/exec';
import type { NpmContext } from './dependency.js';

export async function readPinnedVersion(
  cwd: string,
  packageName: string,
): Promise<string | null> {
  const path = join(cwd, 'package.json');
  const raw = await readFile(path, 'utf8');
  const json = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return (
    json.dependencies?.[packageName] ??
    json.devDependencies?.[packageName] ??
    null
  );
}

export async function installExact(
  pkg: string,
  version: string,
  ctx: NpmContext,
): Promise<void> {
  await exec('npm', ['install', '--save-exact', `${pkg}@${version}`], {
    cwd: ctx.cwd,
    env: ctx.env,
  });
}
