# auto-update-dependencies

Composite GitHub Action that resolves an npm dist-tag, bumps a consumer's `package.json` to the resolved version,
renders a rich PR body listing the dependency repo's commits (and associated PRs) between the old and new versions, and
opens the PR via [`peter-evans/create-pull-request`](https://github.com/peter-evans/create-pull-request).

## Usage

```yaml
jobs:
  update:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - branch: dev
            tag: dev
          - branch: staging
            tag: staging
          - branch: master
            tag: prod
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ matrix.branch }}

      - uses: washogren/auto-update-dependencies@v1
        with:
          package: '@your-org/your-dependency'
          tag: ${{ matrix.tag }}
          base-branch: ${{ matrix.branch }}
          npm-scope: '@your-org'
          token: ${{ secrets.GH_PACKAGES_READ }}
```

The action runs `actions/setup-node` internally, so the consumer doesn't need a separate `setup-node` step. The consumer
is still responsible for the surrounding workflow concerns: triggers, `permissions:`, `actions/checkout`, branch matrix.

## Inputs

| Name                     | Required | Default                      | Description                                                                                                                    |
| ------------------------ | -------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `package`                | yes      |                              | The npm package name (e.g. `@your-org/your-dependency`).                                                                       |
| `tag`                    | yes      |                              | The dist-tag to track.                                                                                                         |
| `token`                  | yes      |                              | Token with package:read on the registry, repo:read on the dependency, and repo:write on the consumer.                          |
| `base-branch`            | no       | `github.ref_name`            | The branch the PR targets.                                                                                                     |
| `npm-registry`           | no       | `https://npm.pkg.github.com` | Registry the package is hosted on.                                                                                             |
| `npm-scope`              | no       |                              | Scope to bind to the registry (e.g. `@your-org`).                                                                              |
| `node-version`           | no       | `20`                         | Node.js version used by the internal `actions/setup-node` step.                                                                |
| `delete-branch`          | no       | `true`                       | Forwarded to `peter-evans/create-pull-request` — delete the auto-update branch when the PR closes.                             |
| `auto-merge`             | no       | `false`                      | Enable GitHub auto-merge on a newly-created PR so it merges once required checks pass.                                         |
| `auto-merge-method`      | no       | `squash`                     | Merge method when `auto-merge` is on: `merge`, `squash`, or `rebase`.                                                          |
| `auto-merge-when-semver` | no       |                              | Restrict auto-merge to specific bump types: a comma-separated list of `major`, `minor`, `patch`. Empty means merge every bump. |

## Outputs

| Name           | Description                                                       |
| -------------- | ----------------------------------------------------------------- |
| `changed`      | `true` if a bump was needed; `false` otherwise.                   |
| `current`      | The previously-pinned version.                                    |
| `latest`       | The version the dist-tag now points to.                           |
| `pr-number`    | The created/updated PR number (empty if no PR was opened).        |
| `pr-url`       | The created/updated PR URL (empty if no PR was opened).           |
| `pr-operation` | `created`, `updated`, `closed`, or `none` — what peter-evans did. |

## Auto-merge

Set `auto-merge: true` to have the action enable GitHub auto-merge on a newly-created PR. It posts a comment noting that
auto-merge was enabled and the merge method, then runs `gh pr merge --auto --<method>`. The PR then merges on its own
once all required status checks pass. Prerequisites:

- **"Allow auto-merge" must be enabled** in the repo's Settings → General.
- **A branch protection rule with at least one required status check** must gate the base branch — auto-merge needs
  something to wait on, otherwise GitHub rejects it.
- **Use a PAT / App token, not the default `GITHUB_TOKEN`.** A PR merged via a `GITHUB_TOKEN`-created PR won't trigger
  downstream workflows (GitHub's loop prevention), same as PR creation. The `token` input should carry a PAT/App token
  if you rely on post-merge workflows.

Auto-merge is only enabled on the `created` operation — re-running against an existing open PR (`updated`) leaves its
existing merge state untouched.

### Restricting auto-merge by SemVer

By default, `auto-merge: true` merges every bump. Set `auto-merge-when-semver` to a comma-separated list of `major`,
`minor`, and/or `patch` to auto-merge only the change types you trust to land unattended — for example, let patches and
minors merge on their own while a major waits for a human:

```yaml
with:
  auto-merge: true
  auto-merge-when-semver: minor, patch
```

- When `auto-merge-when-semver` is **empty** (the default), no SemVer formatting is enforced — every bump auto-merges,
  including versions that aren't valid SemVer.
- When it is **set**, both the pinned and resolved versions must be valid SemVer. If either isn't, the action fails
  loudly rather than guessing
- A **prerelease-only** bump (same `major.minor.patch`, e.g. `1.0.2-dev.11` → `1.0.2-dev.12`) counts as `patch`. The
  watched dist-tag is what pins dev/staging/prod, so the prerelease segment is noise below the patch level.

## How the changelog is built

1. `npm view <pkg>@<version> gitHead` is read for both the previously-pinned version and the new version.
2. `npm view <pkg>@<latest> repository.url` resolves the dependency's GitHub repository.
3. `GET /repos/{slug}/compare/{prev}...{next}` gives the list of commits.
4. For each commit, `GET /repos/{slug}/commits/{sha}/pulls` resolves the associated PR(s).
5. Commits are reversed (newest-first) and grouped under each PR; commits without a PR fall through to a "Commits
   without an associated PR" section. Both sections use `<details>` so commit metadata is collapsible.

## Failure handling

The action fails loudly on any condition that would produce a misleading or incomplete PR. There are no silent
degradations — every failure throws with a descriptive message and a full stack trace logged via `core.error` before the
step is marked failed. Specific cases:

| Condition                                      | Failure message includes                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Dependency missing from `package.json`         | The package name and the workspace path searched.                                             |
| dist-tag not present on the package            | The tag, package, and registry; suggested `npm dist-tag ls` command.                          |
| `repository.url` missing from package metadata | The `package@version` that lacked the field.                                                  |
| `gitHead` missing on either version            | Which version (previous vs new) and that `gitHead` is set by `npm publish` from a clean tree. |
| Repository URL is not on `github.com`          | The unsupported URL.                                                                          |
| GitHub compare or PR-association API fails     | The underlying error message (HTTP status, rate-limit, auth) propagates.                      |
| `npm install` fails                            | The npm stderr propagates.                                                                    |

The only non-failure "no-op" outcome is `current === latest`: the action logs "Already at \<version\>" and exits with
`changed=false`.

## Why a composite action

The action is composite, not a single Node binary, so it can chain into `peter-evans/create-pull-request@v8` directly.
Trade-off: the consumer's workflow becomes a single `uses:` step, but the peter-evans version is pinned by this action's
tag rather than by the consumer. Bump this action's tag to pick up peter-evans updates.

If you want to skip the PR-creation step (e.g. render a body file then commit/push manually), invoke the JS bundle
directly. You'll need to run `actions/setup-node` yourself and provide the `INPUT_*` env vars (composite normally maps
these for you):

```yaml
- uses: actions/setup-node@v6
  with:
    node-version: 20
- run: node $GITHUB_ACTION_PATH/dist/index.js
  env:
    INPUT_PACKAGE: '@your-org/your-dependency'
    INPUT_TAG: dev
    INPUT_NPM_REGISTRY: https://npm.pkg.github.com
    INPUT_NPM_SCOPE: '@your-org'
    INPUT_TOKEN: ${{ secrets.GH_PACKAGES_READ }}
    NODE_AUTH_TOKEN: ${{ secrets.GH_PACKAGES_READ }}
```

Deliberately do **not** pass `registry-url`/`scope` to `setup-node` here: that writes a bare default-registry line into
`.npmrc`, which makes the private registry the default for every package and 404s public deps. The bundle binds only the
scope (from `INPUT_NPM_REGISTRY`/`INPUT_NPM_SCOPE`) and the auth token, leaving the default as npmjs.org.

Each input maps to `INPUT_<NAME>` — uppercase, hyphens become underscores (e.g. `auto-merge` → `INPUT_AUTO_MERGE`). The
action reads these via its own helper rather than `core.getInput`, which in `@actions/core` v3 keeps the hyphen
(`INPUT_AUTO-MERGE`) and wouldn't match.

## Development

```bash
npm install
npm run lint        # eslint .
npm run typecheck   # tsc --noEmit
npm test            # vitest run — covers all four modules + the action.yml schema
npm test -- -u      # regenerate the changelog inline snapshots after an intentional rendering change
npm run build       # esbuild bundle to dist/index.js
```

### Source layout

The four source modules are split by which repository each one interacts with, plus a pure renderer. Each has a sibling
`*.test.ts`.

| File            | Responsibility                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dependency.ts` | Reads about the dependency package: `npm dist-tag ls`, `npm view ... gitHead/repository.url`, `octokit compare`, and per-commit PR association. Read-only.                 |
| `consumer.ts`   | Reads from and writes to the consumer's checkout: `package.json` inspection, and a lockfile-only exact-pin `npm install` (scoped registry only, never the global default). |
| `changelog.ts`  | Pure Markdown rendering. No I/O, no async. Tests use inline snapshots so the expected output is visible alongside each case.                                               |
| `index.ts`      | Action entrypoint: declares `Inputs`/`Outputs`/`Deps`, wires `realDeps` for production, orchestrates the flow in `run()`, and applies outputs via `@actions/core`.         |

The `Deps` interface lets the orchestrator tests inject fakes for every I/O boundary without touching `@actions/exec` or
Octokit.

The bundled `dist/index.js` is committed because GitHub Actions does not run `npm install` for the JS half of a
composite action either. The `check-dist.yml` workflow verifies it stays fresh: it rebuilds from source and fails if the
committed `dist/` differs.
