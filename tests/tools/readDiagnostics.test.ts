import { describe, expect, it } from "vitest";

import { createReadDiagnosticsTool } from "../../src/tools/builtins/readDiagnosticsTool.js";
import type { CommandExecutionResult } from "../../src/review/gates.js";

describe("read_diagnostics tool", () => {
  it("parses and filters TypeScript diagnostics", async () => {
    const tool = createReadDiagnosticsTool({
      executor: async (): Promise<CommandExecutionResult> => ({
        exitCode: 2,
        stdout: "",
        stderr: [
          "src/a.ts(1,2): error TS2322: Type 'string' is not assignable to type 'number'.",
          "src/b.ts(3,4): error TS2345: Argument of type 'null' is not assignable."
        ].join("\n"),
        durationMs: 10
      })
    });

    const filtered = await tool.execute({ repoRoot: process.cwd(), paths: ["src/a.ts"] }, {});
    expect(filtered.diagnostics).toHaveLength(1);
    expect(filtered.diagnostics[0]?.file).toBe("src/a.ts");
    expect(filtered.diagnostics[0]?.code).toBe("TS2322");

    const all = await tool.execute({ repoRoot: process.cwd() }, {});
    expect(all.diagnostics).toHaveLength(2);
  });
});
