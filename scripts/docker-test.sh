#!/usr/bin/env bash
# 在 Docker 容器中实测 install.sh 全流程（含 systemd 服务注册/自启）
# 适用：能访问 Docker Hub 且容器可访问 apt/npm 源的环境
# 用法：bash scripts/docker-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PKG="release/mystokview-0.1.0.tar.gz"
IMG="jrei/systemd-ubuntu:24.04"   # 以 systemd 作为 PID1 的 Ubuntu 24.04
CNAME="mystok-test"
APP_PORT=3001

[ -f "$PKG" ] || { echo "请先运行: bash scripts/make-release.sh"; exit 1; }

echo "== [1/6] 拉取镜像 $IMG =="
docker pull "$IMG"

echo "== [2/6] 启动容器（privileged，systemd 作为 PID1）=="
docker rm -f "$CNAME" >/dev/null 2>&1 || true
docker run -d --privileged --name "$CNAME" "$IMG"

echo "== 等待 systemd 就绪 =="
for i in $(seq 1 40); do
  if docker exec "$CNAME" test -d /run/systemd/system; then
    echo "systemd ready (try $i)"; break
  fi
  sleep 2
done

echo "== [3/6] 预处理：确保 curl/git（干净 ubuntu 可能缺失，install.sh 的 NodeSource 步骤依赖 curl）=="
docker exec "$CNAME" bash -c "apt-get update >/dev/null 2>&1; apt-get install -y curl git >/dev/null 2>&1 || true"

echo "== [4/6] 传入发布包并解压 =="
docker cp "$PKG" "$CNAME":/root/
docker exec "$CNAME" bash -c "cd /root && rm -rf mystokview-0.1.0 && tar -xzf $(basename "$PKG") && ls mystokview-0.1.0"

echo "== [5/6] 运行 install.sh（容器内以 root 执行）=="
docker exec -w /root/mystokview-0.1.0 "$CNAME" bash install.sh

echo "== [6/6] 验证 =="
echo "-- systemd 服务状态（应为 active）--"
docker exec "$CNAME" systemctl is-active mystokview || true
echo "-- HTTP 探测（应返回 200）--"
docker exec "$CNAME" curl -fsS "http://localhost:$APP_PORT/" -o /dev/null && echo "HTTP 200 OK" || echo "HTTP 探测失败"
echo "-- 服务最近日志 --"
docker exec "$CNAME" journalctl -u mystokview --no-pager -n 30 || true

echo "== 清理容器（如需保留排查，请注释掉本行）=="
docker rm -f "$CNAME" >/dev/null 2>&1 || true
echo "DONE."
