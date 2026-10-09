---
description: Show Pingio connection, identity, and encryption status
---

Give the user a compact Pingio status summary using the `pingio` MCP tools:

1. `whoami` — logged-in identity (or report not logged in and suggest `/pingio:setup`).
2. `list_contacts` — count of contacts and total unread messages, if any.
3. `list_channels` — channels they're in, noting which are build groups.
4. `get_agent_status` — whether agent mode is enabled for any chat, one line.
5. If they have DM conversations, `dm_encryption_status` for their most active contact — report whether E2E encryption is active and show the safety number.

Format the result as a short bulleted summary, not raw JSON. Flag anything that looks wrong (not connected, agent mode unexpectedly on/off, encryption inactive) with a suggested fix.
