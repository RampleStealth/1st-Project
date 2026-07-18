export function focusThreadRow(threadId: string) {
  const row = document.getElementById(`thread-row-${threadId}`);
  row?.focus();
  return Boolean(row);
}

export function focusFirstThreadRow() {
  const row = document.querySelector<HTMLButtonElement>("[data-thread-row]");
  row?.focus();
  return Boolean(row);
}
