import pino, { type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string, pretty: boolean = Boolean(process.stdout.isTTY)): Logger {
  const options: pino.LoggerOptions = {
    level,
    redact: {
      paths: [
        'githubToken',
        '*.githubToken',
        'credentials.githubToken',
        'authorization',
        '*.authorization',
        'headers.authorization',
        'req.headers.authorization',
      ],
      censor: '[redacted]',
    },
  };
  if (pretty && hasPinoPretty()) {
    return pino({
      ...options,
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } },
    });
  }
  return pino(options);
}

/** pino-pretty is a dev dependency; fall back to JSON logs when it is not installed. */
function hasPinoPretty(): boolean {
  try {
    import.meta.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
