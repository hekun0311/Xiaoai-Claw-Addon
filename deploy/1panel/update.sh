#!/bin/sh
set -eu
branch=${1:?请传入 main 分支}
[ "$branch" = main ] || { echo 'OpenClaw 小爱固定使用 main。' >&2; exit 1; }
repo_dir=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
[ "$(git -C "$repo_dir" branch --show-current)" = main ] || { echo '当前分支不是 main。' >&2; exit 1; }
[ -z "$(git -C "$repo_dir" status --porcelain)" ] || { echo '工作区存在修改，拒绝更新。' >&2; exit 1; }
git -C "$repo_dir" fetch origin refs/heads/main
git -C "$repo_dir" merge --ff-only FETCH_HEAD
exec python3 "$repo_dir/deploy/1panel/deploy.py" update "$repo_dir" main
