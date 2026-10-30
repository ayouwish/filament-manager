# 部署到 NAS（Docker Compose，推荐）

目标：把「耗材管家」后端跑在家里 NAS 上，手机浏览器 / 鸿蒙客户端 / 电脑都访问同一个地址，数据（库存、照片、打印记录）留在 NAS 上。

- 镜像基于 `node:22-alpine`，**无 npm 依赖**，构建只需要能拉取 `node:22-alpine` 和 alpine 的 `python3/py3-pillow`（用于商品图主色校验，可选；装不上会自动跳过，不影响构建）。
- 数据全部在 `data/` 目录（`db.json` + `photos/`），用卷挂到 NAS 上；升级/重建容器不会丢数据。
- 支持 x86_64 与 ARM64（群晖/威联通常见架构都可以）。

---

## 0. 部署前准备

| 项 | 说明 |
| --- | --- |
| NAS | 群晖 DSM 7.2+ / 威联通 QTS 5+ / Unraid / TrueNAS / 任意 Linux |
| Docker | 群晖「Container Manager」、威联通「Container Station」，或 SSH 里的 `docker compose` |
| 目录 | 建议 `/volume1/docker/filament`（群晖）或 `/share/Container/filament`（威联通），**放在会被备份的卷上** |
| 网络 | NAS 需要能访问外网（MakerWorld 解析、商品图、云端识别）；纯内网也能用，但请关掉商品图抓取 |
| 端口 | 默认 `4174`，被占用就改 `.env` 里的 `FM_PORT` |

---

## 1. 把项目放到 NAS

任选一种：

**A. 直接上传（最简单）**：把 `filament-manager` 整个目录（不含 `node_modules`，本来也没有）通过 File Station / SMB 传到 NAS 的 `/volume1/docker/filament`。

**B. 从 Git 拉取**：SSH 登录 NAS 后 `git clone <你的仓库> filament`。

**C. 只传必要文件**（不想传全部代码时）：

```
filament-manager/
├── Dockerfile
├── docker-compose.yml
├── .env                # 从 .env.example 复制
├── package.json
├── server.mjs
├── lib/
├── web/
└── data/catalog/       # 色卡（镜像里也有一份，可省）
```

> `data/` 目录第一次启动会自动创建并写入 6 盘示例耗材；确认没问题后在界面上删掉即可。

---

## 2. 写 `.env`（令牌可选）

```bash
cp .env.example .env
vi .env
```

家庭局域网自用，最小配置：

```ini
FM_PORT=4174
TZ=Asia/Shanghai
FM_TOKEN=
```

> **`FM_TOKEN` 留空 = 不鉴权**，同一 Wi-Fi 下打开网页即可用，不需要在网页/客户端填任何令牌。适合完全可信的家庭网络。
>
> 如果以后要暴露到公网或访客网络，再设置令牌：
>
> ```bash
> openssl rand -hex 24        # Windows PowerShell:
> # -join ((48..57)+(97..122) | Get-Random -Count 32 | % {[char]$_})
> ```
>
> 写入 `FM_TOKEN=随机串`，并到网页 ⚙ 设置 →「访问令牌」填同一个值（只存浏览器 localStorage）、鸿蒙客户端设置里也填。设置后除 `/api/health` 外所有接口都需要 `x-fm-token`。

---

## 3. 启动

### 群晖（Container Manager）

1. 套件中心安装 **Container Manager**。
2. `项目` → `新增` → 选择存放目录（含 `docker-compose.yml` 的 `filament-manager` 目录）→ 项目名 `filament-manager`。
3. 来源选「使用现有的 docker-compose.yml」，它会自动构建镜像并启动。
4. 完成后在「容器」里能看到 `filament-manager` 状态为运行中。

### 威联通（Container Station）

1. 安装 **Container Station** → `应用程序` → `创建`。
2. 粘贴 `docker-compose.yml` 内容（或选择该文件），设置项目路径与 `.env`，创建并启动。

### 任意 Linux / Unraid / TrueNAS（SSH）

```bash
cd /volume1/docker/filament        # 你的项目目录
cp .env.example .env && vi .env    # 填 FM_TOKEN
sudo docker compose up -d --build
```

首次构建会拉取基础镜像并安装 python3/py3-pil，视网络 1~5 分钟。

---

## 4. 验证

```bash
# 健康检查（不需要令牌）
curl http://127.0.0.1:4174/api/health
# → {"ok":true,"version":1}

# 如果设置了令牌，再验证一次
curl -H "x-fm-token: 你的令牌" http://127.0.0.1:4174/api/state

# 容器日志 / 状态
sudo docker logs -f filament-manager
sudo docker compose ps
```

然后：

- 电脑浏览器打开 `http://<NAS 局域网 IP>:4174`；
- 手机连同一 Wi-Fi 打开同一地址，建议「添加到主屏幕」；
- ⚙ 设置 →「📱 手机拍照录入」会显示/复制当前局域网地址；
- 鸿蒙客户端「设置」填 `http://<NAS IP>:4174` + 同一个 `FM_TOKEN` → 「保存并测试连接」。

---

## 5. 首次配置建议

1. **删除 6 盘示例耗材**（界面上删，或直接在 `data/db.json` 里清空后重启）。
2. **配置识别引擎**（⚙ 设置 → 图片识别）：
   - 本地 Ollama：NAS 上跑 Ollama 容器并 `ollama pull qwen2.5vl:3b`，识别服务选「自动检测本地 Ollama」（NAS 性能弱时识别较慢，建议用云端接口）；
   - 云端 OpenAI 兼容接口：填接口地址（`https://…/v1`）、模型名、API Key（只存 NAS 的 `data/db.json`）。
3. **商品图**：NAS 能上外网时保持开启；入库后会自动在后台抓取，进度显示在材料库工具栏。
4. **MakerWorld 链接**：服务器端可能被 Cloudflare 拦，最稳的是在模型页「下载打印配置」后上传 `.3mf`；也可用油猴脚本从浏览器页面导入。

---

## 6. 手机/外网访问：HTTPS 反向代理

局域网用 `http://NAS-IP:4174` 就够了。要在外面访问或想让浏览器 PWA/相机更稳定，建议加 HTTPS：

**群晖**：控制面板 → 登录门户 → 高级 → 反向代理 → 新增：

| 项 | 值 |
| --- | --- |
| 来源 | HTTPS，主机名 `filament.你的域名`，端口 443 |
| 目的地 | HTTP，主机名 `localhost`，端口 `4174` |

再在「安全性 → 证书」申请 Let's Encrypt 证书。**注意**：上传 3mf 的请求体可达几十 MB，若用 Nginx 自定义反代，需要设置 `client_max_body_size 128m;` 与 `proxy_read_timeout 300s;`。

反代后：客户端地址填 `https://filament.你的域名`，鸿蒙客户端的明文 HTTP 配置就不再需要（可删掉 `module.json5` 里那条 network security metadata）。

---

## 7. 备份与恢复

需要备份的只有 **`data/`** 目录：

```bash
# 停容器后打包（保证 db.json 一致）
sudo docker compose stop
sudo tar czf filament-backup-$(date +%F).tar.gz data/
sudo docker compose start
```

- 群晖可用 **Hyper Backup** 备份 `/volume1/docker/filament/data`；威联通用 HBS。
- 恢复：把 `data/` 放回原处，`docker compose up -d` 即可。
- 照片在 `data/photos/`；`data/db.json` 是全部库存/记录/设置（含识别 API Key，注意保管）。

---

## 8. 升级

```bash
cd /volume1/docker/filament
# 用新代码覆盖（git pull 或重新上传），然后：
sudo docker compose up -d --build
```

- 数据卷不动，升级后库存/照片都在。
- 升级后浏览器 **Ctrl+F5** 强刷一次（前端资源带版本号，避免用到旧 JS）。
- 想回滚：换回旧代码重新 `--build` 即可，数据结构向后兼容。

---

## 9. 安全清单

- [ ] 家庭局域网自用：可以不设 `FM_TOKEN`；若开放到外网，必须设置 32 位以上随机串。
- [ ] 没有把 4174 端口直接映射到公网；外网只走 HTTPS 反代（必要时再加一层 Basic Auth / 群晖账号认证）。
- [ ] `.env` 不提交到 git，不截图外发。
- [ ] 定期备份 `data/`。
- [ ] 云端识别会把照片发给对应服务商；在意隐私就用本地 Ollama，或不用识别只用拍照/取色。

---

## 10. 排错

| 现象 | 处理 |
| --- | --- |
| 页面打不开 / 请求没响应 | 1) `docker compose ps -a` 看状态是 running / created / exited；2) `docker logs --tail 100 filament-manager`；3) `docker port filament-manager` 看实际映射端口；4) 在 NAS 上 `curl -v http://127.0.0.1:4174/api/health`；5) 本机能通、手机/电脑不通 → NAS 防火墙放行端口、确认同一 Wi-Fi、用 NAS 局域网 IP 而不是容器日志里的 172.x 地址 |
| `docker compose up -d` 一直不返回 / 停在 Created | 正常最后一行是 `Container filament-manager Started`。Ctrl+C 后执行 `docker compose up -d --wait --wait-timeout 60`，再用 `docker compose ps` 确认；若 created/exited 则看 `docker logs` |
| 容器日志里显示 `耗材管家已启动：http://127.0.0.1:4174` | 说明应用本身正常，问题在端口/网络：用 `docker port` 确认映射，再从 NAS 本机和局域网分别测试 |
| 打开后接口 401 / 顶部提示「需要访问令牌」 | `.env` 里 `FM_TOKEN` 非空（可能是旧模板占位符）。家庭自用：`sed -i 's/^FM_TOKEN=.*/FM_TOKEN=/' .env && sudo docker compose up -d`；或到网页 ⚙ 设置 →「访问令牌」填同一个值 |
| 数据没保存 / 写入失败 | 挂载目录权限：`sudo chown -R 1026:100 data`（群晖 Docker 用户），或确认共享文件夹允许写入 |
| 商品图一直失败 | NAS 无外网或被限流：`AUTO_PRODUCT_IMAGES=off` / `PRODUCT_IMAGES=off`；也可单盘「换图」重试 |
| 商品图抓到了无关图 | 已内置相关性+主色校验；仍不对时点「换图」，或 `PRODUCT_IMAGE_COLOR_CHECK=off` 反而更差，不建议关 |
| 识别失败 | ⚙ 设置 →「测试识别服务」看原因；NAS 上没 Ollama 就配云端接口 |
| 上传 3mf 失败 | 反代请求体上限太小（`client_max_body_size`），或文件 >48MB |
| 时间不对 | `.env` 里 `TZ=Asia/Shanghai` 后重建容器 |
| 架构不支持 | `docker build` 在 ARM NAS 上会自动拉 arm64 基础镜像；若报错确认 Docker 版本 ≥ 20.10 |

常用命令：

```bash
sudo docker compose logs -f          # 看日志
sudo docker compose restart          # 重启
sudo docker compose down             # 停止并删除容器（数据保留）
sudo docker compose up -d --build    # 重新构建并启动
```

---

## 11. NAS 拉不动镜像时：在电脑上构建再导入

国内 NAS 有时连不上 Docker Hub。可以在装了 Docker 的电脑上构建，然后把镜像文件拷到 NAS：

```bash
# ① 电脑上（Windows/macOS/Linux 均可，需 Docker Desktop 或 docker）
cd filament-manager
docker build -t filament-manager:latest .
docker save filament-manager:latest | gzip > filament-manager-image.tar.gz   # 约 100~200MB

# ② 把 filament-manager-image.tar.gz 传到 NAS（File Station / SMB / scp）

# ③ NAS 上导入并启动
gunzip -c filament-manager-image.tar.gz | sudo docker load
cd /volume1/docker/filament
# 把 docker-compose.yml 里的 `build: .` 一行注释掉（用已导入的 image）
sudo docker compose up -d
```

> 构建时 `apk add python3 py3-pillow` 需要能上外网；如果网络/镜像源不可用，可直接把 Dockerfile 里那行注释掉（商品图主色校验会自动跳过，功能仍可用）。

---

## 12. 数据：迁移现有库存 or 从零开始

- **从零开始**：NAS 上的 `data/` 保持空目录即可，首次启动自动写入 6 盘示例耗材，界面里删掉即可。
- **迁移你电脑上已有的库存**：把开发机 `filament-manager/data/` 下的 `db.json` 和 `photos/` 整个拷到 NAS 的 `data/` 目录（`catalog/` 可不用带，镜像里有兜底色卡），然后 `docker compose restart`。

```bash
# 示例：从电脑同步到群晖
scp -r data/db.json data/photos admin@192.168.1.10:/volume1/docker/filament/data/
```

迁移后建议在界面里点一次「🧩 合并同款」整理重复记录，并用「🖼️ 自动找商品图」补齐缺失图片。

---

## 13. 接入 NAS 统一网关（Nginx Proxy Manager，推荐）

如果 NAS 上已经有 NPM（比如 `english.dreamsearch.top` 已经在用），建议给耗材管家也挂一个域名，
而不是直接访问 `http://NAS-IP:4174`：

- 内网 DNS：`filament.dreamsearch.top` → `192.168.50.104`（NAS 局域网 IP，仅内网）；
- NPM Proxy Host：`http://192.168.50.104:4174`，SSL 复用 `*.dreamsearch.top`；
- Advanced：`client_max_body_size 128m; proxy_read_timeout 300s; proxy_send_timeout 300s;`
- 最终访问：`https://filament.dreamsearch.top`

完整字段、验收命令和排错见 **[NPM_GATEWAY.md](NPM_GATEWAY.md)**。

> 注意：NPM 是桥接容器，转发目标要写 NAS 的**局域网 IP**，不要写 `127.0.0.1`（会 502）。
