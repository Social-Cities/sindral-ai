import { describe, it, expect } from "vitest";

import {
  MODELS_BY_RUNTIME,
  RUNTIME_KINDS,
  inferRuntimeFromModel,
} from "@/lib/data";

describe("MODELS_BY_RUNTIME", () => {
  it("provides at least one model for every runtime", () => {
    for (const runtime of Object.keys(RUNTIME_KINDS) as Array<
      keyof typeof RUNTIME_KINDS
    >) {
      expect(MODELS_BY_RUNTIME[runtime].length).toBeGreaterThan(0);
    }
  });
});

describe("inferRuntimeFromModel", () => {
  it("matches catalog entries to their runtime", () => {
    expect(inferRuntimeFromModel("claude-opus-4-7")).toBe("claude_code");
    expect(inferRuntimeFromModel("gpt-5-codex")).toBe("codex");
  });

  it("falls back to claude_code for unknown claude-prefixed models", () => {
    expect(inferRuntimeFromModel("claude-future-9")).toBe("claude_code");
  });

  it("falls back to codex for unknown non-claude models", () => {
    expect(inferRuntimeFromModel("o5-mini")).toBe("codex");
  });
});
