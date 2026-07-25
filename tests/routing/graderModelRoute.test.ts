import { describe, expect, it } from "vitest";

import {
  createGraderModelRoute,
  DEFAULT_MAX_GRADING_ITERATIONS
} from '../../src/routing/graderModelRoute.js';

const NORMAL_SLOT = { name: "default", provider: "openai-compatible", model: "gpt-5.6-luna" } as const;

describe("graderModelRoute", () => {
  it("falls back to the normal slot when no grader override is set", () => {
    const route = createGraderModelRoute();

    const resolved = route.resolve(NORMAL_SLOT);

    expect(resolved.provider).toBe(NORMAL_SLOT.provider);
    expect(resolved.model).toBe(NORMAL_SLOT.model);
    expect(resolved.overridden).toBe(false);
    expect(resolved.maxIterations).toBe(DEFAULT_MAX_GRADING_ITERATIONS);
  });

  it("uses the grader override when set", () => {
    const route = createGraderModelRoute();
    route.setGrader("openai-compatible", "gpt-5.6-sol");

    const resolved = route.resolve(NORMAL_SLOT);

    expect(resolved.provider).toBe("openai-compatible");
    expect(resolved.model).toBe("gpt-5.6-sol");
    expect(resolved.overridden).toBe(true);
    expect(resolved.maxIterations).toBe(DEFAULT_MAX_GRADING_ITERATIONS);
  });

  it("falls back again after clearGrader", () => {
    const route = createGraderModelRoute();
    route.setGrader("openai-compatible", "gpt-5.6-sol");
    route.clearGrader();

    const resolved = route.resolve(NORMAL_SLOT);

    expect(resolved.provider).toBe(NORMAL_SLOT.provider);
    expect(resolved.model).toBe(NORMAL_SLOT.model);
    expect(resolved.overridden).toBe(false);
    expect(route.getGrader()).toBeUndefined();
  });

  it("honours setMaxIterations for both override and fallback resolves", () => {
    const route = createGraderModelRoute();
    route.setMaxIterations(5);
    expect(route.resolve(NORMAL_SLOT).maxIterations).toBe(5);

    route.setGrader("openai-compatible", "gpt-5.6-sol");
    expect(route.resolve(NORMAL_SLOT).maxIterations).toBe(5);
  });

  it("exposes the current override via getGrader", () => {
    const route = createGraderModelRoute();
    expect(route.getGrader()).toBeUndefined();

    route.setGrader("openai-compatible", "gpt-5.6-terra");
    expect(route.getGrader()).toEqual({ provider: "openai-compatible", model: "gpt-5.6-terra" });
  });

  it("rejects empty provider or model on setGrader", () => {
    const route = createGraderModelRoute();

    expect(() => route.setGrader("", "gpt-5.6-sol")).toThrow(/provider/);
    expect(() => route.setGrader("   ", "gpt-5.6-sol")).toThrow(/provider/);
    expect(() => route.setGrader("openai-compatible", "")).toThrow(/model/);
    expect(() => route.setGrader("openai-compatible", "  ")).toThrow(/model/);
  });

  it("rejects non-positive and non-integer maxIterations", () => {
    const route = createGraderModelRoute();

    expect(() => route.setMaxIterations(0)).toThrow(/positive integer/);
    expect(() => route.setMaxIterations(-1)).toThrow(/positive integer/);
    expect(() => route.setMaxIterations(1.5)).toThrow(/positive integer/);
    expect(() => route.setMaxIterations(Number.NaN)).toThrow(/positive integer/);
    expect(() => createGraderModelRoute(0)).toThrow(/positive integer/);
  });

  it("accepts an explicit constructor maxIterations as the default cap", () => {
    const route = createGraderModelRoute(7);

    expect(route.getMaxIterations()).toBe(7);
    expect(route.resolve(NORMAL_SLOT).maxIterations).toBe(7);
  });
});
