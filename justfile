set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

export UV_CACHE_DIR := justfile_directory() / ".cache/uv"

# 列出可用命令。
default:
    @just --list

alias snap := snapshot

# 生成带时间戳的仓库快照，供远端 agent 阅读。
snapshot:
    #!/usr/bin/env sh
    set -eu
    if ! command -v repomix >/dev/null 2>&1; then
        printf '缺少 repomix，请先安装并加入 PATH。\n' >&2
        exit 1
    fi
    mkdir -p .snapshots
    snapshot_path=".snapshots/$(basename "$PWD")_仓库快照_$(date +%Y%m%d%H%M%S).xml"
    repomix --style xml --token-count-tree --output "$snapshot_path"
    printf '\n快照已生成：%s/%s\n' "$PWD" "$snapshot_path"

# 安装锁定的后端与前端依赖。
setup:
    uv sync --project backend --locked
    pnpm --dir frontend install --frozen-lockfile

# 同时启动 FastAPI 热重载与 Vite；Ctrl-C 一并停止子进程。
dev: migrate
    uv run --project backend python scripts/run.py dev

# 构建前端并由 FastAPI 托管。
start: migrate build
    uv run --project backend python scripts/run.py start

build:
    pnpm --dir frontend build

# Python 与 TypeScript 的格式、静态检查。
lint:
    uv run --project backend ruff check backend scripts
    uv run --project backend ruff format --check backend scripts
    uv run --project backend pyright --project backend
    pnpm --dir frontend lint
    pnpm --dir frontend typecheck
    node --check prototypes/epub-reading/app.mjs
    node --check prototypes/epub-reading/locator.mjs

format:
    uv run --project backend ruff check --fix backend scripts
    uv run --project backend ruff format backend scripts
    pnpm --dir frontend format

# 运行本地后端与前端纯逻辑测试，不访问真实网络或模型。
test:
    uv run --project backend pytest backend/tests
    pnpm --dir frontend test

# 从本地 FastAPI 导出契约，再生成前端类型；不需启动服务。
gen-api:
    uv run --project backend python -m app.export_openapi
    pnpm --dir frontend gen-api

# 从空库建立当前 schema，或执行已记录迁移；不自动清空数据库。
migrate:
    uv run --directory backend alembic upgrade head

# 验证保留的实验与静态视觉原型。
check-assets:
    node --test prototypes/epub-reading/locator.test.mjs
    node --check prototypes/reading-native/app.js
    node --test prototypes/reading-native/verify.mjs
    node references/occurrence_anchor_pilot/reading-experiment/parser-test.mjs
    uv run --project backend python references/occurrence_anchor_pilot/batch-01/validate.py

# 验证规范、交接和资产索引中的本地链接。
check-docs:
    uv run --project backend python scripts/check_docs.py

check: lint test build check-docs
