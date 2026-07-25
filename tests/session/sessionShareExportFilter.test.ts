import { afterEach, describe, expect, it } from "vitest";

import { clearRegisteredSecretValues, registerSecretValue } from '../../src/safety/secretSafety.js';
import { exportSession } from '../../src/session/sessionShareExportFilter.js';

afterEach(() => {
  clearRegisteredSecretValues();
});

describe("exportSession", () => {
  it("omits secret-tagged fields while preserving public session data", () => {
    const record = {
      id: "session-1",
      title: "Safe handoff",
      messages: [{ role: "user", content: "Keep this context" }],
      credentials: { value: "do-not-export", tags: ["secret"] },
      privateNotes: { value: "also-private", tags: ["sensitive:operator"] }
    } as const;

    expect(exportSession(record)).toEqual({
      id: "session-1",
      title: "Safe handoff",
      messages: [{ role: "user", content: "Keep this context" }]
    });
  });

  it("scrubs untagged secret-shaped and registered values even with an allowlist", () => {
    registerSecretValue("plain-resolved-credential");
    const record = {
      id: "session-2",
      title: "Shareable session",
      transcript: "token ghp_ABCDEFGHIJKLMNOPQRST12345 and plain-resolved-credential",
      internal: "omit this field"
    } as const;

    const exported = exportSession(record, { allowlist: ["id", "title", "transcript"] });

    expect(exported).toEqual({
      id: "session-2",
      title: "Shareable session",
      transcript: "token [redacted:secret-shape] and [redacted:credential]"
    });
    expect(JSON.stringify(exported)).not.toContain("ghp_ABCDEFGHIJKLMNOPQRST12345");
    expect(JSON.stringify(exported)).not.toContain("plain-resolved-credential");
  });

  it("supports a tag allowlist without restoring secret-tagged values", () => {
    const record = {
      publicSummary: { value: "ready", tags: ["public"] },
      internalSummary: { value: "not for sharing", tags: ["internal"] },
      secretSummary: { value: "never share", tags: ["secret"] }
    } as const;

    expect(exportSession(record, { allowlist: ["public"] })).toEqual({
      publicSummary: { value: "ready", tags: ["public"] }
    });
  });
});
