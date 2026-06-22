// These tests use inline snapshots so the expected markdown is visible in the
// test source. A reviewer can scan the file to learn what the rendered PR
// body looks like in each case (subject-only commits, multi-line commit
// bodies, PR-grouped commits, mixed sections, etc.).
//
// Each test sets prevSha/nextSha to bracket the commits it passes:
//   * nextSha = the newest commit's SHA
//   * prevSha = a synthetic "before the range" placeholder ("0" * 40)
// so the compare link in the snapshot lines up with the commits below it.
//
// To regenerate after an intentional rendering change: `npm test -- -u`.

import { describe, expect, it } from 'vitest'
import { renderChangelog, type ChangelogContext } from './changelog.js'
import type { AssociatedPr, CommitWithPrs } from './dependency.js'

const PREV_SHA = '0'.repeat(40)

function ctx(nextSha: string): ChangelogContext {
  return {
    package: '@your-org/your-dependency',
    tag: 'dev',
    prev: '1.0.0-staging.5',
    next: '1.0.2-dev.12',
    prevSha: PREV_SHA,
    nextSha,
    repoUrl: 'https://github.com/your-org/your-dependency',
    slug: 'your-org/your-dependency'
  }
}

function commit(sha: string, message: string, prs: AssociatedPr[] = []): CommitWithPrs {
  return { sha, message, prs }
}

describe('renderChangelog', () => {
  it('renders an empty range with no commits', () => {
    expect(renderChangelog(ctx(PREV_SHA), [])).toMatchInlineSnapshot(`
      "| Package | Tag | Previous | New |
      | --- | --- | --- | --- |
      | [\`@your-org/your-dependency\`](https://github.com/your-org/your-dependency) | \`dev\` | [\`1.0.0-staging.5\`](https://github.com/your-org/your-dependency/commit/0000000000000000000000000000000000000000) | [\`1.0.2-dev.12\`](https://github.com/your-org/your-dependency/commit/0000000000000000000000000000000000000000) |

      No commits between \`1.0.0-staging.5\` and \`1.0.2-dev.12\`.

      ---

      _Automated dependency update by [auto-update-dependencies](https://github.com/washogren/auto-update-dependencies)._
      "
    `)
  })

  it('renders subject-only standalone commits in newest-first order, no <details> blocks', () => {
    // Input is oldest-first (the order GitHub's compare API returns); the
    // renderer reverses it. nextSha matches the newest commit (cccc...).
    const commits: CommitWithPrs[] = [
      commit('a'.repeat(40), 'oldest commit'),
      commit('b'.repeat(40), 'middle commit'),
      commit('c'.repeat(40), 'newest commit')
    ]
    expect(renderChangelog(ctx('c'.repeat(40)), commits)).toMatchInlineSnapshot(`
      "| Package | Tag | Previous | New |
      | --- | --- | --- | --- |
      | [\`@your-org/your-dependency\`](https://github.com/your-org/your-dependency) | \`dev\` | [\`1.0.0-staging.5\`](https://github.com/your-org/your-dependency/commit/0000000000000000000000000000000000000000) | [\`1.0.2-dev.12\`](https://github.com/your-org/your-dependency/commit/cccccccccccccccccccccccccccccccccccccccc) |

      Compare: [\`0000000...ccccccc\`](https://github.com/your-org/your-dependency/compare/0000000000000000000000000000000000000000...cccccccccccccccccccccccccccccccccccccccc) — 3 commits

      ## Commits w/ no PR

      > [!IMPORTANT]
      > #### [\`ccccccc\`](https://github.com/your-org/your-dependency/commit/cccccccccccccccccccccccccccccccccccccccc) — \`newest commit\`

      > [!IMPORTANT]
      > #### [\`bbbbbbb\`](https://github.com/your-org/your-dependency/commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) — \`middle commit\`

      > [!IMPORTANT]
      > #### [\`aaaaaaa\`](https://github.com/your-org/your-dependency/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) — \`oldest commit\`

      ---

      _Automated dependency update by [auto-update-dependencies](https://github.com/washogren/auto-update-dependencies)._
      "
    `)
  })

  it('wraps a multi-line commit body in a collapsible <details> block', () => {
    const commits: CommitWithPrs[] = [
      commit('a'.repeat(40), 'Add caching layer\n\n## Why\n\nReduces p99 latency on the hot path.')
    ]
    expect(renderChangelog(ctx('a'.repeat(40)), commits)).toMatchInlineSnapshot(`
      "| Package | Tag | Previous | New |
      | --- | --- | --- | --- |
      | [\`@your-org/your-dependency\`](https://github.com/your-org/your-dependency) | \`dev\` | [\`1.0.0-staging.5\`](https://github.com/your-org/your-dependency/commit/0000000000000000000000000000000000000000) | [\`1.0.2-dev.12\`](https://github.com/your-org/your-dependency/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) |

      Compare: [\`0000000...aaaaaaa\`](https://github.com/your-org/your-dependency/compare/0000000000000000000000000000000000000000...aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) — 1 commit

      ## Commits w/ no PR

      > [!IMPORTANT]
      > #### [\`aaaaaaa\`](https://github.com/your-org/your-dependency/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) — \`Add caching layer\`
      >
      > <details>
      > <summary>Details</summary>
      >
      > > ## Why
      > >
      > > Reduces p99 latency on the hot path.
      >
      > </details>

      ---

      _Automated dependency update by [auto-update-dependencies](https://github.com/washogren/auto-update-dependencies)._
      "
    `)
  })

  it('groups commits under their associated PR with title, link, and full body', () => {
    const pr: AssociatedPr = {
      number: 42,
      title: 'Add feature X',
      html_url: 'https://github.com/your-org/your-dependency/pull/42',
      body: '## Summary\n\nImplements feature X by doing the thing.'
    }
    const commits: CommitWithPrs[] = [
      commit('a'.repeat(40), 'commit A', [pr]),
      commit('b'.repeat(40), 'commit B', [pr])
    ]
    expect(renderChangelog(ctx('b'.repeat(40)), commits)).toMatchInlineSnapshot(`
      "| Package | Tag | Previous | New |
      | --- | --- | --- | --- |
      | [\`@your-org/your-dependency\`](https://github.com/your-org/your-dependency) | \`dev\` | [\`1.0.0-staging.5\`](https://github.com/your-org/your-dependency/commit/0000000000000000000000000000000000000000) | [\`1.0.2-dev.12\`](https://github.com/your-org/your-dependency/commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) |

      Compare: [\`0000000...bbbbbbb\`](https://github.com/your-org/your-dependency/compare/0000000000000000000000000000000000000000...bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) — 2 commits

      ## PRs

      > [!TIP]
      > ### [#42](https://github.com/your-org/your-dependency/pull/42) — \`Add feature X\`
      >
      > #### [\`bbbbbbb\`](https://github.com/your-org/your-dependency/commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) — \`commit B\`
      > #### [\`aaaaaaa\`](https://github.com/your-org/your-dependency/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) — \`commit A\`
      >
      > <details>
      > <summary>Details</summary>
      >
      > > ## Summary
      > >
      > > Implements feature X by doing the thing.
      >
      > </details>

      ---

      _Automated dependency update by [auto-update-dependencies](https://github.com/washogren/auto-update-dependencies)._
      "
    `)
  })

  it('omits the description block when the PR body is null', () => {
    const pr: AssociatedPr = {
      number: 1,
      title: 'Empty body PR',
      html_url: 'https://github.com/x/y/pull/1',
      body: null
    }
    const commits: CommitWithPrs[] = [commit('a'.repeat(40), 'commit', [pr])]
    expect(renderChangelog(ctx('a'.repeat(40)), commits)).toMatchInlineSnapshot(`
      "| Package | Tag | Previous | New |
      | --- | --- | --- | --- |
      | [\`@your-org/your-dependency\`](https://github.com/your-org/your-dependency) | \`dev\` | [\`1.0.0-staging.5\`](https://github.com/your-org/your-dependency/commit/0000000000000000000000000000000000000000) | [\`1.0.2-dev.12\`](https://github.com/your-org/your-dependency/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) |

      Compare: [\`0000000...aaaaaaa\`](https://github.com/your-org/your-dependency/compare/0000000000000000000000000000000000000000...aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) — 1 commit

      ## PRs

      > [!TIP]
      > ### [#1](https://github.com/x/y/pull/1) — \`Empty body PR\`
      >
      > #### [\`aaaaaaa\`](https://github.com/your-org/your-dependency/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) — \`commit\`

      ---

      _Automated dependency update by [auto-update-dependencies](https://github.com/washogren/auto-update-dependencies)._
      "
    `)
  })

  it('renders both PR-grouped and standalone sections when commits are mixed', () => {
    // PR-grouped section comes first; standalone commits follow under their
    // own heading. The standalone section is omitted when empty.
    const pr: AssociatedPr = {
      number: 7,
      title: 'PR title',
      html_url: 'https://github.com/x/y/pull/7',
      body: null
    }
    const commits: CommitWithPrs[] = [commit('a'.repeat(40), 'in a PR', [pr]), commit('b'.repeat(40), 'direct push')]
    expect(renderChangelog(ctx('b'.repeat(40)), commits)).toMatchInlineSnapshot(`
      "| Package | Tag | Previous | New |
      | --- | --- | --- | --- |
      | [\`@your-org/your-dependency\`](https://github.com/your-org/your-dependency) | \`dev\` | [\`1.0.0-staging.5\`](https://github.com/your-org/your-dependency/commit/0000000000000000000000000000000000000000) | [\`1.0.2-dev.12\`](https://github.com/your-org/your-dependency/commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) |

      Compare: [\`0000000...bbbbbbb\`](https://github.com/your-org/your-dependency/compare/0000000000000000000000000000000000000000...bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) — 2 commits

      ## PRs

      > [!TIP]
      > ### [#7](https://github.com/x/y/pull/7) — \`PR title\`
      >
      > #### [\`aaaaaaa\`](https://github.com/your-org/your-dependency/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) — \`in a PR\`

      ## Commits w/ no PR

      > [!IMPORTANT]
      > #### [\`bbbbbbb\`](https://github.com/your-org/your-dependency/commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) — \`direct push\`

      ---

      _Automated dependency update by [auto-update-dependencies](https://github.com/washogren/auto-update-dependencies)._
      "
    `)
  })

  it('shows the full multi-line commit body without truncation', () => {
    // Inline snapshot uses an abbreviated body to stay readable; the assertion
    // below validates the no-truncation contract on a longer body too.
    const commits: CommitWithPrs[] = [commit('a'.repeat(40), 'subject\n\nline 1\nline 2\nline 3')]
    expect(renderChangelog(ctx('a'.repeat(40)), commits)).toMatchInlineSnapshot(`
      "| Package | Tag | Previous | New |
      | --- | --- | --- | --- |
      | [\`@your-org/your-dependency\`](https://github.com/your-org/your-dependency) | \`dev\` | [\`1.0.0-staging.5\`](https://github.com/your-org/your-dependency/commit/0000000000000000000000000000000000000000) | [\`1.0.2-dev.12\`](https://github.com/your-org/your-dependency/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) |

      Compare: [\`0000000...aaaaaaa\`](https://github.com/your-org/your-dependency/compare/0000000000000000000000000000000000000000...aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) — 1 commit

      ## Commits w/ no PR

      > [!IMPORTANT]
      > #### [\`aaaaaaa\`](https://github.com/your-org/your-dependency/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) — \`subject\`
      >
      > <details>
      > <summary>Details</summary>
      >
      > > line 1
      > > line 2
      > > line 3
      >
      > </details>

      ---

      _Automated dependency update by [auto-update-dependencies](https://github.com/washogren/auto-update-dependencies)._
      "
    `)

    const longBody = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
    const longResult = renderChangelog(ctx('a'.repeat(40)), [commit('a'.repeat(40), `subject\n\n${longBody}`)])
    expect(longResult).toContain('line 0')
    expect(longResult).toContain('line 199')
    expect(longResult).not.toContain('…')
  })
})
