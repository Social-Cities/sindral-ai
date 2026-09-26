export interface TaskContract {
  outcome: string | null;
  acceptanceCriteria: string | null;
}

type ContractField = keyof TaskContract;

function contractField(heading: string): ContractField | null {
  const normalized = heading.trim().replace(/[:#]+$/g, '').toLowerCase();
  if (normalized === 'outcome' || normalized === 'desired outcome') return 'outcome';
  if (normalized === 'acceptance criteria' || normalized === 'acceptance criterion') return 'acceptanceCriteria';
  return null;
}

/** Extracts a task outcome and acceptance criteria from Markdown-style source text. */
export function extractTaskContract(markdown: string): TaskContract {
  const sections: Partial<Record<ContractField, string[]>> = {};
  let active: ContractField | null = null;
  let activeLevel = 0;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const field = contractField(heading[2] ?? '');
      if (field) {
        active = field;
        activeLevel = heading[1]?.length ?? 0;
        sections[field] ??= [];
      } else if (active && (heading[1]?.length ?? 0) <= activeLevel) {
        active = null;
      }
      continue;
    }
    const emphasizedHeading = line.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?[ \t]*$/);
    if (emphasizedHeading) {
      const field = contractField(emphasizedHeading[1] ?? '');
      if (field) {
        active = field;
        activeLevel = 1;
        sections[field] ??= [];
      } else {
        active = null;
      }
      continue;
    }
    if (active) sections[active]!.push(line);
  }

  const read = (field: ContractField): string | null => {
    const value = (sections[field] ?? []).join('\n').trim();
    return value || null;
  };

  return { outcome: read('outcome'), acceptanceCriteria: read('acceptanceCriteria') };
}
