#!/usr/bin/env bash
set -euo pipefail

if ! command -v wrangler >/dev/null 2>&1; then
  echo "wrangler CLI 未安装。请先安装: npm i -g wrangler" >&2
  exit 1
fi

if [ $# -lt 1 ]; then
  echo "用法: $0 <cloudflare-pages-project-name>" >&2
  exit 1
fi

PROJECT_NAME="$1"

echo "开始部署到 Cloudflare Pages 项目: ${PROJECT_NAME}"
wrangler pages deploy public --project-name "${PROJECT_NAME}" --functions functions
