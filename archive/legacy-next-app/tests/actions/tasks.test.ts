import { describe, it, expect, vi, beforeEach } from "vitest";

// Manual mock instead of `vi.fn`. vi.fn's internal promise tracking causes
// an unhandled-rejection event even when the code under test catches via
// await — see https://github.com/vitest-dev/vitest/issues for context.
const handle = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  }
  type Impl = (...args: unknown[]) => unknown;
  let impl: Impl = () => Promise.resolve({});
  const calls: unknown[][] = [];
  return {
    ApiError,
    set(f: Impl) {
      impl = f;
    },
    reset() {
      impl = () => Promise.resolve({});
      calls.length = 0;
    },
    callAuthed(...args: unknown[]) {
      calls.push(args);
      return impl(...args);
    },
    calls,
  };
});

vi.mock("@/lib/api", () => ({
  ApiError: handle.ApiError,
  callAuthed: handle.callAuthed,
}));

import { createTaskAction } from "@/lib/actions/tasks";

beforeEach(() => handle.reset());

describe("createTaskAction", () => {
  it("forwards the input (with runtime) to /tasks and returns the new id", async () => {
    handle.set(async () => ({ success: true, id: "AGT-7-aaaaaaaa" }));
    const r = await createTaskAction({
      projectId: "p1",
      type: "feature",
      title: "Add streaming",
      desc: "details",
      autoplan: true,
      planner: "a1",
      runtime: "claude_code",
    });
    expect(r).toEqual({ ok: true, id: "AGT-7-aaaaaaaa" });
    expect(handle.calls).toEqual([
      [
        "/tasks",
        {
          method: "POST",
          body: {
            projectId: "p1",
            type: "feature",
            title: "Add streaming",
            desc: "details",
            autoplan: true,
            planner: "a1",
            runtime: "claude_code",
          },
        },
      ],
    ]);
  });

  it("supports null planner when autoplan is off", async () => {
    handle.set(async () => ({ success: true, id: "AGT-8-aaaaaaaa" }));
    const r = await createTaskAction({
      projectId: "p1",
      type: "bug",
      title: "Fix it",
      desc: "",
      autoplan: false,
      planner: null,
      runtime: "codex",
    });
    expect(r).toEqual({ ok: true, id: "AGT-8-aaaaaaaa" });
    const body = (handle.calls[0]?.[1] as { body: Record<string, unknown> }).body;
    expect(body.planner).toBeNull();
    expect(body.runtime).toBe("codex");
  });

  it("forwards backend validation errors", async () => {
    handle.set(async () => {
      throw new handle.ApiError(400, "Title is required.");
    });
    const r = await createTaskAction({
      projectId: "p1",
      type: "feature",
      title: "",
      desc: "",
      autoplan: false,
      planner: null,
      runtime: "claude_code",
    });
    expect(r).toEqual({ ok: false, error: "Title is required." });
  });

  it("returns 'Not signed in' on 401", async () => {
    handle.set(async () => {
      throw new handle.ApiError(401, "Not signed in");
    });
    const r = await createTaskAction({
      projectId: "p1",
      type: "feature",
      title: "t",
      desc: "",
      autoplan: false,
      planner: null,
      runtime: "claude_code",
    });
    expect(r).toEqual({ ok: false, error: "Not signed in" });
  });
});
