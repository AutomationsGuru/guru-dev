import { describe, expect, it } from "vitest";

import {
  aggregateMixtureOfAgents,
  MixtureOfAgentsNoExpertsError,
  type MixtureOfAgentsAggregator,
  type MixtureOfAgentsExpertOutput
} from '../../src/swarm/mixtureOfAgentsAggregate.js';

function expert(expertId: string, text: string): MixtureOfAgentsExpertOutput {
  return { expertId, text };
}

describe("mixture-of-agents aggregate — ALL experts are included", () => {
  it("the aggregator receives every expert output, in input order", () => {
    const outputs = [expert("a", "alpha"), expert("b", "beta"), expert("c", "gamma")];
    let seen: readonly MixtureOfAgentsExpertOutput[] = [];
    const aggregator: MixtureOfAgentsAggregator<MixtureOfAgentsExpertOutput, string> = (received) => {
      seen = received;
      return received.map((o) => o.text).join(" | ");
    };
    const result = aggregateMixtureOfAgents(outputs, aggregator);
    expect(seen.map((o) => o.expertId)).toEqual(["a", "b", "c"]);
    expect(result).toBe("alpha | beta | gamma");
  });

  it("the result reflects every expert (no expert dropped by the merge)", () => {
    const outputs = [expert("e1", "1"), expert("e2", "2"), expert("e3", "3"), expert("e4", "4")];
    const result = aggregateMixtureOfAgents(outputs, (received) => new Set(received.map((o) => o.expertId)));
    expect(result).toEqual(new Set(["e1", "e2", "e3", "e4"]));
  });

  it("order is preserved — swapping input order changes what the aggregator sees", () => {
    const forward = aggregateMixtureOfAgents([expert("a", "A"), expert("b", "B")], (received) =>
      received.map((o) => o.expertId).join(",")
    );
    const reversed = aggregateMixtureOfAgents([expert("b", "B"), expert("a", "A")], (received) =>
      received.map((o) => o.expertId).join(",")
    );
    expect(forward).toBe("a,b");
    expect(reversed).toBe("b,a");
  });

  it("a single expert works", () => {
    const result = aggregateMixtureOfAgents([expert("solo", "only one")], (received) => received[0]?.text ?? "missing");
    expect(result).toBe("only one");
  });
});

describe("mixture-of-agents aggregate — purity and honest failure", () => {
  it("the input array is not mutated and the aggregator sees a defensive copy", () => {
    const outputs = [expert("a", "alpha"), expert("b", "beta")];
    const snapshot = [...outputs];
    const aggregator: MixtureOfAgentsAggregator<MixtureOfAgentsExpertOutput, number> = (received) => {
      // A hostile aggregator tries to mutate what it was handed; because the
      // copy is frozen this is a no-op (strict-mode TypeScript would throw),
      // and either way the caller's array must be unaffected.
      try {
        (received as MixtureOfAgentsExpertOutput[]).pop();
      } catch {
        // frozen copy rejected the mutation — the guarantee holds
      }
      return received.length;
    };
    aggregateMixtureOfAgents(outputs, aggregator);
    expect(outputs).toEqual(snapshot);
    expect(outputs.length).toBe(2);
  });

  it("the array handed to the aggregator is frozen", () => {
    let frozen = false;
    aggregateMixtureOfAgents([expert("a", "alpha")], (received) => {
      frozen = Object.isFrozen(received);
      return null;
    });
    expect(frozen).toBe(true);
  });

  it("empty input fails honestly — structured error, never a fake success", () => {
    let caught: unknown;
    try {
      aggregateMixtureOfAgents([], (received) => received.length);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MixtureOfAgentsNoExpertsError);
    expect((caught as MixtureOfAgentsNoExpertsError).code).toBe("moa_no_experts");
  });

  it("the aggregator is invoked exactly once per aggregate call", () => {
    let calls = 0;
    aggregateMixtureOfAgents([expert("a", "alpha"), expert("b", "beta")], (received) => {
      calls += 1;
      return received.length;
    });
    expect(calls).toBe(1);
  });

  it("aggregator errors propagate to the caller (no swallowing)", () => {
    expect(() =>
      aggregateMixtureOfAgents([expert("a", "alpha")], () => {
        throw new Error("aggregator exploded");
      })
    ).toThrow(/aggregator exploded/);
  });

  it("expert metadata is carried through to the aggregator untouched", () => {
    const outputs: MixtureOfAgentsExpertOutput[] = [
      { expertId: "a", text: "alpha", metadata: { confidence: 0.9, route: "deepseek" } }
    ];
    const result = aggregateMixtureOfAgents(outputs, (received) => received[0]?.metadata);
    expect(result).toEqual({ confidence: 0.9, route: "deepseek" });
  });
});
