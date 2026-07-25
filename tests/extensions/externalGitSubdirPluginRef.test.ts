import {
  ExternalGitSubdirPluginRefSchema,
  parseExternalGitSubdirPluginRef,
  tryParseExternalGitSubdirPluginRef,
  isValidExternalGitSubdirPluginRef,
  formatExternalRef,
  type ExternalGitSubdirPluginRef
} from '../../src/extensions/externalGitSubdirPluginRef.js';

// ---------------------------------------------------------------------------
// parseExternalGitSubdirPluginRef
// ---------------------------------------------------------------------------

describe("parseExternalGitSubdirPluginRef", () => {
  it("parses a valid ref with a full 40-char SHA pin", () => {
    const ref = parseExternalGitSubdirPluginRef({
      repo: "https://github.com/owner/repo.git",
      subdir: "",
      pin: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"
    });

    expect(ref.repo).toBe("https://github.com/owner/repo.git");
    expect(ref.subdir).toBe("");
    expect(ref.pin).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0");
  });

  it("parses a valid ref with a 7-char short SHA pin", () => {
    const ref = parseExternalGitSubdirPluginRef({
      repo: "https://github.com/owner/repo.git",
      pin: "abc1234"
    });

    expect(ref.pin).toBe("abc1234");
    expect(ref.subdir).toBe("");
  });

  it("parses a tag pin", () => {
    const ref = parseExternalGitSubdirPluginRef({
      repo: "https://github.com/owner/repo.git",
      pin: "v2.1.0"
    });

    expect(ref.pin).toBe("v2.1.0");
  });

  it("parses a branch-name pin with slashes", () => {
    const ref = parseExternalGitSubdirPluginRef({
      repo: "https://github.com/owner/repo.git",
      pin: "feature/plugin-loader"
    });

    expect(ref.pin).toBe("feature/plugin-loader");
  });

  it("parses a pin with refs/heads/ prefix", () => {
    const ref = parseExternalGitSubdirPluginRef({
      repo: "https://github.com/owner/repo.git",
      pin: "refs/heads/main"
    });

    expect(ref.pin).toBe("refs/heads/main");
  });

  it("parses a pin with refs/tags/ prefix", () => {
    const ref = parseExternalGitSubdirPluginRef({
      repo: "https://github.com/owner/repo.git",
      pin: "refs/tags/v1.0.0"
    });

    expect(ref.pin).toBe("refs/tags/v1.0.0");
  });

  it("parses a pin with refs/remotes/ prefix", () => {
    const ref = parseExternalGitSubdirPluginRef({
      repo: "https://github.com/owner/repo.git",
      pin: "refs/remotes/origin/main"
    });

    expect(ref.pin).toBe("refs/remotes/origin/main");
  });

  it("defaults subdir to empty string when omitted", () => {
    const ref = parseExternalGitSubdirPluginRef({
      repo: "https://github.com/owner/repo.git",
      pin: "abc1234"
    });

    expect(ref.subdir).toBe("");
  });

  it("accepts '.' as a root subdir", () => {
    const ref = parseExternalGitSubdirPluginRef({
      repo: "https://github.com/owner/repo.git",
      subdir: ".",
      pin: "abc1234"
    });

    expect(ref.subdir).toBe(".");
  });

  it("accepts a relative subdir path", () => {
    const ref = parseExternalGitSubdirPluginRef({
      repo: "https://github.com/owner/repo.git",
      subdir: "plugins/my-plugin",
      pin: "abc1234"
    });

    expect(ref.subdir).toBe("plugins/my-plugin");
  });

  it("rejects an absolute subdir path", () => {
    expect(() =>
      parseExternalGitSubdirPluginRef({
        repo: "https://github.com/owner/repo.git",
        subdir: "/absolute/path",
        pin: "abc1234"
      })
    ).toThrow();
  });

  // -- missing pin ------------------------------------------------------------------

  it("rejects a missing pin (empty string)", () => {
    expect(() =>
      parseExternalGitSubdirPluginRef({
        repo: "https://github.com/owner/repo.git",
        pin: ""
      })
    ).toThrow();
  });

  it("rejects a whitespace-only pin", () => {
    expect(() =>
      parseExternalGitSubdirPluginRef({
        repo: "https://github.com/owner/repo.git",
        pin: "   "
      })
    ).toThrow();
  });

  it("rejects when pin is omitted entirely", () => {
    expect(() =>
      parseExternalGitSubdirPluginRef({
        repo: "https://github.com/owner/repo.git"
      })
    ).toThrow();
  });

  // -- invalid pin format -----------------------------------------------------------

  it("rejects a pin with shell metacharacters", () => {
    expect(() =>
      parseExternalGitSubdirPluginRef({
        repo: "https://github.com/owner/repo.git",
        pin: "foo; rm -rf /"
      })
    ).toThrow();
  });

  it("rejects a pin with spaces", () => {
    expect(() =>
      parseExternalGitSubdirPluginRef({
        repo: "https://github.com/owner/repo.git",
        pin: "not a valid ref"
      })
    ).toThrow();
  });

  it("rejects a pin that exceeds 255 characters", () => {
    expect(() =>
      parseExternalGitSubdirPluginRef({
        repo: "https://github.com/owner/repo.git",
        pin: "a".repeat(256)
      })
    ).toThrow();
  });

  it("accepts a short alphanumeric string as a valid ref name (tag/branch)", () => {
    // A 5-char hex string is a legal tag or branch name, not an invalid ref.
    // The general ref-name alternation ([\w.\-/]+) correctly covers it.
    const ref = parseExternalGitSubdirPluginRef({
      repo: "https://github.com/owner/repo.git",
      pin: "abc12"
    });

    expect(ref.pin).toBe("abc12");
  });

  // -- invalid repo ----------------------------------------------------------------

  it("rejects an empty repo", () => {
    expect(() =>
      parseExternalGitSubdirPluginRef({
        repo: "",
        pin: "abc1234"
      })
    ).toThrow();
  });

  it("rejects a whitespace-only repo", () => {
    expect(() =>
      parseExternalGitSubdirPluginRef({
        repo: "   ",
        pin: "abc1234"
      })
    ).toThrow();
  });

  it("rejects when repo is omitted", () => {
    expect(() =>
      parseExternalGitSubdirPluginRef({
        pin: "abc1234"
      })
    ).toThrow();
  });

  // -- unknown keys rejected (strict schema) ---------------------------------------

  it("rejects an object with unknown keys (strict schema)", () => {
    expect(() =>
      parseExternalGitSubdirPluginRef({
        repo: "https://github.com/owner/repo.git",
        pin: "abc1234",
        extra: "nope"
      })
    ).toThrow();
  });

  // -- roundtrip -------------------------------------------------------------------

  it("roundtrips after zod parse (parse → zod schema re-parse)", () => {
    const raw = {
      repo: "https://github.com/owner/repo.git",
      subdir: "src/plugins/example",
      pin: "deadbeefcafebabe0123456789abcdef12345678"
    };
    const parsed = parseExternalGitSubdirPluginRef(raw);
    const reParsed = ExternalGitSubdirPluginRefSchema.parse(parsed);

    expect(reParsed.repo).toBe(raw.repo);
    expect(reParsed.subdir).toBe(raw.subdir);
    expect(reParsed.pin).toBe(raw.pin);
  });
});

// ---------------------------------------------------------------------------
// tryParseExternalGitSubdirPluginRef (safe variant)
// ---------------------------------------------------------------------------

describe("tryParseExternalGitSubdirPluginRef", () => {
  it("returns a parsed ref for valid input", () => {
    const ref = tryParseExternalGitSubdirPluginRef({
      repo: "https://github.com/owner/repo.git",
      pin: "abc1234"
    });

    expect(ref).not.toBeNull();
    expect(ref!.repo).toBe("https://github.com/owner/repo.git");
  });

  it("returns null for invalid input instead of throwing", () => {
    const ref = tryParseExternalGitSubdirPluginRef({
      repo: "https://github.com/owner/repo.git",
      pin: ""
    });

    expect(ref).toBeNull();
  });

  it("returns null for completely malformed input", () => {
    expect(tryParseExternalGitSubdirPluginRef(null)).toBeNull();
    expect(tryParseExternalGitSubdirPluginRef(undefined)).toBeNull();
    expect(tryParseExternalGitSubdirPluginRef("nope")).toBeNull();
    expect(tryParseExternalGitSubdirPluginRef(42)).toBeNull();
    expect(tryParseExternalGitSubdirPluginRef({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isValidExternalGitSubdirPluginRef (predicate)
// ---------------------------------------------------------------------------

describe("isValidExternalGitSubdirPluginRef", () => {
  it("returns true for a valid ref", () => {
    expect(
      isValidExternalGitSubdirPluginRef({
        repo: "https://github.com/owner/repo.git",
        pin: "abc1234"
      })
    ).toBe(true);
  });

  it("returns false for an invalid ref", () => {
    expect(isValidExternalGitSubdirPluginRef({ repo: "", pin: "" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatExternalRef (display)
// ---------------------------------------------------------------------------

describe("formatExternalRef", () => {
  it("formats a root-level ref as repo@pin", () => {
    const ref: ExternalGitSubdirPluginRef = {
      repo: "https://github.com/owner/repo.git",
      subdir: "",
      pin: "abc1234"
    };

    expect(formatExternalRef(ref)).toBe("https://github.com/owner/repo.git@abc1234");
  });

  it("includes the subdir between // delimiters", () => {
    const ref: ExternalGitSubdirPluginRef = {
      repo: "https://github.com/owner/repo.git",
      subdir: "plugins/my-plugin",
      pin: "abc1234"
    };

    expect(formatExternalRef(ref)).toBe(
      "https://github.com/owner/repo.git//plugins/my-plugin@abc1234"
    );
  });

  it("strips a leading slash from the subdir in display", () => {
    const ref: ExternalGitSubdirPluginRef = {
      repo: "https://github.com/owner/repo.git",
      subdir: "/plugins/tools",
      pin: "v1.0.0"
    };

    // Note: a leading-slash subdir would have been rejected by the schema;
    // this test covers the display helper's defensive normalization.
    expect(formatExternalRef(ref)).toBe(
      "https://github.com/owner/repo.git//plugins/tools@v1.0.0"
    );
  });

  it("uses the '.' subdir literally in display", () => {
    const ref: ExternalGitSubdirPluginRef = {
      repo: "https://github.com/owner/repo.git",
      subdir: ".",
      pin: "deadbeef"
    };

    // '.' is a valid subdir — display keeps it as-is.
    expect(formatExternalRef(ref)).toBe("https://github.com/owner/repo.git//.@deadbeef");
  });
});
