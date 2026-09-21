interface SpinnerProps {
  label?: string;
  className?: string;
  /** `pulse` renders the prototype's pulsing amber dot; `ring` a rotating ring. */
  kind?: 'pulse' | 'ring';
}

export function Spinner({ label, className = '', kind = 'pulse' }: SpinnerProps) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs text-muted-foreground ${className}`} role="status" aria-live="polite">
      {kind === 'pulse' ? (
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" aria-hidden="true" />
      ) : (
        <span className="w-3 h-3 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" aria-hidden="true" />
      )}
      {label ?? <span className="sr-only">Loading</span>}
    </span>
  );
}

export function PageLoader({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center h-full">
      <Spinner kind="ring" label={label} />
    </div>
  );
}
