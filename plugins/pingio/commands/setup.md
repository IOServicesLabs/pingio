---
description: Set up Pingio — register or log in, verify the relay connection
---

Walk the user through Pingio setup using the `pingio` MCP tools. Keep it short and interactive:

1. Call `whoami`. If it reports a logged-in user, tell the user who they're logged in as and stop here (offer `logout` if they want to switch accounts).
2. Ask the user: do they already have a Pingio account on this server?
   - New account → ask for a username and password, then call `register_user(username, password)`.
   - Existing account → ask for credentials, then call `login(username, password)`.
   - If their team uses enterprise SSO, call `list_sso_providers`, then start `login_sso` and have them finish with `complete_sso_login`.
3. Call `whoami` again to confirm, then `list_contacts` to show their roster (empty is normal for a new account).
4. Suggest next steps in one line: `search_users`/`add_contact` to find teammates, or `create_channel` / `join_channel_by_invite` to get into a channel.

If any call reports the relay is unreachable, stop and help the user check their endpoint configuration (`~/.pingio/config.json` or the `PINGIO_MODE` / `PINGIO_SELF_HOSTED_RELAY_URL` env vars) instead of retrying.
