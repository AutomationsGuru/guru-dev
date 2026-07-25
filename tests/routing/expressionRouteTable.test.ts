import { describe, expect, it } from "vitest";

import { all, any, anyOf, contains, exact, route, type ExpressionRouteRule } from '../../src/routing/expressionRouteTable.js';

describe("expression route table", () => {
  it("returns the target of the first matching rule", () => {
    const rules: readonly ExpressionRouteRule<string, string>[] = [
      { name: "a", match: (input) => input.startsWith("x"), target: "x-handler" },
      { name: "b", match: (input) => input.startsWith("y"), target: "y-handler" }
    ];

    expect(route("yolo", rules)).toEqual({ matched: true, ruleName: "b", target: "y-handler" });
  });

  it("reports a miss when no rule matches", () => {
    const rules: readonly ExpressionRouteRule<string, string>[] = [
      { name: "a", match: (input) => input === "one", target: "one-handler" }
    ];

    expect(route("two", rules)).toEqual({ matched: false, ruleName: undefined, target: undefined });
  });

  it("returns a miss for an empty rule list", () => {
    expect(route("anything", [])).toEqual({ matched: false, ruleName: undefined, target: undefined });
  });

  it("stops at the first match and respects order", () => {
    const rules: readonly ExpressionRouteRule<number, string>[] = [
      { name: "positive", match: (n) => n > 0, target: "positive" },
      { name: "even", match: (n) => n % 2 === 0, target: "even" }
    ];

    expect(route(4, rules)).toEqual({ matched: true, ruleName: "positive", target: "positive" });
  });

  it("supports exact field matching", () => {
    type Input = { readonly command: string };
    const rules: readonly ExpressionRouteRule<Input, string>[] = [
      { name: "log", match: exact("command", "/log"), target: "show-log" },
      { name: "help", match: exact("command", "/help"), target: "show-help" }
    ];

    expect(route({ command: "/help" }, rules)).toEqual({ matched: true, ruleName: "help", target: "show-help" });
  });

  it("supports contains matching", () => {
    type Input = { readonly command: string };
    const rules: readonly ExpressionRouteRule<Input, string>[] = [
      { name: "debug", match: contains("command", "debug"), target: "debug-handler" },
      { name: "fallback", match: any(), target: "default-handler" }
    ];

    expect(route({ command: "run-debug-now" }, rules)).toEqual({ matched: true, ruleName: "debug", target: "debug-handler" });
  });

  it("supports all / anyOf combinators", () => {
    type Input = { readonly role: string; readonly mode: string };
    const rules: readonly ExpressionRouteRule<Input, string>[] = [
      {
        name: "admin-yolo",
        match: all(
          exact("role", "admin"),
          exact("mode", "yolo")
        ),
        target: "admin-yolo"
      },
      {
        name: "any-admin-or-yolo",
        match: anyOf(exact("role", "admin"), exact("mode", "yolo")),
        target: "admin-or-yolo"
      }
    ];

    expect(route({ role: "admin", mode: "yolo" }, rules)).toEqual({ matched: true, ruleName: "admin-yolo", target: "admin-yolo" });
    expect(route({ role: "admin", mode: "safe" }, rules)).toEqual({ matched: true, ruleName: "any-admin-or-yolo", target: "admin-or-yolo" });
  });
});
