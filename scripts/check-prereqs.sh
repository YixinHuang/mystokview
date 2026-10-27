#!/usr/bin/env bash
# MyStokView 运行前环境预检
# 检测 Node 版本、npm 依赖、westock 命令行工具的安装与授权状态、.env 配置。
# 用法: bash scripts/check-prereqs.sh   或   npm run setup

cecho() { printf '\033[0;%sm%s\033[0m\n' "$1" "$2"; }
ok()   { cecho "32" "✅ $1"; }
warn() { cecho "33" "⚠️  $1"; }
err()  { cecho "31" "❌ $1"; }
info() { cecho "36" "ℹ️  $1"; }

echo "=========================================="
echo "        MyStokView 环境预检"
echo "=========================================="

# 1) Node.js
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v | sed 's/v//')
  MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  info "Node.js: v$NODE_VER"
  if [ -n "$MAJOR" ] && [ "$MAJOR" -lt 18 ] 2>/dev/null; then
    err "Node.js 版本过低，需要 >= 18，请先升级。"
  else
    ok "Node.js 版本满足要求 (>= 18)"
  fi
else
  err "未检测到 Node.js，请先安装 >= 18 的版本 (https://nodejs.org)。"
fi

# 2) npm 依赖
if [ -d "node_modules" ]; then
  ok "npm 依赖已安装 (node_modules 存在)"
else
  warn "未检测到 node_modules，请先运行: npm install"
fi

# 3) westock（行情数据源，需单独安装并授权）
if command -v westock >/dev/null 2>&1; then
  ok "已检测到 westock 命令"
  info "正在检查 westock 授权状态..."
  OUT=$(westock version --json 2>/dev/null)
  if echo "$OUT" | grep -qi '"auth"[: ]*true'; then
    ok "westock 已授权，行情可实时获取"
  else
    # 部分 westock 版本不支持 --json（仅返回纯文本版本号，如 "westock 0.0.2 channel=..."），
    # 且有些版本没有 quote 子命令，上面的 JSON 判断永不命中。改用真实行情查询做探针：
    # 输出含 AUTH_REQUIRED 表示未授权；能返回行情表格（含竖线分隔）表示已授权可用。
    PROBE=$(westock kline sh600519 --period day --limit 1 2>/dev/null)
    if echo "$PROBE" | grep -qi 'AUTH_REQUIRED'; then
      warn "westock 已安装但未授权，行情将回退为本地缓存。"
      info "授权方式：运行 'westock version' 或在本应用查询行情时，按返回的授权链接在浏览器扫码登录。"
    elif echo "$PROBE" | grep -q '|'; then
      ok "westock 已授权，行情可实时获取（行情探测成功）"
    else
      warn "未能确认 westock 授权状态（行情探测无有效返回），请自行运行 'westock kline sh600519 --period day --limit 1' 验证；未授权时行情将回退为本地缓存。"
    fi
  fi
else
  err "未检测到 westock 命令（本应用获取 A股/ETF 实时行情所依赖的命令行工具）。"
  echo ""
  info "westock 需单独安装并扫码授权，请按官方/实际来源选择安装方式，例如："
  echo "    npm install -g westock"
  echo "    # 或参考 westock 官方文档的其它安装方式"
  echo ""
  info "安装完成后，重新运行本脚本验证： npm run setup"
  echo ""
  info "未安装/未授权时应用仍可运行，但行情来自本地缓存（页面顶部会显示授权提示 banner）。"
fi

# 4) .env（可选）
if [ -f ".env" ]; then
  ok ".env 已存在"
else
  info "未检测到 .env（可选）：可复制 .env.example 后配置 PORT / CODEBUDDY_API_KEY。"
fi

echo "=========================================="
info "预检完成。开发模式请运行: npm run dev"
echo "=========================================="
