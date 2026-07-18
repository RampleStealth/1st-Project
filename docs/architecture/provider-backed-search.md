# Provider-backed mailbox search

Gmail is the search authority. The browser calls the owner-scoped application API; it never calls Gmail directly. The API accepts normalized plain keywords, quoted phrases, and a fixed structured filter contract: scope, from, to, subject, after, before, unread, and has attachment. Raw Gmail operator syntax is not accepted.

The Gmail adapter is the only query-compilation boundary. Inbox, Sent, Drafts, and Unread use fixed Gmail system `labelIds`; literal terms and the other approved filters compile into a deterministic Gmail `q` value. Spam and Trash remain excluded. Gmail interprets calendar-date filters from midnight Pacific time, and Gmail API results may differ from the Gmail UI for aliases and thread-wide matching.

Search uses ten-result pages. Gmail page tokens are encrypted into versioned application cursors with the purpose-specific HKDF context `aio/mailbox-search-cursor/v1`. Cursor payload version 2 is bound to the authenticated user, mailbox, canonical structured-criteria digest, page size, and expiry. Gmail tokens, plaintext criteria, and compiled queries are never logged, audited, persisted as search history, or used as telemetry labels.

Search owns list, selection, pagination, loading, and error state by mailbox ID, search mode, canonical structured criteria, and request generation. Criteria or mailbox changes abort the previous request and invalidate selection and page history. Browser URLs retain only submitted criteria; filters do not run until explicit submission. Results are Gmail threads hydrated through the existing bounded metadata pipeline and upserted into local projections before being returned. Local projections are not treated as a complete search index.

This slice intentionally excludes raw or advanced Gmail operators, local full-text search, result caching, search history, saved searches, suggestions, fuzzy matching, embeddings, and semantic search.
