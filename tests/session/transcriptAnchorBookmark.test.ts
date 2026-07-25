import { describe, it, expect, beforeEach } from 'vitest';
import { TranscriptAnchorBookmark, type AnchorBookmark } from '../../src/session/transcriptAnchorBookmark.js';

describe('TranscriptAnchorBookmark', () => {
  let store: TranscriptAnchorBookmark;

  beforeEach(() => {
    store = new TranscriptAnchorBookmark();
  });

  describe('set', () => {
    it('creates a bookmark for a valid messageId', () => {
      const bookmark = store.set('msg-123');
      expect(bookmark).toBeDefined();
      expect(bookmark.messageId).toBe('msg-123');
      expect(bookmark.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(store.has('msg-123')).toBe(true);
    });

    it('trims whitespace from messageId', () => {
      store.set('  msg-456  ');
      expect(store.has('msg-456')).toBe(true);
      expect(store.list()).toEqual(['msg-456']);
    });

    it('throws on invalid messageId', () => {
      expect(() => store.set('')).toThrow(/messageId must be a non-empty string/);
      expect(() => store.set('   ')).toThrow(/messageId must be a non-empty string/);
      // @ts-expect-error testing runtime guard
      expect(() => store.set(null)).toThrow();
    });

    it('is idempotent — re-setting same id updates timestamp but keeps id', () => {
      const first = store.set('msg-789');
      const second = store.set('msg-789');
      expect(second.messageId).toBe('msg-789');
      expect(store.size()).toBe(1);
    });
  });

  describe('get / resolve', () => {
    it('returns the bookmark when present', () => {
      store.set('msg-present');
      const found = store.get('msg-present');
      expect(found).toBeDefined();
      expect(found!.messageId).toBe('msg-present');
    });

    it('returns undefined for missing id (fails closed)', () => {
      expect(store.get('nonexistent')).toBeUndefined();
      expect(store.get('')).toBeUndefined();
      expect(store.get('   ')).toBeUndefined();
    });

    it('fails closed on invalid input types', () => {
      // @ts-expect-error testing runtime guard
      expect(store.get(null)).toBeUndefined();
      // @ts-expect-error testing runtime guard
      expect(store.get(undefined)).toBeUndefined();
      // @ts-expect-error testing runtime guard
      expect(store.get(123)).toBeUndefined();
    });
  });

  describe('has', () => {
    it('returns true for bookmarked id', () => {
      store.set('msg-has');
      expect(store.has('msg-has')).toBe(true);
    });

    it('returns false for missing id (fails closed)', () => {
      expect(store.has('missing')).toBe(false);
      expect(store.has('')).toBe(false);
    });
  });

  describe('list — stable order', () => {
    it('returns empty array when no bookmarks', () => {
      expect(store.list()).toEqual([]);
    });

    it('returns messageIds in sorted stable order', () => {
      store.set('msg-c');
      store.set('msg-a');
      store.set('msg-b');
      expect(store.list()).toEqual(['msg-a', 'msg-b', 'msg-c']);
    });

    it('list order remains stable after remove and re-add', () => {
      store.set('z-last');
      store.set('a-first');
      store.remove('z-last');
      store.set('m-middle');
      expect(store.list()).toEqual(['a-first', 'm-middle']);
    });
  });

  describe('remove and clear', () => {
    it('remove is no-op for missing id (fails closed)', () => {
      store.set('keep');
      store.remove('ghost');
      expect(store.size()).toBe(1);
      expect(store.has('keep')).toBe(true);
    });

    it('clear removes all bookmarks', () => {
      store.set('one');
      store.set('two');
      store.clear();
      expect(store.size()).toBe(0);
      expect(store.list()).toEqual([]);
    });
  });

  describe('size', () => {
    it('reports correct count', () => {
      expect(store.size()).toBe(0);
      store.set('x');
      expect(store.size()).toBe(1);
      store.set('y');
      expect(store.size()).toBe(2);
    });
  });
});
