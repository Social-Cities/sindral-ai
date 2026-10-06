import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DiffViewer, inferLanguage, parsePatch, tokenizeLine } from './DiffViewer';

describe('DiffViewer', () => {
  it('parses unified diff line numbers', () => {
    expect(parsePatch('@@ -4,2 +4,3 @@\n unchanged\n-old\n+const next = true')).toEqual([
      { kind: 'hunk', text: '@@ -4,2 +4,3 @@', oldNo: null, newNo: null },
      { kind: 'context', text: 'unchanged', oldNo: 4, newNo: 4 },
      { kind: 'del', text: 'old', oldNo: 5, newNo: null },
      { kind: 'add', text: 'const next = true', oldNo: null, newNo: 5 },
    ]);
  });

  it('highlights common code tokens', () => {
    expect(inferLanguage('src/App.tsx')).toEqual({ id: 'tsx', label: 'TSX' });
    expect(tokenizeLine('const value: string = "ok"; // saved', 'tsx')).toEqual([
      { kind: 'keyword', text: 'const' },
      { kind: 'plain', text: ' ' },
      { kind: 'plain', text: 'value' },
      { kind: 'punctuation', text: ':' },
      { kind: 'plain', text: ' ' },
      { kind: 'type', text: 'string' },
      { kind: 'plain', text: ' ' },
      { kind: 'punctuation', text: '=' },
      { kind: 'plain', text: ' ' },
      { kind: 'string', text: '"ok"' },
      { kind: 'punctuation', text: ';' },
      { kind: 'plain', text: ' ' },
      { kind: 'comment', text: '// saved' },
    ]);
  });

  it('renders readable diff controls and highlighted source', async () => {
    const user = userEvent.setup();
    render(
      <DiffViewer
        file={{
          filename: 'src/App.tsx',
          status: 'modified',
          additions: 1,
          deletions: 1,
          patch: '@@ -1 +1 @@\n-const oldValue = false;\n+const nextValue = true;',
        }}
      />,
    );

    expect(screen.getByText('TSX')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Old' })).toBeInTheDocument();
    expect(screen.getAllByText('const')[0]).toHaveClass('text-[#c4b5fd]');

    await user.click(screen.getByRole('button', { name: 'Wrap off' }));
    expect(screen.getByRole('button', { name: 'Wrap on' })).toBeInTheDocument();
  });
});
