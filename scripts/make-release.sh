#!/usr/bin/env bash
# 生成 MyStokView 发行版安装包
# 用法: bash scripts/make-release.sh
# 产出: release/mystokview-<version>.tar.gz（归档含顶层 mystokview-<version>/ 目录）
# 目标机: 解压后 sudo bash install.sh
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="mystokview"
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo "0.1.0")"
OUT_DIR="release"
STAGE="$OUT_DIR/${APP_NAME}-${VERSION}"
PKG="$OUT_DIR/${APP_NAME}-${VERSION}.tar.gz"

mkdir -p "$OUT_DIR"
rm -rf "$STAGE"
mkdir -p "$STAGE"

# 经 tar 管道复制到暂存目录（与打包容同一套排除规则，规避 rsync 依赖）。
# 注意：bsdtar 的 --exclude 按路径分量匹配（./ 前缀无法锚定顶层），data/dist/release/
# wind-mcp-doc 为顶层专有命名，勿在项目内新建嵌套同名目录，否则会被静默排除
tar --exclude=node_modules --exclude=dist --exclude=data --exclude='*.tar' \
    --exclude=.env --exclude='*.log' --exclude=.git \
    --exclude=release --exclude='.DS_Store' \
    --exclude=.workbuddy --exclude=.codebuddy --exclude=wind-mcp-doc \
    -cf - . | tar -xf - -C "$STAGE"

# 归档带顶层目录，与使用说明的 cd mystokview-<version> 一致
tar -czf "$PKG" -C "$OUT_DIR" "${APP_NAME}-${VERSION}"
rm -rf "$STAGE"

echo "已生成安装包: $PKG ($(du -h "$PKG" | cut -f1))"
echo "使用方式:"
echo "  1) 将 $PKG 传到目标服务器"
echo "  2) tar -xzf $PKG"
echo "  3) cd ${APP_NAME}-${VERSION} && sudo bash install.sh"
