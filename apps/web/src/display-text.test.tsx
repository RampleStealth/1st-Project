import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { decodeDisplayEntities } from "./display-text.js";

describe("safe display entity decoding", () => {
  it("decodes recognized entities once for readable mailbox metadata", () => {
    expect(decodeDisplayEntities("We&#39;re &amp; ready")).toBe("We're & ready");
    expect(decodeDisplayEntities("&#60;Inbox&#x3E; &#169;")).toBe("<Inbox> ©");
    expect(decodeDisplayEntities("&amp;#39;")).toBe("&#39;");
  });

  it("leaves malformed references literal and React keeps decoded angle brackets as text", () => {
    expect(decodeDisplayEntities("keep &bogus; and &#x110000; literal")).toBe("keep &bogus; and &#x110000; literal");
    const { container } = render(<span>{decodeDisplayEntities("&lt;img src=x onerror=alert(1)&gt;")}</span>);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});
