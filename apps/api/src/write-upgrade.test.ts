import test from "node:test";
import assert from "node:assert/strict";
import { writeUpgradeAuthorizationUrl } from "@aio/gmail";
test("write upgrade authorization uses modify scope, PKCE and a dedicated callback", () => {
  const config = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", API_ORIGIN: "https://app.example.test" } as never;
  const url = new URL(writeUpgradeAuthorizationUrl(config, "state", "challenge"));
  assert.equal(url.searchParams.get("scope"), "https://www.googleapis.com/auth/gmail.modify"); assert.equal(url.searchParams.get("code_challenge_method"), "S256"); assert.match(url.searchParams.get("redirect_uri") ?? "", /\/v1\/auth\/google\/write\/callback$/);
});
