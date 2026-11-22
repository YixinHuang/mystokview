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
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"   # 项目根（scripts/ 的上一级）
BACKUP_NAME="mystokviewbackup$(date +%Y%m%d).tar"
OUTPUT_DIR="${OUTPUT_DIR:-$(dirname "$APP_DIR")}"
TARGET="$OUTPUT_DIR/$BACKUP_NAME"

mkdir -p "$OUTPUT_DIR"

# -C 到项目上级目录打包，归档内路径以 mystokview/ 开头；
# node_modules 任意层级均排除；备份包自身也排除（防止 OUTPUT_DIR 指向项目内部时自我包含）
tar -cf "$TARGET" \
    --exclude='node_modules' \
    --exclude='mystokviewbackup*.tar' \
    -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")"

echo "备份完成: $TARGET ($(du -h "$TARGET" | cut -f1))"
