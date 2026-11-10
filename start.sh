#!/usr/bin/env bash
# start.sh - 由 Guard 应用拉起业务主进程；末行必须 exec
# 由 guard-transform 模板渲染生成
set -eo pipefail
cd "$(dirname "$0")"

# Pod 镜像 Dockerfile `ENV PATH=/opt/venv/bin:$PATH` 已让 python3 / pip 直通全局
# venv（/opt/venv）。install.sh 的 `python3 -m pip install` 把依赖装到那里，
# start.sh 直接 `exec python3 -m gunicorn ...` 即可，不再依赖工程内 .venv。
export APP_PORT="${APP_PORT:-3000}"
exec python3 -m uvicorn app:app --host 0.0.0.0 --port ${APP_PORT} 2>&1
