function headingText(line: string): { depth: number; text: string } | null {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trim());
  if (!match) return null;
  return { depth: match[1]!.length, text: match[2]!.trim().toLowerCase() };
}

function markdownSectionRange(markdown: string, title: string): { start: number; end: number } | null {
  const lines = markdown.split(/\r?\n/);
  const target = title.trim().toLowerCase();
  const start = lines.findIndex((line) => headingText(line)?.text === target);
  if (start === -1) return null;

  const startHeading = headingText(lines[start]!);
  if (!startHeading) return null;
  const nextHeading = lines.findIndex((line, index) => {
    if (index <= start) return false;
    const heading = headingText(line);
    return Boolean(heading && heading.depth <= startHeading.depth);
  });
  return { start, end: nextHeading === -1 ? lines.length : nextHeading };
}

export function extractMarkdownSection(markdown: string, title: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const range = markdownSectionRange(markdown, title);
  if (!range) return null;
  return lines.slice(range.start + 1, range.end).join('\n').trim() || null;
}

export function removeMarkdownSection(markdown: string, title: string): string {
  const lines = markdown.split(/\r?\n/);
  const range = markdownSectionRange(markdown, title);
  if (!range) return markdown;

  const nextLines = [...lines.slice(0, range.start), ...lines.slice(range.end)];
  return nextLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
