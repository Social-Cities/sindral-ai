import { describe, it, expect, vi, beforeEach } from "vitest";

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

import {
  createProjectAction,
  deleteProjectAction,
  updateProjectAction,
} from "@/lib/actions/projects";

beforeEach(() => handle.reset());

const sampleProject = {
  id: "lattice-aaaaaaaa-x",
  name: "Lattice",
  repo: null,
  emoji: "◇",
  description: null,
  active: false,
};

describe("createProjectAction", () => {
  it("posts to /projects with a null repo when blank", async () => {
    handle.set(async () => ({ success: true, project: sampleProject }));
    const r = await createProjectAction({
      name: "Lattice",
      repo: null,
      emoji: "◇",
    });
    expect(r).toEqual({ ok: true, project: sampleProject });
    expect(handle.calls).toEqual([
      [
        "/projects",
        {
          method: "POST",
          body: { name: "Lattice", repo: null, emoji: "◇" },
        },
      ],
    ]);
  });

  it("forwards a provided repo URL", async () => {
    handle.set(async () => ({
      success: true,
      project: { ...sampleProject, repo: "github.com/sindral/lattice" },
    }));
    await createProjectAction({
      name: "Lattice",
      repo: "github.com/sindral/lattice",
    });
    expect(handle.calls[0]?.[1]).toMatchObject({
      body: { repo: "github.com/sindral/lattice" },
    });
  });

  it("forwards backend validation errors", async () => {
    handle.set(async () => {
      throw new handle.ApiError(400, "Name is required.");
    });
    const r = await createProjectAction({ name: "", repo: null });
    expect(r).toEqual({ ok: false, error: "Name is required." });
  });

  it("forwards githubInstallationId in the body", async () => {
    handle.set(async () => ({
      success: true,
      project: { ...sampleProject, githubInstallationId: "gh-inst-aaa" },
    }));
    await createProjectAction({
      name: "Lattice",
      repo: "sindral/lattice",
      githubInstallationId: "gh-inst-aaa",
    });
    expect(handle.calls[0]?.[1]).toMatchObject({
      body: {
        name: "Lattice",
        repo: "sindral/lattice",
        githubInstallationId: "gh-inst-aaa",
      },
    });
  });
});

describe("updateProjectAction", () => {
  it("PATCHes /projects/:id with the patch body", async () => {
    handle.set(async () => ({
      success: true,
      project: { ...sampleProject, repo: "github.com/sindral/lattice" },
    }));
    const r = await updateProjectAction({
      id: "lattice-aaaaaaaa-x",
      repo: "github.com/sindral/lattice",
    });
    expect(r.ok).toBe(true);
    expect(handle.calls).toEqual([
      [
        "/projects/lattice-aaaaaaaa-x",
        {
          method: "PATCH",
          body: { repo: "github.com/sindral/lattice" },
        },
      ],
    ]);
  });

  it("forwards backend errors", async () => {
    handle.set(async () => {
      throw new handle.ApiError(400, "No fields to update.");
    });
    const r = await updateProjectAction({ id: "p1" });
    expect(r).toEqual({ ok: false, error: "No fields to update." });
  });
});

describe("deleteProjectAction", () => {
  it("DELETEs /projects/:id and reports ok on success", async () => {
    handle.set(async () => ({ success: true }));
    const r = await deleteProjectAction("lattice-aaaaaaaa-x");
    expect(r).toEqual({ ok: true });
    expect(handle.calls).toEqual([
      [
        "/projects/lattice-aaaaaaaa-x",
        { method: "DELETE" },
      ],
    ]);
  });

  it("encodes the id so slashes can't escape the path", async () => {
    handle.set(async () => ({ success: true }));
    await deleteProjectAction("with/slash");
    expect(handle.calls[0]?.[0]).toBe("/projects/with%2Fslash");
  });

  it("forwards backend errors", async () => {
    handle.set(async () => {
      throw new handle.ApiError(400, "FK violation");
    });
    const r = await deleteProjectAction("p1");
    expect(r).toEqual({ ok: false, error: "FK violation" });
  });
});
