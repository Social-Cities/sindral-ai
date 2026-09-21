const PATTERNS: RegExp[] = [
  /sk_sindral_[0-9a-f]{40}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /x-access-token:[^@\s'"]+/gi,
  /AUTHORIZATION:\s*(?:basic|bearer)\s+[A-Za-z0-9+/=._-]+/gi,
];

/**
 * Scrubs secrets from text before it reaches logs, job events or error
 * messages. Known secret values are registered explicitly; well-known token
 * shapes are caught by pattern as a second line of defence.
 */
export class Redactor {
  private readonly secrets = new Set<string>();

  add(...values: (string | null | undefined)[]): this {
    for (const value of values) {
      if (value && value.length >= 6) this.secrets.add(value);
    }
    return this;
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) out = out.split(secret).join('[redacted]');
    for (const pattern of PATTERNS) out = out.replace(pattern, '[redacted]');
    return out;
  }

  redactError(err: unknown): string {
    return this.redact(errorMessage(err));
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
