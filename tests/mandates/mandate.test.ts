import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { evaluateToolMandate, verbsForCall, MANDATE_READ_ONLY_TOOLS } from "../../src/mandates/evaluate.js";
import { createMandateStore } from "../../src/mandates/store.js";
import type { MandateState } from "../../src/mandates/schema.js";

const EMPTY: MandateState = { grants: [], denies: [] };
const CWD = process.platform === "win32" ? "D:\\work\\repo" : "/work/repo";

describe("verbsForCall", () => {
  it("maps tools to verbs; read-only tools imply no gated verb", () => {
    expect(verbsForCall("read", {})).toEqual([]);
    expect(verbsForCall("memory_search", {})).toEqual([]);
    expect(verbsForCall("write", {})).toEqual(["write"]);
    expect(verbsForCall("bash", { command: "ls" })).toEqual(["exec"]);
    expect(verbsForCall("git.pr.run", {})).toEqual(["net", "exec"]);
  });

  it("F5: a shell redirect WITHOUT whitespace (echo x>.env / >>.env) is a secret-edge", () => {
    expect(verbsForCall("bash", { command: "echo hunter2>.env" })).toContain("secret-edge");
    expect(verbsForCall("bash", { command: "echo hunter2>>.env" })).toContain("secret-edge");
    expect(verbsForCall("bash", { command: "echo hunter2 > .env" })).toContain("secret-edge"); // whitespace form still works
  });

  it("escalates destructive shell input to the destructive verb", () => {
    expect(verbsForCall("bash", { command: "rm -rf build" })).toContain("destructive");
    expect(verbsForCall("bash", { command: "git push --force origin main" })).toContain("destructive");
    expect(verbsForCall("bash", { command: "git reset --hard HEAD~1" })).toContain("destructive");
    expect(verbsForCall("bash", { command: "git push --force-with-lease" })).not.toContain("destructive");
  });

  it("escalates split/long rm flags and git push -f (not only rm -rf / --force)", () => {
    // YOLO-default sessions silently allowed these before the matcher covered split flags.
    for (const command of [
      "rm -r -f build",
      "rm -f -r build",
      "rm --recursive --force build",
      "rm --force --recursive /tmp/out",
      "rm -rf build",
      "git push -f origin main",
      "git push origin main -f"
    ]) {
      expect(verbsForCall("bash", { command }), command).toContain("destructive");
    }
    expect(verbsForCall("bash", { command: "rm -r build" })).not.toContain("destructive"); // recursive alone is not force
    expect(verbsForCall("bash", { command: "git push --force-with-lease origin main" })).not.toContain("destructive");
  });

  it("escalates Windows recursive deletes under YOLO (cmd + PowerShell)", () => {
    // This host is Windows: del/rmdir/Remove-Item were only `exec` before —
    // YOLO lifted them with no hard-edge prompt.
    for (const command of [
      "del /s /q C:\\temp\\out",
      "del /s build",
      "del /f /s /q build",
      "erase /s /q old",
      "rmdir /s /q node_modules",
      "rd /s /q dist",
      "Remove-Item -Recurse -Force build",
      "Remove-Item -r -fo .\\out",
      "ri -Recurse -Force tmp",
      "ri -r -fo tmp"
    ]) {
      expect(verbsForCall("bash", { command }), command).toContain("destructive");
      expect(
        evaluateToolMandate("bash", { command }, { cwd: CWD, state: EMPTY, yolo: true }).outcome,
        command
      ).toBe("escalate");
    }
    // Non-recursive / non-force deletes stay ordinary exec (not hard-edge).
    expect(verbsForCall("bash", { command: "del file.txt" })).not.toContain("destructive");
    expect(verbsForCall("bash", { command: "Remove-Item file.txt" })).not.toContain("destructive");
    expect(verbsForCall("bash", { command: "rmdir empty-dir" })).not.toContain("destructive");
  });

  it("escalates money-moving / billable-provisioning commands to the spend verb (S6)", () => {
    for (const command of [
      "terraform apply -auto-approve",
      "pulumi up --yes",
      "flyctl deploy",
      "railway up",
      "heroku addons:create heroku-postgresql:standard-0",
      "vercel deploy --prod",
      "aws ec2 run-instances --image-id ami-123",
      "gcloud compute instances create web-1 --zone us",
      "az vm create --name web",
      "stripe charges create --amount 5000"
    ]) {
      expect(verbsForCall("bash", { command }), command).toContain("spend");
    }
  });

  it("does NOT flag read-only / free cloud + ordinary dev commands as spend (precision)", () => {
    for (const command of ["aws s3 ls", "gcloud config set project x", "npm install", "npm run build", "git push origin main", "terraform plan", "vercel deploy"]) {
      expect(verbsForCall("bash", { command }), command).not.toContain("spend");
    }
  });
});

describe("evaluateToolMandate — read-only floor + empty state", () => {
  it("read-only tools always allowed", () => {
    for (const toolId of MANDATE_READ_ONLY_TOOLS) {
      expect(evaluateToolMandate(toolId, {}, { cwd: CWD, state: EMPTY, yolo: false }).outcome).toBe("allow");
    }
  });

  it("writes with no mandate escalate (fall through to interactive/allow-writes)", () => {
    const decision = evaluateToolMandate("write", { path: "x" }, { cwd: CWD, state: EMPTY, yolo: false });
    expect(decision.outcome).toBe("escalate");
  });
});

describe("evaluateToolMandate — grants", () => {
  it("a MACHINE work grant allows writes/exec without a per-call prompt", () => {
    const state: MandateState = { grants: [{ scope: "machine", verbs: ["read", "write", "exec"], grantedAt: "t" }], denies: [] };
    expect(evaluateToolMandate("write", {}, { cwd: CWD, state, yolo: false }).outcome).toBe("allow");
    expect(evaluateToolMandate("bash", { command: "npm test" }, { cwd: CWD, state, yolo: false }).outcome).toBe("allow");
  });

  it("a SPACE grant only covers its subtree", () => {
    const state: MandateState = { grants: [{ scope: "space", path: CWD, verbs: ["write"], grantedAt: "t" }], denies: [] };
    expect(evaluateToolMandate("write", {}, { cwd: join(CWD, "src"), state, yolo: false }).outcome).toBe("allow");
    const elsewhere = process.platform === "win32" ? "D:\\other" : "/other";
    expect(evaluateToolMandate("write", {}, { cwd: elsewhere, state, yolo: false }).outcome).toBe("escalate");
  });

  it("SPACE grant scopes to the write TARGET path, not only cwd (B13)", () => {
    const state: MandateState = { grants: [{ scope: "space", path: CWD, verbs: ["write"], grantedAt: "t" }], denies: [] };
    // Operator is inside the grant, but the write escapes outside — must escalate.
    const outside = process.platform === "win32" ? "D:\\other\\escape.txt" : "/other/escape.txt";
    expect(evaluateToolMandate("write", { path: outside }, { cwd: CWD, state, yolo: false }).outcome).toBe("escalate");
    // Target inside the grant is allowed even when specified as a relative path.
    expect(evaluateToolMandate("write", { path: "src/ok.ts" }, { cwd: CWD, state, yolo: false }).outcome).toBe("allow");
  });

  it("a grant missing a required verb does not cover the call", () => {
    const state: MandateState = { grants: [{ scope: "machine", verbs: ["read"], grantedAt: "t" }], denies: [] };
    expect(evaluateToolMandate("write", {}, { cwd: CWD, state, yolo: false }).outcome).toBe("escalate");
  });
});

describe("evaluateToolMandate — the hard edges (THERE scenario 6)", () => {
  it("destructive ops still prompt EVEN under a MACHINE grant", () => {
    const state: MandateState = { grants: [{ scope: "machine", verbs: ["read", "write", "exec", "destructive"], grantedAt: "t" }], denies: [] };
    const decision = evaluateToolMandate("bash", { command: "rm -rf /" }, { cwd: CWD, state, yolo: false });
    expect(decision.outcome).toBe("escalate");
    expect(decision.reason).toContain("hard edge");
  });

  it("SPEND is a live hard edge — escalates under YOLO and even a spend-granted machine mandate (S6)", () => {
    // Under YOLO, a billable command still prompts (was dead before v0.27).
    const yoloDecision = evaluateToolMandate("bash", { command: "terraform apply -auto-approve" }, { cwd: CWD, state: EMPTY, yolo: true });
    expect(yoloDecision.outcome).toBe("escalate");
    expect(yoloDecision.reason).toContain("hard edge (spend)");
    // Even a machine grant that explicitly lists "spend" cannot cover it — hard edges never auto-grant.
    const granted: MandateState = { grants: [{ scope: "machine", verbs: ["read", "write", "exec", "spend"], grantedAt: "t" }], denies: [] };
    expect(evaluateToolMandate("bash", { command: "stripe charges create --amount 5000" }, { cwd: CWD, state: granted, yolo: false }).outcome).toBe("escalate");
  });

  it("deny-wins beats a matching grant", () => {
    const state: MandateState = {
      grants: [{ scope: "machine", verbs: ["read", "write", "exec"], grantedAt: "t" }],
      denies: [{ verb: "exec" }]
    };
    expect(evaluateToolMandate("bash", { command: "ls" }, { cwd: CWD, state, yolo: false }).outcome).toBe("deny");
  });

  it("YOLO lifts ordinary permission gates but NOT hard edges or denies (§2.3 Article 3)", () => {
    // Ordinary write under YOLO → allow.
    expect(evaluateToolMandate("write", {}, { cwd: CWD, state: EMPTY, yolo: true }).outcome).toBe("allow");
    // Hard edge (destructive) under YOLO → escalate (no exec deny in play).
    expect(evaluateToolMandate("bash", { command: "rm -rf build" }, { cwd: CWD, state: EMPTY, yolo: true }).outcome).toBe("escalate");
    // A deny still binds under YOLO (deny-wins beats YOLO).
    const denyExec: MandateState = { grants: [], denies: [{ verb: "exec" }] };
    expect(evaluateToolMandate("bash", { command: "npm test" }, { cwd: CWD, state: denyExec, yolo: true }).outcome).toBe("deny");
  });

  it("secrets-adjacent + ecosystem-auth writes are hard edges that survive YOLO and a grant", () => {
    const grant: MandateState = { grants: [{ scope: "machine", verbs: ["read", "write", "exec", "net"], grantedAt: "t" }], denies: [] };
    // Writing .env is a secret-edge → escalate even with a machine grant.
    expect(verbsForCall("write", { path: "config/.env" })).toContain("secret-edge");
    expect(evaluateToolMandate("write", { path: "config/.env" }, { cwd: CWD, state: grant, yolo: false }).outcome).toBe("escalate");
    expect(evaluateToolMandate("write", { path: "config/.env" }, { cwd: CWD, state: grant, yolo: true }).outcome).toBe("escalate");
    // Writing an ecosystem auth file is an auth-edge → escalate under YOLO too.
    expect(verbsForCall("bash", { command: "cp key ~/.aws/credentials" })).toContain("auth-edge");
    expect(evaluateToolMandate("bash", { command: "cp key ~/.aws/credentials" }, { cwd: CWD, state: grant, yolo: true }).outcome).toBe("escalate");
    // A plain read of .env is NOT a hard edge (reads are sanitized at output).
    expect(verbsForCall("read", { path: ".env" })).toEqual([]);
  });
});

describe("mandate store", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("grants persist to disk and reload; revokeAll clears", () => {
    const dir = mkdtempSync(join(tmpdir(), "guru-mandate-"));
    dirs.push(dir);
    const file = join(dir, "mandates.json");
    const store = createMandateStore({ filePath: file, now: () => new Date("2026-07-04T00:00:00Z") });

    store.grant({ scope: "machine", verbs: ["read", "write", "exec"] });
    const reborn = createMandateStore({ filePath: file }).load();
    expect(reborn.grants).toHaveLength(1);
    expect(reborn.grants[0]?.scope).toBe("machine");
    expect(reborn.grants[0]?.grantedAt).toBe("2026-07-04T00:00:00.000Z");

    // grants are POLICY, not secrets — plain readable JSON is expected.
    expect(readFileSync(file, "utf8")).toContain("machine");

    store.revokeAll();
    expect(createMandateStore({ filePath: file }).load().grants).toHaveLength(0);
  });

  it("corrupt file safe-parses to empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "guru-mandate-"));
    dirs.push(dir);
    const file = join(dir, "mandates.json");
    require("node:fs").writeFileSync(file, "{ not json", "utf8");
    expect(createMandateStore({ filePath: file }).load()).toEqual({ grants: [], denies: [] });
  });
});

describe("swarm trio — permission-neutral (authority enforced in the worker)", () => {
  it("spawn/get/kill map to no gated verbs and are always allowed", () => {
    expect(verbsForCall("spawn_agent", { prompt: "x" })).toEqual([]);
    expect(verbsForCall("get_task_output", {})).toEqual([]);
    expect(verbsForCall("kill_task", {})).toEqual([]);
    expect(evaluateToolMandate("spawn_agent", { prompt: "x" }, { cwd: CWD, state: EMPTY, yolo: false }).outcome).toBe("allow");
  });
});
