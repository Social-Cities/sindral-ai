export interface OperationalSnapshot {
  taskStates: Record<string, number>;
  jobStatuses: Record<string, number>;
  workerCount: number;
  oldestWorkerHeartbeatAgeSeconds: number;
}

type Labels = Record<string, string>;

interface MetricValue {
  labels: Labels;
  value: number;
}

/** Small dependency-free Prometheus registry with deliberately low-cardinality labels. */
export class Metrics {
  private readonly counters = new Map<string, MetricValue>();
  private readonly summaries = new Map<string, MetricValue & { count: number }>();

  inc(name: string, labels: Labels = {}, amount = 1): void {
    const key = metricKey(name, labels);
    const current = this.counters.get(key);
    this.counters.set(key, { labels, value: (current?.value ?? 0) + amount });
  }

  observe(name: string, seconds: number, labels: Labels = {}): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    const key = metricKey(name, labels);
    const current = this.summaries.get(key);
    this.summaries.set(key, { labels, value: (current?.value ?? 0) + seconds, count: (current?.count ?? 0) + 1 });
  }

  render(snapshot: OperationalSnapshot): string {
    const lines = [
      '# HELP sindral_tasks Current tasks by workflow state.',
      '# TYPE sindral_tasks gauge',
      ...samples('sindral_tasks', snapshot.taskStates, 'state'),
      '# HELP sindral_jobs Current jobs by status.',
      '# TYPE sindral_jobs gauge',
      ...samples('sindral_jobs', snapshot.jobStatuses, 'status'),
      '# HELP sindral_workers Current registered workers.',
      '# TYPE sindral_workers gauge',
      `sindral_workers ${snapshot.workerCount}`,
      '# HELP sindral_worker_oldest_heartbeat_age_seconds Age of the stalest worker heartbeat.',
      '# TYPE sindral_worker_oldest_heartbeat_age_seconds gauge',
      `sindral_worker_oldest_heartbeat_age_seconds ${finite(snapshot.oldestWorkerHeartbeatAgeSeconds)}`,
    ];
    const counters = [...this.counters.entries()].sort();
    for (const name of metricNames(counters)) {
      lines.push(`# TYPE ${name} counter`);
      for (const [key, metric] of counters) if (key.startsWith(`${name}|`)) lines.push(`${name}${formatLabels(metric.labels)} ${metric.value}`);
    }
    const summaries = [...this.summaries.entries()].sort();
    for (const name of metricNames(summaries)) {
      lines.push(`# TYPE ${name} summary`);
      for (const [key, metric] of summaries) {
        if (key.startsWith(`${name}|`)) lines.push(`${name}_sum${formatLabels(metric.labels)} ${metric.value}`, `${name}_count${formatLabels(metric.labels)} ${metric.count}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

function metricKey(name: string, labels: Labels): string {
  return `${name}|${Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join(',')}`;
}

function metricNames(entries: [string, unknown][]): string[] {
  return [...new Set(entries.map(([key]) => key.slice(0, key.indexOf('|'))))];
}

function samples(name: string, values: Record<string, number>, label: string): string[] {
  return Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${name}${formatLabels({ [label]: key })} ${finite(value)}`);
}

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  return `{${entries.map(([key, value]) => `${key}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`).join(',')}}`;
}

function finite(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
