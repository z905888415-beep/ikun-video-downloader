# iKun 公网下载站

基于 Vue 3、Express、yt-dlp 和 FFmpeg 的公网视频下载站。用户打开正式域名即可使用，无登录页、无局域网分享逻辑，也不依赖 Redfox 或浏览器捕获；解析、下载和处理统一在服务端通过 yt-dlp 完成。

- 前端：Vue 3 + Pinia + Vite
- 服务端：Express + 本地 `yt-dlp` / FFmpeg
- 下载能力：直链、视频音频合并、仅音频、HLS、图片集
- 运行保护：按 IP 限流、匿名任务控制令牌、自动过期清理、容量上限保护

> 浏览器无法直接运行 yt-dlp。网页只发起请求；解析、下载与转码都在服务器进行。合并、音频、HLS、图片集等产物会写入 `web/downloads/<jobId>/`，再由浏览器下载。

## 目录

```text
web/
├─ client/       # Vue 前端
├─ server/       # Express API 与静态托管
├─ data/         # settings.json、jobs.json（自动创建）
└─ downloads/    # 服务端下载产物（自动创建）
```

## 本地开发与构建

首次安装依赖：

```bash
npm run web:install
```

开发模式使用两个终端：

```bash
# 终端 1：API
npm run web:server

# 终端 2：前端热更新
npm run web:client
```

生产构建与启动：

```bash
npm run web:build
npm run web:start
```

默认 API 监听 `0.0.0.0:8787`。构建成功后，Express 会托管 `web/client/dist/`。

## 功能与运行模型

- **yt-dlp 单通道解析**：Redfox 和浏览器捕获已从 Web 运行链路移除。
- **解析与交付**：`POST /api/v2/resolutions` 返回媒体动作；直链可直接交付，合并、音频、HLS、图片集进入任务队列。
- **匿名任务隔离**：创建任务时服务端签发随机控制令牌，浏览器仅保存自己的令牌；其他匿名用户看不到、取消不了、重试不了、下载不了该任务。没有账户体系，也不需要登录。
- **任务状态**：`RESOLVING → QUEUED → DOWNLOADING → PROCESSING → COMPLETED`。失败任务会进入 `RETRY_WAIT`，可由原浏览器重试。
- **自动清理**：默认保留 24 小时；服务启动时与之后每 30 分钟清理过期任务和文件。
- **容量保护**：下载目录超过上限时，自动优先清理最旧且非运行中的任务目录，直至回落至容量上限的 90%。
- **AI 抠图与生图**：工具箱内独立模块，受公网限流保护。

## 公网部署（宝塔 / Nginx）

推荐结构：Nginx/宝塔负责 HTTPS 与域名，Node 服务只监听本机端口，Nginx 反向代理到 `127.0.0.1:8787`。

### 1. 准备运行环境

服务器需准备：

- Node.js 22 或更高版本
- `resources/bin/yt-dlp.exe` 与 `resources/bin/ffmpeg.exe`（Linux 服务器需替换为可执行的 Linux 二进制，并在 `compose.js` 中按平台确认路径）
- 已构建的前端：`npm run web:build`
- 进程守护：宝塔 Node 项目管理器、PM2 或 systemd 三选一

### 2. 生产环境变量

在 Node 项目管理器、PM2 配置或 systemd 中设置：

```bash
NODE_ENV=production
HOST=127.0.0.1
PORT=8787
TRUST_PROXY=true
CORS_ORIGIN=https://下载站.你的域名
IKUN_ADMIN_TOKEN=请换成一条足够长的随机字符串
```

说明：

- `TRUST_PROXY=true`：使限流使用 Nginx 转发的真实客户端 IP；仅在服务只允许可信反向代理访问时启用。
- `CORS_ORIGIN`：正式域名白名单。多个域名用英文逗号分隔，例如 `https://a.example.com,https://b.example.com`。
- `IKUN_ADMIN_TOKEN`：仅服务器管理员使用。网页公开访客不能读取或改写 Cookie、代理、请求头等敏感下载配置。
- 如果未设置 `IKUN_ADMIN_TOKEN`，`PUT /api/settings` 会被关闭；仍可直接编辑服务器上的 `web/data/settings.json` 后重启服务。

### 3. Nginx 反向代理示例

将 `下载站.你的域名` 替换为实际域名：

```nginx
server {
    listen 80;
    server_name 下载站.你的域名;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name 下载站.你的域名;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    client_max_body_size 16m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/v2/downloads/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

宝塔中可在「网站 → 目标站点 → 反向代理」中填入 `http://127.0.0.1:8787`，并在配置文件补充以上转发头、上传限制和下载超时配置。

### 4. 启动与检查

```bash
npm run web:build
npm run web:start
```

检查：

```bash
curl http://127.0.0.1:8787/api/health
curl -I https://下载站.你的域名/
```

健康检查应返回：

```json
{"ok":true,"name":"iKun Web","version":"0.3.1","public":true}
```

## 公网防护与限流

内置按 IP 的内存限流，默认阈值：

| 请求类型 | 默认限制 | 环境变量 |
| --- | ---: | --- |
| 链接解析 | 20 次/分钟 | `RESOLVE_RATE_LIMIT` |
| 创建下载任务 | 10 次/分钟 | `DOWNLOAD_RATE_LIMIT` |
| AI 抠图 | 5 次/分钟 | `AI_RATE_LIMIT` |
| 媒体内容/代理 | 60 次/分钟 | `ASSET_RATE_LIMIT` |

超限返回 HTTP `429`，并含 `Retry-After` 与 `RateLimit-*` 响应头。当前限流存储在服务进程内存中；若横向扩容为多个 Node 实例，请改为 Redis 等共享限流存储。

不要把 Node 的 `8787` 端口直接暴露到公网。防火墙只开放 Nginx 的 80/443，并让 Node 绑定 `127.0.0.1`。

## yt-dlp 维护建议

部分平台会频繁调整反爬策略，建议定期更新 yt-dlp，并只在服务器端维护以下敏感设置：

- `cookiesFile`：Netscape 格式 Cookie 文件的服务器绝对路径
- `proxy`：必要时使用的代理地址
- `customHeaders`：每行一个 `Header: value`
- `retries`、`fragmentConcurrency`：网络重试与分片并发

这些字段会传给 yt-dlp 的 `--cookies`、`--proxy`、`--add-header`、`--retries`、`--fragment-retries` 与 `--concurrent-fragments` 参数。Cookie、代理和管理员令牌均不得写入前端代码、仓库或公开截图。

## 注意事项

1. 请仅处理你拥有权利下载、保存或再利用的内容，并遵守目标平台规则与适用法律。
2. 任务控制令牌保存在访问者浏览器本地存储中。清理浏览器站点数据或换设备后，旧任务不再可见；这是无登录模式下的隐私保护取舍。
3. 下载产物会按保留时长和容量策略自动清理，请及时保存。
4. 真实平台解析可能需要更新 yt-dlp、更新 Cookie 或调整网络配置；单元测试通过不代表每个平台都无需 Cookie。
