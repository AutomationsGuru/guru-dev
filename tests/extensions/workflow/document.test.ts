import { describe, expect, it } from "vitest";

import { parseWorkflowDocument } from '../../../src/extensions/workflow/document.js';

const validDocument = {
  agents: [{ id: "collect" }, { id: "review" }, { id: "publish" }],
  entry: "collect",
  routes: [
    { from: "collect", to: "review", when: "has_findings" },
    { from: "collect", to: "publish", fallback: true },
    { from: "review", to: "publish", fallback: true }
  ],
  outputs: [{ id: "result", from: "publish" }]
};

describe("parseWorkflowDocument", () => {
  it("accepts a bounded document with declared agents, routes, and outputs", () => {
    const result = parseWorkflowDocument(validDocument);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(validDocument);
    }
  });

  it("rejects a missing or unknown entry agent", () => {
    expect(parseWorkflowDocument({ ...validDocument, entry: "missing" }).success).toBe(false);
    expect(parseWorkflowDocument({ ...validDocument, entry: "" }).success).toBe(false);
  });

  it("rejects duplicate agent or output ids", () => {
    expect(
      parseWorkflowDocument({
        ...validDocument,
        agents: [...validDocument.agents, { id: "review" }]
      }).success
    ).toBe(false);
    expect(
      parseWorkflowDocument({
        ...validDocument,
        outputs: [...validDocument.outputs, { id: "result", from: "publish" }]
      }).success
    ).toBe(false);
  });

  it("rejects routes and outputs that reference undeclared agents", () => {
    expect(
      parseWorkflowDocument({
        ...validDocument,
        routes: [...validDocument.routes, { from: "missing", to: "publish", fallback: true }]
      }).success
    ).toBe(false);
    expect(parseWorkflowDocument({ ...validDocument, outputs: [{ id: "result", from: "missing" }] }).success).toBe(false);
  });

  it("requires a fallback route to be the final route from its source agent", () => {
    expect(
      parseWorkflowDocument({
        ...validDocument,
        routes: [
          { from: "collect", to: "publish", fallback: true },
          { from: "collect", to: "review", when: "has_findings" }
        ]
      }).success
    ).toBe(false);
  });

  it("rejects unknown fields at every document level", () => {
    expect(parseWorkflowDocument({ ...validDocument, unexpected: true }).success).toBe(false);
    expect(parseWorkflowDocument({ ...validDocument, agents: [{ id: "collect", unexpected: true }] }).success).toBe(false);
    expect(
      parseWorkflowDocument({
        ...validDocument,
        routes: [{ from: "collect", to: "review", when: "has_findings", unexpected: true }]
      }).success
    ).toBe(false);
    expect(parseWorkflowDocument({ ...validDocument, outputs: [{ id: "result", from: "publish", unexpected: true }] }).success).toBe(false);
  });
});
