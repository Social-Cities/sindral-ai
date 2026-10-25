# Build shared and worker, then start the worker.
default: start-worker

# Build the worker and its shared package dependency.
build-worker:
    pnpm --filter @sindral/worker... build

# Build and start the worker in the foreground.
start-worker: build-worker
    pnpm --filter @sindral/worker start
