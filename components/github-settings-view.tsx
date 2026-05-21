"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { GithubInstallation } from "@/lib/db/types";
import {
  disconnectGithubInstallationAction,
  getGithubInstallStartUrl,
} from "@/lib/actions/github";

interface Banner {
  kind: "ok" | "err";
  text: string;
}

export function GithubSettingsView({
  installations,
  banner,
}: {
  installations: GithubInstallation[];
  banner: Banner | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const connect = () => {
    setError(null);
    startTransition(async () => {
      const result = await getGithubInstallStartUrl();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Top-level nav so the browser follows the GitHub install redirect.
      window.location.href = result.url;
    });
  };

  const disconnect = (id: string) => {
    setError(null);
    startTransition(async () => {
      const result = await disconnectGithubInstallationAction(id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontStyle: "italic",
          fontSize: 26,
          marginBottom: 16,
        }}
      >
        GitHub
      </div>
      <div className="muted" style={{ marginBottom: 16 }}>
        Connect your GitHub account or organization so Sindral teammates can
        clone, push, and open pull requests under your identity. Each project
        picks one installation from its settings.
      </div>
      {banner && (
        <div
          style={{
            padding: "10px 12px",
            borderRadius: 6,
            marginBottom: 16,
            background: banner.kind === "ok" ? "var(--ok-bg, #1e2b1e)" : "var(--err-bg, #2b1e1e)",
            color: banner.kind === "ok" ? "var(--ok, #5dd25d)" : "var(--type-bug)",
            fontSize: 13,
          }}
        >
          {banner.text}
        </div>
      )}
      {error && (
        <div style={{ color: "var(--type-bug)", fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}
      <div style={{ marginBottom: 16 }}>
        <button className="btn primary" onClick={connect} disabled={pending}>
          {pending ? "Working…" : "Connect GitHub"}
        </button>
      </div>
      {installations.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>
          No installations yet. Click <em>Connect GitHub</em> to install the
          Sindral AI app against your account or an org you administer.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {installations.map((inst) => (
            <div
              key={inst.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 12px",
                border: "1px solid var(--border)",
                borderRadius: 6,
              }}
            >
              <div>
                <div style={{ fontWeight: 600 }}>{inst.accountLogin}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {inst.accountType} · installation #{inst.installationId}
                </div>
              </div>
              <button
                className="btn ghost"
                onClick={() => disconnect(inst.id)}
                disabled={pending}
              >
                Disconnect
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
