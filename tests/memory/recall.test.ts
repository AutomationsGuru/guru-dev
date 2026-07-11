import { describe, expect, it } from "vitest";

import { buildRecallIndex, queryRecall, tokenizeRecall } from "../../src/memory/recall.js";

describe("recall — BM25 semantic ranking (§7 Smart Connections)", () => {
  const docs = [
    { id: "auth", text: "the authentication flow validates the oauth token before granting access" },
    { id: "router", text: "the model router picks a route by capability and credential" },
    { id: "ledger", text: "reconcile the finance ledger nightly at two am" }
  ];
  const index = buildRecallIndex(docs);

  it("ranks the doc whose terms match the query first", () => {
    expect(queryRecall(index, "oauth token authentication")[0]?.id).toBe("auth");
    expect(queryRecall(index, "reconcile finance ledger")[0]?.id).toBe("ledger");
    expect(queryRecall(index, "route capability credential")[0]?.id).toBe("router");
  });

  it("returns ONLY matched docs; a no-match / too-short query yields nothing", () => {
    expect(queryRecall(index, "nonexistent zzz").length).toBe(0);
    expect(queryRecall(index, "a b to").length).toBe(0); // all tokens ≤ 2 chars, dropped
    expect(queryRecall(index, "").length).toBe(0);
  });

  it("a rare, specific term outweighs one common to every doc (idf)", () => {
    const ds = [
      { id: "a", text: "common common common oauth" },
      { id: "b", text: "common common common common" }
    ];
    const idx = buildRecallIndex(ds);
    // 'oauth' occurs in only one doc → only that doc matches.
    expect(queryRecall(idx, "oauth").map((hit) => hit.id)).toEqual(["a"]);
    // 'common' is in both; the doc with more of it ranks first.
    const common = queryRecall(idx, "common");
    expect(common.length).toBe(2);
    expect(common[0]?.id).toBe("b");
  });

  it("empty index → empty; limit caps the result count", () => {
    expect(queryRecall(buildRecallIndex([]), "anything").length).toBe(0);
    expect(queryRecall(index, "the", 1).length).toBeLessThanOrEqual(1);
  });

  it("scores are deterministic and tie-break by id", () => {
    const ds = [
      { id: "bbb", text: "same words here" },
      { id: "aaa", text: "same words here" }
    ];
    const hits = queryRecall(buildRecallIndex(ds), "same words");
    expect(hits.map((h) => h.id)).toEqual(["aaa", "bbb"]); // equal score → id asc
  });

  it("tokenizeRecall lowercases, keeps >=2-char tokens, drops single chars (review 2026-07-08)", () => {
    // >= 2 so 2-char meaningful terms (db, js, go) are searchable; single letters stay excluded.
    expect(tokenizeRecall("The OAuth  Flow, at 2am!")).toEqual(["the", "oauth", "flow", "at", "2am"]);
    expect(tokenizeRecall("db js go ai")).toEqual(["db", "js", "go", "ai"]);
    expect(tokenizeRecall("a I x")).toEqual([]);
  });
});
