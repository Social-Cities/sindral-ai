import { describe, it, expect, vi, beforeEach } from "vitest";

const handle = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  }
  type Impl = (...args: unknown[]) => unknown;
  const make = () => {
    let impl: Impl = () => Promise.resolve({});
    return {
      set(f: Impl) {
        impl = f;
      },
      reset() {
        impl = () => Promise.resolve({});
      },
      fn(...args: unknown[]) {
        return impl(...args);
      },
    };
  };
  return {
    ApiError,
    callPublic: make(),
    callAuthed: make(),
    writeSession: vi.fn(),
    clearSession: vi.fn(),
  };
});

vi.mock("@/lib/api", () => ({
  ApiError: handle.ApiError,
  callPublic: handle.callPublic.fn,
  callAuthed: handle.callAuthed.fn,
}));

vi.mock("@/lib/session", () => ({
  writeSession: handle.writeSession,
  clearSession: handle.clearSession,
}));

import { signInAction, signUpAction, signOutAction } from "@/lib/actions/auth";

beforeEach(() => {
  handle.callPublic.reset();
  handle.callAuthed.reset();
  handle.writeSession.mockReset();
  handle.clearSession.mockReset();
});

describe("signInAction", () => {
  it("writes session cookies on success", async () => {
    handle.callPublic.set(async () => ({
      success: true,
      user: { id: "u1", email: "a@b.c" },
      accessToken: "AT",
      refreshToken: "RT",
    }));
    const r = await signInAction("a@b.c", "pw");
    expect(r).toEqual({ ok: true });
    expect(handle.writeSession).toHaveBeenCalledWith({
      accessToken: "AT",
      refreshToken: "RT",
    });
  });

  it("forwards backend errors", async () => {
    handle.callPublic.set(async () => {
      throw new handle.ApiError(401, "Invalid login credentials");
    });
    const r = await signInAction("a@b.c", "wrong");
    expect(r).toEqual({ ok: false, error: "Invalid login credentials" });
    expect(handle.writeSession).not.toHaveBeenCalled();
  });

  it("surfaces email-confirmation requirement", async () => {
    handle.callPublic.set(async () => ({
      success: true,
      requiresConfirmation: true,
    }));
    const r = await signInAction("a@b.c", "pw");
    expect(r).toEqual({
      ok: false,
      error: "Check your email to confirm your account.",
    });
    expect(handle.writeSession).not.toHaveBeenCalled();
  });
});

describe("signUpAction", () => {
  it("writes session on immediate signup", async () => {
    handle.callPublic.set(async () => ({
      success: true,
      user: { id: "u1", email: "a@b.c" },
      accessToken: "AT",
      refreshToken: "RT",
    }));
    const r = await signUpAction("a@b.c", "pw");
    expect(r).toEqual({ ok: true });
    expect(handle.writeSession).toHaveBeenCalled();
  });
});

describe("signOutAction", () => {
  it("clears session and redirects", async () => {
    handle.callAuthed.set(async () => ({ success: true }));
    await expect(signOutAction()).rejects.toThrow("__REDIRECT__:/login");
    expect(handle.clearSession).toHaveBeenCalled();
  });

  it("clears session even when backend call fails", async () => {
    handle.callAuthed.set(async () => {
      throw new handle.ApiError(500, "boom");
    });
    await expect(signOutAction()).rejects.toThrow("__REDIRECT__:/login");
    expect(handle.clearSession).toHaveBeenCalled();
  });
});
