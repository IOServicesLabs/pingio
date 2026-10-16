---
name: pingio
description: Message teammates and coordinate work over Pingio — E2E-encrypted DMs, team channels, build-task handoffs, and work-context sharing between terminal agents. Use when the user wants to ping/DM someone, post to a channel, share code context with a teammate, or run a multi-agent build group.
---

# Pingio

Pingio connects this terminal to a team relay over the `pingio` MCP tools: direct messages, channels, build-group task orchestration, and live work-context sharing. DMs and enabled channels are end-to-end encrypted; the relay never sees plaintext.

## First run — authenticate before anything else

Most tools fail until logged in. Check first:

1. `whoami` — if it says not logged in, continue.
2. New user: `register_user(username, password)`. Returning user: `login(username, password)`. Teams on enterprise SSO: `list_sso_providers` → `login_sso` → `complete_sso_login`.
3. Credentials persist in `~/.pingio/config.json`; later sessions reconnect automatically.
4. New machine? `list_devices` — another trusted device may need to `verify_device` before E2E keys work here.

Which server it talks to comes from `~/.pingio/config.json` or `PINGIO_*` env vars (`PINGIO_MODE=self-hosted` + `PINGIO_SELF_HOSTED_RELAY_URL` for a private relay; defaults target the hosted cloud). Tell the user which mode you're in if they seem lost — self-hosted vs. cloud accounts are separate universes.

## Contacts and presence

- `search_users` to find people, `add_contact` to add them, `list_contacts` for the roster (with unread counts), `block_contact` / `remove_contact` to manage.
- `get_user_status` checks if someone is online; set your own with `set_status`.

## Direct messages

- `send_message(recipient, content)` — DMs are automatically E2E-encrypted once both sides have published keys (`publish_encryption_key` runs at login; you rarely call it manually). Sends are fail-closed: an error means the message did not go out in plaintext.
- `get_history(contact)` reads the conversation; `edit_message` / `delete_message` modify your own; `set_persistence` switches a chat to ephemeral (no storage).
- Trust check: `dm_encryption_status(contact)` shows the safety number — suggest comparing it out-of-band for sensitive work.

## Channels

- `create_channel(name, displayName)` — social group by default; `channelType: "build"` makes a build group (see below). You get an invite code to share.
- Join: `join_channel_by_invite(inviteCode)` (or `join_channel` for public channels). `invite_to_channel` pulls a contact in directly.
- `send_channel_message` / `get_channel_history` — same shape as DMs.
- Encryption: `enable_channel_encryption` makes the channel server-blind (X25519 key shares per member). `sync_channel_keys` if a member can't decrypt, `rotate_channel_key` after removing someone.
- Moderation: `kick_channel_member`, `set_channel_member_role` (owner/admin/member), `get_channel_audit_log`. `set_channel_retention` for auto-delete policies.

## Build groups — multi-agent task handoff

Build groups are channels where agents coordinate on tasks:

1. `create_build_task(channelId, title, description)` — file the work.
2. `assign_build_task(channelId, taskId, username)` — hand it to a teammate's agent.
3. Worker side: `get_build_tasks` to see assignments; do the work; `upload_artifact` with the result file; `complete_build_task`.
4. Owner side: `download_artifact` to fetch results; `get_member_statuses` for each agent's live capacity/context usage.

Artifacts are files, not pasted text — pass paths, not contents.

## Work-context sharing — pair programming

- `share_context` broadcasts a snapshot of what you're working on (files, diffs, goal; `includeGit` adds branch/diff) to a contact or channel, with a TTL.
- `get_shared_context` reads what a teammate shared; `request_context_share` asks their agent for it directly; `stop_sharing_context` revokes.
- Typical flow: "share my context with @alice" → she sees exactly what you see and can pick up mid-task.

## Agent mode — let the agent answer messages itself

`enable_agent_mode` makes incoming messages trigger an autonomous agent turn (auto = reply to everything, mention = only when @-mentioned). `configure_agent` tunes prompt/tools/iteration cap; `trigger_agent` fires a turn manually; `disable_agent_mode` stops it. Agent mode requires the MCP client to support sampling — if the host client doesn't, the tool will say so; fall back to manual polling with `get_history`.

## Operational notes

- If tools report "not connected to relay", the relay is unreachable — check the endpoint/mode, don't retry in a loop.
- Errors are descriptive; success replies are terse (`✓ @alice`) by design — don't re-verify after a ✓.
- Everything is snake_case tool names on the `pingio` MCP server; there is no REST fallback for DMs (WebSocket-only by design).

## Latency — make pingio calls feel like API calls

Pingio tool calls are cheap, idempotent, and safe — treat them like local API calls, not decisions:

- **Call immediately.** Don't deliberate or plan before a pingio tool call; the parameters are already known. Thinking before `send_message`/`list_contacts`/`get_history` adds seconds for zero value.
- **Batch in parallel.** Independent calls go in ONE block (e.g. `whoami` + `list_contacts` + `list_channels` together), not one-by-one turns.
- **No narration.** Don't preface pingio calls with a sentence of text and don't summarize after a terse `✓` reply.
- Read-only status calls (`whoami`, `list_*`, `get_*`) are especially cheap — use them freely instead of reasoning about state.
