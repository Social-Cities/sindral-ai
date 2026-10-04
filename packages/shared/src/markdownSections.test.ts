import { describe, expect, it } from 'vitest';
import { extractMarkdownSection, removeMarkdownSection } from './markdownSections.js';

describe('markdown section helpers', () => {
  const report = '# Review\n\n## Diff explanation\nChanged `TaskDetail` to expose review output.\n\n### Assumptions\nThe report uses standard headings.\n\n## Findings ordered by severity\nNone.';

  it('extracts a heading section including nested subsections', () => {
    expect(extractMarkdownSection(report, 'Diff explanation')).toBe('Changed `TaskDetail` to expose review output.\n\n### Assumptions\nThe report uses standard headings.');
  });

  it('removes a heading section and preserves the rest of the document', () => {
    expect(removeMarkdownSection(report, 'Diff explanation')).toBe('# Review\n\n## Findings ordered by severity\nNone.');
  });
});
