import { describe, expect, it } from 'vitest';
import { extractGitHubSlug, normalizeRepoUrl } from './dependency.js';

describe('normalizeRepoUrl', () => {
  it('strips git+ prefix and .git suffix', () => {
    expect(normalizeRepoUrl('git+https://github.com/foo/bar.git')).toBe(
      'https://github.com/foo/bar',
    );
  });

  it('rewrites the git:// scheme to https://', () => {
    expect(normalizeRepoUrl('git://github.com/foo/bar.git')).toBe(
      'https://github.com/foo/bar',
    );
  });

  it('passes through an already-clean https URL', () => {
    expect(normalizeRepoUrl('https://github.com/foo/bar')).toBe(
      'https://github.com/foo/bar',
    );
  });
});

describe('extractGitHubSlug', () => {
  it('returns owner/repo for a github URL', () => {
    expect(extractGitHubSlug('https://github.com/your-org/your-dependency')).toBe(
      'your-org/your-dependency',
    );
  });

  it('throws a descriptive error for non-github URLs', () => {
    expect(() => extractGitHubSlug('https://gitlab.com/foo/bar')).toThrow(
      /Could not extract a GitHub owner\/repo slug.*gitlab\.com/,
    );
  });

  it('throws when the URL is empty or unparseable', () => {
    expect(() => extractGitHubSlug('')).toThrow(/Could not extract a GitHub/);
    expect(() => extractGitHubSlug('not-a-url')).toThrow(/Could not extract a GitHub/);
  });
});
