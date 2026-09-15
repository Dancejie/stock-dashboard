#!/usr/bin/env bash
# install.sh - Pod 解压后跑一次
# 由 guard-transform 模板渲染生成；shebang / set / 镜像参数已写死，请勿手改
set -eo pipefail
cd "$(dirname "$0")"

# monorepo 后端子目录（空字符串表示单仓，pip/npm 直接在顶层执行）
BACKEND_DIR=""

echo "[install] step: start (backend_dir='${BACKEND_DIR}')"

# 切到 backend 目录的 helper：单仓时是 no-op
_cd_backend() {
  if [ -n "$BACKEND_DIR" ] && [ -d "$BACKEND_DIR" ]; then
    cd "$BACKEND_DIR"
  fi
}

if [ "1" = "1" ]; then
  (
    _cd_backend
    if [ -f requirements.txt ]; then
      # ★ Pod 镜像（Dockerfile 里）已预创建 /opt/venv 并把 /opt/venv/bin 拍到 PATH 最前；
      #   pip / python 都解析到 /opt/venv/bin。直接用 ambient `python3 -m pip` 即可。
      # 历史坑：在 venv 内部再跑 `python3 -m venv .venv` 会触发：
      #   1) bookworm 的 python3-venv 单包不带 ensurepip 的 pip wheel（pip 在 python3-pip 包里），
      #      新建 .venv 没有 pip → `. .venv/bin/activate` 后 PATH 上 `pip: command not found`
      #   2) 多一层嵌套 venv 没收益，反而更脆弱
      # macOS 本地：用户大概率已自激活 venv 或装了 pip，同样直接 ambient 即可。
      # 镜像源不写死在脚本里；如需走内部 mirror，在 Pod env 设 PIP_INDEX_URL / PIP_TRUSTED_HOST。
      echo "[install] step: pip install (use ambient pip from /opt/venv on Pod) in $(pwd)"
      python3 -m pip install --no-cache-dir -r requirements.txt 2>&1
    fi
  )
fi

if [ "0" = "1" ]; then
  (
    _cd_backend
    # Next.js standalone 通常自带 node_modules，可跳过
    if [ -f package.json ] && [ ! -f .next/standalone/server.js ]; then
      echo "[install] step: npm ci --omit=dev in $(pwd)"
      # .npmrc 已打进 zip，自动走内部双路 registry
      npm ci --omit=dev 2>&1
    fi
  )
fi

# ── 纯前端 SPA 托管 runtime（仅 server.cjs 依赖的 serve-handler）─────────────
# 设计：业务 package.json 通常只声明 build 期 devDependencies（vite/react/...），
# 生产 Pod 不需要这些。我们把托管层依赖（serve-handler）隔离到 .guard-runtime/
# 子目录，单独装一个 package.json，避免：
#   1) 改业务 package.json（破坏 package-lock 一致性，npm ci 失败）
#   2) 在业务根目录跑 npm install（重新解析全部 deps，浪费 + 可能拉公网）
# server.cjs 通过 require('.guard-runtime/node_modules/serve-handler') 引用
if [ "0" = "1" ]; then
  echo "[install] step: setup .guard-runtime/ for static serving (serve-handler)"
  mkdir -p .guard-runtime
  # 不存在则写一份最小 package.json；存在则保留（支持后续手动加钉版本）
  if [ ! -f .guard-runtime/package.json ]; then
    cat > .guard-runtime/package.json <<'JSON'
{
  "name": "guard-static-runtime",
  "version": "1.0.0",
  "private": true,
  "description": "guard-transform 渲染的纯前端托管 runtime，仅含 server.cjs 所需依赖",
  "dependencies": {
    "serve-handler": "^6.1.5"
  }
}
JSON
  fi
  (
    cd .guard-runtime
    # 继承上级 .npmrc（双路内部镜像）；无 lock 走 npm install
    if [ -f package-lock.json ]; then
      npm ci --omit=dev 2>&1
    else
      npm install --no-audit --prefer-offline --omit=dev 2>&1
    fi
  )
fi

if [ "1" = "1" ]; then
  (
    _cd_backend
    # Pod 镜像 Dockerfile `ENV PATH=/opt/venv/bin:$PATH` 已让 python / pip 直通全局 venv，
    # 工程内不再嵌套建 .venv（详见 install.sh 顶部注释）。
    echo "[install] step: db init (DDL + DML) in $(pwd)"
    if [ -f app/init_db.py ]; then
      python3 -m app.init_db 2>&1
    elif [ -f init_db.py ]; then
      python3 init_db.py 2>&1
    elif [ -f dist/init_db.js ]; then
      node dist/init_db.js 2>&1
    elif [ -f init_db.js ]; then
      node init_db.js 2>&1
    fi

    if [ -f app/seed_db.py ]; then
      echo "[install] step: db seed"
      python3 -m app.seed_db 2>&1
    elif [ -f dist/seed_db.js ]; then
      echo "[install] step: db seed"
      node dist/seed_db.js 2>&1
    fi
  )
fi

echo "[install] done"
