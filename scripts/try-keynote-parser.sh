#!/bin/sh
# One-off check: can keynote-parser unpack a Keynote 14.4 file?
# Run from the repo root:   sh scripts/try-keynote-parser.sh
# Then paste everything it prints to Claude.
set -x
cd "$(dirname "$0")/.."
python3 -m venv .venv-kp
.venv-kp/bin/pip install keynote-parser
rm -rf /tmp/example-unpacked
.venv-kp/bin/keynote-parser unpack example.key --output /tmp/example-unpacked
ls /tmp/example-unpacked/Index | head
