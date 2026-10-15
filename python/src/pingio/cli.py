"""Command line interface for the Pingio Python SDK.

Usage::

    pingio register --username alice --password s3cret
    pingio add-contact --username bob
    pingio send --to bob --message "hello from python"
    pingio receive            # stream incoming frames until Ctrl+C
"""

from __future__ import annotations

import argparse
import getpass
import json
import sys

from . import DEFAULT_AUTH_URL, DEFAULT_RELAY_WS_URL, __version__
from .client import PingioClient
from .errors import PingioError


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pingio",
        description="Pingio secure messaging relay — Python client CLI",
    )
    parser.add_argument("--version", action="version", version=f"pingio {__version__}")
    parser.add_argument(
        "--auth-url",
        default=DEFAULT_AUTH_URL,
        help=f"auth server base URL (default: {DEFAULT_AUTH_URL})",
    )
    parser.add_argument(
        "--relay-url",
        default=DEFAULT_RELAY_WS_URL,
        help=f"relay WebSocket URL (default: {DEFAULT_RELAY_WS_URL})",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_reg = sub.add_parser("register", help="create a new account")
    p_reg.add_argument("--username", required=True)
    p_reg.add_argument("--password", help="omit to be prompted securely")
    p_reg.add_argument("--display-name")

    p_login = sub.add_parser("login", help="log in and store tokens")
    p_login.add_argument("--username", required=True)
    p_login.add_argument("--password", help="omit to be prompted securely")

    sub.add_parser("whoami", help="show the current token's identity")
    sub.add_parser("logout", help="remove stored credentials")

    p_add = sub.add_parser("add-contact", help="add a user to your contacts")
    p_add.add_argument("--username", required=True)

    sub.add_parser("contacts", help="list your contacts")

    p_send = sub.add_parser("send", help="send a direct message")
    p_send.add_argument(
        "--to",
        dest="recipient",
        required=True,
        help="recipient username (or user id for non-contacts)",
    )
    p_send.add_argument("--message", required=True)
    p_send.add_argument(
        "--ephemeral",
        action="store_true",
        help="deliver without persisting on the server",
    )

    p_recv = sub.add_parser("receive", help="stream incoming messages until Ctrl+C")
    p_recv.add_argument(
        "--json",
        action="store_true",
        help="print raw protocol frames instead of a friendly format",
    )

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    client = PingioClient(auth_url=args.auth_url, relay_ws_url=args.relay_url)
    try:
        if args.command == "register":
            password = args.password or getpass.getpass("Password: ")
            result = client.register(args.username, password, display_name=args.display_name)
            print(f"registered {args.username} (user {result.get('userId')})")
            return 0

        if args.command == "login":
            password = args.password or getpass.getpass("Password: ")
            client.login(args.username, password)
            print(f"logged in as {args.username}")
            return 0

        if args.command == "whoami":
            info = client.whoami()
            print(
                json.dumps(
                    {
                        "active": info.get("active"),
                        "userId": info.get("sub"),
                        "username": info.get("username"),
                        "deviceId": info.get("device_id"),
                        "expires": info.get("exp"),
                    },
                    indent=2,
                )
            )
            return 0

        if args.command == "logout":
            client.logout()
            print("logged out")
            return 0

        if args.command == "add-contact":
            contact = client.add_contact(args.username)
            print(f"added @{args.username} (id {contact.get('contactId') or contact.get('contact_id')})")
            return 0

        if args.command == "contacts":
            contacts = client.list_contacts()
            if not contacts:
                print("no contacts yet — use `pingio add-contact --username <name>`")
                return 0
            for contact in contacts:
                presence = (contact.get("presence") or {}).get("status") or "offline"
                print(f"@{contact.get('username')}  {presence}  id={contact.get('contactId')}")
            return 0

        if args.command == "send":
            recipient_id = client.resolve_recipient(args.recipient)
            client.connect()
            message = client.send_dm(recipient_id, args.message, is_ephemeral=args.ephemeral)
            print(f"sent message {message.get('id')} to @{args.recipient}")
            client.disconnect()
            return 0

        if args.command == "receive":
            user = client.connect()
            print(
                f"connected as {user.get('username')} ({user.get('id')}); waiting for messages, Ctrl+C to quit",
                file=sys.stderr,
            )
            for frame in client.iter_messages():
                if args.json:
                    print(json.dumps(frame))
                elif frame.get("type") == "message":
                    msg = (frame.get("payload") or {}).get("message") or {}
                    sender = msg.get("senderUsername") or msg.get("senderId")
                    print(f"[DM] {sender}: {msg.get('content')}")
                else:
                    print(f"[{frame.get('type')}] {json.dumps(frame.get('payload'))}")
                sys.stdout.flush()
            return 0

    except KeyboardInterrupt:
        return 130
    except PingioError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    finally:
        client.disconnect()
    return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
