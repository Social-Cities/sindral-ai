import { describe, expect, it } from 'vitest';
import { Metrics } from './metrics.js';

describe('Metrics', () => {
  it('renders gauges, counters and duration summaries with escaped labels', () => {
    const metrics = new Metrics();
    metrics.inc('sindral_webhook_failures_total', { reason: 'bad"signature' });
    metrics.observe('sindral_job_duration_seconds', 2.5, { kind: 'agent' });
    const text = metrics.render({ taskStates: { planning: 2 }, jobStatuses: { running: 1 }, workerCount: 3, oldestWorkerHeartbeatAgeSeconds: 12 });
    expect(text).toContain('sindral_tasks{state="planning"} 2');
    expect(text).toContain('sindral_jobs{status="running"} 1');
    expect(text).toContain('sindral_webhook_failures_total{reason="bad\\"signature"} 1');
    expect(text).toContain('sindral_job_duration_seconds_sum{kind="agent"} 2.5');
    expect(text).toContain('sindral_job_duration_seconds_count{kind="agent"} 1');
  });
});
