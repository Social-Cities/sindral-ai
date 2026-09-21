import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

interface MarkdownProps {
  children: string;
  className?: string;
}

/** Only allow http(s) links; everything else renders as plain text. */
function isSafeHref(href: string | undefined): href is string {
  if (!href) return false;
  try {
    const url = new URL(href, 'https://sindral.invalid');
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

const components: Components = {
  a: ({ href, children }) => {
    if (!isSafeHref(href)) return <span>{children}</span>;
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  // Never render remote images from untrusted content.
  img: ({ alt }) => <span className="text-muted-foreground">[image{alt ? `: ${alt}` : ''}]</span>,
};

/**
 * Renders markdown from agents/users. react-markdown does not render raw HTML
 * by default, which is the behaviour we rely on for safety — never add rehype-raw.
 */
export function Markdown({ children, className = '' }: MarkdownProps) {
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {children}
      </ReactMarkdown>
    </div>
  );
}
