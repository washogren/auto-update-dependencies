import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installExact, readPinnedVersion } from './consumer.js';

let tmpDirs: string[] = [];
beforeEach(() => {
  tmpDirs = [];
});
afterEach(async () => {
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function withPackageJson(json: object): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aud-consumer-'));
  tmpDirs.push(dir);
  await writeFile(join(dir, 'package.json'), JSON.stringify(json));
  return dir;
}

describe('readPinnedVersion', () => {
  it('returns the version when the package is in `dependencies`', async () => {
    const dir = await withPackageJson({
      name: 'consumer',
      dependencies: { '@your-org/your-dependency': '1.0.0-prod.1' },
    });
    expect(await readPinnedVersion(dir, '@your-org/your-dependency')).toBe('1.0.0-prod.1');
  });

  it('returns the version when the package is in `devDependencies`', async () => {
    const dir = await withPackageJson({
      name: 'consumer',
      devDependencies: { 'some-tool': '2.3.4' },
    });
    expect(await readPinnedVersion(dir, 'some-tool')).toBe('2.3.4');
  });

  it('prefers `dependencies` over `devDependencies` when the package appears in both', async () => {
    // The action operates on runtime deps; if a consumer somehow lists the package
    // in both buckets we should pick the runtime pin to keep them consistent.
    const dir = await withPackageJson({
      name: 'consumer',
      dependencies: { dual: '1.0.0' },
      devDependencies: { dual: '9.9.9' },
    });
    expect(await readPinnedVersion(dir, 'dual')).toBe('1.0.0');
  });

  it('returns null when the package is absent from both dependency buckets', async () => {
    const dir = await withPackageJson({
      name: 'consumer',
      dependencies: { 'some-other-package': '1.0.0' },
    });
    expect(await readPinnedVersion(dir, 'missing')).toBeNull();
  });

  it('returns null when neither dependency bucket exists', async () => {
    const dir = await withPackageJson({ name: 'empty-consumer' });
    expect(await readPinnedVersion(dir, 'whatever')).toBeNull();
  });

  it('throws when package.json does not exist', async () => {
    // The action requires a package.json to be present in the consumer
    // checkout; surfacing the read error rather than silently returning null
    // makes a misconfigured workspace easy to diagnose.
    const dir = await mkdtemp(join(tmpdir(), 'aud-consumer-empty-'));
    tmpDirs.push(dir);
    await expect(readPinnedVersion(dir, 'whatever')).rejects.toThrow();
  });

  it('throws when package.json contains invalid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aud-consumer-bad-'));
    tmpDirs.push(dir);
    await writeFile(join(dir, 'package.json'), '{ this is not json');
    await expect(readPinnedVersion(dir, 'whatever')).rejects.toThrow();
  });
});

describe('installExact', () => {
  // We test installExact by intercepting @actions/exec rather than running a
  // real `npm install`. The contract under test is "we shell out to npm with
  // the right argv and the caller-provided cwd/env" — running the real install
  // would be slow, hit the registry, and verify nothing the unit cares about.

  async function spyExec(): Promise<{
    calls: Array<{ command: string; args: readonly string[]; cwd?: string; env?: Record<string, string> }>;
  }> {
    const calls: Array<{ command: string; args: readonly string[]; cwd?: string; env?: Record<string, string> }> = [];
    const exec = await import('@actions/exec');
    vi.spyOn(exec, 'exec').mockImplementation(
      async (command: string, args?: string[], options?: { cwd?: string; env?: Record<string, string> }) => {
        calls.push({ command, args: args ?? [], cwd: options?.cwd, env: options?.env });
        return 0;
      },
    );
    return { calls };
  }

  it('runs `npm install --save-exact <pkg>@<version>` so the bump pins to the exact version', async () => {
    // Without --save-exact, npm prefixes the version with ^ and the next run's
    // current/latest comparison would be a string mismatch even when nothing
    // moved.
    const { calls } = await spyExec();
    await installExact('@your-org/your-dependency', '1.0.2-dev.12', {
      cwd: '/some/workspace',
      env: { FOO: 'bar' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('npm');
    expect(calls[0].args).toEqual([
      'install',
      '--save-exact',
      '@your-org/your-dependency@1.0.2-dev.12',
    ]);
  });

  it('forwards the caller-provided cwd and env to the npm subprocess', async () => {
    // The action's run() hands installExact an NpmContext that contains the
    // consumer workspace and the auth-bearing env. If we drop either, npm
    // installs into the wrong tree or fails to authenticate against the
    // private registry.
    const { calls } = await spyExec();
    await installExact('pkg', '1.0.0', {
      cwd: '/runner/work/repo',
      env: { NODE_AUTH_TOKEN: 'token-value', npm_config_registry: 'https://example.com' },
    });
    expect(calls[0].cwd).toBe('/runner/work/repo');
    expect(calls[0].env).toMatchObject({
      NODE_AUTH_TOKEN: 'token-value',
      npm_config_registry: 'https://example.com',
    });
  });

  it('propagates failure when npm exits non-zero', async () => {
    const exec = await import('@actions/exec');
    vi.spyOn(exec, 'exec').mockRejectedValue(new Error('npm install failed: E404'));
    await expect(
      installExact('missing', '1.0.0', { cwd: '/x', env: {} }),
    ).rejects.toThrow(/E404/);
  });
});
