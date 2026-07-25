import { describe, it, expect } from 'vitest';
import { runSequential, sequentialAgentPipeline as seqAlias } from '../../src/swarm/sequentialAgentPipeline.js';

describe('sequentialAgentPipeline', () => {
  describe('basic composition', () => {
    it('returns a function when given transforms', () => {
      const transforms = [(x: number) => x + 1];
      const pipeline = runSequential(transforms);
      expect(typeof pipeline).toBe('function');
    });

    it('applies a single transform to initial input', () => {
      const double = (x: number) => x * 2;
      const pipeline = runSequential([double]);
      expect(pipeline(5)).toBe(10);
    });

    it('applies two transforms in sequence', () => {
      const double = (x: number) => x * 2;
      const addOne = (x: number) => x + 1;
      const pipeline = runSequential([double, addOne]);
      // (5 * 2) + 1 = 11
      expect(pipeline(5)).toBe(11);
    });

    it('applies three transforms in sequence preserving order', () => {
      const addOne = (x: number) => x + 1;
      const double = (x: number) => x * 2;
      const subtractThree = (x: number) => x - 3;
      const pipeline = runSequential([addOne, double, subtractThree]);
      // ((5 + 1) * 2) - 3 = 9
      expect(pipeline(5)).toBe(9);
    });
  });

  describe('order preservation', () => {
    it('produces different results for different transform orders', () => {
      const double = (x: number) => x * 2;
      const addTen = (x: number) => x + 10;

      const order1 = runSequential([double, addTen]);
      const order2 = runSequential([addTen, double]);

      // (5 * 2) + 10 = 20
      expect(order1(5)).toBe(20);
      // (5 + 10) * 2 = 30
      expect(order2(5)).toBe(30);
    });
  });

  describe('edge cases', () => {
    it('handles empty transform array as identity function', () => {
      const pipeline = runSequential<number>([]);
      expect(pipeline(42)).toBe(42);
    });

    it('handles identity transforms', () => {
      const identity = <T>(x: T): T => x;
      const pipeline = runSequential([identity, identity, identity]);
      expect(pipeline('hello')).toBe('hello');
    });

    it('works with string transformations', () => {
      const toUpper = (s: string) => s.toUpperCase();
      const appendExclaim = (s: string) => s + '!';
      const pipeline = runSequential([toUpper, appendExclaim]);
      expect(pipeline('hello')).toBe('HELLO!');
    });

    it('works with object transformations', () => {
      interface User {
        name: string;
        age: number;
      }
      const setName = (u: User) => ({ ...u, name: 'Alice' });
      const incrementAge = (u: User) => ({ ...u, age: u.age + 1 });
      const pipeline = runSequential([setName, incrementAge]);
      const result = pipeline({ name: 'Bob', age: 30 });
      expect(result).toEqual({ name: 'Alice', age: 31 });
    });
  });

  describe('determinism', () => {
    it('produces identical results on repeated calls with same input', () => {
      const double = (x: number) => x * 2;
      const addFive = (x: number) => x + 5;
      const pipeline = runSequential([double, addFive]);

      const result1 = pipeline(10);
      const result2 = pipeline(10);
      const result3 = pipeline(10);

      expect(result1).toBe(25);
      expect(result2).toBe(25);
      expect(result3).toBe(25);
    });
  });

  describe('readonly array support', () => {
    it('accepts readonly arrays without mutation', () => {
      const transforms: ReadonlyArray<(x: number) => number> = [
        (x) => x + 1,
        (x) => x * 2,
      ];
      const pipeline = runSequential(transforms);
      expect(pipeline(3)).toBe(8); // (3 + 1) * 2 = 8
    });
  });

  describe('PLAN alignment: runSequential export and exact compatibility alias', () => {
    it('exports runSequential as primary API per PLAN', () => {
      const double = (x: number) => x * 2;
      const pipeline = runSequential([double]);
      expect(pipeline(5)).toBe(10);
    });

    it('provides exact compatibility alias sequentialAgentPipeline', () => {
      const addOne = (x: number) => x + 1;
      // Using the alias import
      const pipeline = seqAlias([addOne]);
      expect(pipeline(5)).toBe(6);
    });

    it('alias and primary produce identical results', () => {
      const double = (x: number) => x * 2;
      const addTen = (x: number) => x + 10;
      const p1 = runSequential([double, addTen]);
      const p2 = seqAlias([double, addTen]);
      expect(p1(5)).toBe(p2(5));
      expect(p1(5)).toBe(20);
    });
  });
});
