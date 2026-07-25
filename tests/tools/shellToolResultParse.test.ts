import { describe, it, expect } from "vitest";

import { parse } from "../../src/tools/shellToolResultParse.js";

describe("shellToolResultParse", () => {
  describe("plain string input", () => {
    it("returns raw string as stdout and defaults other fields", () => {
      const result = parse("hello world");
      expect(result).toEqual({
        stdout: "hello world",
        stderr: "",
        exitCode: 0
      });
    });

    it("handles empty strings", () => {
      const result = parse("");
      expect(result).toEqual({
        stdout: "",
        stderr: "",
        exitCode: 0
      });
    });
  });

  describe("JSON string input", () => {
    it("parses valid result JSON strings correctly", () => {
      const json = '{"stdout": "success data", "stderr": "some warning", "exitCode": 1}';
      const result = parse(json);
      expect(result).toEqual({
        stdout: "success data",
        stderr: "some warning",
        exitCode: 1
      });
    });

    it("parses JSON strings with alternative property names", () => {
      const json = '{"output": "alt out", "error": "alt err", "exit_code": "2"}';
      const result = parse(json);
      expect(result).toEqual({
        stdout: "alt out",
        stderr: "alt err",
        exitCode: 2
      });
    });

    it("falls back to raw string when JSON parse fails", () => {
      const badJson = '{"stdout": "unclosed';
      const result = parse(badJson);
      expect(result).toEqual({
        stdout: '{"stdout": "unclosed',
        stderr: "",
        exitCode: 0
      });
    });

    it("falls back to raw string when JSON parsed as primitive/array", () => {
      expect(parse("123")).toEqual({ stdout: "123", stderr: "", exitCode: 0 });
      expect(parse("true")).toEqual({ stdout: "true", stderr: "", exitCode: 0 });
      expect(parse("[1, 2, 3]")).toEqual({ stdout: "[1, 2, 3]", stderr: "", exitCode: 0 });
    });
  });

  describe("direct object input", () => {
    it("handles standard object with stdout, stderr, and exitCode", () => {
      const obj = { stdout: "data", stderr: "error", exitCode: 5 };
      const result = parse(obj);
      expect(result).toEqual({
        stdout: "data",
        stderr: "error",
        exitCode: 5
      });
    });

    it("handles stdout key mapping hierarchy", () => {
      expect(parse({ stdout: "A" }).stdout).toBe("A");
      expect(parse({ stdOut: "B" }).stdout).toBe("B");
      expect(parse({ output: "C" }).stdout).toBe("C");
      expect(parse({ out: "D" }).stdout).toBe("D");
      // Precedence check
      expect(parse({ stdout: "A", stdOut: "B", output: "C", out: "D" }).stdout).toBe("A");
      expect(parse({ stdOut: "B", output: "C", out: "D" }).stdout).toBe("B");
      expect(parse({ output: "C", out: "D" }).stdout).toBe("C");
    });

    it("handles stderr key mapping hierarchy", () => {
      expect(parse({ stderr: "A" }).stderr).toBe("A");
      expect(parse({ stdErr: "B" }).stderr).toBe("B");
      expect(parse({ error: "C" }).stderr).toBe("C");
      expect(parse({ err: "D" }).stderr).toBe("D");
      // Precedence check
      expect(parse({ stderr: "A", stdErr: "B", error: "C", err: "D" }).stderr).toBe("A");
      expect(parse({ stdErr: "B", error: "C", err: "D" }).stderr).toBe("B");
      expect(parse({ error: "C", err: "D" }).stderr).toBe("C");
    });

    it("handles exitCode key mapping hierarchy and type normalization", () => {
      expect(parse({ exitCode: 3 }).exitCode).toBe(3);
      expect(parse({ exit_code: 4 }).exitCode).toBe(4);
      expect(parse({ code: 5 }).exitCode).toBe(5);
      expect(parse({ status: 6 }).exitCode).toBe(6);
      // Precedence check
      expect(parse({ exitCode: 3, exit_code: 4, code: 5, status: 6 }).exitCode).toBe(3);
      expect(parse({ exit_code: 4, code: 5, status: 6 }).exitCode).toBe(4);
      expect(parse({ code: 5, status: 6 }).exitCode).toBe(5);
    });

    it("normalizes non-number exit codes", () => {
      expect(parse({ exitCode: "7" }).exitCode).toBe(7);
      expect(parse({ exitCode: "7.8" }).exitCode).toBe(7);
      expect(parse({ exitCode: true }).exitCode).toBe(1);
      expect(parse({ exitCode: false }).exitCode).toBe(0);
      expect(parse({ exitCode: "invalid" }).exitCode).toBe(0);
      expect(parse({ exitCode: null }).exitCode).toBe(0);
    });

    it("safely stringifies non-string stdout/stderr values", () => {
      const obj = { stdout: 123, stderr: true };
      const result = parse(obj);
      expect(result).toEqual({
        stdout: "123",
        stderr: "true",
        exitCode: 0
      });
    });
  });

  describe("other primitive inputs", () => {
    it("handles null", () => {
      const result = parse(null);
      expect(result).toEqual({
        stdout: "",
        stderr: "",
        exitCode: 0
      });
    });

    it("handles undefined", () => {
      const result = parse(undefined);
      expect(result).toEqual({
        stdout: "",
        stderr: "",
        exitCode: 0
      });
    });

    it("handles non-string primitives", () => {
      expect(parse(123.45)).toEqual({
        stdout: "123.45",
        stderr: "",
        exitCode: 0
      });
      expect(parse(true)).toEqual({
        stdout: "true",
        stderr: "",
        exitCode: 0
      });
    });
  });
});
