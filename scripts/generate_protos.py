#!/usr/bin/env python3
"""
generate_protos.py — compile ProtoMQ's V2 protobufs to Python modules.

The protobufs in ../protobufs/ have already been nanopb-stripped and their
imports flattened into that single directory by `npm run import-protos`, so
`protoc` can compile them directly. This writes the generated *_pb2.py modules
into ./protomq_pb/ (beside this script) for protomq_client.py to import.

Run once (re-run after the .proto set changes):

    python3 scripts/generate_protos.py

Requires either:
  * `grpcio-tools` (preferred — bundles a protoc matched to its `protobuf`
    runtime, so the generated code always imports cleanly):  pip install grpcio-tools
  * OR a standalone `protoc` on PATH whose version matches the installed
    `protobuf` runtime.

We prefer `python -m grpc_tools.protoc` run under *this* interpreter so protoc
and the runtime agree; a version skew (e.g. old system protoc + new protobuf)
otherwise breaks import with "Descriptors cannot be created directly".
"""

import os
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
PROTO_SRC = os.path.join(REPO_ROOT, "protobufs")
OUT_DIR = os.path.join(SCRIPT_DIR, "protomq_pb")


def main():
    if not os.path.isdir(PROTO_SRC):
        sys.exit(f"proto source dir not found: {PROTO_SRC}\n"
                 f"Did you run `npm run import-protos`?")

    protos = sorted(f for f in os.listdir(PROTO_SRC) if f.endswith(".proto"))
    if not protos:
        sys.exit(f"no .proto files in {PROTO_SRC}")

    os.makedirs(OUT_DIR, exist_ok=True)
    # Make the output dir an importable package.
    init_path = os.path.join(OUT_DIR, "__init__.py")
    if not os.path.exists(init_path):
        with open(init_path, "w") as f:
            f.write("# generated protobuf package (see generate_protos.py)\n")

    # Prefer grpc_tools.protoc under this interpreter (version-matched to the
    # protobuf runtime); fall back to a standalone protoc binary.
    protoc_args = [f"-I{PROTO_SRC}", f"--python_out={OUT_DIR}", *protos]
    try:
        import grpc_tools.protoc  # noqa: F401
        cmd = [sys.executable, "-m", "grpc_tools.protoc", *protoc_args]
    except ImportError:
        cmd = ["protoc", *protoc_args]

    print("#", " ".join(cmd), file=sys.stderr)
    try:
        subprocess.run(cmd, check=True, cwd=PROTO_SRC)
    except FileNotFoundError:
        sys.exit("No protoc available. Install grpcio-tools (pip install "
                 "grpcio-tools) or a standalone protoc.")
    except subprocess.CalledProcessError as e:
        sys.exit(f"protoc failed (exit {e.returncode}).")

    generated = sorted(f for f in os.listdir(OUT_DIR) if f.endswith("_pb2.py"))
    print(f"# generated {len(generated)} module(s) in {OUT_DIR}", file=sys.stderr)
    print(f"# key module: {'signal_pb2.py' if 'signal_pb2.py' in generated else 'MISSING signal_pb2.py!'}",
          file=sys.stderr)


if __name__ == "__main__":
    main()
