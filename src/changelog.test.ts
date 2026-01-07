import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs';
import { getReleaseNotes, formatReleaseNotes, getWhatsNewSummary } from './changelog.js';
import { createMockFormatter } from './test-utils/mock-formatter.js';

// Mock CHANGELOG content for testing
const MOCK_CHANGELOG = `# Changelog

All notable changes to this project will be documented in this file.

## [0.39.0] - 2026-01-06

### Added
- Multi-platform support for Slack and Mattermost
- Session persistence and resume

### Fixed
- Memory leak in WebSocket connections
- Race condition in message handling

### Changed
- Updated dependencies to latest versions

## [0.38.0] - 2026-01-01

### Added
- Git worktree integration
- Context prompt for thread history

### Fixed
- Timeout handling bug

## [0.37.0]

### Added
- Initial release with basic features
`;

describe('changelog', () => {
  describe('getReleaseNotes (with mocked filesystem)', () => {
    let existsSyncSpy: ReturnType<typeof spyOn>;
    let readFileSyncSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      // Mock existsSync to return true for first path
      existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
        // Return true for the first CHANGELOG.md path tried
        return String(path).includes('CHANGELOG.md');
      });

      // Mock readFileSync to return our mock changelog
      readFileSyncSpy = spyOn(fs, 'readFileSync').mockReturnValue(MOCK_CHANGELOG as any);
    });

    afterEach(() => {
      existsSyncSpy.mockRestore();
      readFileSyncSpy.mockRestore();
    });

    it('parses latest version when no version specified', () => {
      const notes = getReleaseNotes();

      expect(notes).not.toBeNull();
      expect(notes!.version).toBe('0.39.0');
      expect(notes!.date).toBe('2026-01-06');
    });

    it('parses specific version when requested', () => {
      const notes = getReleaseNotes('0.38.0');

      expect(notes).not.toBeNull();
      expect(notes!.version).toBe('0.38.0');
      expect(notes!.date).toBe('2026-01-01');
    });

    it('returns null for non-existent version', () => {
      const notes = getReleaseNotes('9.9.9');

      expect(notes).toBeNull();
    });

    it('parses all sections correctly', () => {
      const notes = getReleaseNotes('0.39.0');

      expect(notes).not.toBeNull();
      expect(notes!.sections['Added']).toEqual([
        'Multi-platform support for Slack and Mattermost',
        'Session persistence and resume',
      ]);
      expect(notes!.sections['Fixed']).toEqual([
        'Memory leak in WebSocket connections',
        'Race condition in message handling',
      ]);
      expect(notes!.sections['Changed']).toEqual([
        'Updated dependencies to latest versions',
      ]);
    });

    it('handles version without date', () => {
      const notes = getReleaseNotes('0.37.0');

      expect(notes).not.toBeNull();
      expect(notes!.version).toBe('0.37.0');
      expect(notes!.date).toBe('');
    });
  });

  describe('getReleaseNotes (file not found)', () => {
    it('returns null when CHANGELOG.md does not exist', () => {
      const existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(false);

      const notes = getReleaseNotes();

      expect(notes).toBeNull();

      existsSyncSpy.mockRestore();
    });

    it('returns null when readFileSync throws', () => {
      const existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
      const readFileSyncSpy = spyOn(fs, 'readFileSync').mockImplementation(() => {
        throw new Error('File read error');
      });

      const notes = getReleaseNotes();

      expect(notes).toBeNull();

      existsSyncSpy.mockRestore();
      readFileSyncSpy.mockRestore();
    });
  });

  describe('formatReleaseNotes', () => {
    const mockFormatter = createMockFormatter();

    it('formats release notes with date', () => {
      const notes = {
        version: '1.0.0',
        date: '2026-01-01',
        sections: {
          Added: ['Feature 1', 'Feature 2'],
        },
      };

      const formatted = formatReleaseNotes(notes, mockFormatter);

      expect(formatted).toContain('📋 Release Notes - v1.0.0');
      expect(formatted).toContain('(2026-01-01)');
      expect(formatted).toContain('✨ Added');
      expect(formatted).toContain('- Feature 1');
      expect(formatted).toContain('- Feature 2');
    });

    it('formats release notes without date', () => {
      const notes = {
        version: '1.0.0',
        date: '',
        sections: {
          Fixed: ['Bug fix 1'],
        },
      };

      const formatted = formatReleaseNotes(notes, mockFormatter);

      expect(formatted).toContain('📋 Release Notes - v1.0.0');
      expect(formatted).not.toContain('()');
      expect(formatted).toContain('🐛 Fixed');
    });

    it('uses correct emoji for each section type', () => {
      const notes = {
        version: '1.0.0',
        date: '',
        sections: {
          Added: ['New feature'],
          Fixed: ['Bug fix'],
          Changed: ['Changed behavior'],
          Removed: ['Deprecated feature'],
          Other: ['Other item'],
        },
      };

      const formatted = formatReleaseNotes(notes, mockFormatter);

      expect(formatted).toContain('✨ Added');
      expect(formatted).toContain('🐛 Fixed');
      expect(formatted).toContain('🔄 Changed');
      expect(formatted).toContain('🗑️ Removed');
      expect(formatted).toContain('• Other');
    });

    it('skips empty sections', () => {
      const notes = {
        version: '1.0.0',
        date: '',
        sections: {
          Added: ['Feature'],
          Fixed: [],
        },
      };

      const formatted = formatReleaseNotes(notes, mockFormatter);

      expect(formatted).toContain('✨ Added');
      expect(formatted).not.toContain('Fixed');
    });
  });

  describe('getWhatsNewSummary', () => {
    it('returns summary from Added section first', () => {
      const notes = {
        version: '1.0.0',
        date: '',
        sections: {
          Added: ['New feature one', 'New feature two'],
          Fixed: ['Bug fix'],
        },
      };

      const summary = getWhatsNewSummary(notes);

      expect(summary).toBe('New feature one, New feature two');
    });

    it('falls back to Fixed section when Added is empty', () => {
      const notes = {
        version: '1.0.0',
        date: '',
        sections: {
          Added: [],
          Fixed: ['Bug fix one'],
        },
      };

      const summary = getWhatsNewSummary(notes);

      expect(summary).toBe('Bug fix one');
    });

    it('falls back to Changed section when Added and Fixed are empty', () => {
      const notes = {
        version: '1.0.0',
        date: '',
        sections: {
          Added: [],
          Fixed: [],
          Changed: ['Updated API'],
        },
      };

      const summary = getWhatsNewSummary(notes);

      expect(summary).toBe('Updated API');
    });

    it('truncates long items to 50 characters', () => {
      const longItem = 'This is a very long feature description that exceeds fifty characters and should be truncated';
      const notes = {
        version: '1.0.0',
        date: '',
        sections: {
          Added: [longItem],
        },
      };

      const summary = getWhatsNewSummary(notes);

      expect(summary.length).toBeLessThanOrEqual(50);
      expect(summary).toContain('...');
    });

    it('removes markdown bold markers', () => {
      const notes = {
        version: '1.0.0',
        date: '',
        sections: {
          Added: ['**Bold feature** - with description'],
        },
      };

      const summary = getWhatsNewSummary(notes);

      expect(summary).toBe('Bold feature');
      expect(summary).not.toContain('**');
    });

    it('returns up to 2 items', () => {
      const notes = {
        version: '1.0.0',
        date: '',
        sections: {
          Added: ['Item 1', 'Item 2', 'Item 3', 'Item 4'],
        },
      };

      const summary = getWhatsNewSummary(notes);
      const itemCount = summary.split(',').length;

      expect(itemCount).toBeLessThanOrEqual(2);
    });

    it('handles missing sections gracefully', () => {
      const notes = {
        version: '1.0.0',
        date: '',
        sections: {},
      };

      const summary = getWhatsNewSummary(notes);

      expect(summary).toBe('');
    });

    it('extracts first part before dash', () => {
      const notes = {
        version: '1.0.0',
        date: '',
        sections: {
          Added: ['Feature name - detailed description here'],
        },
      };

      const summary = getWhatsNewSummary(notes);

      expect(summary).toBe('Feature name');
    });
  });
});
