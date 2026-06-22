// Pure markdown rendering. No I/O, no async required. The orchestrator only
// invokes the renderer once it has all data — there are no degraded modes here.

import type { AssociatedPr, CommitWithPrs } from './dependency.js'

const ACTION_REPO_URL = 'https://github.com/washogren/auto-update-dependencies'

export interface ChangelogContext {
  package: string
  tag: string
  prev: string
  next: string
  prevSha: string
  nextSha: string
  repoUrl: string
  slug: string
}

export function renderChangelog(
  ctx: ChangelogContext,
  commits: CommitWithPrs[]
): string {
  // Newest commit first. The fetcher passes the GitHub compare-API list as-is
  // (oldest-first); reversing here keeps the rendering self-contained.
  const ordered = [...commits].reverse()
  const out: string[] = []

  out.push('| Package | Tag | Previous | New |')
  out.push('| --- | --- | --- | --- |')
  out.push(
    `| [\`${ctx.package}\`](${ctx.repoUrl}) | \`${ctx.tag}\` | [\`${ctx.prev}\`](${ctx.repoUrl}/commit/${ctx.prevSha}) | [\`${ctx.next}\`](${ctx.repoUrl}/commit/${ctx.nextSha}) |`
  )
  out.push('')

  if (ordered.length === 0) {
    out.push(`No commits between \`${ctx.prev}\` and \`${ctx.next}\`.`)
    out.push('')
    out.push(footer())
    return out.join('\n') + '\n'
  }

  out.push(
    `Compare: [\`${shortSha(ctx.prevSha)}...${shortSha(ctx.nextSha)}\`](${compareUrl(ctx)}) — ${pluralize(ordered.length, 'commit')}`
  )
  out.push('')

  const prOrder: number[] = []
  const prByNum = new Map<number, AssociatedPr>()
  const prCommits = new Map<number, string[]>()
  const standalone: CommitWithPrs[] = []

  for (const entry of ordered) {
    const subject = firstLine(entry.message)
    const subheading = `#### [\`${shortSha(entry.sha)}\`](${ctx.repoUrl}/commit/${entry.sha}) — ${inlineCode(subject)}`
    if (entry.prs.length === 0) {
      standalone.push(entry)
      continue
    }
    for (const pr of entry.prs) {
      if (!prByNum.has(pr.number)) {
        prByNum.set(pr.number, pr)
        prCommits.set(pr.number, [])
        prOrder.push(pr.number)
      }
      prCommits.get(pr.number)!.push(subheading)
    }
  }

  if (prOrder.length > 0) {
    out.push('## PRs')
    out.push('')
    for (const num of prOrder) {
      const pr = prByNum.get(num)!
      const inner: string[] = []
      inner.push(`### [#${num}](${pr.html_url}) — ${inlineCode(pr.title)}`)
      inner.push('')
      inner.push(...prCommits.get(num)!)
      if (pr.body && pr.body.length > 0) {
        inner.push('')
        inner.push('<details>')
        inner.push('<summary>Details</summary>')
        inner.push('')
        inner.push(blockquote(pr.body))
        inner.push('')
        inner.push('</details>')
      }
      out.push(callout('TIP', inner))
      out.push('')
    }
  }

  if (standalone.length > 0) {
    out.push('## Commits w/ no PR')
    out.push('')
    for (const entry of standalone) {
      const subject = firstLine(entry.message)
      const rest = restOfMessage(entry.message)
      const link = `[\`${shortSha(entry.sha)}\`](${ctx.repoUrl}/commit/${entry.sha})`
      const inner: string[] = []
      inner.push(`#### ${link} — ${inlineCode(subject)}`)
      if (rest.length > 0) {
        inner.push('')
        inner.push('<details>')
        inner.push('<summary>Details</summary>')
        inner.push('')
        inner.push(blockquote(rest))
        inner.push('')
        inner.push('</details>')
      }
      out.push(callout('IMPORTANT', inner))
      out.push('')
    }
  }

  out.push(footer())
  return out.join('\n') + '\n'
}

function footer(): string {
  return `---\n\n_Automated dependency update by [auto-update-dependencies](${ACTION_REPO_URL})._`
}

// Wrap a block of inner content in a GitHub alert callout. Every line gets a
// `>` prefix; blank lines collapse to a bare `>` so the callout stays open.
function callout(
  kind: 'TIP' | 'IMPORTANT' | 'NOTE' | 'WARNING' | 'CAUTION',
  inner: string[]
): string {
  const flat = inner.join('\n').split('\n')
  const lines = [`> [!${kind}]`]
  for (const line of flat) {
    lines.push(line.length === 0 ? '>' : `> ${line}`)
  }
  return lines.join('\n')
}

function compareUrl(ctx: ChangelogContext): string {
  return `${ctx.repoUrl}/compare/${ctx.prevSha}...${ctx.nextSha}`
}

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

function firstLine(message: string): string {
  const idx = message.indexOf('\n')
  return idx === -1 ? message : message.slice(0, idx)
}

function restOfMessage(message: string): string {
  // Skip the subject line and the conventional blank separator.
  const lines = message.split('\n')
  if (lines.length <= 1) return ''
  const tail = lines.slice(1)
  if (tail[0] === '') tail.shift()
  return tail.join('\n').trimEnd()
}

// Wrap text in a backtick fence long enough to escape any internal backticks.
// Quoted PR titles / commit subjects go through this so GitHub doesn't autolink
// `#N` (or other refs) into the consumer repo.
function inlineCode(s: string): string {
  if (s.length === 0) return '``'
  let maxRun = 0
  let cur = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '`') {
      cur++
      if (cur > maxRun) maxRun = cur
    } else {
      cur = 0
    }
  }
  const fence = '`'.repeat(maxRun + 1)
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${s}${pad}${fence}`
}

function blockquote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? '>' : `> ${line}`))
    .join('\n')
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}
