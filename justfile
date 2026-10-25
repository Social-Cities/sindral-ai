# Install dependencies, build shared and worker, then start the worker.
default: start-worker

# Refresh workspace dependencies from the checked-in lockfile.
install-deps:
    pnpm install --frozen-lockfile

# Build the worker and its shared package dependency.
build-worker: install-deps
    pnpm --filter @sindral/worker... build

# Build and start the worker in the foreground.
start-worker: build-worker
    pnpm --filter @sindral/worker start
