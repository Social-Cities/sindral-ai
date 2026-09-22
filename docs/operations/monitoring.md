# Monitoring and alerts

Scrape `GET /api/metrics` with `Authorization: Bearer <METRICS_TOKEN>`. Keep the token in the monitoring system's secret store. Metrics contain aggregate states and bounded outcome labels only; identifiers remain in structured application logs.

Recommended initial alerts:

| Signal | Starting condition | Response |
|---|---|---|
| `sindral_worker_oldest_heartbeat_age_seconds` | > 180 for 5 minutes while queued jobs exist | Check worker host, key revocation, protocol mismatch, and network path. |
| `increase(sindral_lease_expiries_total[15m])` | > 3 | Inspect worker crashes/timeouts before retries exhaust. |
| `increase(sindral_merge_failures_total[15m])` | > 0 | Disable automatic merge and inspect branch protection/head drift. |
| `increase(sindral_webhook_failures_total[15m])` | > 5 | Check signature secret, delivery replay, GitHub availability, and server errors. |
| `increase(sindral_conflict_resolution_total{outcome="escalated"}[1h])` | sustained rise | Review protected paths, failed checks, and conflict patterns; do not increase safety limits reflexively. |
| `increase(sindral_transition_conflicts_total[15m])` | sustained rise | Check stale clients, duplicate actions, and database contention. |
| `increase(sindral_validation_failures_total[15m])` | sharp rise | Identify the failing boundary and possible client/worker version drift. |

Dashboard task/job state gauges, claim latency, job duration by kind/outcome, retry and lease-expiry rates, conflict-resolution outcomes, merge failures, webhook failures, and worker heartbeat age. Correlate an alert to logs using `requestId`/Fastify `reqId`, `deliveryId`, `userId`, `taskId`, and `jobId`; do not add task descriptions, message content, tokens, or webhook bodies to metric labels or routine logs.
