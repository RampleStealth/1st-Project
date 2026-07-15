# Milestone 3: thread reading

Gmail remains the authority for a selected thread. The API first verifies mailbox ownership, then decrypts credentials and requests only Gmail's structured `full` MIME representation. It never requests `raw`, stores bodies, or logs message content, recipients, MIME, provider responses, or provider identifiers.

The ordered Gmail message array is normalized in memory. `text/plain` is the fallback; the last usable `text/html` candidate in a multipart/alternative tree is sanitized. Nested multipart trees are traversed. Malformed MIME and sanitizer errors yield safe plain-text/failure states, never unfiltered HTML.

The allowlist permits only structural/text tags and limited table/link attributes. Scripts, event attributes, forms, frames, embeds, SVG, styles, images/media, and unsafe URL schemes are discarded. Safe `http`, `https`, and `mailto` links are rewritten with `target=_blank` and `rel=noopener noreferrer`.

The browser renders sanitized HTML only in an empty-sandbox iframe (no same-origin, scripts, forms, popups, downloads, or navigation permissions) with a CSP whose default source and every network-capable directive are `none`, including images and media. Plain text never uses HTML insertion.

An in-process LRU holds only normalized sanitized display payloads for five minutes (100 entries / 2 MiB by default). Keys contain the mailbox ID and a hash of the immutable Gmail thread content identity. Expired, least-recently-used, and over-budget values are evicted. Gmail is still retrieved before a cache lookup, preserving provider authority while avoiding repeat parsing/sanitization.
