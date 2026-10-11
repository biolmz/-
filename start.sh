#!/usr/bin/env bash
# 感官评价线上评分系统 — 一键启动
set -e
cd "$(dirname "$0")"

export PORT="${PORT:-8200}"
export HOST="${HOST:-0.0.0.0}"

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未检测到 node，请先安装 Node.js 18 或更高版本。" >&2
  exit 1
fi

echo "Node 版本：$(node -v)"
exec node server.js
