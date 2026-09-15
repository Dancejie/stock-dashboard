#!/bin/sh
# health.sh — 子应用探活脚本，由 guard-transform 模板渲染。
#
# 端口契约：
#   - Guard 通过 $APP_PORT 环境变量传入当前要探测的端口
#   - 兼容历史脚本：未设置时回退到 3000
#
# 蓝绿场景：Guard 先在 3001 起新版本并 health-check（APP_PORT=3001），
# 通过后原子切流量到 3001，再 SIGTERM 老版本（在 3000 上）。
# 写死 3000 会让蓝绿期 health-check 永远探到老版本，新版本永远过不了校验。
curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:${APP_PORT:-3000}/health" || exit 1
