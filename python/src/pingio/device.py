"""Device identity helpers.

Mirrors the device fingerprint algorithm in
``packages/mcp-server/src/services/device.ts`` so a Python client is
recognized as the same device class by the auth server's device
verification.
"""

from __future__ import annotations

import hashlib
import os
import platform
import socket

_CACHE: str | None = None


def get_device_fingerprint() -> str:
    """Return a stable, anonymous fingerprint for this machine.

    Components match the TypeScript client (hostname, platform, arch,
    CPU model, total RAM, client tag) hashed with SHA-256 and truncated
    to 32 url-safe base64 characters.
    """
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    components = [
        socket.gethostname(),
        platform.system().lower() or "unknown",
        platform.machine() or "unknown",
        platform.processor() or "unknown",
        str(_total_ram()),
        "pingio-client",
    ]
    digest = hashlib.sha256("|".join(components).encode("utf-8")).digest()
    import base64

    _CACHE = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")[:32]
    return _CACHE


def get_device_name() -> str:
    """User-friendly device name, e.g. ``DESKTOP-ABC (Windows-10)``."""
    return f"{socket.gethostname()} ({platform.system()}-{platform.release()})".strip()


def clear_cache() -> None:
    """Forget the cached fingerprint (testing aid)."""
    global _CACHE
    _CACHE = None


def _total_ram() -> int:
    """Best-effort total physical memory in bytes (0 when unknown)."""
    try:
        if hasattr(os, "sysconf") and "SC_PHYS_PAGES" in os.sysconf_names:
            pages = os.sysconf("SC_PHYS_PAGES")
            page_size = os.sysconf("SC_PAGE_SIZE")
            return int(pages) * int(page_size)
        import ctypes

        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        stat = MEMORYSTATUSEX()
        stat.dwLength = ctypes.sizeof(stat)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
            return int(stat.ullTotalPhys)
    except Exception:
        pass
    return 0
