import { describe, it, expect } from 'vitest'
import {
  needsCompact,
  resolveCompactModel,
  resolveCompactionRequest,
} from '../../src/routing/compactionModelRoute'

describe('compactionModelRoute', () => {
  describe('needsCompact', () => {
    it('returns false when under budget (no compaction needed)', () => {
      expect(needsCompact(100, 200)).toBe(false)
      expect(needsCompact(0, 100)).toBe(false)
      expect(needsCompact(500, 1000)).toBe(false)
    })

    it('returns true when over budget', () => {
      expect(needsCompact(300, 200)).toBe(true)
      expect(needsCompact(1001, 1000)).toBe(true)
    })

    it('returns false when exactly at budget', () => {
      expect(needsCompact(200, 200)).toBe(false)
    })
  })

  describe('resolveCompactModel', () => {
    it('uses compact slot when available', () => {
      const slots = { compact: 'gpt-4o-mini', normal: 'gpt-4o' }
      expect(resolveCompactModel(slots)).toBe('gpt-4o-mini')
    })

    it('falls back to normal when compact slot is missing', () => {
      const slots = { normal: 'gpt-4o' }
      expect(resolveCompactModel(slots)).toBe('gpt-4o')
    })

    it('returns undefined when neither slot is available', () => {
      const slots = {}
      expect(resolveCompactModel(slots)).toBeUndefined()
    })
  })

  describe('resolveCompactionRequest', () => {
    it('returns null when under budget (no compaction needed)', () => {
      const result = resolveCompactionRequest({
        tokenCount: 100,
        budget: 200,
        slots: { compact: 'gpt-4o-mini', normal: 'gpt-4o' },
      })
      expect(result).toBeNull()
    })

    it('returns compaction request with compact model when over budget', () => {
      const result = resolveCompactionRequest({
        tokenCount: 300,
        budget: 200,
        slots: { compact: 'gpt-4o-mini', normal: 'gpt-4o' },
      })
      expect(result).not.toBeNull()
      expect(result?.model).toBe('gpt-4o-mini')
      expect(result?.reason).toBe('history_exceeds_budget')
      expect(result?.tokenCount).toBe(300)
      expect(result?.budget).toBe(200)
    })

    it('falls back to normal model when compact slot is missing', () => {
      const result = resolveCompactionRequest({
        tokenCount: 300,
        budget: 200,
        slots: { normal: 'gpt-4o' },
      })
      expect(result).not.toBeNull()
      expect(result?.model).toBe('gpt-4o')
    })
  })
})
