import { isClientToolAllowed, type ClientToolGateConfig } from "../../src/tools/clientToolGate.js";

describe("client tool gate", () => {
  it("denies client tools by default", () => {
    expect(isClientToolAllowed({}, "remote.search")).toBe(false);
    expect(isClientToolAllowed(undefined, "remote.search")).toBe(false);
  });

  it("denies an allow-listed tool when the registry is not explicitly enabled", () => {
    const config: ClientToolGateConfig = { allowedTools: ["remote.search"] };

    expect(isClientToolAllowed(config, "remote.search")).toBe(false);
  });

  it("denies every tool when enabled without an explicit allow-list", () => {
    expect(isClientToolAllowed({ enabled: true }, "remote.search")).toBe(false);
    expect(isClientToolAllowed({ enabled: true, allowedTools: [] }, "remote.search")).toBe(false);
  });

  it("allows only explicitly listed tools when enabled", () => {
    const config: ClientToolGateConfig = {
      enabled: true,
      allowedTools: ["remote.search", "remote.fetch"]
    };

    expect(isClientToolAllowed(config, "remote.search")).toBe(true);
    expect(isClientToolAllowed(config, "remote.fetch")).toBe(true);
    expect(isClientToolAllowed(config, "remote.write")).toBe(false);
  });

  it("uses exact ids and never treats a wildcard or blank id as an implicit grant", () => {
    const config: ClientToolGateConfig = { enabled: true, allowedTools: ["*"] };

    expect(isClientToolAllowed(config, "remote.search")).toBe(false);
    expect(isClientToolAllowed(config, "")).toBe(false);
    expect(isClientToolAllowed(config, "  ")).toBe(false);
  });
});
