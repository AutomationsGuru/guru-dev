import { describe, expect, it } from "vitest";

import { listSyncable } from '../../src/sandbox/gitignoreDownloadSync.js';

describe("listSyncable", () => {
  it("excludes paths covered by a directory ignore pattern", () => {
    expect(listSyncable(["src/index.ts", "node_modules/vitest/index.js"], ["node_modules/"])).toEqual(["src/index.ts"]);
  });

  it("keeps a later negated path pattern", () => {
    expect(listSyncable(["build/app.js", "build/keep.js"], ["build/", "!build/keep.js"])).toEqual(["build/keep.js"]);
  });
});
