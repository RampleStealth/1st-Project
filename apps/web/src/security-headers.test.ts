import { describe, expect, it } from "vitest";
import { browserSecurityHeaders } from "./security-headers.js";

describe("browser security headers", () => { it("deny unsafe execution and add HSTS only in production", () => {
  const production = browserSecurityHeaders({ NODE_ENV: "production" } as never);
  expect(production["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  expect(production["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
  expect(production["content-security-policy"]).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  expect(browserSecurityHeaders({ NODE_ENV: "development" } as never)["strict-transport-security"]).toBeUndefined();
}); });
