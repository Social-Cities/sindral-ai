export interface PlanOverview {
  behaviorChange: string;
  affectedSystems: string;
  invariants: string;
  edgeCases: string;
  verification: string;
}

const MISSING = 'Not specified in this plan.';

function normalizeHeading(value: string): keyof PlanOverview | null {
  const heading = value.trim().replace(/[:#]+$/g, '').toLowerCase();
  if (['what behavior is changing', 'behavior changing', 'behavior change', 'behavior changes', 'summary', 'outcome', 'desired outcome'].includes(heading)) return 'behaviorChange';
  if (
    [
      'what files/systems are affected',
      'what files and systems are affected',
      'files/systems affected',
      'files and systems affected',
      'affected files/systems',
      'affected files and systems',
      'files expected to change',
      'systems affected',
    ].includes(heading)
  ) {
    return 'affectedSystems';
  }
  if (['important invariants', 'invariants', 'constraints', 'assumptions', 'plan assumptions'].includes(heading)) return 'invariants';
  if (['edge cases', 'edge cases to handle', 'risks', 'risk controls'].includes(heading)) return 'edgeCases';
  if (['how correctness will be verified', 'correctness verification', 'verification', 'verification contract', 'testing', 'acceptance criteria', 'acceptance criterion'].includes(heading)) {
    return 'verification';
  }
  return null;
}

/** Extracts the user-facing plan summary fields from agent-authored markdown. */
export function planOverview(plan: string): PlanOverview {
  const lines = plan.split(/\r?\n/);
  const sections: Partial<Record<keyof PlanOverview, string[]>> = {};
  let active: keyof PlanOverview | null = null;
  let activeLevel = 0;

  for (const line of lines) {
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const key = normalizeHeading(heading[2] ?? '');
      if (key) {
        active = key;
        activeLevel = heading[1]?.length ?? 0;
        sections[key] ??= [];
      } else if (active && (heading[1]?.length ?? 0) <= activeLevel) {
        active = null;
      }
      continue;
    }
    if (active) sections[active]!.push(line);
  }

  const fallbackSummary = lines.find((line) => line.trim() && !/^\s{0,3}#/.test(line));
  const read = (key: keyof PlanOverview, fallback = MISSING) => {
    const content = (sections[key] ?? []).join('\n').trim();
    return content || fallback;
  };

  return {
    behaviorChange: read('behaviorChange', fallbackSummary?.trim() || MISSING),
    affectedSystems: read('affectedSystems'),
    invariants: read('invariants'),
    edgeCases: read('edgeCases'),
    verification: read('verification'),
  };
}
