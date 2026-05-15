// Mock filesystem for the kettle repo (used by the Code tab)

export type FsNode = FsFile | FsDir;
export interface FsFile {
  kind: "file";
  size: string;
  text: string;
  lang?: string;
  highlight?: string;
}
export interface FsDir {
  kind: "dir";
  children: Record<string, FsNode>;
}

export const FS: Record<string, FsNode> = {
  "README.md": {
    kind: "file",
    size: "4.2k",
    lang: "md",
    text: `# kettle

A CLI for orchestrating coding agents across many sandboxes.

## Quickstart

\`\`\`
cargo install kettle
kettle init
kettle worker spawn --pool sindral
\`\`\`

Read [docs/architecture.md](./docs/architecture.md) for the design.

## License

MIT`,
  },
  "Cargo.toml": {
    kind: "file",
    size: "1.1k",
    lang: "toml",
    text: `[workspace]
members = ["server", "worker", "cli"]
resolver = "2"

[workspace.dependencies]
tokio   = { version = "1.38", features = ["full"] }
axum    = "0.7"
sqlx    = { version = "0.7", features = ["postgres", "runtime-tokio"] }
serde   = { version = "1", features = ["derive"] }
tracing = "0.1"
anyhow  = "1"`,
  },
  "package.json": {
    kind: "file",
    size: "0.9k",
    lang: "json",
    text: `{
  "name": "kettle-ui",
  "version": "0.4.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest"
  },
  "dependencies": {
    "react": "18.3.1",
    "react-dom": "18.3.1"
  }
}`,
  },
  server: {
    kind: "dir",
    children: {
      src: {
        kind: "dir",
        children: {
          "main.rs": {
            kind: "file",
            size: "0.6k",
            lang: "rust",
            text: `use anyhow::Result;
use kettle_server::{config, run};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let cfg = config::load()?;
    run(cfg).await
}`,
          },
          "lib.rs": {
            kind: "file",
            size: "0.3k",
            lang: "rust",
            text: `pub mod config;
pub mod db;
pub mod error;
pub mod middleware;
pub mod queue;
pub mod routes;
pub mod task;

use anyhow::Result;
use config::Config;

pub async fn run(cfg: Config) -> Result<()> {
    let pool = db::connect(&cfg.database_url).await?;
    routes::serve(pool, cfg).await
}`,
          },
          routes: {
            kind: "dir",
            children: {
              "mod.rs": {
                kind: "file",
                size: "0.4k",
                lang: "rust",
                text: `pub mod messages;
pub mod tasks;
pub mod workers;

use axum::Router;

pub fn router() -> Router<crate::AppCtx> {
    Router::new()
        .nest("/v1/messages", messages::router())
        .nest("/v1/tasks", tasks::router())
        .nest("/v1/workers", workers::router())
}`,
              },
              "messages.rs": {
                kind: "file",
                size: "5.8k",
                lang: "rust",
                highlight: "AGT-142",
                text: `use axum::{
    extract::State,
    response::Response,
    Json,
};
use crate::{AppCtx, error::ApiError};

const UPSTREAM: &str = "https://api.anthropic.com/v1/messages";

// XXX: This buffers the entire response before returning it to the
// client. For long tool-use sessions this introduces 8-40s of perceived
// latency. AGT-142 will replace this with a streaming proxy.
pub async fn messages(
    State(ctx): State<AppCtx>,
    Json(req): Json<MessagesRequest>,
) -> Result<Json<MessagesResponse>, ApiError> {
    let resp = ctx.client
        .post(UPSTREAM)
        .header("authorization", &ctx.upstream_key)
        .json(&req)
        .send()
        .await?
        .json::<MessagesResponse>()
        .await?;
    Ok(Json(resp))
}`,
              },
            },
          },
          queue: {
            kind: "dir",
            children: {
              "mod.rs": {
                kind: "file",
                size: "3.4k",
                lang: "rust",
                highlight: "AGT-138",
                text: `use crate::db::PgPool;
use crate::task::Task;
use sqlx::postgres::PgListener;

pub struct Worker {
    pool: PgPool,
    listener: PgListener,
    id: WorkerId,
}

impl Worker {
    pub async fn run(mut self) -> Result<()> {
        self.listener.listen("task_enqueued").await?;
        loop {
            // Drain any tasks already queued before we listened.
            while let Some(task) = self.try_claim_next().await? {
                self.execute(task).await?;
            }
            // Block on the next NOTIFY.
            self.listener.recv().await?;
        }
    }
}`,
              },
              "tests.rs": {
                kind: "file",
                size: "2.1k",
                lang: "rust",
                text: `#[tokio::test]
async fn worker_picks_up_enqueued_task() -> Result<()> {
    let pool = test_pool().await;
    let worker = Worker::new(pool.clone(), WorkerId::new()).await?;
    let handle = tokio::spawn(worker.run());
    enqueue(&pool, "noop").await?;
    // Should pick up within 50ms now (was 250ms p50 with polling).
    wait_until_done(&pool, Duration::from_millis(100)).await?;
    assert_eq!(completed_count(&pool).await?, 1);
    handle.abort();
    Ok(())
}`,
              },
            },
          },
          middleware: {
            kind: "dir",
            children: {
              "mod.rs": { kind: "file", size: "0.2k", lang: "rust", text: `pub mod auth;\npub mod ratelimit;` },
              "ratelimit.rs": {
                kind: "file",
                size: "2.7k",
                lang: "rust",
                text: `// TODO: release token on connection close, not response start.\n// Tracking in AGT-142.\n\npub struct RateLimit { ... }`,
              },
              "auth.rs": { kind: "file", size: "1.4k", lang: "rust", text: `pub async fn require_token(...) { ... }` },
            },
          },
          "task.rs": { kind: "file", size: "1.8k", lang: "rust", text: `pub struct Task { ... }` },
          "db.rs": {
            kind: "file",
            size: "0.9k",
            lang: "rust",
            text: `pub type PgPool = sqlx::PgPool;\npub async fn connect(url: &str) -> Result<PgPool> { ... }`,
          },
          "error.rs": {
            kind: "file",
            size: "0.6k",
            lang: "rust",
            text: `#[derive(thiserror::Error, Debug)]\npub enum ApiError { ... }`,
          },
          "config.rs": { kind: "file", size: "0.5k", lang: "rust", text: `pub struct Config { pub database_url: String }` },
        },
      },
      migrations: {
        kind: "dir",
        children: {
          "0001_init.sql": { kind: "file", size: "1.2k", text: `CREATE TABLE tasks ( ... );` },
          "0014_task_notify.sql": {
            kind: "file",
            size: "0.4k",
            highlight: "AGT-138",
            text: `-- Notify workers when a task is enqueued.\nCREATE OR REPLACE FUNCTION notify_task_enqueued() ...`,
          },
        },
      },
      "Cargo.toml": { kind: "file", size: "0.7k", lang: "toml", text: `[package]\nname = "kettle-server"\nversion = "0.4.0"` },
    },
  },
  worker: {
    kind: "dir",
    children: {
      src: {
        kind: "dir",
        children: {
          "main.rs": { kind: "file", size: "0.4k", lang: "rust", text: `fn main() { kettle_worker::run() }` },
          "sandbox.rs": { kind: "file", size: "4.1k", lang: "rust", text: `pub struct Sandbox { ... }` },
          "agent.rs": { kind: "file", size: "3.3k", lang: "rust", text: `pub struct Agent { ... }` },
        },
      },
      "Cargo.toml": { kind: "file", size: "0.5k", lang: "toml", text: `[package]\nname = "kettle-worker"` },
    },
  },
  ui: {
    kind: "dir",
    children: {
      src: {
        kind: "dir",
        children: {
          "App.tsx": { kind: "file", size: "1.6k", lang: "tsx", text: `export function App() { return <div>...</div> }` },
          "routes.tsx": { kind: "file", size: "0.8k", lang: "tsx", text: `export const routes = [ ... ]` },
        },
      },
      "index.html": { kind: "file", size: "0.2k", lang: "html", text: `<!doctype html>\n<html>...</html>` },
    },
  },
  docs: {
    kind: "dir",
    children: {
      "architecture.md": { kind: "file", size: "8.1k", text: `# Architecture\n\nKettle is a three-tier system: server, worker, sandbox...` },
      "agent-protocol.md": { kind: "file", size: "3.4k", text: `# Agent ↔ worker handshake\n\nSee AGT-136 for context.` },
    },
  },
  ".github": {
    kind: "dir",
    children: {
      workflows: {
        kind: "dir",
        children: {
          "ci.yml": { kind: "file", size: "1.1k", lang: "yaml", text: `name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest` },
          "release.yml": { kind: "file", size: "0.7k", lang: "yaml", text: `name: release\non:\n  push:\n    tags: ['v*']` },
        },
      },
    },
  },
  ".gitignore": { kind: "file", size: "0.1k", text: `target/\nnode_modules/\n.env\n*.log` },
};

export function getFile(path: string): FsFile | null {
  if (!path) return null;
  const parts = path.split("/");
  let cur: Record<string, FsNode> = FS;
  for (let i = 0; i < parts.length; i++) {
    const k = parts[i];
    if (i === parts.length - 1) return cur[k] && cur[k].kind === "file" ? (cur[k] as FsFile) : null;
    if (!cur[k] || cur[k].kind !== "dir") return null;
    cur = (cur[k] as FsDir).children;
  }
  return null;
}
