"""Unit tests for the pingio SDK — no network required."""

from __future__ import annotations

import io
import json
import unittest
import urllib.error
from unittest import mock

from pingio import (
    AuthError,
    NotConnectedError,
    PingioClient,
    ProtocolError,
    get_device_fingerprint,
)
from pingio.auth import AuthClient, join_ws_url
from pingio.cli import main as cli_main
from pingio.ws import RelayConnection, make_envelope


def _http_response(payload: dict, status: int = 200):
    body = json.dumps(payload).encode("utf-8")
    resp = mock.Mock()
    resp.read.return_value = body
    resp.__enter__ = lambda s: resp
    resp.__exit__ = lambda s, *a: False
    return resp


class TestDeviceFingerprint(unittest.TestCase):
    def test_stable_and_truncated(self):
        from pingio import device

        device.clear_cache()
        a = get_device_fingerprint()
        b = get_device_fingerprint()
        self.assertEqual(a, b)
        self.assertEqual(len(a), 32)


class TestJoinWsUrl(unittest.TestCase):
    def test_variants(self):
        self.assertEqual(join_ws_url("https://example.com"), "wss://example.com")
        self.assertEqual(join_ws_url("http://localhost:3000"), "ws://localhost:3000")
        self.assertEqual(join_ws_url("wss://example.com/ws"), "wss://example.com/ws")
        self.assertEqual(join_ws_url("example.com"), "wss://example.com")
        self.assertEqual(join_ws_url("https://example.com/"), "wss://example.com")
        with self.assertRaises(ValueError):
            join_ws_url("")


class TestAuthClient(unittest.TestCase):
    def setUp(self):
        self.client = AuthClient("https://auth.example.com/")

    @mock.patch("urllib.request.urlopen")
    def test_register_success(self, urlopen):
        urlopen.return_value = _http_response(
            {"success": True, "userId": "u1", "token": "t", "refreshToken": "r", "deviceId": "d"}
        )
        result = self.client.register("alice", "pw", device_fingerprint="fp")
        self.assertTrue(result["success"])
        request = urlopen.call_args[0][0]
        self.assertEqual(request.full_url, "https://auth.example.com/oauth/register")
        sent = json.loads(request.data.decode("utf-8"))
        self.assertEqual(sent["deviceFingerprint"], "fp")

    @mock.patch("urllib.request.urlopen")
    def test_login_error_message(self, urlopen):
        err = urllib.error.HTTPError(
            "https://auth.example.com/oauth/login", 401, "Unauthorized", {}, io.BytesIO(b'{"error":"bad creds"}')
        )
        urlopen.side_effect = err
        with self.assertRaises(AuthError) as ctx:
            self.client.login("alice", "wrong")
        self.assertEqual(str(ctx.exception), "bad creds")
        self.assertEqual(ctx.exception.status, 401)

    @mock.patch("urllib.request.urlopen")
    def test_refresh_requires_fingerprint(self, urlopen):
        urlopen.return_value = _http_response({"success": True, "token": "t2"})
        result = self.client.refresh("rt", "fp")
        self.assertEqual(result["token"], "t2")
        sent = json.loads(urlopen.call_args[0][0].data.decode("utf-8"))
        self.assertEqual(sent, {"refreshToken": "rt", "deviceFingerprint": "fp"})


class FakeWebSocket:
    """In-memory stand-in for websocket-client's WebSocket."""

    def __init__(self, scripted: list[str]):
        self.scripted = list(scripted)
        self.sent: list[str] = []
        self.closed = False
        self._timeout = None

    def send(self, data: str):
        self.sent.append(data)

    def recv(self):
        if not self.scripted:
            raise AssertionError("no more scripted frames")
        item = self.scripted.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def settimeout(self, t):
        self._timeout = t

    def gettimeout(self):
        return self._timeout

    def close(self):
        self.closed = True


class TestRelayConnection(unittest.TestCase):
    def test_envelope_shape(self):
        env = make_envelope("ping", {})
        self.assertEqual(env["type"], "ping")
        self.assertEqual(env["payload"], {})
        # uuid4 + epoch-ms timestamp
        self.assertEqual(len(env["id"]), 36)
        self.assertGreater(env["timestamp"], 1_700_000_000_000)

    @mock.patch("websocket.create_connection")
    def test_auth_success(self, create):
        create.return_value = FakeWebSocket(
            [json.dumps({"id": "1", "type": "auth_response", "timestamp": 1, "payload": {"success": True, "user": {"id": "u1"}}})]
        )
        conn = RelayConnection("wss://relay.example.com/ws")
        conn.open()
        user = conn.authenticate("token", "fp")
        self.assertEqual(user, {"id": "u1"})
        sent = json.loads(create.return_value.sent[0])
        self.assertEqual(sent["type"], "auth")
        self.assertEqual(sent["payload"], {"token": "token", "deviceFingerprint": "fp"})

    @mock.patch("websocket.create_connection")
    def test_auth_rejected(self, create):
        create.return_value = FakeWebSocket(
            [json.dumps({"id": "1", "type": "auth_response", "timestamp": 1, "payload": {"success": False, "error": "nope"}})]
        )
        conn = RelayConnection("wss://relay.example.com/ws")
        conn.open()
        with self.assertRaises(ProtocolError) as ctx:
            conn.authenticate("bad", None)
        self.assertEqual(str(ctx.exception), "nope")
        conn.close()
        self.assertFalse(conn.is_open)

    @mock.patch("websocket.create_connection")
    def test_malformed_frame(self, create):
        create.return_value = FakeWebSocket(["not json"])
        conn = RelayConnection("wss://relay.example.com/ws")
        conn.open()
        with self.assertRaises(ProtocolError):
            conn.recv_frame()


class TestPingioClient(unittest.TestCase):
    def make_client(self, tmp_config):
        return PingioClient(
            auth_url="https://auth.example.com",
            relay_ws_url="wss://relay.example.com/ws",
            config_path=tmp_config,
        )

    @mock.patch("urllib.request.urlopen")
    def test_register_persists_tokens(self, urlopen):
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            urlopen.return_value = _http_response(
                {"success": True, "userId": "u1", "token": "tok", "refreshToken": "rt", "deviceId": "d1"}
            )
            client = self.make_client(f"{td}/config.json")
            client.register("alice", "pw")
            self.assertEqual(client.token, "tok")
            self.assertEqual(client.user_id, "u1")
            # saved to disk
            client2 = self.make_client(f"{td}/config.json")
            self.assertEqual(client2.token, "tok")

    @mock.patch("urllib.request.urlopen")
    def test_register_failure_raises(self, urlopen):
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            err = urllib.error.HTTPError(
                "https://auth.example.com/oauth/register", 409, "Conflict", {}, io.BytesIO(b'{"success": false, "error": "username taken"}')
            )
            urlopen.side_effect = err
            client = self.make_client(f"{td}/config.json")
            with self.assertRaises(AuthError):
                client.register("alice", "pw")

    @mock.patch("urllib.request.urlopen")
    def test_whoami_active(self, urlopen):
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            urlopen.return_value = _http_response({"active": True, "sub": "u1", "username": "alice", "device_id": "d1"})
            client = self.make_client(f"{td}/config.json")
            client._config = {"token": "tok"}
            info = client.whoami()
            self.assertEqual(info["username"], "alice")

    @mock.patch("urllib.request.urlopen")
    def test_whoami_requires_login(self, urlopen):
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            client = self.make_client(f"{td}/config.json")
            with self.assertRaises(AuthError):
                client.whoami()

    @mock.patch("websocket.create_connection")
    def test_send_dm_success(self, create):
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            client = self.make_client(f"{td}/config.json")
            client._config = {"token": "tok"}
            fake = FakeWebSocket(
                [
                    json.dumps(
                        {
                            "id": "1",
                            "type": "auth_response",
                            "timestamp": 1,
                            "payload": {"success": True, "user": {"id": "u1"}},
                        }
                    ),
                    json.dumps(
                        {
                            "id": "2",
                            "type": "message_sent",
                            "timestamp": 2,
                            "payload": {"message": {"id": "m1"}, "clientMessageId": "CMID"},
                        }
                    ),
                ]
            )
            create.return_value = fake
            with mock.patch("uuid.uuid4", return_value="CMID"):
                client.connect()
                message = client.send_dm("u2", "hello")
            self.assertEqual(message["id"], "m1")
            sent = json.loads(fake.sent[-1])
            self.assertEqual(sent["type"], "message")
            self.assertEqual(
                sent["payload"],
                {"recipientId": "u2", "content": "hello", "isEphemeral": False, "clientMessageId": "CMID"},
            )
            client.disconnect()

    @mock.patch("websocket.create_connection")
    def test_send_dm_requires_connection(self, create):
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            client = self.make_client(f"{td}/config.json")
            client._config = {"token": "tok"}
            with self.assertRaises(NotConnectedError):
                client.send_dm("u2", "hello")

    @mock.patch("websocket.create_connection")
    def test_set_presence_validation(self, create):
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            client = self.make_client(f"{td}/config.json")
            client._config = {"token": "tok"}
            create.return_value = FakeWebSocket(
                [json.dumps({"id": "1", "type": "auth_response", "timestamp": 1, "payload": {"success": True, "user": {}}})]
            )
            client.connect()
            with self.assertRaises(ValueError):
                client.set_presence("sleeping")
            client.set_presence("away", "brb")
            sent = json.loads(create.return_value.sent[-1])
            self.assertEqual(sent["type"], "presence_update")
            self.assertEqual(sent["payload"], {"status": "away", "message": "brb"})
            client.disconnect()


class TestCli(unittest.TestCase):
    @mock.patch("pingio.cli.PingioClient")
    def test_whoami_output(self, client_cls):
        client = client_cls.return_value
        client.whoami.return_value = {"active": True, "sub": "u1", "username": "alice", "device_id": "d1", "exp": 123}
        code = cli_main(["--auth-url", "https://auth.example.com", "whoami"])
        self.assertEqual(code, 0)

    def test_help_exits_zero(self):
        with self.assertRaises(SystemExit) as ctx:
            cli_main(["--help"])
        self.assertEqual(ctx.exception.code, 0)


if __name__ == "__main__":
    unittest.main()
