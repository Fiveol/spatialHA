"""Custom components package - handle case-insensitive alias for spatialHA."""

from __future__ import annotations

import importlib
import sys


def __getattr__(name: str):
    """PEP 562: lazily alias spatialha (lower) -> spatialHA (capital)."""
    if name == "spatialha":
        try:
            mod = importlib.import_module("custom_components.spatialHA")
        except ModuleNotFoundError:
            raise AttributeError(f"module {__name__!r} has no attribute {name!r}") from None
        sys.modules["custom_components.spatialha"] = mod
        for sub in list(sys.modules.keys()):
            if sub.startswith("custom_components.spatialHA"):
                alias = sub.replace("custom_components.spatialHA", "custom_components.spatialha", 1)
                if alias not in sys.modules:
                    sys.modules[alias] = sys.modules[sub]
        return mod
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


# Eager alias for already-loaded modules (lower -> capital)
try:
    import custom_components.spatialHA as _spatialHA  # noqa: F401

    sys.modules.setdefault("custom_components.spatialha", _spatialHA)
    for _sub in (
        "ble",
        "config_flow",
        "const",
        "device_tracker",
        "floorplan",
        "gps",
        "positioning",
        "storage",
        "targets",
        "websocket",
        "ws_ble",
        "ws_floorplan",
        "ws_gps",
        "ws_settings",
        "ws_targets",
    ):
        try:
            _mod = importlib.import_module(f"custom_components.spatialHA.{_sub}")
            sys.modules.setdefault(f"custom_components.spatialha.{_sub}", _mod)
        except Exception:  # noqa: BLE001
            pass
except Exception:  # noqa: BLE001
    pass
