# iKun 可分享网页端

基于桌面版能力拆出的 **电脑 / 手机自适应** Web 版，支持 **一个链接 + 访问密码** 分享给朋友使用。

- 前端：Vue 3 + Pinia + Vite（响应式布局）
- 后端：Express + 本地 `yt-dlp` / FFmpeg（复用项目 `resources/bin`）
- 分享：单端口托管 API + 前端、访问密码、按设备隔离任务

> 说明：浏览器本身不能运行 yt-dlp，因此网页端必须在你的电脑（或服务器）上启动服务。解析与下载由服务端完成；单文件直链不落服务器磁盘，其余动作（合并 / 音频 / HLS / 图片集）产物按任务目录落到主机 `web/downloads/<jobId>`，再通过浏览器「下载到本机」。

## 目录

```text
web/
├─ client/      # 网页前端
├─ server/      # API + 静态资源托管
├─ downloads/   # 下载输出目录（自动创建）
└─ data/        # share-config.json 等（自动创建）
```

## 推荐：一键分享模式（单端口）

适合把链接发给同一 Wi-Fi 下的朋友。

### 1. 安装依赖（首次）

```powershell
npm run web:install
```

### 2. 构建并启动

```powershell
npm run web:share
```

或分步：

```powershell
npm run web:build
npm run web:start
```

终端会打印类似信息：

```text
本机访问:  http://127.0.0.1:8787
局域网:    http://192.168.x.x:8787
访问密码:  ab12cd34
```

### 3. 分享给朋友

1. 把 **局域网地址** + **访问密码** 发给同一 Wi-Fi 的朋友
2. 朋友用手机/电脑浏览器打开链接
3. 输入密码后即可解析下载
4. 各自任务按设备隔离，互不影响

### 自定义密码 / 端口

```powershell
# Windows PowerShell
$env:IKUN_WEB_PASSWORD="你的密码"
$env:PORT="8787"
npm run web:start
```

也可直接编辑 `web/data/share-config.json` 里的 `password` 字段。

## 开发模式（双进程热更新）

```powershell
# 终端 1
npm run web:server

# 终端 2
npm run web:client
```

- 前端：`http://127.0.0.1:5173`（Vite 代理 `/api`）
- API：`http://127.0.0.1:8787`

## 功能

- 访问密码登录（Bearer Token，约 7 天有效）
- 解析下载（v2）：解析返回媒体动作列表——直链 / 合并 / 仅音频 / HLS / 图片集，一键选择
- 直链优先：单文件直链不落服务器磁盘（302 跳转或流式代理），合并 / 音频 / HLS / 图片集走任务队列
- 下载队列：任务状态机（RESOLVING → DOWNLOADING → PROCESSING → COMPLETED / FAILED），失败自动进入 RETRY_WAIT 并按最大重试次数自动重试；可手动取消 / 重试
- 批量导入：文本识别多链接，逐个解析并入队
- 历史记录（按设备隔离）
- 分享页：复制链接 / 系统分享
- 设置：并发、分片并发、最大重试次数、直链优先开关、代理、Cookies 路径、请求头、字幕/元数据/缩略图、Redfox 去水印 API Key
- 命理工具：导航栏「命理」页内嵌算了么（suanle-me）静态产物（`/suanle/`），紫微/八字/梅花易数等本地计算

## 命理工具（suanle-me 集成）

源码在 `../suanle-me`（独立仓库，`output: export` + `basePath: /suanle`）。更新集成版：

```powershell
npm --prefix ../suanle-me install
npm --prefix ../suanle-me run build
Copy-Item -LiteralPath ../suanle-me/out -Destination ./suanle -Recurse -Force
```

`web/suanle/` 为构建产物（已 gitignore），Express 在 SPA 兜底前挂载 `/suanle`。

## 解析与下载（v2 架构）

- 解析（`POST /api/v2/resolutions`）返回标题、缩略图、媒体资产与**媒体动作**列表：直链（direct）/ 合并（merge）/ 仅音频（extract-audio）/ HLS / 图片集（images-zip）
- 直链动作不落服务器磁盘：单文件以 302 跳转或流式代理交付
- 合并 / 音频 / HLS / 图片集动作进入任务队列（`POST /api/v2/downloads`），产物保存在 `web/downloads/<jobId>/`，资产地址 24 小时内有效（`/api/v2/assets/:id/content`）
- 任务状态：`RESOLVING → QUEUED → DOWNLOADING → PROCESSING → COMPLETED`；失败自动转 `RETRY_WAIT` 按最大重试次数自动重试，超限置为 `FAILED`，可手动重试

## 浏览器捕获上报（可选）

`POST /api/v2/capture/report` 用于扩展浏览器扩展 / 采集端上报解析结果。需配置环境变量 `IKUN_CAPTURE_SECRET`，且请求头携带 `X-Capture-Secret` 匹配；**未配置则上报端点禁用**（返回 401）。

## 自动清理

网页端默认开启自动清理（小硬盘服务器推荐）：

- 默认保留 **24 小时**
- 每 **30 分钟** 扫描一次 `web/downloads/`，删除超过保留时长的任务目录（含旧版散落文件），并同步清理 `web/data/jobs.json` 中超过保留时长的已结束任务记录
- 可在「设置 → 自动清理」修改保留时长

也可通过环境变量/设置接口调整：`autoCleanupEnabled`、`retentionHours`。

## Cloudflare（小黄云）绑定域名

推荐用 **Cloudflare Tunnel**，不用在防火墙开 8787，还能免费 HTTPS。

1. 域名 NS 指到 Cloudflare
2. Zero Trust → Networks → Tunnels → Create a tunnel（cloudflared）
3. Public Hostname：
   - Subdomain：如 `dl`
   - Domain：你的域名
   - Service：`http://127.0.0.1:8787`
4. 复制安装 token，在服务器执行：

```bash
export CF_TUNNEL_TOKEN='你的token'
bash /opt/ikun-web/scripts/setup-cloudflare-tunnel.sh
# 或把仓库 scripts/setup-cloudflare-tunnel.sh 拷到服务器后执行
```

完成后访问：`https://dl.你的域名`，再输入网页访问密码。

> 注意：Tunnel 只负责域名/HTTPS；下载仍走服务器磁盘与带宽。

## 注意

1. 需先准备好 `resources/bin/yt-dlp.exe` 与 `ffmpeg.exe`（可用根目录 `npm run fetch:ytdlp`）。
2. 部分站点（如抖音）需要 Cookies，请在设置中填写服务器可访问的 `cookies.txt` 路径。
3. 合并 / 音频等需落盘的产物先存到主机 `web/downloads/<jobId>`，再通过「下载到本机」传到浏览器所在设备；单文件直链不占用服务器磁盘。
4. 分享模式依赖主机保持开机联网；关掉服务后朋友无法访问。
