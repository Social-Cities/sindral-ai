export interface PlanOverview {
  summary: string;
  outcome: string;
  assumptions: string;
  acceptanceCriteria: string;
}

const MAX_PREVIEW_LENGTH = 280;
const MISSING = 'Not specified in this plan.';

function normalizeHeading(value: string): keyof PlanOverview | null {
  const heading = value.trim().replace(/[:#]+$/g, '').toLowerCase();
  if (heading === 'summary') return 'summary';
  if (heading === 'outcome' || heading === 'desired outcome') return 'outcome';
  if (heading === 'assumptions' || heading === 'plan assumptions') return 'assumptions';
  if (heading === 'acceptance criteria' || heading === 'acceptance criterion') return 'acceptanceCriteria';
  return null;
}

function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:[-*+] |\d+[.)] |>\s?)/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function abbreviate(markdown: string): string {
  const value = plainText(markdown);
  if (value.length <= MAX_PREVIEW_LENGTH) return value;
  return `${value.slice(0, MAX_PREVIEW_LENGTH - 1).trimEnd()}…`;
}

/** Extracts the four user-facing plan fields from agent-authored markdown. */
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
    const content = abbreviate((sections[key] ?? []).join('\n'));
    return content || fallback;
  };

  return {
    summary: read('summary', fallbackSummary ? abbreviate(fallbackSummary) : MISSING),
    outcome: read('outcome'),
    assumptions: read('assumptions'),
    acceptanceCriteria: read('acceptanceCriteria'),
  };
}
