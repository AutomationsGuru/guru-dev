import { describe, expect, it } from "vitest";

import { scrubEnv } from '../../src/sandbox/secretScrubTeleport.js';

describe("scrubEnv", () => {
  it("keeps non-secret environment entries", () => {
    expect(scrubEnv({ PATH: "/usr/local/bin", LOG_LEVEL: "debug" })).toEqual({
      PATH: "/usr/local/bin",
      LOG_LEVEL: "debug"
    });
  });

  it("removes API key and token environment entries", () => {
    const scrubbed = scrubEnv({
      OPENAI_API_KEY: "test-value",
      SERVICE_TOKEN: "test-value",
      PATH: "/usr/local/bin"
    });

    expect(scrubbed).toEqual({ PATH: "/usr/local/bin" });
  });
});
