import { useEffect, useState } from 'react';
import { formatDateTime, timeAgo } from '@/lib/format';

interface RelativeTimeProps {
  iso: string;
  className?: string;
}

/** Relative timestamp that re-renders every minute and exposes the full date on hover. */
export function RelativeTime({ iso, className = '' }: RelativeTimeProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <time dateTime={iso} title={formatDateTime(iso)} className={className}>
      {timeAgo(iso, now)}
    </time>
  );
}
