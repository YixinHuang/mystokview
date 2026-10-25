#!/usr/bin/env bash
# 生成 MyStokView 发行版安装包
# 用法: bash scripts/make-release.sh
# 产出: release/mystokview-<version>.tar.gz
# 目标机: 解压后 sudo bash install.sh
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="mystokview"
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo "0.1.0")"
OUT_DIR="release"
PKG="$OUT_DIR/${APP_NAME}-${VERSION}.tar.gz"

mkdir -p "$OUT_DIR"

# 打包项目根（排除本地产物与敏感文件），并自带 install.sh / README / .env.example
tar --exclude=node_modules --exclude=dist --exclude=data \
    --exclude=.env --exclude='*.log' --exclude=.git \
    --exclude=release --exclude='.DS_Store' \
    --exclude=.workbuddy --exclude=.codebuddy \
    -czf "$PKG" .

echo "已生成安装包: $PKG ($(du -h "$PKG" | cut -f1))"
echo "使用方式:"
echo "  1) 将 $PKG 传到目标服务器"
echo "  2) tar -xzf $PKG"
echo "  3) cd ${APP_NAME}-${VERSION} && sudo bash install.sh"
