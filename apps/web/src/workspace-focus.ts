export function focusThreadRow(threadId: string) {
  document.getElementById(`thread-row-${threadId}`)?.focus();
}

export function focusFirstThreadRow() {
  document.querySelector<HTMLButtonElement>("[data-thread-row]")?.focus();
}
