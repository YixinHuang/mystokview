#!/usr/bin/env bash
# MyStokView 一键安装器（发行版）
# 用法:
#   sudo bash install.sh                # Linux (注册 systemd 服务)
#   bash install.sh                     # macOS (后台 nohup 启动)
#
# 环境变量覆盖:
#   INSTALL_DIR=/opt/mystokview  PORT=3001  APP_USER=mystokview
set -euo pipefail

APP_NAME="mystokview"
VERSION="0.1.0"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-/opt/$APP_NAME}"
PORT="${PORT:-3001}"
APP_USER="${APP_USER:-$APP_NAME}"
SERVICE_NAME="$APP_NAME"

log()  { printf '\033[0;36m[install]\033[0m %s\n' "$1"; }
ok()   { printf '\033[0;32m[ ok ]\033[0m %s\n' "$1"; }
warn() { printf '\033[0;33m[warn]\033[0m %s\n' "$1"; }
err()  { printf '\033[0;31m[error]\033[0m %s\n' "$1"; exit 1; }

OS="$(uname -s)"
ARCH="$(uname -m)"

# 仅在 Linux 上要求 root
if [ "$OS" = "Linux" ] && [ "$(id -u)" -ne 0 ]; then
  err "Linux 下请使用 root 运行: sudo bash install.sh"
fi

# ---------- 1. 运行时检测 / 安装 Node.js >= 18 ----------
have_node() {
  command -v node >/dev/null 2>&1 && \
    node -e "process.exit(process.versions.node.split('.')[0] >= 18 ? 0 : 1)" 2>/dev/null
}
if have_node; then
  ok "已检测到 Node.js $(node -v)"
else
  warn "未检测到 Node.js >= 18，开始安装..."
  if [ "$OS" = "Linux" ]; then
    if command -v apt-get >/dev/null 2>&1; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash - || err "NodeSource 源添加失败"
      apt-get install -y nodejs || err "nodejs 安装失败"
    elif command -v dnf >/dev/null 2>&1; then
      dnf module install -y nodejs:20 || err "nodejs 安装失败"
    elif command -v yum >/dev/null 2>&1; then
      curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - || err "NodeSource 源添加失败"
      yum install -y nodejs || err "nodejs 安装失败"
    else
      err "不支持的 Linux 发行版，请手动安装 Node.js >= 18 后重试"
    fi
  elif [ "$OS" = "Darwin" ]; then
    if command -v brew >/dev/null 2>&1; then
      brew install node || err "brew 安装 node 失败"
    else
      err "macOS 请先安装 Homebrew (https://brew.sh) 或手动安装 Node.js >= 18"
    fi
  else
    err "不支持的操作系统: $OS"
  fi
  command -v node >/dev/null 2>&1 || err "Node.js 安装后仍不可用，请检查 PATH"
  ok "Node.js $(node -v) 安装完成"
fi

# ---------- 2. 复制应用文件 ----------
EXCLUDES="--exclude=node_modules --exclude=dist --exclude=data \
  --exclude=.env --exclude='*.log' --exclude=.git \
  --exclude=.workbuddy --exclude=.codebuddy"
log "复制应用到 $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
if command -v rsync >/dev/null 2>&1; then
  # shellcheck disable=SC2086
  rsync -a $EXCLUDES "$SRC_DIR/" "$INSTALL_DIR/"
else
  # shellcheck disable=SC2086
  ( cd "$SRC_DIR" && tar $EXCLUDES -cf - . ) \
    | ( mkdir -p "$INSTALL_DIR" && tar -xf - -C "$INSTALL_DIR" )
fi

# ---------- 2.5 原生模块编译工具（Linux）----------
# better-sqlite3 等原生模块在缺少预编译包时需本地编译
if [ "$OS" = "Linux" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update >/dev/null 2>&1
    apt-get install -y build-essential python3 pkg-config \
      || warn "安装编译工具失败（若 better-sqlite3 有预编译包可忽略）"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y gcc-c++ make python3 pkgconfig \
      || warn "安装编译工具失败（若 better-sqlite3 有预编译包可忽略）"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y gcc-c++ make python3 pkgconfig \
      || warn "安装编译工具失败（若 better-sqlite3 有预编译包可忽略）"
  fi
fi

# ---------- 3. 安装依赖 + 构建前端 ----------
cd "$INSTALL_DIR"
log "安装依赖 (npm install)..."
npm install || err "npm install 失败"
if [ ! -d "dist" ]; then
  log "构建前端 (npm run build)..."
  npm run build || err "npm run build 失败"
else
  ok "已包含预构建前端 dist/，跳过构建"
fi

# ---------- 4. 生成 .env ----------
if [ ! -f "$INSTALL_DIR/.env" ]; then
  log "生成 .env (PORT=$PORT)"
  printf 'PORT=%s\n' "$PORT" > "$INSTALL_DIR/.env"
fi

# ---------- 5. 创建运行用户（Linux）----------
if [ "$OS" = "Linux" ]; then
  if ! id "$APP_USER" >/dev/null 2>&1; then
    useradd --system --shell /usr/sbin/nologin "$APP_USER" 2>/dev/null \
      || useradd --system --shell /usr/sbin/nologin "$APP_USER"
  fi
  chown -R "$APP_USER:$APP_USER" "$INSTALL_DIR"
fi

# ---------- 6. 注册 / 启动服务 ----------
if [ "$OS" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
  log "注册 systemd 服务 $SERVICE_NAME"
  cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=MyStokView
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$INSTALL_DIR
Environment=PORT=$PORT
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=-$INSTALL_DIR/.env
ExecStart=/usr/bin/env npm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
  ok "服务已启动，访问 http://<服务器IP>:$PORT"
elif [ "$OS" = "Darwin" ]; then
  log "macOS 未注册系统服务，使用 nohup 后台启动"
  ( cd "$INSTALL_DIR" && nohup npm start > "$INSTALL_DIR/mystokview.log" 2>&1 & )
  ok "已在后台启动，访问 http://localhost:$PORT"
else
  log "未知初始化系统，请手动运行: cd $INSTALL_DIR && npm start"
fi

# ---------- 7. 后续步骤提示 ----------
echo
warn "==================== 后续步骤 ===================="
echo "1) 开放防火墙端口 $PORT："
echo "   - 云服务器：在控制台安全组 / 防火墙放行 TCP:$PORT"
echo "   - 本地： sudo ufw allow $PORT"
echo "2) 实时行情：在服务器安装并授权 westock"
echo "     npm install -g westock && westock version   # 按提示扫码"
echo "     （未授权时行情使用本地缓存，应用仍正常运行）"
echo "3) AI 管家：终端执行 npx codebuddy login 完成登录"
echo "4) 查看日志："
echo "   - Linux: journalctl -u $SERVICE_NAME -f"
echo "   - macOS: tail -f $INSTALL_DIR/mystokview.log"
echo "=================================================="
