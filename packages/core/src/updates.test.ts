import { describe, expect, it } from 'vitest';
import { compareSemver, newerRelease, parseSemver } from './index.ts';

const answer = (o: Record<string, unknown>): string => JSON.stringify({ tag_name: 'v0.2.0', html_url: 'https://github.com/dbuffoni/Folio/releases/tag/v0.2.0', draft: false, prerelease: false, ...o });

describe('update notice: versions', () => {
  it('parses and orders semantic versions @FR-APP-16', () => {
    expect(parseSemver('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: [] });
    expect(parseSemver('1.2.3-rc.1+build5')).toEqual({ major: 1, minor: 2, patch: 3, pre: ['rc', '1'] });
    expect(parseSemver('1.2')).toBeNull();
    expect(parseSemver('latest')).toBeNull();
    const c = (a: string, b: string): number => Math.sign(compareSemver(parseSemver(a)!, parseSemver(b)!));
    expect(c('0.1.10', '0.1.9')).toBe(1);
    expect(c('0.2.0', '0.1.99')).toBe(1);
    expect(c('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(c('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
    expect(c('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(c('0.1.4', 'v0.1.4')).toBe(0);
  });

  it('reports only a newer final release, ignoring drafts and pre-releases @FR-APP-16', () => {
    expect(newerRelease(answer({}), '0.1.4')).toEqual({ version: '0.2.0', url: 'https://github.com/dbuffoni/Folio/releases/tag/v0.2.0' });
    expect(newerRelease(answer({ tag_name: 'v0.1.4' }), '0.1.4')).toBeNull();
    expect(newerRelease(answer({ tag_name: 'v0.1.3' }), '0.1.4')).toBeNull();
    expect(newerRelease(answer({ draft: true }), '0.1.4')).toBeNull();
    expect(newerRelease(answer({ prerelease: true }), '0.1.4')).toBeNull();
    expect(newerRelease(answer({ tag_name: 'v0.2.0-rc.1' }), '0.1.4')).toBeNull();
    expect(newerRelease(answer({ tag_name: 'nightly' }), '0.1.4')).toBeNull();
    expect(newerRelease('not json', '0.1.4')).toBeNull();
    expect(newerRelease('null', '0.1.4')).toBeNull();
    expect(newerRelease(answer({}), 'dev')).toBeNull();
  });

  it('never links anywhere but the project releases @FR-APP-16', () => {
    const r = newerRelease(answer({ html_url: 'https://evil.example/download' }), '0.1.4');
    expect(r?.url).toBe('https://github.com/dbuffoni/Folio/releases/tag/v0.2.0');
    expect(newerRelease(answer({ html_url: 'javascript:alert(1)' }), '0.1.4')?.url.startsWith('https://github.com/dbuffoni/Folio/')).toBe(true);
  });
});
