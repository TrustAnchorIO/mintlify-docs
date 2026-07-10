/**
 * Tests for scripts/logger.mjs. Run with: node --test scripts/logger.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createLogger,
  resolveLogLevel,
  scrubSensitiveFields,
} from "./logger.mjs";

function createCapturingLogger(level = "debug") {
  const stdoutLines = [];
  const stderrLines = [];
  const logger = createLogger(
    { script: "logger-test" },
    {
      level,
      writeStdout: (line) => stdoutLines.push(JSON.parse(line)),
      writeStderr: (line) => stderrLines.push(JSON.parse(line)),
    }
  );
  return { logger, stdoutLines, stderrLines };
}

test("resolveLogLevel defaults to info when LOG_LEVEL is unset or empty", () => {
  assert.equal(resolveLogLevel({}), "info");
  assert.equal(resolveLogLevel({ LOG_LEVEL: "" }), "info");
});

test("resolveLogLevel accepts valid levels case-insensitively", () => {
  assert.equal(resolveLogLevel({ LOG_LEVEL: "DEBUG" }), "debug");
  assert.equal(resolveLogLevel({ LOG_LEVEL: "warn" }), "warn");
});

test("resolveLogLevel rejects invalid values with an actionable message", () => {
  assert.throws(
    () => resolveLogLevel({ LOG_LEVEL: "verbose" }),
    /Invalid LOG_LEVEL "verbose".*debug, info, warn, error/
  );
});

test("createLogger rejects an invalid explicit level", () => {
  assert.throws(
    () => createLogger({}, { level: "loud" }),
    /Invalid logger level "loud"/
  );
});

test("emits structured JSON with timestamp, level, event, and base fields", () => {
  const { logger, stdoutLines } = createCapturingLogger();
  logger.info("docs_build_started", { pageCount: 42 });

  assert.equal(stdoutLines.length, 1);
  const entry = stdoutLines[0];
  assert.equal(entry.level, "info");
  assert.equal(entry.event, "docs_build_started");
  assert.equal(entry.script, "logger-test");
  assert.equal(entry.pageCount, 42);
  assert.ok(!Number.isNaN(Date.parse(entry.timestamp)));
});

test("routes warn and error to stderr, debug and info to stdout", () => {
  const { logger, stdoutLines, stderrLines } = createCapturingLogger();
  logger.debug("cache_probe");
  logger.info("cache_hit");
  logger.warn("cache_stale");
  logger.error("cache_unreachable");

  assert.deepEqual(
    stdoutLines.map((entry) => entry.level),
    ["debug", "info"]
  );
  assert.deepEqual(
    stderrLines.map((entry) => entry.level),
    ["warn", "error"]
  );
});

test("suppresses entries below the configured minimum level", () => {
  const { logger, stdoutLines, stderrLines } = createCapturingLogger("warn");
  logger.debug("ignored_debug");
  logger.info("ignored_info");
  logger.warn("emitted_warn");

  assert.equal(stdoutLines.length, 0);
  assert.equal(stderrLines.length, 1);
  assert.equal(stderrLines[0].event, "emitted_warn");
});

test("rejects empty or non-string event names", () => {
  const { logger } = createCapturingLogger();
  assert.throws(() => logger.info(""), /non-empty string/);
  assert.throws(() => logger.info("   "), /non-empty string/);
  assert.throws(() => logger.info(undefined), /non-empty string/);
});

test("redacts sensitive field names, including nested and mixed case", () => {
  const { logger, stdoutLines } = createCapturingLogger();
  logger.info("request_received", {
    Authorization: "Bearer abc123",
    requestHeaders: { apiKey: "xyz", accept: "text/html" },
    attempts: [{ password: "hunter2" }, { outcome: "denied" }],
  });

  const entry = stdoutLines[0];
  assert.equal(entry.Authorization, "[REDACTED]");
  assert.equal(entry.requestHeaders.apiKey, "[REDACTED]");
  assert.equal(entry.requestHeaders.accept, "text/html");
  assert.equal(entry.attempts[0].password, "[REDACTED]");
  assert.equal(entry.attempts[1].outcome, "denied");
});

test("scrubSensitiveFields handles empty objects, arrays, and null values", () => {
  assert.deepEqual(scrubSensitiveFields({}), {});
  assert.deepEqual(scrubSensitiveFields([]), []);
  assert.deepEqual(scrubSensitiveFields({ token: null, note: null }), {
    token: "[REDACTED]",
    note: null,
  });
});

test("error() serializes Error instances with name, message, and stack", () => {
  const { logger, stderrLines } = createCapturingLogger();
  logger.error(
    "page_validation_failed",
    { page: "cli/usage.mdx" },
    new RangeError("frontmatter exceeds limit")
  );

  const entry = stderrLines[0];
  assert.equal(entry.error.name, "RangeError");
  assert.equal(entry.error.message, "frontmatter exceeds limit");
  assert.ok(entry.error.stack.includes("RangeError"));
});

test("error() handles thrown non-Error values", () => {
  const { logger, stderrLines } = createCapturingLogger();
  logger.error("unexpected_throw", {}, "plain string failure");

  assert.deepEqual(stderrLines[0].error, {
    name: "NonErrorThrown",
    message: "plain string failure",
  });
});

test("preserves unicode and special characters in field values", () => {
  const { logger, stdoutLines } = createCapturingLogger();
  logger.info("page_indexed", { title: "Café ☕ — مرحبا" });
  assert.equal(stdoutLines[0].title, "Café ☕ — مرحبا");
});
