import { type Logger, type LoggerOptions, pino } from "pino";

/**
 * Structured logging for every application code path.
 *
 * WHY A FACTORY rather than a shared singleton instance. Log context on this
 * platform is hierarchical — a worker binds a job id, which binds a site id,
 * which binds a pattern id — and `child()` on a per-request/per-job logger is
 * what keeps that context attached without threading it through every call
 * signature. A single module-level logger would force callers to interpolate
 * ids into message strings, which is exactly what makes logs unqueryable when
 * 650 sites are running at once. See docs/CODING_STANDARDS.md 1.6.
 */
export interface LoggerContext {
  /** Which process this is: "api", "worker", or a script name. */
  readonly service: string;
  readonly level?: LoggerOptions["level"];
  /** Pretty-print for a human at a terminal. Never enable in production. */
  readonly pretty?: boolean;
}

/** Create the root logger for a process. Call once at startup; `child()` from it thereafter. */
export function createLogger(context: LoggerContext): Logger {
  const options: LoggerOptions = {
    level: context.level ?? "info",
    base: { service: context.service },
    // ISO timestamps rather than epoch millis: these logs are read by people
    // reconstructing what produced a published estimate, often days later.
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "*.AWS_SECRET_ACCESS_KEY",
        "*.AUTH_SECRET",
        "*.password"
      ],
      censor: "[redacted]"
    }
  };

  if (context.pretty === true) {
    return pino({
      ...options,
      transport: { target: "pino-pretty", options: { colorize: true } }
    });
  }

  return pino(options);
}

export type { Logger } from "pino";
