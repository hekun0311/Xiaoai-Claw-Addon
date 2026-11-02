#!/bin/sh
set -eu
repo_dir=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
exec python3 "$repo_dir/deploy/1panel/deploy.py" install "$repo_dir" main
