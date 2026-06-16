// Pure markdown rendering. No I/O, no async required. The orchestrator only
// invokes the renderer once it has all data — there are no degraded modes here.

import type { AssociatedPr, CommitWithPrs } from './dependency.js';

export interface ChangelogContext {
  package: string;
  tag: string;
  prev: string;
  next: string;
  prevSha: string;
  nextSha: string;
  repoUrl: string;
  slug: string;
}

export function renderChangelog(
  ctx: ChangelogContext,
  commits: CommitWithPrs[],
): string {
  const out: string[] = headerLines(ctx);

  // Newest commit first. The fetcher passes the GitHub compare-API list as-is
  // (oldest-first); reversing here keeps the rendering self-contained.
  const ordered = [...commits].reverse();

  out.push(`## Changes in \`${ctx.package}\``);
  out.push('');
  out.push(
    `Compare: [\`${shortSha(ctx.prevSha)}...${shortSha(ctx.nextSha)}\`](${compareUrl(ctx)}) — ${ordered.length} commit(s)`,
  );
  out.push('');

  const prOrder: number[] = [];
  const prByNum = new Map<number, AssociatedPr>();
  const prCommits = new Map<number, string[]>();
  const standalone: CommitWithPrs[] = [];

  for (const entry of ordered) {
    const subject = firstLine(entry.message);
    const link = `[\`${shortSha(entry.sha)}\`](${ctx.repoUrl}/commit/${entry.sha}) — ${subject}`;
    if (entry.prs.length === 0) {
      standalone.push(entry);
      continue;
    }
    for (const pr of entry.prs) {
      if (!prByNum.has(pr.number)) {
        prByNum.set(pr.number, pr);
        prCommits.set(pr.number, []);
        prOrder.push(pr.number);
      }
      prCommits.get(pr.number)!.push(`- ${link}`);
    }
  }

  for (const num of prOrder) {
    const pr = prByNum.get(num)!;
    const commitLines = prCommits.get(num)!;
    out.push('');
    out.push(`### [#${num}](${pr.html_url}) — ${pr.title}`);
    out.push('');
    out.push('<details>');
    out.push('<summary>Commits and description</summary>');
    out.push('');
    out.push('**Commits:**');
    out.push('');
    out.push(...commitLines);
    if (pr.body && pr.body.length > 0) {
      out.push('');
      out.push('**Description:**');
      out.push('');
      out.push(pr.body);
      out.push('');
    }
    out.push('</details>');
  }

  if (standalone.length > 0) {
    out.push('');
    out.push('### Commits without an associated PR');
    out.push('');
    for (const entry of standalone) {
      const subject = firstLine(entry.message);
      const rest = restOfMessage(entry.message);
      out.push(
        `#### [\`${shortSha(entry.sha)}\`](${ctx.repoUrl}/commit/${entry.sha}) — ${subject}`,
      );
      if (rest.length > 0) {
        out.push('');
        out.push('<details>');
        out.push('<summary>Description</summary>');
        out.push('');
        out.push(rest);
        out.push('');
        out.push('</details>');
      }
      out.push('');
    }
  }

  return out.join('\n') + '\n';
}

function headerLines(ctx: ChangelogContext): string[] {
  return [
    'Automated dist-tag tracking update.',
    '',
    `Package:    \`${ctx.package}\``,
    `Tag:        \`${ctx.tag}\``,
    `Previous:   \`${ctx.prev}\``,
    `New:        \`${ctx.next}\``,
    '',
  ];
}

function compareUrl(ctx: ChangelogContext): string {
  return `${ctx.repoUrl}/compare/${ctx.prevSha}...${ctx.nextSha}`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function firstLine(message: string): string {
  const idx = message.indexOf('\n');
  return idx === -1 ? message : message.slice(0, idx);
}

function restOfMessage(message: string): string {
  // Skip the subject line and the conventional blank separator.
  const lines = message.split('\n');
  if (lines.length <= 1) return '';
  const tail = lines.slice(1);
  if (tail[0] === '') tail.shift();
  return tail.join('\n').trimEnd();
}
