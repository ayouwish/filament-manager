# 耗材管家（Filament Manager）

[![CI](https://github.com/ayouwish/filament-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/ayouwish/filament-manager/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

管理家里 3D 打印耗材的小工具：**拍照/图片识别录入料盘** → **粘贴 MakerWorld 链接** → 自动从库存里挑选颜色/材料类型/余量最合适的料盘 → 扣减余量、留存打印记录。

- 零依赖：Node 18+ 直接跑，不需要数据库、不需要前端构建。
- 本地优先：照片、库存、记录都在自己电脑/NAS 上；可选访问令牌，适合部署到 NAS。
- 附带 **HarmonyOS 客户端**（`harmony-client/`，API 23+）做手机拍照入库。

```bash
git clone https://github.com/ayouwish/filament-manager.git
cd filament-manager
npm start                # 或 node server.mjs
# 打开 http://127.0.0.1:4173
```

手机拍照录入（同一 Wi-Fi）：

```bash
node server.mjs --lan    # 监听 0.0.0.0，启动时会打印本机所有局域网访问地址
node server.mjs --lan --port 4174   # 4173 被占用时换端口
```

部署到 NAS（Docker Compose，推荐）：

```bash
cd filament-manager
cp .env.example .env      # 家庭局域网可留空；需要鉴权再填 FM_TOKEN
sudo docker compose up -d --build
# 打开 http://<NAS 局域网 IP>:4174
```

- 数据在 `./data`（`db.json` + 照片），升级重建容器不丢数据；
- 完整步骤（群晖 Container Manager / 威联通 Container Station / 通用 Linux、HTTPS 反代、备份、升级、排错）见 **[docs/DEPLOY_NAS.md](docs/DEPLOY_NAS.md)**；
- 想挂到 NAS 统一网关/域名（NPM + 通配符证书，如 `https://filament.dreamsearch.top`）见 **[docs/NPM_GATEWAY.md](docs/NPM_GATEWAY.md)**；
- 不用 Docker 也可以：NAS 上装 Node 18+ 后 `FM_TOKEN=xxx node server.mjs --lan`（配合 systemd/pm2/任务计划守护）。

> 镜像监听 `0.0.0.0`，映射端口后局域网可访问。家庭内网自用可以不设 `FM_TOKEN`（任何 Wi-Fi 设备都能读写，确认网络可信即可）；要开鉴权时在 `.env` 填随机串，再到网页 ⚙ 设置 →「访问令牌」填同一个值（只存浏览器本地）。本机直接 `node server.mjs` 默认只监听 `127.0.0.1`，更安全。

---

## 快速上手（3 分钟）

1. **录耗材**：点「＋ 拍照添加耗材」→ 拍照/选图 → 有识别引擎就自动识别（没有就手动填）→ 核对条目（颜色/品牌/材料/SKU/克重/数量都可改）→「加入材料库」。点照片可放大、在放大图上点一下即可取色。
   - 一张整箱照片里**同款多盒默认合并成一条**（显示 ×N、总重按合计），需要分别记录每盘时勾选「同款多盒拆成多盘」。
2. **选料**：切到「智能选料」→ 粘贴 `https://makerworld.com/zh/models/…` 链接 → 点「解析链接」。
   - 若被 Cloudflare 拦截（常见），点「上传打印配置 .3mf」：在 MakerWorld 模型页点「下载打印配置」，把 .3mf 拖进来，克重最精确。
   - 想省事可以先点「试用示例模型」看整套流程。
3. **确认**：核对每项颜色/类型/余量，必要时用下拉框手动指定料盘 → 点「确认并扣减余量」。
4. **记录**：在「打印记录」里查看每次打印用了哪些料、多少克。

> 首次启动会自动写入 6 盘示例耗材（黑/白/红 PLA、宝蓝/透明 PETG 等），数据在 `data/db.json`，可在界面上删除。

### 30 秒演示（不用准备任何材料；也适用于你自己拍的照片）

1. 打开「智能选料」→ 点「试用示例模型」。
2. 预期：黑色 / 红色 PLA「匹配成功」；白色 PLA「余量不足，还差约 80 g」；琥珀 PETG「颜色差异大」。
3. 上传 `data/examples/sample-multicolor.3mf`：显示 2 个平台、3 项合并需求，克重精确到 0.1 g。
4. 材料库 →「＋ 拍照添加耗材」→ 选 `test/fixtures/panchroma-boxes.jpg` → 10 盒 Panchroma 会变成 10 条可编辑记录；点图片放大核对标签/SKU。
5. 点「确认并扣减余量」→ 到「打印记录」能看到这次打印，库存同步减少。

---

## 手机拍照录入

前提：手机和电脑连**同一个 Wi-Fi**，服务用 `--lan` 启动（只监听 127.0.0.1 时手机连不上）。

1. 电脑上启动：`node server.mjs --lan`（或 `--lan --port 4175`）。启动日志会打印局域网地址，如 `http://192.168.1.23:4174`。
2. 手机浏览器（iOS Safari / Android Chrome）打开该地址；也可以 ⚙ 设置 →「📱 手机拍照录入」查看/复制地址。
3. 建议「添加到主屏幕」（已内置 manifest 和图标），之后像 App 一样点开。
4. 添加耗材有三种入口：
   - 「＋ 拍照添加耗材」→ 直接调系统相机；
   - 「🖼️ 从相册添加」→ 直接从相册选已有照片；
   - 也可以先打开添加弹窗，再点里面的「📷 拍照」/「🖼️ 相册」。
   - 照片自动压缩并上传到电脑；配置了识别引擎就自动识别，否则手动填；
   - 支持整箱多盘；点图片可放大核对标签，在放大图上点一下即可取色。
5. 核对条目 →「加入材料库」。照片存在电脑 `data/photos/`。

**排错：**
- 手机打不开：确认同一 Wi-Fi、电脑防火墙放行端口、用日志里的 IP（不要用 `127.0.0.1`）。
- 跑在 Docker / WSL / 云容器里：Docker 用 `-p 4174:4174`；WSL2 需在 Windows 做端口转发；容器打印的 `172.x` 地址手机通常连不上，要用宿主机局域网 IP。
- 相机不弹出：改用「选图」；或检查浏览器相机权限。
- 云端识别会把照片发给所配置的视觉服务；想完全离线就在本机跑 Ollama。

---

## 鸿蒙客户端（可选）

仓库带有 HarmonyOS NEXT（ArkTS，**API 23+**）客户端工程 `harmony-client/`，开发环境为 **Windows + DevEco Studio**，适合装在鸿蒙手机上做「拍照/识别入库 + 库存查看/扣减」：

```
harmony-client/          # 用 DevEco Studio 打开
├── entry/src/main/ets/pages/Index.ets    # 库存 / 添加 / 设置 三个 Tab
├── entry/src/main/ets/common/Api.ets     # 后端接口封装（支持 x-fm-token）
└── README.md                             # Windows 安装、DevEco 配置、API 23、签名、真机/模拟器、明文 HTTP/HTTPS
```

- 后端在 NAS 上用 Docker 跑；客户端「设置」里填 NAS 地址，后端设了 `FM_TOKEN` 就填同一个令牌。
- 客户端只做「拍照录入 + 库存查看」；MakerWorld 选料等复杂功能用手机浏览器打开同一地址。
- 详细步骤见 [harmony-client/README.md](harmony-client/README.md)。
- **完整客户端协议（字段、错误码、限制、curl/PowerShell 示例）见 [docs/CLIENT_PROTOCOL.md](docs/CLIENT_PROTOCOL.md)**。

---

## 功能

| 功能 | 说明 |
| --- | --- |
| 拍照添加（识别+手动二合一） | 一个入口：拍照 → 自动识别品牌/材料/颜色/SKU/克重（识别不了就手动填）→ 核对 → 批量入库；单张照片可含多盘 |
| 图片放大/取色 | 点击照片放大（滚轮/按钮缩放、拖动平移），在放大图上点一下即可取色并填入当前选中条目 |
| 库存管理 | 品牌、材料类型、颜色、总重、剩余、备注；余量进度条；编辑/删除/手动扣减；**同款多盒合并为一条（×N）**，也可一键「🧩 合并同款」整理重复记录 |
| 分组/列表视图 | 平铺与紧凑列表切换；**默认按品牌分组**，可切换 品牌 / 材质 / 颜色 / 品牌+材质（可折叠）；品牌、材质筛选下拉；搜索名称/品牌/颜色/备注；偏好本地记忆，省空间 |
| 商品图 | **入库后自动在后台拉取**对应颜色商品图；多图源（Bing async + 百度兜底）+ 标题相关性门槛 + **主色 ΔE 校验** + 品牌官网优先，宁可不抓也不抓错；实拍图保留；支持找图/换图/删图与批量补图 |
| MakerWorld 链接解析 | 匿名接口（`api.bambulab.com`）取模型名/作者/配置；有登录态时下载打印配置 3mf 精确解析；否则引导上传 3mf |
| 3mf 精确解析 | 读取 `Metadata/slice_info.config`，得到每个平台每种耗材的 `used_g`；未切片文件退化到 `project_settings.config`（无克重） |
| 自动选料 | CIEDE2000 色差 + 材料类型家族 + 余量（严格覆盖）+ 先清仓；支持同色多盘拼接、多需求共享库存预留 |
| 扣减与记录 | 一键把用量写进打印记录并原子扣减；服务端二次校验（料盘存在/不超量/不重复） |
| 图片识别 | 本地 Ollama 或 OpenAI/Anthropic 兼容视觉接口；官方色卡校正颜色；重复项合并 + 盒数校验 |
| 手机/鸿蒙 | 手机浏览器拍照（PWA 可加到主屏幕）；鸿蒙原生客户端（API 23+） |
| 可选令牌 | `FM_TOKEN` 环境变量，除 `/api/health` 外接口都需 `x-fm-token` |

---

## MakerWorld 链接为什么可能解析失败？

实测（2026-10，无登录、无代理）：

- `makerworld.com`（含其 `/v1/design-service`）返回 **Cloudflare 403**，服务端抓页面不可用；
- `api.bambulab.com/v1/design-service` **匿名可读**：标题/封面/作者/配置列表；
- 匿名态 `detail.weight = 0`、`detail.instanceFilaments = null`、`f3mf.url = ""` —— **克重和耗材清单要登录才给**。

因此按可靠性分层，任何一层成功都能继续：

1. **打印配置 .3mf（最稳、最准，推荐）**：模型页「下载打印配置」→ 上传，解析 `slice_info.config`，克重精确到 0.1 g。
2. **MakerWorld 元数据（贴链接即可）**：显示模型名/作者/配置列表；没有克重时提示上传 3mf，并可直接手动补需求。
3. **登录态接口 / 3mf 直链**：若环境变量 `MAKERWORLD_COOKIE` 注入了有效登录态，会尝试下载 3mf 精确解析（不落盘）。
4. **页面数据（油猴脚本）**：你在浏览器里已通过人机校验，脚本只读当前页面 `__NEXT_DATA__`，POST 给本地服务后自动打开选料页。

工具只处理**你主动提供的链接/文件**，不做批量抓取，不保存登录 Cookie。

---

## 图片识别怎么配置

识别引擎可选：不配置时仍可拍照 + 点图取色 + 手填。

| 方式 | 配置 | 说明 |
| --- | --- | --- |
| 本地 Ollama（推荐，离线） | `ollama pull qwen2.5vl:3b`；⚙ 设置里识别服务选「自动检测本地 Ollama」 | 照片不出本机；CPU 推理首次较慢，3B 模型约 3GB |
| OpenAI 兼容接口 | ⚙ 设置填地址（如 `http://…/v1`）、模型（如 `deepseek-flash` / `glm-4.6v` / `gpt-4o`）、API Key | 质量通常更好；照片会发到该服务商。推理型模型建议 `reasoningEffort: low`（默认已配置） |
| Anthropic 兼容接口 | 同上，选「Anthropic 兼容接口」 | 部分网关需 `x-opencode-session` 头，本工具会自动附带随机值 |

识别结果**不会直接写入库存**：品牌/颜色/材料/SKU/克重/数量都可改，确认后才批量创建。颜色优先用本地 Panchroma 官方色卡校正（`data/catalog/panchroma-pla.json`，来自 MIT 许可的 SpoolmanDB），模型估算色也会保留（`modelColorHex`）便于核对。

> API Key 只保存在本地 `data/db.json`（`settings.vision.apiKey`），页面/接口只返回 `hasApiKey` 布尔值。

---

## 匹配规则（可在 ⚙ 设置里调整）

- **颜色**：sRGB → CIELAB(D65) → **CIEDE2000**。`ΔE ≤ 5` 视为肉眼同色，`5 < ΔE ≤ 12` 标「颜色相近」，`> 12` 不自动选。
- **材料类型**：按家族比较（`PLA` / `PLA+` / `PLA-CF` 同族；PLA 与 PETG 默认不可互换）。
- **余量**：严格覆盖（0.5 g 容差），单盘不够给同色多盘拼接方案；多需求共享库存会预留。
- **先清仓**：优先已开封、剩余刚好够用的料盘。
- 确认扣减时服务端二次校验，再原子更新库存与打印记录。

---

## 目录结构

```
filament-manager/
├── server.mjs              # HTTP 服务 / API / 静态资源 / 可选 FM_TOKEN
├── lib/
│   ├── color.mjs           # sRGB↔Lab、CIEDE2000、颜色命名
│   ├── zip.mjs             # 极简 zip 读取（3mf 是 zip）
│   ├── threemf.mjs         # slice_info/project_settings 解析、多平台合并
│   ├── match.mjs           # 匹配算法（纯函数，可测试）
│   ├── vision.mjs          # 图片识别（Ollama / OpenAI / Anthropic 兼容）
│   ├── product-image.mjs    # 商品图搜索/下载（Bing 图片搜索，内网地址拦截）
│   ├── makerworld.mjs      # 链接解析 + 3mf 下载 + 页面数据兜底
│   └── store.mjs           # 本地 JSON 存储（原子写）与照片文件
├── web/                    # 原生 HTML/CSS/ESM 前端（含 PWA manifest/图标）
├── harmony-client/         # 鸿蒙客户端工程（DevEco Studio 打开，API 23+）
├── extensions/             # 油猴脚本（MakerWorld 页面一键导入）
├── docs/
│   ├── CLIENT_PROTOCOL.md  # 客户端协议（字段/错误码/限制/示例）
│   ├── DEPLOY_NAS.md       # NAS 部署指南（Compose/群晖/威联通/HTTPS/备份）
│   ├── NPM_GATEWAY.md      # 接入 NAS 统一网关（NPM 反代/证书/上传/排错）
│   ├── DESIGN.md           # 产品与技术设计
│   ├── research.md         # 调研笔记
│   └── QA-REPORT.md        # 独立 QA 复核报告
├── data/
│   ├── db.json             # 库存/记录/设置（运行时生成，建议备份）
│   ├── photos/             # 材料照片（运行时生成）
│   ├── catalog/            # Panchroma 官方色卡（SpoolmanDB MIT 提取）
│   └── examples/           # 演示用 3mf
├── tools/recognize.mjs     # 命令行测试图片识别（不用启动服务）
├── tools/make_fixture_3mf.py  # 生成测试用 .3mf 夹具
└── test/                   # node:test 单元 + HTTP 集成测试（77 个）
```

---

## 开发

```bash
npm test                 # 77 个测试：ΔE、匹配、3mf、图片识别、商品图、HTTP、CORS、令牌
npm run fixtures         # 重新生成 test/fixtures/*.3mf（需要 python3）
```

- 前端无构建，改 `web/` 后刷新即可；`web/app.js` 直接 import 服务端同款 `/lib/color.mjs`。
- 服务端零第三方依赖，Node 18+ 自带 `fetch`/`node:test`。
- 数据目录可用 `FM_DATA_DIR` 改到别处（例如 NAS 挂载盘）。

## 隐私与安全

- 默认只监听 `127.0.0.1`；`--lan` 会暴露到局域网，建议同时设置 `FM_TOKEN`。
- `FM_TOKEN`（**可选**）：设置后除 `/api/health` 外所有接口都要 `x-fm-token`（或 `?token=`）；网页端在 ⚙ 设置里填、鸿蒙客户端在设置里填。家庭局域网自用可留空。
- 写接口有跨域保护：默认拒绝陌生网页读写本地库存；只有同源页面与「MakerWorld 页面导入」这一条跨域路径被允许。
- 照片、库存、打印记录全部在本地 `data/`；不保存 MakerWorld Cookie/登录态。
- 图片识别可完全本地（Ollama）；云端识别会把照片发给对应服务商。
- 商品图默认从公开图片搜索抓取（Bing），仅用于个人展示；可用 `PRODUCT_IMAGES=off` 关闭。
- 油猴脚本只在你点击时读取当前页面数据，不做后台轮询或批量爬取。

## 常见问题

### 启动报 `EADDRINUSE: address already in use 0.0.0.0:4173`

说明端口已被占用，通常是之前启动的窗口没关。

```bash
# 停掉旧实例（或在启动它的终端 Ctrl+C）
pkill -f "node server.mjs"        # Windows：任务管理器结束 node.exe

# 换端口启动
node server.mjs --lan --port 4174
# 或 PORT=4174 node server.mjs --lan
```

新版启动时会检测占用者并给出提示；成功后打印本机所有局域网地址。

> 不要同时开两个实例写同一个 `data/db.json`，一次只用一个。

### 手机打不开局域网地址

1. 确认手机与电脑同一 Wi-Fi，电脑防火墙放行端口；
2. 用启动日志里的 IP（不是 `127.0.0.1`）；
3. Docker/WSL/云容器需要端口映射；容器打印的 `172.x` 手机通常连不上，用宿主机局域网 IP。

### 旧页面没有识别接口 / 连到旧服务

页面会检测到旧实例并提示/自动跳转到 `http://127.0.0.1:4174`。手动打开 `http://127.0.0.1:4174`，或先停掉旧实例再重启。

### 图片识别失败 / 结果为空

1. 看 ⚙ 设置 →「测试识别服务」：`ollama_unreachable`（Ollama 没启动）、`ollama_no_vision_model`（`ollama pull qwen2.5vl:3b`）、`missing_api_key`/`missing_model`（填 Key/模型）。
2. 接口 400：常见是 `max_tokens` 超该服务上限（默认 3500，可在 `data/db.json` 的 `settings.vision.maxTokens` 调）或模型不支持图片。
3. 结果被截断：调大 `maxTokens` 或换更强模型；结果可手动补齐。
4. 图片会压到最长边 1400px；标签小/反光时靠近拍单盒最稳。

### 识别出来的数量比照片里的盒子多（比如 10 盒识别成 11 项）

视觉模型偶尔把同一盒的正面/侧面标签算成两条，或对同一盒给出两个 SKU 猜测。后端已做：提示词先计数 `boxCount`、按「品牌+材料+颜色接近+颜色名互相包含」自动合并重复项、并提示"模型数出 X 盒但列出 Y 项"。核对时删掉多余项即可，结果不会直接入库。

### 商品图抓取规则与失败处理

商品图搜索按「品牌 + 颜色 + 材料」进行，并有三道过滤：**标题相关性门槛**（品牌/颜色词必须命中，宁可不抓）、**垃圾词黑名单**、**主色 ΔE 校验**（本机有 python3+Pillow 时启用，Docker 镜像已内置；`PRODUCT_IMAGE_COLOR_CHECK=off` 可关）。图源为 Bing async，必要时用百度图片兜底；品牌官网域名优先。

- 单盘可点卡片上的「换图」重试；也可「删图」只保留实拍图；
- 批量「自动找商品图」每次最多处理 10 盘，缺图多时可再点一次；
- 新入库的料会自动排队拉图（页面顶部显示「正在拉取商品图（剩 N 盘）」）；想关闭自动抓取：`AUTO_PRODUCT_IMAGES=off`；想整体关闭：`PRODUCT_IMAGES=off`；
- 抓取仅用于个人库存展示，图片版权归原站点；服务端会拒绝内网/非 http(s) 地址（防 SSRF）。

### 手机上点「拍照」只能进相机、选不了相册

`capture="environment"` 属性会让手机浏览器直接调相机（桌面浏览器会忽略它）。现在已拆成两个入口：**「📷 拍照」** 和 **「🖼️ 相册」**，选图请点后者。更新后需要重建镜像（前端文件打在镜像里）：`git pull && sudo docker compose up -d --build`。

### 照片/3mf 上传失败

- 照片在浏览器端压到最长边 1100px（鸿蒙客户端 1400px）；失败检查 `data/photos` 写权限。
- 3mf 上传上限约 48MB；过大的打印配置可在 Bambu Studio 里删掉不用的平台再导出。

## 已知限制

- MakerWorld 反爬策略可能变化；匿名接口拿不到克重，精确用量请上传 3mf（未切片时只按颜色/类型匹配）。
- 照片取色受光线影响；建议自然光、点平整耗材表面，必要时手动改色值。
- 匹配假设 1.75 mm 线材、每盘一色；暂不处理同盘多色/拼接打印的特殊工艺。
- 单用户本地工具，无多用户/云同步/打印机直连。

## 开源与贡献

- 协议：[MIT License](LICENSE)
- 仓库：<https://github.com/ayouwish/filament-manager>
- 贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)（开发环境、测试、提交规范）
- 安全问题：[SECURITY.md](SECURITY.md)（不要公开开 issue）
- 更新记录：[CHANGELOG.md](CHANGELOG.md)

欢迎 issue / PR。提交前请确保 `npm test` 全绿，并且不要提交 `data/db.json`、`data/photos/`、`.env` 等本地数据。

## 后续可做

- 鸿蒙客户端增加选料/3mf/打印记录页；扫码填 NAS 地址
- 视觉识别辅助填表（品牌/色号）与未切片体积估算
- 与 Spoolman 互通（导入/导出 REST API）、打印机真实用量回写
- 拓竹 RFID / OpenSpool（NFC 自动识别）
