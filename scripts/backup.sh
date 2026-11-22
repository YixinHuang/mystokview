#!/usr/bin/env bash
# MyStokView 备份脚本：将项目目录（除 node_modules）打包为 mystokviewbackupYYYYMMDD.tar
# 用法: bash scripts/backup.sh
#   默认输出到项目上级目录（与 mystokview/ 并列），可用 OUTPUT_DIR 覆盖，如:
#   OUTPUT_DIR=/tmp bash scripts/backup.sh
#
# 说明:
#   - 仅排除 node_modules（任意层级），其余全部打包——包括 .git、data/（个人持仓库）、
#     .env（密钥）等，备份包含敏感与个人信息，请妥善保管
#   - 同一天重复运行会覆盖当天的备份包
#   - 有 sqlite3 时对运行中的库先做在线一致性快照（.backup），归档中的 data/ 只含自洽快照；
#     无 sqlite3 则退回直接打包（服务写入中可能得到轻微不一致的库）
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"   # 项目根（scripts/ 的上一级）
BACKUP_NAME="mystokviewbackup$(date +%Y%m%d).tar"
OUTPUT_DIR="${OUTPUT_DIR:-$(dirname "$APP_DIR")}"
TARGET="$OUTPUT_DIR/$BACKUP_NAME"

mkdir -p "$OUTPUT_DIR"

# 运行中的 SQLite 直接拷贝 db+wal 可能不一致：有 sqlite3 时先导出自洽快照
DB_SRC="$APP_DIR/data/portfolio.db"
SNAP_DIR=""
EXTRA_EXCLUDE=()
cleanup() { [ -n "$SNAP_DIR" ] && rm -rf "$SNAP_DIR"; } # set -e 中途失败也清理临时目录
trap cleanup EXIT

if command -v sqlite3 >/dev/null 2>&1 && [ -f "$DB_SRC" ]; then
  SNAP_DIR="$(mktemp -d)"
  sqlite3 "$DB_SRC" ".backup '$SNAP_DIR/portfolio.db'"
  EXTRA_EXCLUDE=(--exclude=data)
else
  echo "[warn] 未找到 sqlite3，data/ 为运行中直接拷贝，存在轻微不一致风险"
fi

# -C 到项目上级目录打包，归档内路径以 mystokview/ 开头；
# node_modules 任意层级均排除；备份包自身也排除（防止 OUTPUT_DIR 指向项目内部时自我包含）。
# ${arr[@]:+...} 展开兼容 bash 3.2 的空数组 + set -u
tar -cf "$TARGET" \
    --exclude='node_modules' \
    --exclude='mystokviewbackup*.tar' \
    ${EXTRA_EXCLUDE[@]:+"${EXTRA_EXCLUDE[@]}"} \
    -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")"

# 追加快照库，归档路径对齐为 mystokview/data/portfolio.db
if [ -n "$SNAP_DIR" ]; then
  mkdir -p "$SNAP_DIR/$(basename "$APP_DIR")/data"
  mv "$SNAP_DIR/portfolio.db" "$SNAP_DIR/$(basename "$APP_DIR")/data/portfolio.db"
  tar -rf "$TARGET" -C "$SNAP_DIR" "$(basename "$APP_DIR")/data"
fi

echo "备份完成: $TARGET ($(du -h "$TARGET" | cut -f1))"
