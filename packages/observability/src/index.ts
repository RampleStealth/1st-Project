import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["accessToken", "refreshToken", "authorization", "headers.authorization", "emailBody", "subject", "recipients"],
    censor: "[REDACTED]"
  }
});
