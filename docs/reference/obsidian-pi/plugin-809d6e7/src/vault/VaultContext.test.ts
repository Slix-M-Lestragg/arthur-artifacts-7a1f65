import { describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { VaultContext } from './VaultContext';
import type { App, TFile } from 'obsidian';

function makeApp(vaultBase: string, linkMap: Record<string, string>): App {
  return {
    vault: { adapter: { basePath: vaultBase } },
    metadataCache: {
      getFirstLinkpathDest: vi.fn((linkpath: string) => {
        const filePath = linkMap[linkpath];
        return filePath ? ({ path: filePath } as TFile) : null;
      }),
    },
    workspace: {
      getActiveFile: vi.fn(() => null),
      getActiveViewOfType: vi.fn(() => null),
      openLinkText: vi.fn(),
    },
  } as unknown as App;
}

describe('VaultContext wikilink resolution (cwd-independent)', () => {
  it('resolves a top-level wikilink to an absolute vault path', () => {
    const vaultBase = path.join(os.tmpdir(), 'pi-test-vault');
    const app = makeApp(vaultBase, { Note: 'Note.md' });
    const ctx = new VaultContext(app);

    expect(ctx.resolveWikilink('[[Note]]')).toBe(path.join(vaultBase, 'Note.md'));
  });

  it('resolves wikilinks inside text to absolute paths, leaving unresolved links unchanged', () => {
    const vaultBase = path.join(os.tmpdir(), 'pi-test-vault');
    const app = makeApp(vaultBase, { Note: 'Note.md', Other: 'Other.md' });
    const ctx = new VaultContext(app);

    const result = ctx.replaceWikilinks('see [[Note]] and [[Missing]]');
    expect(result).toBe(
      `see ${path.join(vaultBase, 'Note.md')} and [[Missing]]`,
    );
  });

  it('resolves nested wikilinks without double slashes or relative segments', () => {
    const vaultBase = path.join(os.tmpdir(), 'pi-test-vault') + path.sep;
    const app = makeApp(vaultBase, { 'Nested/Note': 'projects/Nested/Note.md' });
    const ctx = new VaultContext(app);

    const resolved = ctx.resolveWikilink('[[Nested/Note]]');
    expect(path.isAbsolute(resolved!)).toBe(true);
    expect(resolved).toBe(path.join(vaultBase, 'projects/Nested/Note.md'));
    expect(resolved).not.toContain('//');
    expect(resolved).not.toContain('./');
  });

  it('strips aliases and heading references before resolving', () => {
    const vaultBase = path.join(os.tmpdir(), 'pi-test-vault');
    const app = makeApp(vaultBase, { Note: 'Note.md' });
    const ctx = new VaultContext(app);

    expect(ctx.resolveWikilink('[[Note#Heading]]')).toBe(path.join(vaultBase, 'Note.md'));
    expect(ctx.resolveWikilink('[[Note|alias]]')).toBe(path.join(vaultBase, 'Note.md'));
  });

  it('does not depend on the Node process cwd', () => {
    const vaultBase = path.join(os.tmpdir(), 'pi-test-vault');
    fs.mkdirSync(vaultBase, { recursive: true });
    const app = makeApp(vaultBase, { Note: 'Note.md' });
    const ctx = new VaultContext(app);

    const originalCwd = process.cwd();
    try {
      process.chdir(vaultBase);
      expect(ctx.resolveWikilink('[[Note]]')).toBe(path.join(vaultBase, 'Note.md'));
      process.chdir(os.tmpdir());
      expect(ctx.resolveWikilink('[[Note]]')).toBe(path.join(vaultBase, 'Note.md'));
    } finally {
      process.chdir(originalCwd);
    }
  });
});
