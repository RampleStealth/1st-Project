import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./index.js";

const valid = {
  NODE_ENV: "production", APP_ORIGIN: "https://app.example.test", API_ORIGIN: "https://app.example.test",
  DATABASE_URL: "postgres://user:password@localhost:5432/aio", REDIS_URL: "redis://localhost:6379",
  GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "not-a-placeholder-secret", GOOGLE_REDIRECT_URI: "https://app.example.test/v1/auth/google/callback",
  GOOGLE_PUBSUB_TOPIC: "projects/project/topics/topic", GOOGLE_CLOUD_PROJECT: "project", PUBSUB_PUSH_AUDIENCE: "https://app.example.test/v1/webhooks/gmail", PUBSUB_SERVICE_ACCOUNT_EMAIL: "push@example.test",
  TOKEN_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 3).toString("base64"), SESSION_SECRET: "session-secret-with-production-entropy-123", TRUST_PROXY: "true"
};

test("production configuration rejects insecure origins, missing proxy trust, placeholders, and invalid encryption keys without exposing values", () => {
  for (const [field, value] of Object.entries({ APP_ORIGIN: "http://app.example.test", TRUST_PROXY: "false", SESSION_SECRET: "change-me", TOKEN_ENCRYPTION_KEY_BASE64: "not-a-key", RATE_LIMIT_FAILURE_MODE: "fail_open" })) {
    assert.throws(() => loadConfig({ ...valid, [field]: value }), /Production|placeholder|Encryption/);
  }
});

test("configuration enforces callback, Pub/Sub, body-size, and rotation invariants", () => {
  assert.throws(() => loadConfig({ ...valid, GOOGLE_REDIRECT_URI: "https://app.example.test/other" }), /Google redirect URI/);
  assert.throws(() => loadConfig({ ...valid, APP_ORIGIN: "https://app.example.test/app" }), /origin-only/);
  assert.throws(() => loadConfig({ ...valid, PUBSUB_PUSH_AUDIENCE: "https://app.example.test/other" }), /Pub\/Sub audience/);
  assert.throws(() => loadConfig({ ...valid, GOOGLE_PUBSUB_TOPIC: "projects/other/topics/topic" }), /GOOGLE_CLOUD_PROJECT/);
  assert.throws(() => loadConfig({ ...valid, WEBHOOK_BODY_LIMIT_BYTES: "700000" }), /Webhook body limit/);
  const previous = "previous-session-secret-with-entropy-456";
  const loaded = loadConfig({ ...valid, SESSION_SECRET_PREVIOUS: previous });
  assert.equal(loaded.SESSION_SECRET_PREVIOUS, previous);
});
