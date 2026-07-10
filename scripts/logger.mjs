/**
 * Structured JSON logger for repo tooling scripts.
 *
 * Usage:
 *   import { createLogger } from "./logger.mjs";
 *   const logger = createLogger({ script: "validate-docs" });
 *   logger.info("validation_started", { pageCount: 42 });
 *
 * Configuration:
 *   LOG_LEVEL — minimum level to emit: "debug" | "info" | "warn" | "error".
 *               Optional. Defaults to "info", which is safe for local use.
 */

const LOG_LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

const DEFAULT_LOG_LEVEL = "info";

/** Field names whose values must never appear in log output. */
const SENSITIVE_FIELD_NAMES = Object.freeze([
  "password",
  "token",
  "secret",
  "authorization",
  "api_key",
  "apikey",
  "card_number",
  "cvv",
  "ssn",
]);

const REDACTED_PLACEHOLDER = "[REDACTED]";

/**
 * Reads and validates LOG_LEVEL from the environment.
 * Fails fast with a clear error if the value is present but invalid.
 */
export function resolveLogLevel(environment = process.env) {
  const configuredLevel = environment.LOG_LEVEL;
  if (configuredLevel === undefined || configuredLevel === "") {
    return DEFAULT_LOG_LEVEL;
  }
  const normalizedLevel = String(configuredLevel).toLowerCase();
  if (!(normalizedLevel in LOG_LEVELS)) {
    const validLevels = Object.keys(LOG_LEVELS).join(", ");
    throw new Error(
      `Invalid LOG_LEVEL "${configuredLevel}". Valid values: ${validLevels}. Default: "${DEFAULT_LOG_LEVEL}".`
    );
  }
  return normalizedLevel;
}

function isSensitiveFieldName(fieldName) {
  const normalizedName = fieldName.toLowerCase();
  return SENSITIVE_FIELD_NAMES.some((sensitiveName) =>
    normalizedName.includes(sensitiveName)
  );
}

/**
 * Returns a deep copy of the given fields with sensitive values replaced
 * by a redaction placeholder. Handles nested objects and arrays.
 */
export function scrubSensitiveFields(fields) {
  if (Array.isArray(fields)) {
    return fields.map((entry) =>
      entry !== null && typeof entry === "object"
        ? scrubSensitiveFields(entry)
        : entry
    );
  }
  const scrubbed = {};
  for (const [fieldName, fieldValue] of Object.entries(fields)) {
    if (isSensitiveFieldName(fieldName)) {
      scrubbed[fieldName] = REDACTED_PLACEHOLDER;
    } else if (fieldValue !== null && typeof fieldValue === "object") {
      scrubbed[fieldName] = scrubSensitiveFields(fieldValue);
    } else {
      scrubbed[fieldName] = fieldValue;
    }
  }
  return scrubbed;
}

function serializeError(caughtError) {
  if (caughtError instanceof Error) {
    return {
      name: caughtError.name,
      message: caughtError.message,
      stack: caughtError.stack,
    };
  }
  return { name: "NonErrorThrown", message: String(caughtError) };
}

/**
 * Creates a logger that emits one JSON object per line.
 * Levels "debug" and "info" go to stdout; "warn" and "error" go to stderr.
 *
 * @param {object} baseFields - Fields included in every log line (e.g. script name).
 * @param {object} [options]
 * @param {string} [options.level] - Minimum level; defaults to LOG_LEVEL env var or "info".
 * @param {(line: string) => void} [options.writeStdout] - Override for testing.
 * @param {(line: string) => void} [options.writeStderr] - Override for testing.
 */
export function createLogger(baseFields = {}, options = {}) {
  const minimumLevel = options.level ?? resolveLogLevel();
  if (!(minimumLevel in LOG_LEVELS)) {
    const validLevels = Object.keys(LOG_LEVELS).join(", ");
    throw new Error(
      `Invalid logger level "${minimumLevel}". Valid values: ${validLevels}.`
    );
  }

  const writeStdout =
    options.writeStdout ?? ((line) => process.stdout.write(`${line}\n`));
  const writeStderr =
    options.writeStderr ?? ((line) => process.stderr.write(`${line}\n`));

  function emitLogLine(level, eventName, contextFields) {
    if (LOG_LEVELS[level] < LOG_LEVELS[minimumLevel]) {
      return;
    }
    if (typeof eventName !== "string" || eventName.trim() === "") {
      throw new Error(
        `Log event name must be a non-empty string, got: ${JSON.stringify(eventName)}`
      );
    }
    const logEntry = scrubSensitiveFields({
      timestamp: new Date().toISOString(),
      level,
      event: eventName,
      ...baseFields,
      ...contextFields,
    });
    const serializedEntry = JSON.stringify(logEntry);
    if (LOG_LEVELS[level] >= LOG_LEVELS.warn) {
      writeStderr(serializedEntry);
    } else {
      writeStdout(serializedEntry);
    }
  }

  return {
    debug: (eventName, contextFields = {}) =>
      emitLogLine("debug", eventName, contextFields),
    info: (eventName, contextFields = {}) =>
      emitLogLine("info", eventName, contextFields),
    warn: (eventName, contextFields = {}) =>
      emitLogLine("warn", eventName, contextFields),
    /**
     * @param {string} eventName
     * @param {object} [contextFields]
     * @param {unknown} [caughtError] - Optional error to serialize into the entry.
     */
    error: (eventName, contextFields = {}, caughtError = undefined) => {
      const fieldsWithError =
        caughtError === undefined
          ? contextFields
          : { ...contextFields, error: serializeError(caughtError) };
      emitLogLine("error", eventName, fieldsWithError);
    },
  };
}
