/**
 * Unit tests for the fuzzy matching utilities.
 *
 * Covers exact, prefix, subsequence, no-match, token-based filtering, and
 * alpha-numeric swap fallback — all behavior copied from the pi TUI fuzzy.js.
 */

import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyMatch } from './fuzzy';

describe('fuzzyMatch', () => {
  it('matches when query is empty', () => {
    const result = fuzzyMatch('', 'anything');
    expect(result.matches).toBe(true);
    expect(result.score).toBe(0);
  });

  it('does not match when query is longer than text', () => {
    const result = fuzzyMatch('toolong', 'short');
    expect(result.matches).toBe(false);
    expect(result.score).toBe(0);
  });

  it('rewards an exact match with the best score', () => {
    const exact = fuzzyMatch('README', 'README');
    const prefix = fuzzyMatch('READ', 'README');
    const substring = fuzzyMatch('EDM', 'README');

    expect(exact.matches).toBe(true);
    expect(prefix.matches).toBe(true);
    expect(substring.matches).toBe(true);
    expect(exact.score).toBeLessThan(prefix.score); // lower score = better
    expect(prefix.score).toBeLessThan(substring.score);
  });

  it('rewards prefix matches over substring matches', () => {
    const prefix = fuzzyMatch('test', 'testing');
    const substring = fuzzyMatch('test', 'my-test-file');

    expect(prefix.matches).toBe(true);
    expect(substring.matches).toBe(true);
    expect(prefix.score).toBeLessThan(substring.score);
  });

  it('rewards word-boundary matches', () => {
    const wordBoundary = fuzzyMatch('sm', 'src/main.ts');
    const nonBoundary = fuzzyMatch('sm', 'osmium.ts');

    expect(wordBoundary.matches).toBe(true);
    expect(nonBoundary.matches).toBe(true);
    expect(wordBoundary.score).toBeLessThan(nonBoundary.score);
  });

  it('rewards consecutive matches', () => {
    const consecutive = fuzzyMatch('abc', 'abc.ts');
    const separated = fuzzyMatch('abc', 'a-b-c.ts');

    expect(consecutive.matches).toBe(true);
    expect(separated.matches).toBe(true);
    expect(consecutive.score).toBeLessThan(separated.score);
  });

  it('uses alpha-numeric swap fallback when primary query does not match', () => {
    // "f2" as letters+digits could have been intended as "2f".
    const primary = fuzzyMatch('f2', 'file2.txt');
    const swapped = fuzzyMatch('2f', 'file2.txt');

    expect(primary.matches).toBe(true);
    expect(swapped.matches).toBe(true);
    // The primary interpretation is better (lower score) than the swap fallback,
    // but both must find the text.
    expect(primary.score).toBeLessThan(swapped.score);
  });

  it('returns no match when nothing fits even with swap', () => {
    const result = fuzzyMatch('xyz', 'abc');
    expect(result.matches).toBe(false);
    expect(result.score).toBe(0);
  });
});

describe('fuzzyFilter', () => {
  const items = [
    'testing.ts',
    'telemetry.md',
    'src/utils/helpers.ts',
    'architecture.canvas',
    'README.md',
    'obsidian-pi/manifest.json',
  ];
  const getText = (item: string) => item;

  it('returns all items for an empty query', () => {
    expect(fuzzyFilter(items, '', getText)).toEqual(items);
  });

  it('returns all items for whitespace-only query', () => {
    expect(fuzzyFilter(items, '   ', getText)).toEqual(items);
  });

  it('sorts prefix matches before substring matches', () => {
    const result = fuzzyFilter(items, 'te', getText);
    expect(result.slice(0, 2)).toContain('testing.ts');
    expect(result.slice(0, 2)).toContain('telemetry.md');
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('supports slash-separated tokens (directory + file)', () => {
    const result = fuzzyFilter(items, 'src/help', getText);
    expect(result).toContain('src/utils/helpers.ts');
  });

  it('requires all tokens to match', () => {
    const result = fuzzyFilter(items, 'src readme', getText);
    expect(result).not.toContain('README.md');
    expect(result).not.toContain('src/utils/helpers.ts');
    expect(result).toHaveLength(0);
  });

  it('filters by full path as well as filename', () => {
    const result = fuzzyFilter(items, 'mani', getText);
    expect(result).toContain('obsidian-pi/manifest.json');
  });
});
