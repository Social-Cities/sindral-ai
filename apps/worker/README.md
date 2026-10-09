# @sindral/worker

The Sindral worker is a small Node daemon that runs on a developer's machine. It polls the central Sindral server for agent jobs, runs Claude Code or Codex inside git worktrees, pushes branches, opens or updates pull requests, and reports results back. Nothing in it is reachable from the network; it only makes outbound HTTPS requests to the server and to GitHub.

## Install

Requirements: Node 22+, `git`, and the CLIs you want to use (`claude`, `codex`, `gh`). The worker probes for them on startup and reports which are available to the server; steps that need a missing engine fail with a clear message instead of hanging.

```sh
pnpm install            # from the monorepo root
pnpm --filter @sindral/shared build
pnpm --filter @sindral/worker build
```

## Configure

Create a worker key in the Sindral UI (Settings → Worker keys) and put it in the environment, a `.env` file (current directory or repository root), or `~/.sindral/config.json`. Environment variables win over both files.

| Variable | Default | Meaning |
|---|---|---|
| `SINDRAL_SERVER_URL` | — | Base URL of the server, e.g. `https://sindral.example.com` |
| `SINDRAL_WORKER_KEY` | — | `sk_sindral_<40 hex>` key from the UI |
| `SINDRAL_WORKDIR` | `~/.sindral` | Where clones, worktrees, results and logs live |
| `SINDRAL_CONCURRENCY` | `2` | Jobs run in parallel (1–8); never two jobs of the same task |
| `SINDRAL_WORKER_NAME` | hostname | Display name in the UI |
| `SINDRAL_CLAUDE_BIN` / `SINDRAL_CODEX_BIN` / `SINDRAL_GH_BIN` | `claude` / `codex` / `gh` | Binaries to use |
| `SINDRAL_EXTRA_PATH` | — | Extra PATH entries prepended before probing and running `claude`, `codex`, and `gh`; useful for supervisor-launched workers that do not load shell profiles |
| `SINDRAL_JOB_TIMEOUT_MINUTES` | `90` | Hard limit per agent run |
| `SINDRAL_RETENTION_DAYS` | `7` | Keep inactive worktrees, temp files, results, outputs, and logs for this many days |
| `SINDRAL_ALLOW_PAT_MERGE` | `false` | Allow internal/local workers to merge using the configured PAT; keep disabled in production |
| `SINDRAL_PUBLISH_CHECKS` | — | Optional semicolon- or newline-separated commands run before the worker pushes, for example `pnpm lint; pnpm typecheck; pnpm test` |
| `SINDRAL_PUBLISH_CHECK_MODE` | `off` | `off`, `advisory`, or `strict`; strict blocks publishing when checks fail |
| `SINDRAL_PUBLISH_CHECK_TIMEOUT_MINUTES` | `30` | Timeout for each publish check command |
| `LOG_LEVEL` | `info` | pino level |

## Run

```sh
pnpm --filter @sindral/worker dev      # tsx, pretty logs
pnpm --filter @sindral/worker start    # node dist/cli.js start
sindral-worker clean --dry-run         # preview inactive retained files eligible for cleanup
sindral-worker clean                   # remove eligible files after server lease/worker checks
```

If a CLI works over SSH but the portal reports it as missing, the worker daemon is
usually running with a different PATH than your interactive shell. Set
`SINDRAL_EXTRA_PATH` to the directories that contain the CLIs and their runtime,
or set the relevant `SINDRAL_*_BIN` value to an absolute path, then restart the
worker.

`SIGINT`/`SIGTERM` stop claiming new work, keep renewing active job leases, and wait up to `SINDRAL_JOB_TIMEOUT_MINUTES` for running jobs to finish. Jobs still running at that deadline are killed and reported as failed ("worker shutting down"). Claimed jobs that have not started are released immediately.

Cleanup requires a previously registered worker and a reachable server. It refuses to run while that worker is online or owns an active job lease, preserves repository clones, and removes only inactive worktrees, temporary directories, results, outputs, and logs older than `SINDRAL_RETENTION_DAYS`.

## What it does on your machine

Everything lives under `SINDRAL_WORKDIR`:

```
repos/<owner>__<name>/       one clone per repository (fetched before every job)
worktrees/<task-key>/<name>/ one git worktree per task and repository
tmp/<task-key>/              working directory for non-code tasks
results/<jobId>.json         the JSON result the agent writes (SINDRAL_RESULT_FILE)
outputs/<jobId>/             files the agent produces for document tasks (SINDRAL_OUTPUT_DIR)
logs/<jobId>.log             full agent output for each job
worker.json                  the worker id assigned by the server
running.json                 jobs in flight (used by `clean`)
```

For each agent job the worker:

1. Fetches the repository, creates or reuses the task worktree on the task branch (`payload.branch`, else `sindral/<task-key>`) starting from `origin/<branch>` when it already exists (feedback passes) or `origin/<base branch>` otherwise.
2. Builds the prompt: the step prompt with `{{context}}` interpolated, the Sindral result-file protocol, and a workspace note (repos, branch, "commit if possible, do not push").
3. Runs `claude -p --output-format stream-json ...` or `codex exec --json -` with the prompt on stdin, streaming output to the server as job events.
4. Parses and validates the result file. For `pr` steps it commits leftover changes as `Sindral AI`, omits GitHub Actions workflow file changes that OAuth credentials cannot push, fetches and rebases onto the latest configured base branch, runs configured publish checks, pushes with bounded recovery for moved branches and transient GitHub failures, then opens a PR (`gh pr create`) or comments on the existing one with the agent's summary so GitHub reviewers see the response. For `document` steps it uploads the declared artifacts plus every text file in the output directory.
5. Renews the job's 90-second capability lease every 30 seconds while it is running or locally queued, then calls `complete` or `fail` with that claim's attempt and lease token. Expired or superseded claims cannot publish events or outcomes.

Every worker request carries an explicit wire-protocol version. The server returns the negotiated version at registration and rejects missing or incompatible versions with HTTP 426 before claiming or mutating work. Deploy the server and worker from the same release. Protocol-aware incompatible workers stop on their next API request; older workers that predate negotiation are still fenced by the server, and any claimed jobs expire and are safely requeued.

Rebase-stack jobs rebase each subtask branch onto its base in order and stop at the first conflict (later branches depend on it).

## Security notes

- A short-lived GitHub App installation token (production) or configured fine-grained PAT (internal/local) arrives with each matching job. It is never written to `.git/config` or a remote URL: git gets it through a per-invocation `http.extraheader` config, and `gh` gets it through `GH_TOKEN` in its environment only. PAT-backed automatic merge is disabled by default.
- Agent subprocesses never see `GH_TOKEN`, `GITHUB_TOKEN` or the worker key; they are stripped from the environment. Agents therefore cannot push or open PRs themselves; the worker does that after validating the result.
- All commands are spawned with argv arrays (no shell). Repository names, task keys and branch names are validated before they become paths or git refs.
- GitHub tokens, worker keys, and per-claim lease tokens are redacted from logs, job events and error messages, both by value and by pattern (`ghp_…`, `github_pat_…`, `sk_sindral_…`, auth headers).
- Agent subprocesses run with open local permissions inside Sindral-managed checkouts: Claude uses `--permission-mode bypassPermissions`, and Codex uses `--dangerously-bypass-approvals-and-sandbox`. Workflow step permissions remain intent metadata for prompts and orchestration, not a filesystem sandbox. Non-write steps are still instructed to avoid repository modifications, commits, pushes and PRs; the worker validates the structured result and performs GitHub publishing itself.
- A 401 from the server means the key was revoked; the worker logs that and exits with status 2. Transient errors (network, 5xx, 429) are retried with exponential backoff and jitter.
