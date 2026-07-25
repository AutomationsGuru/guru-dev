import {
  continueMiddleware,
  haltMiddleware,
  runMiddlewareChain,
  type Middleware,
  type MiddlewareChainOutcome,
  type MiddlewareContext
} from '../../src/runtime/middlewareChainOrder.js';

type Ctx = { log: string[] };
type ChainMiddleware = Middleware<Ctx, string>;

function recordingMiddleware(tag: string): ChainMiddleware {
  return (ctx) => {
    ctx.value.log.push(tag);
    return continueMiddleware(tag);
  };
}

function emptyCtx(): MiddlewareContext<Ctx> {
  return { value: { log: [] } };
}

describe("runMiddlewareChain", () => {
  describe("order", () => {
    it("runs every middleware left-to-right when all continue", () => {
      const ctx = emptyCtx();
      const chain: ReadonlyArray<ChainMiddleware> = [
        recordingMiddleware("A"),
        recordingMiddleware("B"),
        recordingMiddleware("C")
      ];

      const outcome = runMiddlewareChain(chain, ctx);

      expect(ctx.value.log).toEqual(["A", "B", "C"]);
      expect(outcome.results.map((result) => result.value)).toEqual(["A", "B", "C"]);
      expect(outcome.halted).toBe(false);
      expect(outcome.haltIndex).toBe(-1);
      expect(outcome.finalValue).toBe("C");
    });

    it("short-circuits at the first halt and does not call later middleware", () => {
      const ctx = emptyCtx();
      const haltingB: ChainMiddleware = (c) => {
        c.value.log.push("B");
        return haltMiddleware("halted-at-B");
      };
      const chain: ReadonlyArray<ChainMiddleware> = [
        recordingMiddleware("A"),
        haltingB,
        recordingMiddleware("C")
      ];

      const outcome = runMiddlewareChain(chain, ctx);

      // Proves C never ran.
      expect(ctx.value.log).toEqual(["A", "B"]);
      expect(ctx.value.log).not.toEqual(["A", "B", "C"]);
      expect(outcome.results.map((result) => result.value)).toEqual(["A", "halted-at-B"]);
      expect(outcome.halted).toBe(true);
      expect(outcome.haltIndex).toBe(1);
      expect(outcome.finalValue).toBe("halted-at-B");
    });
  });

  describe("empty and single-element chains", () => {
    it("completes with no results and is not halted for an empty chain", () => {
      const ctx = emptyCtx();

      const outcome = runMiddlewareChain([], ctx);

      expect(outcome.results).toEqual([]);
      expect(outcome.halted).toBe(false);
      expect(outcome.haltIndex).toBe(-1);
    });

    it("runs a single continue middleware and reports the continue value", () => {
      const ctx = emptyCtx();

      const outcome = runMiddlewareChain([recordingMiddleware("only")], ctx);

      expect(outcome.results.map((result) => result.type)).toEqual(["continue"]);
      expect(outcome.results.map((result) => result.value)).toEqual(["only"]);
      expect(outcome.halted).toBe(false);
      expect(outcome.haltIndex).toBe(-1);
      expect(outcome.finalValue).toBe("only");
    });

    it("halts on a single halt middleware and reports halt at index 0", () => {
      const ctx = emptyCtx();
      const onlyHalt: ChainMiddleware = (c) => {
        c.value.log.push("halt");
        return haltMiddleware("stop");
      };

      const outcome = runMiddlewareChain([onlyHalt], ctx);

      expect(ctx.value.log).toEqual(["halt"]);
      expect(outcome.results.map((result) => result.type)).toEqual(["halt"]);
      expect(outcome.halted).toBe(true);
      expect(outcome.haltIndex).toBe(0);
      expect(outcome.finalValue).toBe("stop");
    });
  });

  describe("result helpers", () => {
    it("continueMiddleware produces a continue result with the given value", () => {
      const result = continueMiddleware("payload");
      expect(result.type).toBe("continue");
      expect(result.value).toBe("payload");
    });

    it("haltMiddleware produces a halt result with the given value", () => {
      const result = haltMiddleware("reason");
      expect(result.type).toBe("halt");
      expect(result.value).toBe("reason");
    });

    it("continueMiddleware with no argument yields an undefined value", () => {
      const result = continueMiddleware();
      expect(result.type).toBe("continue");
      expect(result.value).toBeUndefined();
    });
  });

  describe("outcome contract", () => {
    it("returns a MiddlewareChainOutcome shape with the documented fields", () => {
      const ctx = emptyCtx();
      const outcome: MiddlewareChainOutcome<string> = runMiddlewareChain(
        [recordingMiddleware("A")],
        ctx
      );

      expect(Object.keys(outcome).sort()).toEqual(
        ["finalValue", "haltIndex", "halted", "results"].sort()
      );
    });
  });
});
