#!/usr/bin/env bash
set -euo pipefail

if ! command -v vercel >/dev/null 2>&1; then
  echo "vercel CLI 未安装。请先安装: npm i -g vercel" >&2
  exit 1
fi

echo "开始部署到 Vercel..."
vercel --prod
