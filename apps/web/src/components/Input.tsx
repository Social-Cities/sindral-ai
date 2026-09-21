import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { useId } from 'react';

const FIELD_CLASSES =
  'w-full bg-input border border-border rounded-md text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-accent/50 disabled:opacity-50';

interface FieldWrapperProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  id: string;
  children: ReactNode;
  className?: string;
}

function FieldWrapper({ label, hint, error, id, children, className = '' }: FieldWrapperProps) {
  return (
    <div className={className}>
      {label && (
        <label htmlFor={id} className="label-caps block">
          {label}
        </label>
      )}
      <div className={label ? 'mt-1.5' : ''}>{children}</div>
      {error ? (
        <p className="text-[10px] text-[#f87171] mt-1" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">{hint}</p>
      ) : null}
    </div>
  );
}

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  mono?: boolean;
  /** Compact padding/text for dense editors. */
  dense?: boolean;
  wrapperClassName?: string;
}

export function Input({ label, hint, error, mono, dense, id, className = '', wrapperClassName, ...rest }: InputProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldWrapper label={label} hint={hint} error={error} id={fieldId} className={wrapperClassName}>
      <input
        id={fieldId}
        aria-invalid={error ? true : undefined}
        className={`${FIELD_CLASSES} ${dense ? 'px-2 py-1 text-[11px]' : 'px-3 py-2 text-sm'} ${mono ? 'font-mono' : ''} ${className}`}
        {...rest}
      />
    </FieldWrapper>
  );
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  mono?: boolean;
  wrapperClassName?: string;
}

export function Textarea({ label, hint, error, mono, id, className = '', wrapperClassName, ...rest }: TextareaProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldWrapper label={label} hint={hint} error={error} id={fieldId} className={wrapperClassName}>
      <textarea
        id={fieldId}
        aria-invalid={error ? true : undefined}
        className={`${FIELD_CLASSES} px-3 py-2 text-sm leading-relaxed resize-none ${mono ? 'font-mono text-xs' : ''} ${className}`}
        {...rest}
      />
    </FieldWrapper>
  );
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  dense?: boolean;
  wrapperClassName?: string;
}

export function Select({ label, hint, error, dense, id, className = '', wrapperClassName, children, ...rest }: SelectProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldWrapper label={label} hint={hint} error={error} id={fieldId} className={wrapperClassName}>
      <select id={fieldId} className={`${FIELD_CLASSES} ${dense ? 'px-2 py-1 text-[11px]' : 'px-2 py-1.5 text-xs'} appearance-none cursor-pointer ${className}`} {...rest}>
        {children}
      </select>
    </FieldWrapper>
  );
}
