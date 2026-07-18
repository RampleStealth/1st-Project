# Provider-backed keyword search

Gmail is the search authority. The browser calls the owner-scoped application API; it never calls Gmail directly. The API accepts only normalized plain keywords and quoted phrases, then passes parsed literal terms to the Gmail adapter. Raw Gmail operator syntax is not accepted.

Search uses ten-result pages. Gmail page tokens are encrypted into versioned application cursors with the purpose-specific HKDF context `aio/mailbox-search-cursor/v1`. A cursor is bound to the authenticated user, mailbox, canonical query digest, page size, and expiry. Gmail tokens and plaintext queries are never logged, audited, or used as telemetry labels.

Search owns list, selection, pagination, loading, and error state by mailbox ID, search mode, normalized query, and request generation. Query or mailbox changes abort the previous request and invalidate its page history. Results are Gmail threads hydrated through the existing bounded metadata pipeline and upserted into local projections before being returned. Local projections are not treated as a complete search index.

This slice intentionally excludes advanced operators, filters, local full-text search, result caching, search history, suggestions, embeddings, and semantic search.
