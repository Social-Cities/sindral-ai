import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'success' | 'warning' | 'danger' | 'ghost' | 'subtle';
export type ButtonSize = 'xs' | 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children: ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground font-semibold hover:bg-primary/90',
  success: 'bg-[var(--color-success-strong)] text-white font-semibold hover:bg-[var(--color-success-strong)]/90',
  warning: 'bg-[#f97316] text-white font-semibold hover:bg-[#f97316]/90',
  danger: 'bg-[color-mix(in_srgb,var(--color-danger-strong)_13%,transparent)] border border-[color-mix(in_srgb,var(--color-danger-strong)_19%,transparent)] text-[var(--color-danger)] font-semibold hover:bg-[color-mix(in_srgb,var(--color-danger-strong)_19%,transparent)]',
  ghost: 'bg-secondary border border-border text-accent font-mono hover:border-border-strong',
  subtle: 'bg-secondary border border-border text-secondary-foreground hover:text-foreground',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  xs: 'px-2 py-1 text-[10px]',
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
};

export function Button({ variant = 'primary', size = 'sm', loading = false, className = '', disabled, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md transition-all disabled:opacity-30 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
      {...rest}
    >
      {loading && <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}
