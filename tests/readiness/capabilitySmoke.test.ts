import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface CapabilitySmokeOutput {
  command?: string;
  verdict?: string;
  runtime?: { name?: string; version?: string };
  config?: { verdict?: string; status?: string };
  repo?: { resolved?: boolean; agentsChainCount?: number; repoRoot?: string };
  tools?: { count?: number; ids?: string[] };
  readOnlyToolRun?: { status?: string; output?: { repoRoot?: string } };
  memory?: { provider?: string; status?: string };
  honcho?: { status?: string; writeEnabled?: boolean };
  providerRouting?: {
    routeCount?: number;
    catalogSource?: string;
    selectedRouteId?: string;
    selectedRouteStatus?: string;
    selectionKind?: string;
    availabilitySummary?: Record<string, number>;
    routes?: Array<{ routeId?: string; availability?: string; missingEnvVarNames?: string[] }>;
  };
  extensionHost?: {
    available?: boolean;
    commandsRegistered?: number;
    toolFactoriesRegistered?: number;
    routesRegistered?: number;
    eventRoundTrip?: boolean;
    registeredCommandIds?: string[];
    registeredToolIds?: string[];
    honchoStatusToolReachable?: boolean;
    honchoToolStatus?: string;
  };
  providerCli?: { configuredCount?: number; ids?: string[]; note?: string };
  completionBlock?: { secrets?: string; handoffNeeded?: string; tasks?: string[] };
}

function runSmoke(): CapabilitySmokeOutput {
  const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "capability-smoke"], {
    cwd: repoRoot,
    encoding: "utf8"
  }).trim();

  return JSON.parse(output) as CapabilitySmokeOutput;
}

describe("capability-smoke", () => {
  // One smoke run shared across assertions: each run spawns a full CLI process and
  // scans provider CLIs on PATH (~2-8s; worse under load). Six per-test runs made
  // this file the suite's flake source under concurrent load (2026-07-02).
  let parsed: CapabilitySmokeOutput;

  beforeAll(() => {
    parsed = runSmoke();
  }, 60_000);

  it("proves the core capability nucleus in a single CLI run", () => {

    expect(parsed.command).toBe("capability-smoke");
    expect(parsed.runtime?.name).toBe("GuruHarness");
    expect(parsed.config).toMatchObject({ status: "loaded", verdict: "GREEN" });
    expect(parsed.repo?.resolved).toBe(true);
    expect(parsed.repo?.agentsChainCount).toBe(1);
    expect(parsed.repo?.repoRoot).toBe(repoRoot);
  });

  it("runs a safe read-only tool and reports Honcho + direct-first routing as first-class shapes", () => {

    expect(parsed.tools?.ids).toContain("repo.context.resolve");
    expect(parsed.readOnlyToolRun).toMatchObject({ status: "succeeded", output: { repoRoot } });
    expect(parsed.memory).toMatchObject({ provider: "markdown", status: "ready" });
    expect(parsed.honcho?.status).not.toBe("not-implemented");
    expect(["disabled", "missing-env", "offline", "ready"]).toContain(parsed.honcho?.status);
    expect(parsed.honcho?.writeEnabled).toBe(false);
    expect(parsed.providerRouting?.catalogSource).toBe("direct-provider-catalog");
    expect(parsed.providerRouting?.routeCount).toBeGreaterThanOrEqual(10);
    expect(parsed.providerRouting?.selectedRouteId).toBe("sakana/fugu-ultra");
    expect(parsed.providerRouting?.selectionKind).toBe("direct");
    expect(parsed.providerRouting?.routes?.every((route) => typeof route.availability === "string")).toBe(true);
    expect(JSON.stringify(parsed.providerRouting)).not.toContain("guruharness/seed-direct-first");
  });

  it("exposes an operational extension-host spine", () => {

    expect(parsed.extensionHost?.available).toBe(true);
    expect(parsed.extensionHost?.commandsRegistered).toBeGreaterThanOrEqual(1);
    expect(parsed.extensionHost?.toolFactoriesRegistered).toBeGreaterThanOrEqual(1);
    expect(parsed.extensionHost?.routesRegistered).toBeGreaterThanOrEqual(1);
    expect(parsed.extensionHost?.eventRoundTrip).toBe(true);
    expect(parsed.extensionHost?.registeredCommandIds).toContain("smoke.demo");
    expect(parsed.extensionHost?.honchoStatusToolReachable).toBe(true);
    expect(parsed.extensionHost?.registeredToolIds).toContain("honcho_memory_status");
    expect(parsed.extensionHost?.registeredToolIds).toContain("service_readiness_report");
    expect(["disabled", "missing-env", "offline", "ready"]).toContain(parsed.extensionHost?.honchoToolStatus);
  });

  it("surfaces the folded provider-CLI inventory", () => {

    expect(parsed.providerCli?.configuredCount).toBeGreaterThanOrEqual(10);
    expect(parsed.providerCli?.ids).toContain("codex");
  });

  it("exposes the extension tools in the live session tool registry", () => {

    expect(parsed.tools?.ids).toContain("honcho_memory_status");
    expect(parsed.tools?.ids).toContain("service_readiness_report");
  });

  it("emits a structured completion block without secrets", () => {

    expect(["GREEN", "YELLOW", "RED"]).toContain(parsed.verdict);
    expect(parsed.completionBlock?.secrets).toContain("none");
    expect(parsed.completionBlock?.tasks?.length).toBeGreaterThanOrEqual(7);
  });
});
