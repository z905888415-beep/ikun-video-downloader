#!/bin/bash
# ============================================================
# iKun 公网下载站 · Linux / 沙箱 / 宝塔 一键全自动上线与守护脚本
# 适用：Ubuntu / Debian / CentOS 云服务器与沙箱
# 用法：curl -sSL https://raw.githubusercontent.com/z905888415-beep/ikun-video-downloader/master/deploy-ikun.sh | bash
# 安全：幂等，可重复执行；数据自动备份保护
# ============================================================
set -e

LOG=/opt/keepalive/deploy.log
SITE=/workspace/site
REPO_URL=https://github.com/z905888415-beep/ikun-video-downloader.git
PORT="${PORT:-8787}"
DOMAIN="${DOMAIN:-dl.zhangjianli.icu}"
ADMIN_TOKEN="${IKUN_ADMIN_TOKEN:-}"

# 自动探测环境已有监听端口，避免与隧道或反代冲突
for p in 3000 8787 8080; do
  if ss -tln 2>/dev/null | grep -q ":${p} "; then
    echo "ℹ️ 检测到端口 ${p} 已有服务监听，自动沿用 PORT=${p}"
    PORT=$p
    break
  fi
done
echo "▶ 使用端口 PORT=${PORT}（公网接入：https://${DOMAIN}）"

mkdir -p /opt/keepalive
exec > >(tee -a "$LOG") 2>&1
echo "===== [$(date '+%F %T')] iKun 上线与同步脚本开始 ====="

# ---------- 0. 环境工具检查 ----------
command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git || yum install -y git; }
command -v node >/dev/null || { echo "❌ 未检测到 Node.js，请先安装 Node 20 或 22+"; exit 1; }
echo "✅ Node 版本: $(node -v)"

# ---------- 1. 拉取与更新最新源码 ----------
if [ -d "$SITE/.git" ]; then
  cd "$SITE"
  git remote set-url origin "$REPO_URL" 2>/dev/null || git remote add origin "$REPO_URL"
  git stash --include-untracked 2>/dev/null || true
  git fetch origin master
  git reset --hard origin/master
else
  mkdir -p /opt/ikun-backup
  [ -d "$SITE/data" ] && cp -r "$SITE/data" /opt/ikun-backup/ 2>/dev/null && echo "✅ data 已备份 → /opt/ikun-backup/"
  [ -d "$SITE/downloads" ] && cp -r "$SITE/downloads" /opt/ikun-backup/ 2>/dev/null && echo "✅ downloads 已备份 → /opt/ikun-backup/"
  [ -d "$SITE" ] && mv "$SITE" "${SITE}.old.$(date +%s)" 2>/dev/null || true
  git clone "$REPO_URL" "$SITE"
  [ -d /opt/ikun-backup/data ] && cp -r /opt/ikun-backup/data "$SITE/" && echo "✅ data 已恢复"
  [ -d /opt/ikun-backup/downloads ] && cp -r /opt/ikun-backup/downloads "$SITE/" && echo "✅ downloads 已恢复"
fi
cd "$SITE"

# ---------- 2. 依赖安装与前端构建 ----------
echo "📦 正在安装依赖并编译前端..."
[ -f server/package.json ] && (cd server && npm install --production=false)
[ -f client/package.json ] && (cd client && npm install && npm run build)
echo "✅ 前端构建打包完成"

# ---------- 3. Linux 二进制（yt-dlp / ffmpeg）----------
mkdir -p resources/bin
BIN_DIR="$(pwd)/resources/bin"
if [ ! -x "$BIN_DIR/yt-dlp" ]; then
  echo "⏳ 下载 Linux yt-dlp 核心…"
  curl -sSL -o "$BIN_DIR/yt-dlp" https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
  chmod +x "$BIN_DIR/yt-dlp"
fi
if [ ! -x "$BIN_DIR/ffmpeg" ]; then
  echo "⏳ 下载 Linux ffmpeg 核心…"
  FF_VER=7.0.2
  FF_URL="https://www.johnvansickle.com/ffmpeg/old-releases/ffmpeg-${FF_VER}-amd64-static.tar.xz"
  curl -sSL -o /tmp/ff.tar.xz "$FF_URL"
  tar -xf /tmp/ff.tar.xz -C /tmp
  cp /tmp/ffmpeg-${FF_VER}-amd64-static/ffmpeg "$BIN_DIR/ffmpeg"
  cp /tmp/ffmpeg-${FF_VER}-amd64-static/ffprobe "$BIN_DIR/ffprobe" 2>/dev/null || true
  chmod +x "$BIN_DIR/ffmpeg" "$BIN_DIR/ffprobe"
  rm -rf /tmp/ff.tar.xz /tmp/ffmpeg-${FF_VER}-amd64-static
fi
"$BIN_DIR/yt-dlp" --version && "$BIN_DIR/ffmpeg" -version 2>&1 | head -1
echo "✅ Linux 二进制就绪: $BIN_DIR"

# ---------- 4. 写入生产环境变量 ----------
if [ -z "$ADMIN_TOKEN" ]; then
  ADMIN_TOKEN="ikun_$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)"
  echo "🎲 已生成 IKUN_ADMIN_TOKEN=$ADMIN_TOKEN"
fi
cat > /etc/ikun-web.env << ENVEOF
NODE_ENV=production
HOST=127.0.0.1
PORT=${PORT}
TRUST_PROXY=true
CORS_ORIGIN=https://${DOMAIN}
IKUN_ADMIN_TOKEN=${ADMIN_TOKEN}
RESOLVE_RATE_LIMIT=20
DOWNLOAD_RATE_LIMIT=10
AI_RATE_LIMIT=5
ASSET_RATE_LIMIT=60
ENVEOF
chmod 600 /etc/ikun-web.env
echo "✅ 环境变量已写入 /etc/ikun-web.env"

# ---------- 5. systemd 服务守护与启动 ----------
cat > /etc/systemd/system/ikun-web.service << SRVEOF
[Unit]
Description=iKun Web Downloader (Express + yt-dlp)
After=network.target

[Service]
Type=simple
WorkingDirectory=${SITE}/server
EnvironmentFile=/etc/ikun-web.env
ExecStart=$(command -v node) index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
SRVEOF

systemctl daemon-reload
systemctl enable ikun-web.service
systemctl restart ikun-web.service || { echo "❌ 服务启动失败，查看日志："; journalctl -u ikun-web -n 30 --no-pager; exit 1; }

# ---------- 6. 注册 2分钟自动检测同步 Cron ----------
cat > /opt/keepalive/ikun_sync.sh << 'SYNCEOF'
#!/bin/bash
LOG=/opt/keepalive/sync.log
SITE=/workspace/site
cd "$SITE" || exit 1
git fetch origin master 2>/dev/null
LOCAL=$(git rev-parse HEAD 2>/dev/null)
REMOTE=$(git rev-parse origin/master 2>/dev/null)
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "[$(date '+%F %T')] 检测到 GitHub 新提交: $LOCAL → $REMOTE，开始自动更新" >> "$LOG"
  git pull --ff-only origin master >> "$LOG" 2>&1
  cd "$SITE/server" && npm install --production=false >> "$LOG" 2>&1
  cd "$SITE/client" && npm run build >> "$LOG" 2>&1
  systemctl restart ikun-web.service
  echo "[$(date '+%F %T')] 自动更新完成，服务已重启" >> "$LOG"
fi
SYNCEOF
chmod +x /opt/keepalive/ikun_sync.sh
(crontab -l 2>/dev/null | grep -v "ikun_sync\|ikun_keepalive"; echo "*/2 * * * * /opt/keepalive/ikun_sync.sh") | crontab -

# ---------- 7. 验收测试 ----------
sleep 2
code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/api/health" || echo 000)
echo "本机 http://127.0.0.1:${PORT}/api/health → HTTP ${code}"
curl -s "http://127.0.0.1:${PORT}/api/health" && echo ""
[ "$code" != "200" ] && { echo "❌ 服务未通过健康检查"; exit 1; }

echo ""
echo "===================================================="
echo "🎉 恭喜！新版服务已成功部署上线！"
echo "   本地服务：http://127.0.0.1:${PORT}"
echo "   公网接入：https://${DOMAIN}"
echo "   自动更新：已开启（每 2 分钟自动同步 GitHub）"
echo "   管理令牌：${ADMIN_TOKEN}"
echo "===================================================="
