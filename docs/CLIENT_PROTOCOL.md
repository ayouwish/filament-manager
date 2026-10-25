# 耗材管家 · 客户端协议文档（HTTP / JSON）

| 项 | 值 |
| --- | --- |
| 协议版本 | **v1.4**（`GET /api/health` 返回 `version: 1`） |
| 后端 | `filament-manager`（Node 18+，零依赖，可 Docker 部署在 NAS） |
| 客户端 | 鸿蒙 HarmonyOS NEXT / ArkTS（API 23+）；网页版 / 油猴脚本复用同一协议 |
| 传输 | HTTP/1.1（HTTPS 由 NAS 反向代理提供） |
| 编码 | JSON，UTF-8，`Content-Type: application/json` |
| 文档日期 | 2026-10-19 |

本文档是**原生客户端与后端之间的完整契约**：所有接口、数据结构、错误码、限制、鉴权与推荐流程。字段以本文档为准；后端返回的未知字段客户端必须忽略（向后兼容）。

---

## 1. 传输约定

| 项 | 约定 |
| --- | --- |
| Base URL | `http(s)://<NAS 地址>:<端口>`，默认端口 `4174`。客户端配置项只保存 Base URL |
| 明文 HTTP | 内网可用；鸿蒙需允许明文（`network_config.json`，见客户端 README）。公网建议 HTTPS |
| 超时 | 连接 10s；普通请求 30s；`/api/recognize` 建议 180s（本地视觉模型首次加载可能 30~60s）；3mf 上传 120s |
| 重试 | GET 可重试（1s、2s 退避，最多 2 次）；POST/PUT/DELETE **不要自动重试**（扣减/入库非幂等），由用户点按重试 |
| 二进制 | 不传 multipart。照片/3mf 以 **base64** 放入 JSON |
| 图片规格 | 客户端应压到最长边 ≤1400px、JPEG 质量 ~72；base64 前 ≤10MB（后端硬限制） |
| 时间 | ISO-8601 UTC，如 `2026-10-19T08:30:00.000Z` |
| 数值 | 克重保留 1 位小数；后端对超范围数值做钳制/校验（见 §7） |
| 字段缺失 | 客户端必须容忍字段缺失或 `null`；未知字段忽略 |

### 1.1 局域网地址发现

**`GET /api/net`**（需令牌）

```json
{
  "port": 4174,
  "host": "0.0.0.0",
  "lanEnabled": true,
  "urls": [
    { "name": "eth0", "address": "192.168.1.23", "url": "http://192.168.1.23:4174" }
  ]
}
```

用途：在设置页提示"手机该访问哪个地址"。`lanEnabled=false` 表示后端只监听 127.0.0.1，手机连不上，需要 `--lan` 重启或端口映射。

---

## 2. 鉴权

后端支持**可选**访问令牌（环境变量 `FM_TOKEN`）：

- 设置了 `FM_TOKEN` 后，**除 `/api/health` 外所有接口**都要求令牌：
  - 推荐请求头：`x-fm-token: <FM_TOKEN>`
  - 兼容 query：`?token=<FM_TOKEN>`
- 未设置 `FM_TOKEN` 时接口开放（仅适合完全可信的家庭内网）。

| 情况 | 响应 |
| --- | --- |
| 未带 / 错误令牌 | `401`，body：`{"error":"需要访问令牌：请在请求头带上 x-fm-token（或在客户端设置里填 FM_TOKEN）"}` |
| 令牌正确 | 正常业务响应 |
| `GET /api/health` | 永远 200，不需要令牌 |

> 原生客户端不存在 CORS 问题；网页端跨域由后端 Origin 白名单限制（同源 + MakerWorld 页面导入）。

---

## 3. 通用响应与错误

### 3.1 HTTP 状态码

| 状态码 | 含义 | 典型场景 |
| --- | --- | --- |
| 200 | 成功 | 查询、更新、识别成功、匹配 |
| 201 | 已创建 | 新增材料、批量入库、创建打印记录 |
| 400 | 参数错误 | JSON 非法、颜色格式错、缺字段、重复 items |
| 401 | 未授权 | 缺少/错误 `FM_TOKEN` |
| 404 | 不存在 | 材料 ID/待导入结果不存在 |
| 409 | 冲突 | 扣减超过剩余量 |
| 413 | 请求体过大 | 图片 >10MB、请求体超上限 |
| 422 | 语义失败 | 识别未配置/模型失败、3mf 解析失败、MakerWorld 解析失败 |
| 500 | 服务器错误 | 内部异常（日志在服务端，响应不泄漏细节） |

### 3.2 错误响应形状

**普通错误**（400/401/404/409/413/500）：

```json
{ "error": "可读的中文错误信息" }
```

**识别类失败**（HTTP 422，`ok:false`）：

```json
{
  "ok": false,
  "reason": "not_configured | provider_error | bad_response | unsupported_provider | no_image | ollama_unreachable | ollama_no_vision_model | ollama_no_models | missing_model | missing_api_key",
  "message": "给用户看的中文说明",
  "availableModels": ["qwen2.5vl:3b"]
}
```

**MakerWorld 解析失败**（HTTP 422）：

```json
{
  "ok": false,
  "reason": "upstream_blocked | no_requirements | invalid_url",
  "message": "……",
  "fallbacks": ["upload_3mf", "paste_page", "manual"],
  "designId": "1400373",
  "warnings": ["……"]
}
```

客户端建议：`error`/`message` 直接展示；`reason` 用于决定引导动作（去设置、改用 3mf、手动录入、重试）。

---

## 4. 数据模型

### 4.1 Spool（料盘）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `s_` + 12 位十六进制；客户端只透传 |
| `name` | string | 显示名，≤60 字符；创建时为空则自动生成 `颜色名 材料` |
| `brand` | string | 品牌，≤40 字符，可为空 |
| `type` | string | 材料类型：`PLA`/`PETG`/`ABS`/`ASA`/`TPU`/`PA`/`PC`/`其他`（后端只存字符串） |
| `colorHex` | string | `#RRGGBB`（大写），创建/更新时非法会 400 |
| `colorName` | string | 颜色名，≤20 字符；后端缺省按 ΔE 最近邻生成中文名 |
| `totalGrams` | number | **合计**总重（g），0~1,000,000；`count>1` 时为多盘合计 |
| `remainingGrams` | number | 合计剩余（g），0~total |
| `count` | number | 同款盘数（1~99），默认 1；界面显示 ×N |
| `spoolWeightG` | number | 单盘克重（g），默认 1000 |
| `opened` | boolean | 后端按 `remaining < total` 推导 |
| `photo` | string | 用户实拍照片相对路径 `/data/photos/…`，可为空。客户端展示时拼接 Base URL |
| `productPhoto` | string | 自动搜索下载的商品图相对路径，可为空；与实拍图分开存 |
| `productPhotoSource` | string | 商品图原图 URL（来源标注） |
| `productImageQuery` | string | 抓取时使用的搜索词 |
| `note` | string | 备注，≤300 字符 |
| `createdAt` / `updatedAt` | string | ISO 时间 |

示例：

```json
{
  "id": "s_02e9bf8bd472",
  "name": "Matte Forest Green PLA",
  "brand": "Polymaker",
  "type": "PLA",
  "colorHex": "#519F61",
  "colorName": "Matte Forest Green",
  "totalGrams": 1000,
  "remainingGrams": 1000,
  "photo": "/data/photos/s_02e9bf8bd472-1792254838219.jpg",
  "note": "SKU CA04078 · Panchroma PLA Matte",
  "opened": false,
  "createdAt": "2026-10-19T08:00:00.000Z",
  "updatedAt": "2026-10-19T08:00:00.000Z"
}
```

### 4.2 Job（打印记录）与 JobItem

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `j_` + 12 位十六进制 |
| `title` | string | 记录标题（通常为模型名） |
| `sourceUrl` | string | 模型链接，可为空 |
| `items` | JobItem[] | 扣减明细（快照） |
| `totalGrams` | number | 合计克重 |
| `note` | string | 备注 |
| `createdAt` | string | ISO 时间 |

`JobItem`：`{ spoolId, spoolName, colorHex, grams }`（spoolName/colorHex 为**当时的快照**，料盘删除后记录仍可读）。

### 4.3 RecognizeItem（识别结果条目）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string? | 后端不返回该字段（客户端可自行补）；客户端提交时可用 |
| `brand` | string | 品牌（如 Polymaker） |
| `productLine` | string | 产品线（如 Panchroma PLA Matte） |
| `material` | string | 材料类型（推断后） |
| `colorName` | string | 颜色名（优先包装原文） |
| `colorHex` | string | `#RRGGBB`；来自官方色卡（`hexSource:"catalog"`）、模型估算（`model`）或内置字典（`dictionary`） |
| `modelColorHex` | string? | 模型给出的原始近似色（可能为空） |
| `hexSource` | string | `catalog` / `model` / `dictionary`（客户端可展示"官方色卡/模型估算"） |
| `sku` | string | 包装 SKU（可能读错，必须允许用户编辑） |
| `spoolWeightG` | number | 单盘克重，默认 1000 |
| `count` | number | 数量 1~20 |
| `confidence` | number | 0~1 |
| `labelText` | string | 包装上读到的文字（≤160 字） |

> 后端会做重复项合并与 `boxCount` 校验，合并/异常会在 `warnings[]` 里说明。

### 4.4 匹配（可选，客户端未实现）

`MatchRequirement`：`{ index?, type, colorHex, grams: number|null }`
`MatchAssignment`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `requirement` | MatchRequirement | 回显需求 |
| `status` | string | `ok` / `color_near` / `combine` / `color_far` / `insufficient` / `no_type` / `type_mismatch` / `no_stock` |
| `spool` | Spool\|null | 选中的料盘（可能为 null） |
| `deltaE` | number\|null | CIEDE2000 色差 |
| `alternatives` | array | 备选 `{spool, deltaE, typeOk, available, coverage}` |
| `parts` | `[{spool, grams}]` | 拼盘方案（`status=combine` 时） |
| `shortfallGrams` | number | 缺口克重 |
| `message` | string | 中文提示 |

`MatchSummary`：`{ requirementCount, totalGrams, gramsKnown, okCount, warnCount, problemCount, spoolsUsed }`

### 4.5 VisionStatus

`{ ready: boolean, provider: string, model: string, reason: string, availableModels: string[] }`

- `provider`：`ollama` / `openai` / `anthropic` / `""`
- `reason`：不可用原因，如 `ollama_unreachable`、`ollama_no_vision_model`、`missing_api_key`、`missing_model`

### 4.6 Settings（后端设置）

```json
{
  "match": { "goodDeltaE": 5, "maxDeltaE": 12, "allowTypeMismatch": false, "preferOpened": true },
  "vision": { "provider": "openai", "baseUrl": "http://…/v1", "model": "deepseek-flash", "hasApiKey": true }
}
```

> `vision.hasApiKey` 只是布尔值；**API Key 不会回传给客户端**。

---

## 5. 接口一览

| # | 方法/路径 | 用途 | 客户端必需 |
| --- | --- | --- | --- |
| 5.1 | `GET /api/health` | 健康检查 / 测试连接 | ✅ |
| 5.2 | `GET /api/net` | 局域网地址提示 | 可选 |
| 5.3 | `GET /api/state` | 一次性拉库存 + 记录 + 设置 | ✅ |
| 5.4 | `GET /api/spools` | 只拉库存 | 可选 |
| 5.5 | `POST /api/spools` | 新增一盘 | ✅ |
| 5.6 | `PUT /api/spools/{id}` | 修改一盘（部分字段） | 可选 |
| 5.7 | `DELETE /api/spools/{id}` | 删除一盘 | ✅ |
| 5.8 | `POST /api/spools/{id}/consume` | 扣减余量 | ✅ |
| 5.9 | `POST /api/spools/bulk` | 批量入库（识别结果） | ✅ |
| 5.10 | `POST /api/recognize` | 图片识别（视觉模型） | ✅ |
| 5.11 | `GET /api/vision/status` | 识别引擎可用性 | ✅ |
| 5.12 | `POST /api/match` | 需求 → 选料 | 可选 |
| 5.13 | `GET/POST /api/jobs` | 打印记录 | 可选 |
| 5.14 | `GET/POST /api/settings` | 匹配/识别设置 | 可选 |
| 5.15 | `POST /api/import/3mf` | 解析打印配置 | 可选 |
| 5.16 | `POST /api/makerworld/resolve` | 解析 MakerWorld 链接 | 可选 |
| 5.17 | `GET /api/sample` | 内置示例模型 | 仅演示 |
| 5.18 | `POST /api/import/page` + `GET /api/pending/{id}` | 浏览器油猴导入 | 仅网页 |
| 5.19 | `POST/DELETE /api/spools/{id}/product-image` | 单盘找/删商品图 | 可选 |
| 5.20 | `POST /api/spools/product-images` | 批量补商品图（≤10/次） | 可选 |
| 5.21 | `POST /api/spools/merge-duplicates` | 合并同品牌/材质/色/名的重复料盘 | 可选 |

---

## 5.1 GET /api/health

- 鉴权：**不需要令牌**
- 响应 `200`：

```json
{ "ok": true, "version": 1 }
```

客户端用途：设置页"测试连接"第一步；判断协议版本。

---

## 5.2 GET /api/net

见 §1.1。

---

## 5.3 GET /api/state

- 鉴权：需要（若启用）
- 响应 `200`：

```json
{
  "spools": [ /* Spool[] */ ],
  "jobs": [ /* Job[]，最新在前 */ ],
  "settings": {
    "match": { /* 匹配设置 */ },
    "vision": { "provider": "openai", "baseUrl": "http://…/v1", "model": "deepseek-flash", "hasApiKey": true }
  },
  "productImageQueue": { "pending": 0, "running": false, "done": 12, "failed": 0 },
  "matchDefaults": {
    "goodDeltaE": 5,
    "maxDeltaE": 12,
    "minRemainingGrams": 2,
    "allowTypeMismatch": false,
    "allowCombine": true,
    "maxCombineParts": 3,
    "preferOpened": true
  }
}
```

客户端用途：首屏/刷新的**唯一数据源**；`jobs` 可选展示最近记录。

`productImageQueue` 是「入库后自动拉商品图」的后台队列进度：`pending/running` 非零时客户端可每隔 2~3 秒重新拉取 `/api/state`，商品图就绪后 `spools[].productPhoto` 会出现。新增/批量入库会自动入队（服务端 `AUTO_PRODUCT_IMAGES=off` 可关闭）。

---

## 5.4 GET /api/spools

- 响应 `200`：`{ "spools": [ Spool… ] }`

---

## 5.5 POST /api/spools

- 请求体（均为可选字段，未传用默认值）：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 自动 | ≤60 字符 |
| `brand` | string | `""` | ≤40 字符 |
| `type` | string | `PLA` | 材料类型 |
| `colorHex` | string | `#808080` | 必须 `#RRGGBB`，否则 400 |
| `colorName` | string | 自动 | ≤20 字符 |
| `totalGrams` | number | `1000` | 0~1e6 |
| `remainingGrams` | number | `totalGrams` | 自动钳制 ≤ total |
| `note` | string | `""` | ≤300 字符 |
| `photoDataUrl` | string | — | `data:image/jpeg;base64,…`（≤8MB），保存为照片 |
| `photo` | string | — | 传 `""` 表示清空照片（更新时用） |

- 响应 `201`：`{ "spool": Spool }`
- 错误：`400`（颜色/字段非法、照片格式不支持）、`413`（照片过大）

示例：

```json
{
  "name": "Matte Forest Green PLA",
  "brand": "Polymaker",
  "type": "PLA",
  "colorHex": "#519F61",
  "totalGrams": 1000,
  "remainingGrams": 1000,
  "note": "SKU CA04078"
}
```

---

## 5.6 PUT /api/spools/{id}

- 请求体：同 5.5 的任意子集（部分更新）；`photoDataUrl` 替换照片，`photo:""` 清空。
- 响应 `200`：`{ "spool": Spool }`
- 错误：`404` 不存在、`400` 字段非法

---

## 5.7 DELETE /api/spools/{id}

- 响应 `200`：`{ "ok": true }`（同时删除关联照片文件）
- 错误：`404`

> 删除不会回滚历史打印记录（记录里是快照）。

---

## 5.8 POST /api/spools/{id}/consume

- 请求体：`{ "grams": 50 }`（number，>0）
- 行为：`remaining = max(0, remaining - grams)`，`opened` 自动更新
- 响应 `200`：`{ "spool": Spool }`
- 错误：`404`

> 与 `/api/jobs` 的区别：consume 是**手动扣减**，不生成打印记录；客户端快捷 -20g/-100g 用它。

---

## 5.9 POST /api/spools/bulk

- 请求体：

```json
{
  "items": [ { "name": "Matte Forest Green PLA", "brand": "Polymaker", "type": "PLA", "colorHex": "#519F61", "totalGrams": 1000, "remainingGrams": 1000, "note": "SKU CA04078" } ],
  "photoDataUrl": "data:image/jpeg;base64,…"
}
```

| 约束 | 值 |
| --- | --- |
| `items` 数量 | 1~30 |
| 每个 item | 同 5.5，`photoDataUrl` 不放在 item 里 |
| `photoDataUrl` | 可选；**所有条目共用**这一张照片（只落盘一份） |

- 响应 `201`：`{ "spools": [ Spool… ] }`
- 错误：`400`（缺 items / 超过 30 / 字段非法）

---

## 5.10 POST /api/recognize

把一张图片交给后端配置的视觉模型，返回结构化耗材清单。**客户端不要自动入库**，必须展示可编辑列表让用户确认。

- 请求体：

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `base64`（或 `dataBase64`） | string | ✅ | 图片 base64；可带 `data:image/jpeg;base64,` 前缀（后端会剥离） |
| `mimeType` | string | 可选 | `image/jpeg` / `image/png` / `image/webp` |
| `brandHint` | string | 可选 | 提示品牌（≤60 字符），提高准确率 |

- 限制：图片解码后 **≥16 字节且 ≤10MB**（超限 413）；请求体上限 12MB。
- 响应 `200`（成功）：

```json
{
  "ok": true,
  "provider": "openai",
  "model": "deepseek-flash",
  "items": [ { "brand": "Polymaker", "productLine": "Panchroma PLA Matte", "material": "PLA", "colorName": "Matte Forest Green", "colorHex": "#519F61", "hexSource": "catalog", "sku": "CA04078", "spoolWeightG": 1000, "count": 1, "confidence": 0.95, "labelText": "Panchroma PLA Matte Forest Green SKU:CA04078" } ],
  "summary": "照片里共有 10 盒耗材",
  "warnings": []
}
```

- 响应 `422`（失败）：`{ ok:false, reason, message, availableModels? }`（见 §3.2）
- 常见耗时：云端 10~30s；本地 Ollama 首次 30~60s。客户端读超时建议 180s，并显示"识别中"。
- 客户端处理建议：
  1. 压图（≤1400px、JPEG 72）再 base64；
  2. 展示 `items`（可删/可改颜色/品牌/材料/克重/数量；`count>1` 入库时展开为多盘）；
  3. 展示 `warnings`（重复合并、盒数不一致等）；
  4. 用户点「入库」时调 5.9，`photoDataUrl` 传同一张图。

---

## 5.11 GET /api/vision/status

- 响应 `200`：

```json
{
  "ready": true,
  "provider": "openai",
  "model": "deepseek-flash",
  "reason": "",
  "availableModels": []
}
```

- `ready=false` 时：`reason` 说明原因，客户端应引导去后端设置页配置，或直接用「手动添加」。
- 该接口会实时探测（Ollama 时约 1~3s）。

---

## 5.12 POST /api/match（可选）

- 请求体：

```json
{
  "requirements": [
    { "index": 1, "type": "PLA", "colorHex": "#17181A", "grams": 120.4 },
    { "index": 2, "type": "PLA", "colorHex": "#F2F2EE", "grams": 600 }
  ],
  "options": { "maxDeltaE": 12, "goodDeltaE": 5 }
}
```

- 校验：`requirements` 非空；`colorHex` 必须 `#RRGGBB`；`grams` 数字或 `null`
- 响应 `200`：`{ assignments: MatchAssignment[], summary: MatchSummary, spools: Spool[] }`
- 状态语义见 §4.4；`ok/color_near/combine` 可自动接受，其余需要人工确认。

---

## 5.13 GET / POST /api/jobs

**GET** `200`：`{ "jobs": [ Job… ] }`

**POST** 创建打印记录并**原子扣减**：

```json
{
  "title": "三色小夜灯",
  "sourceUrl": "https://makerworld.com/zh/models/1234567",
  "items": [ { "spoolId": "s_abc123", "grams": 120.4 } ],
  "note": "可选"
}
```

| 校验 | 失败响应 |
| --- | --- |
| `items` 为空 | 400 |
| 料盘不存在 | 404 |
| 同一 `spoolId` 重复出现 | 400 |
| `grams` 非正数 | 400 |
| `grams` 超过剩余量 | 409 |

- 响应 `201`：`{ "job": Job, "spools": Spool[] }`（`spools` 为扣减后的最新库存）
- 客户端注意：此接口**非幂等**，超时后不要自动重试，先刷新 `/api/state` 判断是否已扣减。

---

## 5.14 GET / POST /api/settings

**GET** `200`：`{ settings: { match, vision } }`（vision 不含 key）

**POST** 保存（部分更新）：

```json
{
  "match": { "goodDeltaE": 5, "maxDeltaE": 12, "allowTypeMismatch": false, "preferOpened": true },
  "vision": {
    "provider": "openai",
    "baseUrl": "http://8.x.x.x:3000/v1",
    "model": "deepseek-flash",
    "apiKey": "sk-…",
    "reasoningEffort": "minimal",
    "maxTokens": 3800
  }
}
```

- `vision.apiKey` 只写不读；传空字符串表示保留原 key；`vision.clearApiKey: true` 清除 key。
- `provider` 允许：`""`（自动检测 Ollama）/ `ollama` / `openai` / `anthropic`。
- `reasoningEffort`：`minimal|low|medium|high`（推理型模型建议 `minimal`/`low`）。
- 响应 `200`：`{ settings: { match, vision } }`

---

## 5.15 POST /api/import/3mf（可选）

- 请求体：`{ "filename": "model.3mf", "base64": "…" }`（请求体上限 64MB，文件 ≤48MB 较稳）
- 响应 `200`：

```json
{
  "ok": true,
  "source": "3mf",
  "title": "三色小夜灯",
  "cover": "",
  "plates": [ { "index": 1, "predictionSeconds": 4823, "totalGrams": 165.6, "filaments": [ { "slot": 1, "type": "PLA", "colorHex": "#17181A", "grams": 120.4, "meters": 4.823, "colorName": "黑色", "display": "黑色 / PLA" } ] } ],
  "project": { "printerModel": "Bambu Lab A1", "nozzle": "0.4" },
  "requirements": [ { "index": 1, "type": "PLA", "colorHex": "#17181A", "grams": 120.4, "colorName": "黑色", "display": "黑色 / PLA" } ],
  "warnings": []
}
```

- 错误 `400`（不是 zip/缺 base64）、`422`（解析失败）
- 未切片 3mf：`requirements[].grams = null`，`warnings` 会说明"克重未知"。

---

## 5.16 POST /api/makerworld/resolve（可选）

- 请求体：`{ "url": "https://makerworld.com/zh/models/1400373#profileId-1452154" }`
- 成功 `200` 两种形态：
  1. 拿到精确 3mf：`{ ok:true, source:"makerworld+3mf", title, cover, author, plates, requirements, instances, warnings }`
  2. 只有元数据：`{ ok:true, source:"makerworld+metadata", needs3mf:true, title, cover, author, instances, requirements:[], warnings }`
- 失败 `422`：`{ ok:false, reason, message, fallbacks, designId, warnings }`
- `invalid_url` 时 `400`。
- 客户端策略：`needs3mf=true` 时提示"在 MakerWorld 下载打印配置后上传 3mf"，或转手动录入。

---

## 5.17 GET /api/sample（仅演示）

`200`：`{ model: { title, sourceUrl, cover, sample: true, plates: [], warnings, requirements: [ {index,type,colorHex,colorName,grams,display} ] } }`

---

## 5.18 浏览器专用接口（原生客户端不需要）

| 接口 | 说明 |
| --- | --- |
| `POST /api/import/page` | 油猴脚本把 MakerWorld 页面 HTML/`__NEXT_DATA__` 发来解析，返回 `{ ok, source:"makerworld+page", title, cover, sourceUrl, requirements, warnings, importId }`（200/422） |
| `GET /api/pending/{importId}` | 取回上述导入结果（30 分钟内有效，404 表示过期） |

---

## 5.19 商品图（可选）

### POST /api/spools/{id}/product-image

按「品牌 + 颜色 + 材料」在 Bing 图片搜索里找图并下载到 NAS，写入 `productPhoto`（不覆盖实拍 `photo`）。

- 请求体：`{ "force": false }`（已有商品图且 `force=false` 时直接返回 `cached:true`）
- 响应 `200`：`{ ok:true, cached?:true, spool: Spool, query?: string, sourceUrl?: string }`
- 失败 `422`：`{ ok:false, reason, message, query }`（如 `no_candidates`、`download_failed`、`disabled`）
- 关闭抓取：服务端环境变量 `PRODUCT_IMAGES=off`

### DELETE /api/spools/{id}/product-image

删除商品图（保留实拍图），响应 `200`：`{ ok:true, spool }`。

### POST /api/spools/product-images

批量给缺少商品图的料盘补图。

- 请求体：`{ "ids"?: string[], "force"?: false, "limit"?: 10 }`（limit 1~10，默认 10）
- 响应 `200`：`{ results: [{id, name, ok, query?, error?}], fetched, failed }`
- 串行抓取（含节流），单次请求可能耗时几十秒，客户端超时建议 ≥120s。

---


---

## 6. 客户端推荐流程

### 6.1 启动 / 刷新

```
读取本地配置(serverUrl, token)
  → GET /api/health            （可选，判断协议版本/连通性）
  → GET /api/state             （拉 spools + jobs + settings）
  → 渲染库存；失败显示错误 + 「去设置」
```

### 6.2 拍照识别入库

```
拍照/相册 → 本地压缩(≤1400px, JPEG 72)
  → base64 → POST /api/recognize
  → 200: 展示 items（可编辑/删除/改数量），展示 warnings
  → 用户确认 → POST /api/spools/bulk { items, photoDataUrl }
  → 201 → 刷新 /api/state
  → 422: 展示 message，降级到「手动添加」或去设置配置识别引擎
```

### 6.3 手动添加

```
填写 name/type/colorHex/grams
  → POST /api/spools
  → 201 → 刷新
```

### 6.4 扣减 / 删除

```
-20g/-100g → POST /api/spools/{id}/consume {grams}
删除      → 二次确认 → DELETE /api/spools/{id}
两者成功后都应刷新 /api/state（或本地更新对应 Spool）
```

### 6.5 设置与连通性

```
保存 Base URL/Token → GET /api/health（无需令牌）
                    → GET /api/vision/status（需要令牌）
                    → 展示「连接成功 / 识别引擎可用性」
```

### 6.6 错误与重试策略

| 场景 | 处理 |
| --- | --- |
| 401 | 提示"令牌不正确"，引导去设置填写 |
| 400 / 422 | 展示 `message`，不重试 |
| 409（扣减超量） | 刷新库存后让用户重新操作 |
| 超时 / 网络错误 | GET 可自动重试；POST 不自动重试，提示手动重试 |
| 识别超时（本地模型） | 提示"模型加载较慢，可重试或换云端模型" |

---

## 7. 限制与约束

| 项 | 限制 |
| --- | --- |
| 图片解码大小 | 16B ~ 10MB（`/api/recognize`） |
| 识别请求体 | ≤12MB |
| 3mf 上传 | 请求体 ≤64MB（建议文件 ≤48MB） |
| 批量入库 | items 1~30 |
| 单盘克重 | 0~1,000,000（建议 50~5000） |
| `count`（识别） | 1~20 |
| 名称/品牌/备注 | 60 / 40 / 300 字符 |
| 照片 | JPEG/PNG/WebP，≤8MB（入库时） |
| 扣减 | 0 < grams ≤ 剩余量 |
| 待导入结果 | 30 分钟过期 |

---

## 8. 版本与兼容

- 协议版本通过 `GET /api/health` 的 `version` 暴露，当前为 `1`。
- 后端只做**向后兼容的增量变更**（新增可选字段/接口）；客户端必须忽略未知字段。
- 如果未来出现破坏性变更，会新增 `/api/v2/*` 并保留 v1 一段时间。
- 客户端应在 `aboutToAppear` 里读取 `version`，不支持的版本给出提示而不是崩溃。

---

## 9. 安全建议（NAS 部署）

1. 设置 `FM_TOKEN`，客户端在设置里填同一个值（推荐用随机 32+ 位）。
2. 只在家庭内网开放端口；如需外网访问，用 HTTPS 反代（群晖/威联通/Caddy/Nginx）并加认证。
3. 不要把 `data/` 目录暴露为静态站点；照片通过 `/data/photos/…` 由后端鉴权后返回（启用令牌时同样受保护）。
4. 客户端不要在日志里打印 token/图片 base64。
5. 定期备份 NAS 上的 `data/db.json` 与 `data/photos/`。

---

## 10. 附录

### 10.1 Windows 下用 curl 自测

Windows 10+ 自带 `curl.exe`（PowerShell 里注意用 `curl.exe` 而不是别名）：

```powershell
# 健康检查
curl.exe http://192.168.1.10:4174/api/health

# 库存（无令牌模式）
curl.exe http://192.168.1.10:4174/api/state

# 有令牌时
curl.exe -H "x-fm-token: 你的令牌" http://192.168.1.10:4174/api/state

# 扣减 50g
curl.exe -X POST -H "Content-Type: application/json" -H "x-fm-token: 你的令牌" ^
  -d "{\"grams\":50}" http://192.168.1.10:4174/api/spools/s_xxx/consume
```

### 10.2 识别请求示例（PowerShell 准备 base64）

```powershell
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\photo.jpg"))
$body = @{ base64 = $b64; mimeType = "image/jpeg" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://192.168.1.10:4174/api/recognize" `
  -Headers @{ "x-fm-token" = "你的令牌" } -ContentType "application/json" -Body $body
```

### 10.3 识别失败 reason 对照

| reason | 含义 | 客户端动作 |
| --- | --- | --- |
| `not_configured` / `missing_model` / `missing_api_key` | 未配置识别引擎 | 去设置页配置；或手动添加 |
| `ollama_unreachable` | 本机 Ollama 没启动 | 提示启动 Ollama |
| `ollama_no_models` / `ollama_no_vision_model` | 没有视觉模型 | 提示 `ollama pull qwen2.5vl:3b` |
| `provider_error` | 上游接口错误/超时 | 可重试；检查网络/额度 |
| `bad_response` | 模型输出不是预期 JSON | 可重试；换模型 |
| `no_image` | 图片数据为空 | 检查照片读取/压缩 |
| `unsupported_provider` | provider 配置不支持 | 去设置改 provider |

### 10.4 变更记录

| 日期 | 版本 | 变更 |
| --- | --- | --- |
| 2026-10-18 | v1.0 | 初版：库存/识别/批量入库/扣减/匹配/3mf/MakerWorld 等接口 |
| 2026-10-19 | v1.1 | 增加可选 `FM_TOKEN` 鉴权、`/api/net`；补全客户端协议文档；客户端改用 API 23+ |
| 2026-10-22 | v1.2 | Spool 增加 `productPhoto`/`productPhotoSource`/`productImageQuery`；新增单盘/批量商品图接口；库存支持分组/列表视图 |
| 2026-10-23 | v1.3 | 新增/批量入库自动排队拉取商品图；`/api/state` 增加 `productImageQueue`；图片搜索优先品牌官网域名 |
| 2026-10-23 | v1.4 | Spool 增加 `count`/`spoolWeightG`（同款多盒合并为一条）；新增 `POST /api/spools/merge-duplicates`；商品图增加相关性门槛、垃圾词过滤与主色 ΔE 校验，Bing async + 百度兜底 |
