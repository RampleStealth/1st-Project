export function hasUnprocessedPendingHistory(pendingHistoryId: string | null, appliedHistoryId: string): boolean {
  return pendingHistoryId !== null && BigInt(pendingHistoryId) > BigInt(appliedHistoryId);
}

export function shouldRetryForUnavailableHistory(processedHistoryId: string, appliedHistoryId: string, pendingHistoryId: string | null): boolean {
  return processedHistoryId === appliedHistoryId && hasUnprocessedPendingHistory(pendingHistoryId, appliedHistoryId);
}
