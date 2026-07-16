# Version 1 scope and user workflows

Version 1 supports one primary Gmail account per user. The account list is implementation capability, not a supported account-switching workflow.

Users can connect Gmail, browse Inbox, All Mail, Sent, and Drafts, read safely rendered conversations, archive a thread, mark it unread, and create, explicitly save, and send application-created drafts. Gmail confirms every mutation before the interface presents it as complete.

Only drafts created by this application are editable. Gmail-native drafts are read-only. Version 1 does not support attachments, reply, forward, scheduled send, undo-send, custom labels, search, automation, AI, or Gmail-native draft editing.

## Keyboard and accessibility

Use the visible controls first. `Escape` closes an open reader; `C` opens a new draft only in the Drafts view. Shortcuts do nothing while focus is in an input, textarea, select, or content-editable editor. Use the skip link to reach the workspace. The reader iframe has a descriptive title, strict sandbox, and no remote media access.

## Manual review procedure

Review desktop, tablet, and 320px-wide mobile layouts; 200% browser zoom; keyboard-only navigation; reduced motion; and a screen-reader smoke test. Include loading, empty, disconnected, permission, reconnect, retry, conflict, recovery, and sent states. Confirm focus remains visible and follows the reader after selection or returns to the list after `Escape`. No screenshots or video evidence were generated in this environment.
