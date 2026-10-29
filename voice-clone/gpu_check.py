"""Check that the voice-clone tool can use the NVIDIA graphics card. install.bat runs this."""

from __future__ import annotations

import os
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")  # e.g. "pkg_resources is deprecated", which means nothing to the owner
os.environ.setdefault("HF_HOME", str(Path(__file__).resolve().parent / "models"))  # as in voiceclone.py


def main() -> int:
    try:
        import torch
    except Exception as err:
        print(f"FAILED: PyTorch (the maths library the voice runs on) is not installed properly: {err}")
        return 1

    print(f"PyTorch {torch.__version__} (CUDA {torch.version.cuda})")
    if not torch.cuda.is_available():
        print(
            "FAILED: PyTorch can't see an NVIDIA graphics card.\n"
            "Update the NVIDIA driver (version 570 or newer) from nvidia.com, restart the PC, "
            "then run install.bat again."
        )
        return 1

    name = torch.cuda.get_device_name(0)
    major, minor = torch.cuda.get_device_capability(0)
    arch = f"sm_{major}{minor}"
    supported = torch.cuda.get_arch_list()
    print(f"Graphics card: {name} ({arch}, {torch.cuda.get_device_properties(0).total_memory / 2**30:.0f} GB)")
    print(f"This PyTorch supports: {' '.join(supported)}")
    if arch not in supported:
        print(
            f"FAILED: this PyTorch build has no support for {arch} cards "
            "(the error would be 'no kernel image is available'). Run install.bat again."
        )
        return 1

    try:
        x = torch.randn(1024, 1024, device="cuda")
        (x @ x).sum().item()
        torch.cuda.synchronize()
    except Exception as err:
        print(f"FAILED: a test calculation on the graphics card didn't work: {err}")
        return 1

    try:
        import chatterbox  # noqa: F401
        import lameenc  # noqa: F401
        import perth
    except Exception as err:
        print(f"FAILED: the voice software didn't load: {err}")
        return 1
    if perth.PerthImplicitWatermarker is None:
        # perth hides its import error; it needs pkg_resources from setuptools<81.
        print("FAILED: the watermark part of the voice software didn't load. Run install.bat again.")
        return 1

    print("OK: the graphics card works and the voice software is installed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
