export type ReaderState = "idle" | "loading" | "ready" | "deleted" | "disconnected" | "error" | "rendering-failure";
export function readerFailureState(code?: string): ReaderState { return code === "thread_deleted" ? "deleted" : code === "provider_reauthentication_required" ? "disconnected" : code === "safe_rendering_failed" ? "rendering-failure" : "error"; }
