export function localDraftEditPath(mailboxId: string, draftId: string) {
  return `/mail/${encodeURIComponent(mailboxId)}/drafts/local/${encodeURIComponent(draftId)}`;
}
