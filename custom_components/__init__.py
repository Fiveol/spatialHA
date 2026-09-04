"""Custom components package - handle case-insensitive alias for spatialHA.

Home Assistant normalizes domains to lowercase (spatialha) but the integration
was originally named spatialHA with capitals. To support both casings on
case-sensitive filesystems (Linux) while the repo may only have one folder
(lowercase spatialha), we alias the capital import to the lowercase package.
"""

from __future__ import annotations

import importlib
import sys


def __getattr__(name: str):
    """PEP 562: lazily alias spatialHA -> spatialha."""
    if name == "spatialHA":
        # Import the canonical lowercase package
        try:
            mod = importlib.import_module("custom_components.spatialha")
        except ModuleNotFoundError:
            raise AttributeError(f"module {__name__!r} has no attribute {name!r}") from None
        # Cache alias for future imports
        sys.modules["custom_components.spatialHA"] = mod
        # Also alias submodules if already loaded
        for sub in list(sys.modules.keys()):
            if sub.startswith("custom_components.spatialha"):
                alias = sub.replace("custom_components.spatialha", "custom_components.spatialHA", 1)
                if alias not in sys.modules:
                    sys.modules[alias] = sys.modules[sub]
        return mod
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


# Eager alias for environments where __getattr__ not used (import system)
try:
    import custom_components.spatialha as _spatialha  # noqa: F401

    sys.modules.setdefault("custom_components.spatialHA", _spatialha)
    # Pre-alias known submodules if they exist
    for _sub in ("config_flow", "const", "websocket", "frontend"):
        try:
            _mod = importlib.import_module(f"custom_components.spatialha.{_sub}")
            sys.modules.setdefault(f"custom_components.spatialHA.{_sub}", _mod)
        except Exception:  # noqa: BLE001
            pass
except Exception:  # noqa: BLE001
    pass
