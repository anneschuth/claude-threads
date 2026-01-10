/**
 * Tests for session title and description suggestion parsing
 *
 * Note: These tests focus on the buildTitlePrompt and parseMetadata functions.
 * Integration tests for the full suggestSessionMetadata flow would require
 * the Claude CLI, so they belong in the integration test suite.
 */

import { describe, expect, test } from 'bun:test';
import { buildTitlePrompt, parseMetadata } from './title-suggest.js';

describe('buildTitlePrompt', () => {
  test('builds prompt with user message', () => {
    const prompt = buildTitlePrompt('fix the login button not working');

    expect(prompt).toContain('fix the login button not working');
    expect(prompt).toContain('Generate a session title and description');
    expect(prompt).toContain('TITLE:');
    expect(prompt).toContain('DESC:');
  });

  test('includes formatting rules for title', () => {
    const prompt = buildTitlePrompt('add dark mode');

    expect(prompt).toContain('3-7 words');
    expect(prompt).toContain('imperative form');
    expect(prompt).toContain('Fix login bug');
    expect(prompt).toContain('Add dark mode');
  });

  test('includes formatting rules for description', () => {
    const prompt = buildTitlePrompt('update dependencies');

    expect(prompt).toContain('1-2 sentences');
    expect(prompt).toContain('under 100 characters');
    expect(prompt).toContain('Explain what will be accomplished');
  });

  test('includes output format instructions', () => {
    const prompt = buildTitlePrompt('refactor code');

    expect(prompt).toContain('Output format (exactly two lines)');
    expect(prompt).toContain('TITLE: <title here>');
    expect(prompt).toContain('DESC: <description here>');
  });

  test('truncates long messages at 500 characters', () => {
    const longMessage = 'a'.repeat(600);
    const prompt = buildTitlePrompt(longMessage);

    // Should contain truncated message (500 chars + '...')
    expect(prompt).toContain('a'.repeat(500) + '...');
    // Should NOT contain the full 600 character string
    expect(prompt).not.toContain('a'.repeat(600));
  });

  test('does not truncate messages under 500 characters', () => {
    const shortMessage = 'a'.repeat(400);
    const prompt = buildTitlePrompt(shortMessage);

    expect(prompt).toContain(shortMessage);
    expect(prompt).not.toContain('...');
  });

  test('truncates message exactly at 500 characters boundary', () => {
    const exactMessage = 'a'.repeat(500);
    const prompt = buildTitlePrompt(exactMessage);

    // 500 chars exactly should NOT be truncated
    expect(prompt).toContain(exactMessage);
    expect(prompt).not.toContain('...');
  });

  test('truncates message at 501 characters', () => {
    const overMessage = 'a'.repeat(501);
    const prompt = buildTitlePrompt(overMessage);

    expect(prompt).toContain('a'.repeat(500) + '...');
    expect(prompt).not.toContain('a'.repeat(501));
  });

  test('handles empty message', () => {
    const prompt = buildTitlePrompt('');

    expect(prompt).toContain('Task: ""');
    expect(prompt).toContain('TITLE:');
    expect(prompt).toContain('DESC:');
  });

  test('handles message with special characters', () => {
    const message = 'fix bug with "quotes" and <brackets>';
    const prompt = buildTitlePrompt(message);

    expect(prompt).toContain(message);
  });

  test('handles message with newlines', () => {
    const message = 'line one\nline two\nline three';
    const prompt = buildTitlePrompt(message);

    expect(prompt).toContain(message);
  });
});

describe('parseMetadata', () => {
  test('parses valid response with title and description', () => {
    const response = 'TITLE: Fix login button\nDESC: Debugging the non-functional login button.';
    const metadata = parseMetadata(response);

    expect(metadata).not.toBeNull();
    expect(metadata?.title).toBe('Fix login button');
    expect(metadata?.description).toBe('Debugging the non-functional login button.');
  });

  test('parses response with extra whitespace', () => {
    const response = 'TITLE:   Add dark mode toggle   \nDESC:   Implementing theme switching.   ';
    const metadata = parseMetadata(response);

    expect(metadata).not.toBeNull();
    expect(metadata?.title).toBe('Add dark mode toggle');
    expect(metadata?.description).toBe('Implementing theme switching.');
  });

  test('parses response case-insensitively', () => {
    const response = 'title: Update dependencies\ndesc: Upgrading all project dependencies.';
    const metadata = parseMetadata(response);

    expect(metadata).not.toBeNull();
    expect(metadata?.title).toBe('Update dependencies');
    expect(metadata?.description).toBe('Upgrading all project dependencies.');
  });

  test('parses response with mixed case labels', () => {
    const response = 'Title: Refactor module\nDesc: Cleaning up the module structure.';
    const metadata = parseMetadata(response);

    expect(metadata).not.toBeNull();
    expect(metadata?.title).toBe('Refactor module');
    expect(metadata?.description).toBe('Cleaning up the module structure.');
  });

  test('returns null when title is missing', () => {
    const response = 'DESC: Some description here.';
    const metadata = parseMetadata(response);

    expect(metadata).toBeNull();
  });

  test('returns null when description is missing', () => {
    const response = 'TITLE: Some title here';
    const metadata = parseMetadata(response);

    expect(metadata).toBeNull();
  });

  test('returns null for empty response', () => {
    const metadata = parseMetadata('');

    expect(metadata).toBeNull();
  });

  test('returns null for whitespace-only response', () => {
    const metadata = parseMetadata('   \n  \n   ');

    expect(metadata).toBeNull();
  });

  test('returns null for malformed response', () => {
    const response = 'This is just some random text without proper formatting';
    const metadata = parseMetadata(response);

    expect(metadata).toBeNull();
  });

  // Title length validation tests (MIN_TITLE_LENGTH = 3, MAX_TITLE_LENGTH = 50)
  test('returns null when title is too short (less than 3 chars)', () => {
    const response = 'TITLE: Ab\nDESC: Valid description here.';
    const metadata = parseMetadata(response);

    expect(metadata).toBeNull();
  });

  test('accepts title at minimum length (3 chars)', () => {
    const response = 'TITLE: Fix\nDESC: Valid description here.';
    const metadata = parseMetadata(response);

    expect(metadata).not.toBeNull();
    expect(metadata?.title).toBe('Fix');
  });

  test('returns null when title is too long (more than 50 chars)', () => {
    const longTitle = 'a'.repeat(51);
    const response = `TITLE: ${longTitle}\nDESC: Valid description here.`;
    const metadata = parseMetadata(response);

    expect(metadata).toBeNull();
  });

  test('accepts title at maximum length (50 chars)', () => {
    const maxTitle = 'a'.repeat(50);
    const response = `TITLE: ${maxTitle}\nDESC: Valid description here.`;
    const metadata = parseMetadata(response);

    expect(metadata).not.toBeNull();
    expect(metadata?.title).toBe(maxTitle);
  });

  // Description length validation tests (MIN_DESC_LENGTH = 5, MAX_DESC_LENGTH = 100)
  test('returns null when description is too short (less than 5 chars)', () => {
    const response = 'TITLE: Valid title\nDESC: Test';
    const metadata = parseMetadata(response);

    expect(metadata).toBeNull();
  });

  test('accepts description at minimum length (5 chars)', () => {
    const response = 'TITLE: Valid title\nDESC: Tests';
    const metadata = parseMetadata(response);

    expect(metadata).not.toBeNull();
    expect(metadata?.description).toBe('Tests');
  });

  test('returns null when description is too long (more than 100 chars)', () => {
    const longDesc = 'a'.repeat(101);
    const response = `TITLE: Valid title\nDESC: ${longDesc}`;
    const metadata = parseMetadata(response);

    expect(metadata).toBeNull();
  });

  test('accepts description at maximum length (100 chars)', () => {
    const maxDesc = 'a'.repeat(100);
    const response = `TITLE: Valid title\nDESC: ${maxDesc}`;
    const metadata = parseMetadata(response);

    expect(metadata).not.toBeNull();
    expect(metadata?.description).toBe(maxDesc);
  });

  test('handles response with extra lines', () => {
    const response =
      'Here is the suggestion:\nTITLE: Add feature\nDESC: Adding a new feature.\nHope this helps!';
    const metadata = parseMetadata(response);

    expect(metadata).not.toBeNull();
    expect(metadata?.title).toBe('Add feature');
    expect(metadata?.description).toBe('Adding a new feature.');
  });

  test('handles response with reversed order', () => {
    const response = 'DESC: Fixing the bug.\nTITLE: Fix bug';
    const metadata = parseMetadata(response);

    expect(metadata).not.toBeNull();
    expect(metadata?.title).toBe('Fix bug');
    expect(metadata?.description).toBe('Fixing the bug.');
  });

  test('handles title with special characters', () => {
    const response = 'TITLE: Fix "special" bug\nDESC: Handling special characters in titles.';
    const metadata = parseMetadata(response);

    expect(metadata).not.toBeNull();
    expect(metadata?.title).toBe('Fix "special" bug');
  });

  test('handles description with special characters', () => {
    const response = 'TITLE: Update config\nDESC: Updating <config> with "new" values.';
    const metadata = parseMetadata(response);

    expect(metadata).not.toBeNull();
    expect(metadata?.description).toBe('Updating <config> with "new" values.');
  });

  test('handles colons in title content', () => {
    const response = 'TITLE: Fix: login issue\nDESC: Resolving the login problem.';
    const metadata = parseMetadata(response);

    expect(metadata).not.toBeNull();
    expect(metadata?.title).toBe('Fix: login issue');
  });

  test('handles colons in description content', () => {
    const response = 'TITLE: Update docs\nDESC: Note: this updates documentation.';
    const metadata = parseMetadata(response);

    expect(metadata).not.toBeNull();
    expect(metadata?.description).toBe('Note: this updates documentation.');
  });
});
