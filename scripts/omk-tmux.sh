#!/usr/bin/env bash
set -euo pipefail

# A running OMK cannot move into tmux; launch or resume it in a fresh pane instead.
if [[ -n "${TMUX:-}" ]]; then
	exec omk "$@"
fi

if ! command -v tmux >/dev/null 2>&1; then
	printf 'omk-tmux: tmux is required. Install it, then run this script again.\n' >&2
	exit 127
fi

exec tmux new-session -c "$PWD" -e OMK_PIN_STATUS_SIDEBAR=0 -- omk "$@"
