import { describe, expect, it } from "vitest";
import { readerFailureState } from "./reader-state.js";
describe("reader response states", () => { it("maps deleted, disconnected, rendering failure and retryable failures", () => { expect(readerFailureState("thread_deleted")).toBe("deleted"); expect(readerFailureState("provider_reauthentication_required")).toBe("disconnected"); expect(readerFailureState("safe_rendering_failed")).toBe("rendering-failure"); expect(readerFailureState("provider_temporarily_unavailable")).toBe("error"); }); });
