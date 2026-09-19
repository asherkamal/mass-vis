"""
Import this BEFORE `import pyflamegpu`, on Windows, when pyflamegpu was
installed from a plain (non-.vis) whl.flamegpu.com wheel via pip rather than
a full CUDA Toolkit install - see the "Windows install, the real story"
section of ../README.md for how each of these was discovered.

Short version: the pip pyflamegpu wheels do NOT bundle the CUDA
runtime/NVRTC/cuRAND/CCCL/nvJitLink components they need at import and
JIT-compile time - despite appearances, nothing on PyPI or whl.flamegpu.com
documents this. On a machine with the full CUDA Toolkit installed (setting
CUDA_PATH to the toolkit root, and its bin/ on PATH) none of this is needed.
Without one, each of the pip packages below supplies exactly one missing
piece, found by iterating actual NVRTC/link failures one at a time:

  nvidia-cuda-nvrtc-cu12   -> nvrtc64_120_0.dll (pyflamegpu's own __init__.py
                              already searches PATH for this one via `where`,
                              so adding its bin/ to PATH is enough - no
                              add_dll_directory needed for this one alone,
                              but harmless to do anyway)
  nvidia-cuda-runtime-cu12 -> include/cuda_runtime.h and friends
  nvidia-curand-cu12       -> include/curand_kernel.h (used by FLAME GPU2's
                              own runtime/random headers) + curand64_10.dll
  nvidia-cuda-cccl-cu12    -> include/nv/target, cub/, thrust/ (pulled in
                              transitively by curand_kernel.h)
  nvidia-nvjitlink-cu12    -> nvJitLink_120_0.dll, needed at link time (not
                              compile time) once NVRTC produces PTX/LTOIR

Pin every one of these to the SAME CUDA release train as the pyflamegpu
build you installed (2.0.0rc4+cuda124 here -> the 12.4.x line below). NVRTC
compiles against whatever headers CUDA_PATH points at, and a version
mismatch between components is exactly the kind of thing that fails
silently or subtly rather than with a clear error.

The include/ directories from nvidia-cuda-runtime-cu12 and nvidia-cuda-cccl-
cu12 must be merged into one directory before CUDA_PATH points at it -
JitifyCache only takes a single "$CUDA_PATH/include", the way a real
Toolkit install lays out all its headers together in one place. This module
builds that merge once, into a cache directory, and reuses it on later runs.

Install (matching this file's pins):
    pip install --extra-index-url https://whl.flamegpu.com/whl/cuda124/ pyflamegpu
    pip install nvidia-cuda-nvrtc-cu12==12.4.127 nvidia-cuda-runtime-cu12==12.4.127 \
        nvidia-curand-cu12==10.3.5.147 nvidia-cuda-cccl-cu12==12.4.127.post1 \
        nvidia-nvjitlink-cu12==12.4.127

If you have a real CUDA Toolkit 12.4+ installed instead (the toolkit's own
installer, not pip), none of this is necessary - just make sure CUDA_PATH
points at it and its bin/ is on PATH, and importing plain `pyflamegpu`
already works.
"""
import os
import shutil
import sys

_DONE = False


def setup():
    """Idempotent - safe to call more than once (e.g. if multiple adapter
    modules each import this). Must run before the first `import pyflamegpu`
    anywhere in the process, since pyflamegpu's own __init__.py resolves the
    NVRTC dll location at import time."""
    global _DONE
    if _DONE:
        return
    if os.name != "nt":
        _DONE = True
        return  # only Windows needs any of this - see module docstring
    if "pyflamegpu" in sys.modules:
        raise RuntimeError(
            "_pyflamegpu_env.setup() must be called before `import pyflamegpu` "
            "- pyflamegpu resolves its NVRTC DLL location at import time."
        )

    try:
        import nvidia.cuda_nvrtc
        import nvidia.cuda_runtime
        import nvidia.curand
        import nvidia.cuda_cccl
        import nvidia.nvjitlink
    except ImportError as e:
        raise RuntimeError(
            "Missing one of the pip CUDA component packages this adapter needs "
            "on Windows without a full CUDA Toolkit install - see this file's "
            "module docstring for the exact `pip install` command."
        ) from e

    import pathlib

    nvrtc_bin = str(pathlib.Path(nvidia.cuda_nvrtc.__file__).resolve().parent / "bin")
    curand_bin = str(pathlib.Path(nvidia.curand.__file__).resolve().parent / "bin")
    nvjitlink_bin = str(pathlib.Path(nvidia.nvjitlink.__file__).resolve().parent / "bin")
    for d in (nvrtc_bin, curand_bin, nvjitlink_bin):
        os.environ["PATH"] = d + os.pathsep + os.environ["PATH"]
        os.add_dll_directory(d)

    # Merge cuda_runtime's and cuda_cccl's include/ dirs into one, cached
    # across runs by content-stamping on each source package's own version.
    cache_root = pathlib.Path(
        os.environ.get("MASSVIZ_FLAMEGPU_CUDA_CACHE")
        or (pathlib.Path(__file__).resolve().parent / ".cuda-include-cache")
    )
    runtime_inc = pathlib.Path(nvidia.cuda_runtime.__file__).resolve().parent / "include"
    curand_inc = pathlib.Path(nvidia.curand.__file__).resolve().parent / "include"
    cccl_inc = pathlib.Path(nvidia.cuda_cccl.__file__).resolve().parent / "include"
    source_dirs = [runtime_inc, curand_inc, cccl_inc]
    stamp_file = cache_root / ".stamp"
    stamp = "|".join(str(d) for d in source_dirs)
    merged_include = cache_root / "include"
    if not merged_include.is_dir() or not stamp_file.is_file() or stamp_file.read_text() != stamp:
        if cache_root.is_dir():
            shutil.rmtree(cache_root)
        merged_include.mkdir(parents=True)
        for d in source_dirs:
            shutil.copytree(d, merged_include, dirs_exist_ok=True)
        stamp_file.write_text(stamp)

    os.environ["CUDA_PATH"] = str(cache_root)
    _DONE = True
