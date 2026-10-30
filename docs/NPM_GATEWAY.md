# 接入 NAS 统一网关（Nginx Proxy Manager）

目标：把耗材管家挂到 **`https://filament.dreamsearch.top`**，复用 NPM 的 `*.dreamsearch.top` 通配符证书，家里手机/电脑直接打开，不用记端口。

> 前提：NAS 上已有 NPM（管理口 `http://192.168.50.104:81`），且 `english.dreamsearch.top` 已在用同一套网关。
> 本文按「只用内网」写；要公网访问见文末 §7。

## 拓扑

```
手机/电脑
   │  HTTPS 443
   ▼
NPM（NAS 192.168.50.104:443，*.dreamsearch.top 证书）
   │  HTTP
   ▼
http://192.168.50.104:4174   ← 耗材管家容器发布端口
   │
   ▼
filament-manager 容器（数据在 ./data）

内网 DNS：filament.dreamsearch.top → 192.168.50.104
```

## 0. 前置检查

```bash
# NAS 上：容器在跑 + 端口通
sudo docker compose ps
curl -sS http://127.0.0.1:4174/api/health        # {"ok":true,"version":1}
curl -sS http://192.168.50.104:4174/api/health   # 从局域网 IP 也要通
grep '^FM_PORT' .env                             # 默认 4174，记下这个端口
```

## 1. 内网 DNS

和 `english.dreamsearch.top` 一样，只在**内网 DNS / hosts** 里加一条 A 记录：

| 名称 | 值 |
| --- | --- |
| `filament.dreamsearch.top` | `192.168.50.104`（NAS 局域网 IP） |

**不要加公网记录**（本文是内网方案；公网见 §7）。

验证：

```bash
getent hosts filament.dreamsearch.top    # → 192.168.50.104
```

## 2. NPM：新建 Proxy Host

NPM → **Hosts → Proxy Hosts → Add Proxy Host**，按下表填：

| 字段 | 值 |
| --- | --- |
| Domain Names | `filament.dreamsearch.top` |
| Scheme | `http` |
| Forward Hostname / IP | `192.168.50.104`（NAS 局域网 IP，**不要写 `127.0.0.1`**） |
| Forward Port | `4174`（与 `.env` 的 `FM_PORT` 一致） |
| Cache Assets | 可关 |
| Block Common Exploits | ✅ 开 |
| Websockets Support | ✅ 开（当前用轮询，留着以后） |
| Access List | 无（内网）；要公网再加 |

> 为什么不能写 `127.0.0.1`：NPM 是桥接容器，它自己的 `127.0.0.1` 不是 NAS 宿主，连不到发布在宿主上的 4174。这是 [多域名网关手册](../../english-coach/local/multi-domain-gateway.md) §5.2 记录过的坑。

## 3. SSL

同一页 **SSL** 选项卡：

| 项 | 值 |
| --- | --- |
| SSL Certificate | 选现有的 `*.dreamsearch.top`（SAN 已覆盖 `filament` 子域） |
| Force SSL | ✅ |
| HTTP/2 Support | ✅ |
| HSTS Enabled | 跟随现有策略（english 开了就一起开，别单独改） |

**不需要为 `filament` 单独签证书。**

## 4. Advanced：上传大小与超时（重要）

同一页 **Advanced** 粘贴：

```nginx
client_max_body_size 128m;
proxy_read_timeout 300s;
proxy_send_timeout 300s;
```

原因：

- 拍照/相册上传是 base64 JSON，几 MB 起步；NPM/Nginx 默认 1m 会直接 **413**；
- 3mf 上传最大 48MB；
- 视觉识别接口可能跑 60s 以上，默认 60s 代理会 **504**。

## 5. 验收

```bash
# 内网 DNS
getent hosts filament.dreamsearch.top

# HTTPS + 证书（应 200，server: openresty，且没有 cf-ray）
curl -sSI https://filament.dreamsearch.top/ | head -12
curl -sS  https://filament.dreamsearch.top/api/health

# 上传链路（可选）：随便传一张照片/3mf，确认不 413、不 504
```

浏览器打开 `https://filament.dreamsearch.top`：

- 能正常加载库存（首次是示例料盘，删掉即可）；
- 手机「添加到主屏幕」可当 PWA；
- 手机拍照/相册、点图取色都可用（HTTPS 是安全上下文）；
- 上传一张整箱照片 → 识别/核对 → 入库。

## 6. 常见问题

| 现象 | 原因 / 修法 |
| --- | --- |
| **502 Bad Gateway** | NPM 转发目标写成 `127.0.0.1` 或端口不对。改成 `192.168.50.104:4174`；确认容器 `running`、`curl http://192.168.50.104:4174/api/health` 通 |
| **413 Request Entity Too Large** | §4 的 `client_max_body_size` 没加/没保存 |
| **504 / 识别一直转圈** | §4 的 `proxy_read_timeout 300s` 没加；或 NAS 上没配识别引擎 |
| **401 / 顶部提示「需要访问令牌」** | `.env` 里 `FM_TOKEN` 非空。家庭内网可改成 `FM_TOKEN=` 后 `docker compose up -d`；或网页 ⚙ 设置里填同一个值 |
| **证书名不匹配** | 证书选的不是 `*.dreamsearch.top`，或证书 SAN 不含该子域 |
| **页面能开但接口失败** | 打开 F12 Console/Network 看是 4xx/5xx；按上面 401/502 排查 |
| **手机按「拍照」只进相机** | 正常；选相册请点「🖼️ 从相册添加」（或弹窗里的「🖼️ 相册」） |

## 7. 公网访问（可选，默认不建议）

耗材管家有家庭照片和识别 API Key，**默认只内网**。如果确实要外网访问：

1. 在 Cloudflare 给 `filament.dreamsearch.top` 加一条 **proxied（橙云）A 记录**指向家里公网 IP（或走 Cloudflare Tunnel，把 Public Hostname 指到 `http://192.168.50.104:4174`）；
2. 路由器转发 443 到 NPM（只开 443，别开 4174）；
3. **必须设置 `FM_TOKEN`**（32 位以上随机串），网页 ⚙ 设置/客户端填同一个值；
4. 建议再加 Cloudflare Access（邮箱策略）或 NPM Access List；
5. 注意 Cloudflare 上传限制（免费版 100MB），本项目 3mf 上限 48MB，够用。

## 8. 维护

- 升级耗材管家：`git pull && sudo docker compose up -d --build`，NPM 配置不用动；
- 改 `FM_PORT` 时同步改 NPM 的 Forward Port；
- 备份：`data/`（库存/照片/设置）+ NPM 自己的 data 目录。
