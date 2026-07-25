import { enhanceAgentProjectScaffoldModules, type ScaffoldModuleFlag } from '../../src/home/agentScaffoldEnhanceModules.js';

describe("agent scaffold enhance modules", () => {
  const flags: readonly ScaffoldModuleFlag[] = ["cicd", "deploy", "rag"];

  it.each(flags.map((flag) => [flag] as const))("sets the optional %s flag on a base manifest", (flag) => {
    const manifest = { name: "Release helper", version: 1, skills: ["lint"] };
    const enhanced = enhanceAgentProjectScaffoldModules(manifest, [flag]);

    expect(enhanced.name).toBe("Release helper");
    expect(enhanced.version).toBe(1);
    expect(enhanced.skills).toEqual(["lint"]);
    expect(enhanced[flag]).toBe(true);
  });

  it("sets all flags at once", () => {
    const manifest = { name: "Release helper", version: 1, skills: [] };
    const enhanced = enhanceAgentProjectScaffoldModules(manifest, ["cicd", "deploy", "rag"]);

    expect(enhanced).toMatchObject({ cicd: true, deploy: true, rag: true });
  });

  it("leaves flags absent when no modules are requested", () => {
    const manifest = { name: "Release helper", version: 1, skills: ["lint"] };
    const enhanced = enhanceAgentProjectScaffoldModules(manifest);

    expect(enhanced.cicd).toBeUndefined();
    expect(enhanced.deploy).toBeUndefined();
    expect(enhanced.rag).toBeUndefined();
    expect(enhanced).toEqual(manifest);
  });

  it("preserves flags the manifest already carried", () => {
    const manifest = { name: "Release helper", version: 1, skills: [], deploy: true };
    const enhanced = enhanceAgentProjectScaffoldModules(manifest, ["rag"]);

    expect(enhanced.deploy).toBe(true);
    expect(enhanced.rag).toBe(true);
    expect(enhanced.cicd).toBeUndefined();
  });

  it("ignores duplicate and unknown module names", () => {
    const manifest = { name: "Release helper", version: 1, skills: [] };
    const enhanced = enhanceAgentProjectScaffoldModules(manifest, ["rag", "rag", "observability"]);

    expect(enhanced.rag).toBe(true);
    expect(enhanced.cicd).toBeUndefined();
    expect(enhanced.deploy).toBeUndefined();
    expect("observability" in enhanced).toBe(false);
  });

  it("does not mutate the input manifest", () => {
    const manifest = { name: "Release helper", version: 1, skills: ["lint"] };
    const enhanced = enhanceAgentProjectScaffoldModules(manifest, ["cicd"]);

    expect("cicd" in manifest).toBe(false);
    expect(enhanced).not.toBe(manifest);
  });
});
