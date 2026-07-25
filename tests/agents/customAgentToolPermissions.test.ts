import { describe, expect, it } from "vitest";
import { evaluate } from '../../src/agents/customAgentToolPermissions.js';

describe("customAgentToolPermissions", () => {
  describe("basic allow/deny lists", () => {
    it("should allow tool when there is no allow/deny list defined", () => {
      const def = {};
      expect(evaluate(def, "read", "manual")).toBe(true);
      expect(evaluate(def, "write", "manual")).toBe(true);
    });

    it("should allow a tool that is in the allowed list", () => {
      const def = {
        allowedTools: ["read", "grep"]
      };
      expect(evaluate(def, "read", "manual")).toBe(true);
      expect(evaluate(def, "grep", "manual")).toBe(true);
    });

    it("should deny a tool that is not in the allowed list", () => {
      const def = {
        allowedTools: ["read"]
      };
      expect(evaluate(def, "write", "manual")).toBe(false);
    });

    it("should deny a tool that is in the denied list", () => {
      const def = {
        deniedTools: ["bash", "write"]
      };
      expect(evaluate(def, "bash", "manual")).toBe(false);
      expect(evaluate(def, "write", "manual")).toBe(false);
      expect(evaluate(def, "read", "manual")).toBe(true);
    });

    it("should make deny beat allow when a tool is in both lists", () => {
      const def = {
        allowedTools: ["read", "write"],
        deniedTools: ["write"]
      };
      expect(evaluate(def, "read", "manual")).toBe(true);
      expect(evaluate(def, "write", "manual")).toBe(false);
    });
  });

  describe("role gate intersection", () => {
    describe("read-only capability mode", () => {
      it("should allow read-only tools under read-only mode", () => {
        const def = {
          roleGate: {
            capabilityMode: "read-only" as const
          }
        };
        expect(evaluate(def, "read", "manual")).toBe(true);
        expect(evaluate(def, "grep", "manual")).toBe(true);
      });

      it("should deny mutating tools under read-only mode", () => {
        const def = {
          roleGate: {
            capabilityMode: "read-only" as const
          }
        };
        // bash is inherently mutating (exec verb)
        expect(evaluate(def, "bash", "manual")).toBe(false);
        // write is mutating (write verb)
        expect(evaluate(def, "write", "manual")).toBe(false);
      });
    });

    describe("restricted role tools list", () => {
      it("should allow tools that are in the role's floor", () => {
        const def = {
          roleGate: {
            capabilityMode: "all" as const,
            tools: ["grep"]
          }
        };
        // Core floor tools are read, bash, edit, write. They should be allowed even if not explicitly listed in role tools
        expect(evaluate(def, "read", "manual")).toBe(true);
        expect(evaluate(def, "bash", "manual")).toBe(true);
        expect(evaluate(def, "write", "manual")).toBe(true);
        // grep is in role tools, so allowed
        expect(evaluate(def, "grep", "manual")).toBe(true);
      });

      it("should deny tools not in the core floor and not in the role's tools list", () => {
        const def = {
          roleGate: {
            capabilityMode: "all" as const,
            tools: ["grep"]
          }
        };
        // resolve_capability_gap is not core floor and not in the role tools list, so denied
        expect(evaluate(def, "resolve_capability_gap", "manual")).toBe(false);
      });

      it("should allow read-only floor and deny everything else in read-only role with restricted list", () => {
        const def = {
          roleGate: {
            capabilityMode: "read-only" as const,
            tools: ["grep", "bash"] // even if role specifies bash, read-only mode denies it
          }
        };
        expect(evaluate(def, "read", "manual")).toBe(true); // read-only floor
        expect(evaluate(def, "grep", "manual")).toBe(true); // grep is read-only and in role tools
        expect(evaluate(def, "bash", "manual")).toBe(false); // bash is mutating, so denied under read-only capabilityMode
      });
    });
  });

  describe("autonomy risk (hard-limit denial under auto)", () => {
    it("should allow ordinary tools in auto mode", () => {
      const def = {};
      expect(evaluate(def, "read", "auto")).toBe(true);
      expect(evaluate(def, "grep", "auto")).toBe(true);
    });

    it("should allow ordinary mutating tools in auto mode if no hard edges are present", () => {
      const def = {};
      // ordinary write to non-secret path is allowed
      expect(evaluate(def, { id: "write", input: { path: "src/main.ts" } }, "auto")).toBe(true);
      // ordinary command run is allowed
      expect(evaluate(def, { id: "bash", input: { command: "ls -la" } }, "auto")).toBe(true);
    });

    it("should deny hard-limit tools in auto mode", () => {
      const def = {};

      // 1. Destructive shell command
      expect(
        evaluate(
          def,
          { id: "bash", input: { command: "rm -rf src/" } },
          "auto"
        )
      ).toBe(false);

      // 2. Spend/money-moving command
      expect(
        evaluate(
          def,
          { id: "bash", input: { command: "terraform apply" } },
          "auto"
        )
      ).toBe(false);

      // 3. Write targeting a secrets-adjacent path (secret-edge)
      expect(
        evaluate(
          def,
          { id: "write", input: { path: ".env" } },
          "auto"
        )
      ).toBe(false);

      // 4. Write targeting an ecosystem auth path (auth-edge)
      expect(
        evaluate(
          def,
          { id: "write", input: { path: "/home/user/.aws/credentials" } },
          "auto"
        )
      ).toBe(false);
    });

    it("should allow hard-limit tools in manual mode", () => {
      const def = {};

      expect(
        evaluate(
          def,
          { id: "bash", input: { command: "rm -rf src/" } },
          "manual"
        )
      ).toBe(true);

      expect(
        evaluate(
          def,
          { id: "write", input: { path: ".env" } },
          "supervised"
        )
      ).toBe(true);
    });
  });
});
