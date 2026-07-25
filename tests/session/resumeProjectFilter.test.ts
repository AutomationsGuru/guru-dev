import {
  filterSessions,
  type ResumeSessionRef
} from '../../src/session/resumeProjectFilter.js';

const ROOT_A = "/home/operator/project-a";
const ROOT_B = "/home/operator/project-b";

function sampleSessions(): ResumeSessionRef[] {
  return [
    { sessionId: "a1", projectRoot: ROOT_A },
    { sessionId: "b1", projectRoot: ROOT_B },
    { sessionId: "a2", projectRoot: ROOT_A },
    { sessionId: "unscoped1" },
    { sessionId: "b2", projectRoot: ROOT_B }
  ];
}

describe("filterSessions — project match", () => {
  it("returns only sessions whose projectRoot equals the filter", () => {
    const result = filterSessions(sampleSessions(), { projectRoot: ROOT_A });

    expect(result.map((s) => s.sessionId)).toEqual(["a1", "a2"]);
  });

  it("preserves the original relative order of matched sessions", () => {
    const sessions: ResumeSessionRef[] = [
      { sessionId: "first", projectRoot: ROOT_A },
      { sessionId: "other", projectRoot: ROOT_B },
      { sessionId: "second", projectRoot: ROOT_A },
      { sessionId: "third", projectRoot: ROOT_A }
    ];

    const result = filterSessions(sessions, { projectRoot: ROOT_A });

    expect(result.map((s) => s.sessionId)).toEqual(["first", "second", "third"]);
  });

  it("matches a filter root given with a trailing separator", () => {
    const result = filterSessions(sampleSessions(), { projectRoot: `${ROOT_A}/` });

    expect(result.map((s) => s.sessionId)).toEqual(["a1", "a2"]);
  });

  it("matches a filter root given as a relative segment (resolved lexically)", () => {
    const sessions: ResumeSessionRef[] = [
      { sessionId: "rel", projectRoot: "/home/operator/project-a" }
    ];

    const result = filterSessions(sessions, { projectRoot: "/home/operator/./project-a" });

    expect(result.map((s) => s.sessionId)).toEqual(["rel"]);
  });

  it("matches when a session projectRoot carries a trailing separator", () => {
    const sessions: ResumeSessionRef[] = [
      { sessionId: "trailed", projectRoot: `${ROOT_A}/` }
    ];

    const result = filterSessions(sessions, { projectRoot: ROOT_A });

    expect(result.map((s) => s.sessionId)).toEqual(["trailed"]);
  });

  it("excludes sessions whose projectRoot is a different project", () => {
    const result = filterSessions(sampleSessions(), { projectRoot: ROOT_B });

    expect(result.map((s) => s.sessionId)).toEqual(["b1", "b2"]);
  });

  it("excludes sessions that have no projectRoot", () => {
    const sessions: ResumeSessionRef[] = [
      { sessionId: "scoped", projectRoot: ROOT_A },
      { sessionId: "loose" }
    ];

    const result = filterSessions(sessions, { projectRoot: ROOT_A });

    expect(result.map((s) => s.sessionId)).toEqual(["scoped"]);
  });

  it("is case-sensitive (paths are not lower-cased)", () => {
    const sessions: ResumeSessionRef[] = [
      { sessionId: "lower", projectRoot: "/home/operator/project-a" },
      { sessionId: "upper", projectRoot: "/home/operator/Project-A" }
    ];

    const result = filterSessions(sessions, { projectRoot: "/home/operator/Project-A" });

    expect(result.map((s) => s.sessionId)).toEqual(["upper"]);
  });
});

describe("filterSessions --all", () => {
  it("returns the entire global list, ignoring projectRoot", () => {
    const sessions = sampleSessions();

    const result = filterSessions(sessions, { projectRoot: ROOT_A, all: true });

    expect(result.map((s) => s.sessionId)).toEqual([
      "a1",
      "b1",
      "a2",
      "unscoped1",
      "b2"
    ]);
  });

  it("returns the global list even when projectRoot is omitted", () => {
    const sessions = sampleSessions();

    const result = filterSessions(sessions, { all: true });

    expect(result).toHaveLength(sessions.length);
  });

  it("does not mutate the global view when projectRoot would otherwise filter", () => {
    const sessions = sampleSessions();

    const result = filterSessions(sessions, { projectRoot: ROOT_B, all: true });

    expect(result.map((s) => s.sessionId)).toContain("a1");
    expect(result.map((s) => s.sessionId)).toContain("b1");
  });
});

describe("filterSessions — default and edge behavior", () => {
  it("returns an empty list when neither projectRoot nor all is provided", () => {
    const result = filterSessions(sampleSessions(), {});

    expect(result).toEqual([]);
  });

  it("returns an empty list when called with no options", () => {
    const result = filterSessions(sampleSessions());

    expect(result).toEqual([]);
  });

  it("returns an empty list when projectRoot is an empty string", () => {
    const result = filterSessions(sampleSessions(), { projectRoot: "" });

    expect(result).toEqual([]);
  });

  it("returns an empty list when the input list is empty", () => {
    expect(filterSessions([], { projectRoot: ROOT_A })).toEqual([]);
    expect(filterSessions([], { all: true })).toEqual([]);
  });

  it("returns an empty list when no session matches the filter", () => {
    const result = filterSessions(sampleSessions(), {
      projectRoot: "/home/operator/project-c"
    });

    expect(result).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const sessions = sampleSessions();
    const snapshot = sessions.map((s) => ({ ...s }));

    filterSessions(sessions, { projectRoot: ROOT_A });

    expect(sessions).toEqual(snapshot);
  });

  it("returns a new array instance (does not return the input reference)", () => {
    const sessions = sampleSessions();

    const allResult = filterSessions(sessions, { all: true });

    expect(allResult).not.toBe(sessions);
  });

  it("is deterministic across repeated calls with the same input", () => {
    const sessions = sampleSessions();
    const options = { projectRoot: ROOT_A };

    const first = filterSessions(sessions, options);
    const second = filterSessions(sessions, options);

    expect(first).toEqual(second);
  });
});
