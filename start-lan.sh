#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOST=0.0.0.0 LAN_ACCESS=1 sh "$SCRIPT_DIR/start.sh"
