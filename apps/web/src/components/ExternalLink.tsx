import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { safeHttpsUrl } from '@/lib/format';

interface ExternalLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'target' | 'rel'> {
  href: string | null | undefined;
  children: ReactNode;
  /** Rendered instead of the link when the URL is missing or not https. */
  fallback?: ReactNode;
}

/** Anchor for URLs that come from data (PRs, tickets). Only https is rendered as a link. */
export function ExternalLink({ href, children, fallback = null, ...rest }: ExternalLinkProps) {
  const safe = safeHttpsUrl(href);
  if (!safe) return <>{fallback}</>;
  return (
    <a href={safe} target="_blank" rel="noreferrer noopener" {...rest}>
      {children}
    </a>
  );
}
