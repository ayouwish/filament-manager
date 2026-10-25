# 家庭 3D 打印耗材管理软件 · 产品与技术设计

> 一句话：**把"这卷料还剩多少、放哪了"变成一张照片；把"这个模型要什么料"变成一次粘贴。**
> 输入 MakerWorld 链接 / 打印配置 3mf → 从自家库存自动选料 → 一键扣减余量并留记录。

- 版本：v0.1（可运行的本地 MVP，代码在 `filament-manager/`）
- 日期：2026-10-18
- 关联文档：[README（使用说明）](../README.md) · [调研笔记](./research.md)

---

## 1. 背景与目标

家庭 3D 打印用户（尤其拓竹 A1/P1S/X1C + AMS 用户）有两个反复出现的摩擦：

1. **耗材账本靠脑子**：买了十几卷 PLA/PETG，颜色接近、开封后用剩多少、哪卷快用完，全凭记忆。结果要么重复购买，要么打到一半断料。
2. **模型要什么料不直观**：MakerWorld 上一个多色模型，需要"黑色 PLA 120 g、白色 PLA 45 g、琥珀 PETG 60 g"，用户得自己对着色卡和库存一格格比。颜色差一点（ΔE 10~15）肉眼不容易判断，买错一卷料很常见。

目标：**降低"这卷料够不够、颜色对不对、用了多少"的决策成本**，而不是做一个完整的打印农场 ERP。

### 设计原则

| 原则 | 含义 |
| --- | --- |
| 录料 30 秒 | 拍照 + 少量字段；颜色优先从照片取，避免手填色值 |
| 数据要准 | 模型需求克重以切片结果为准（3mf 的 `used_g`），不靠估算 |
| 匹配可解释 | 每个结果都显示"为什么选它"（ΔE、余量、类型），并允许人工改选 |
| 失败有退路 | MakerWorld 可能被 Cloudflare 拦截，必须有 3mf 上传、页面导入、手动录入三条退路 |
| 本地优先 | 家庭隐私数据（照片/库存）留在自己电脑/NAS，不上云 |

---

## 2. 用户与场景

**典型用户**：有一台拓竹 A1/P1S，AMS 里常驻 2~4 卷料，MakerWorld 是主要模型来源，家里有若干"买了还没拆"的囤料。

| 场景 | 频率 | 现在的做法 | 目标体验 |
| --- | --- | --- | --- |
| 新买一卷料 | 每月几次 | 随手一放，靠包装记得 | 拍照 30 秒入库，颜色/余量/ep 记录 |
| 打印 MakerWorld 模型 | 每周几次 | 肉眼比色、估算克重 | 粘链接 → 自动列出"用哪几卷、各多少克、够不够" |
| 打一半发现料不够 | 偶发 | 停打印、翻库存 | 匹配时就提示"还差 80 g"或"两卷拼起来够" |
| 查历史用量 | 偶尔 | 没记录 | 打印记录列表，知道每卷料消耗 |

非目标用户：打印农场/多用户团队（需要权限、审计、HTTP API 集成，见路线图）。

---

## 3. 产品范围

### P0（本次 MVP，已实现）

1. 材料库存：拍照、取色、品牌/类型/颜色/总重/剩余/备注；编辑、删除、手动扣减；余量进度条。
2. 拍照取色：照片压缩、点图取色（邻域平均）、ΔE 最近邻中文色名、手动改色兜底。
3. MakerWorld 输入：粘贴链接解析（匿名元数据 → 登录态 3mf 直链 → 页面 JSON 兜底）；上传 `.3mf` 精确解析；内置示例；手动录入。
4. 自动匹配：颜色 ΔE、材料类型、余量、先清仓、多盘拼接、多需求预留；每项给出状态与备选。
5. 人工干预：下拉手动指定料盘；确认扣减生成打印记录；打印记录列表。
6. 本地服务：零依赖 Node，默认 127.0.0.1，`--lan` 支持手机拍照。

### P1（下一步）

- PWA/离线安装、手机端相机体验优化（拍照即上传）。
- 视觉识别辅助：拍标签自动填品牌/色号（多模态模型），人工确认。
- 3mf 未切片时的体积估算（网格求积 × 材料密度）与"在 Bambu Studio 里补切片"引导。
- 撤销扣减、打印记录编辑、CSV 导出。
- Spoolman REST API 互通（导入/导出）。

### P2（可选硬件/生态）

- 拓竹 RFID / OpenSpool：NFC 读卡器贴近料盘自动识别（需注意官方标签加密/克隆限制）。
- 打印机接入（Bambu MQTT / OctoPrint）自动回写真实用量。
- 多用户与移动端原生 App。

### 明确不做（当前）

- 不做购买/比价、电商导流。
- 不做切片器（不内嵌 Bambu Studio/Orca）。
- 不做云端账号体系（本地优先；同步是后续可选）。

---

## 4. 核心流程

### 4.1 拍照入库

```
拍摄料盘照片 ──▶ 客户端压缩(≤1100px, JPEG 0.82) ──┬──▶ 点照片取色(13×13 邻域中位色)
                                                 │            │
                                                 │            ▼
                                                 │     颜色 #RRGGBB ──▶ ΔE 最近邻命名(黑色/象牙白/宝蓝…)
                                                 │            │
                                                 └──▶ 🤖 视觉模型识别（可选）──▶ 品牌/材料/颜色名/SKU/克重
                                                              │
       ┌──────────────────────────────────────────────────────┘
       ▼
 品牌/类型/总重/剩余（人可逐项修改） ──▶ POST /api/spools 或 /api/spools/bulk
       │
       ▼
 data/db.json + data/photos/xxx.jpg
```

设计取舍：

- **不做"拍完自动识别一切"**：家庭环境下光线、背景、标签模糊，纯视觉识别错误率不可控，错一次比手动填更烦。MVP 用"人工点一下取色 + 少量字段"，准确率由人保证；识别能力作为 P1 辅助。
- **颜色以 Lab/ΔE 存**：所有颜色在匹配时都转 CIELAB(D65)，用 CIEDE2000 比较，避免 RGB 欧氏距离在深色/高饱和色上的偏差。
- 照片只作为**人眼核对凭据**，不参与匹配计算（避免光照误差直接污染算法）。取色结果允许手动纠正。

### 4.2 链接选料（本文档的重点）

```
 MakerWorld 链接 / .3mf 文件 / 示例 / 手动
                 │
                 ▼
        [需求提取层]  ── 输出统一的「材料需求」数组
                 │     {type, colorHex, grams, 平台来源}
                 ▼
        [匹配引擎]     ── 与本地库存做带约束的最优分配
                 │
                 ▼
        [人工确认层]   ── 展示 ΔE/余量/备选/警告，可改选
                 │
                 ▼
        [扣减与记录]   ── 原子扣减 + 打印记录
```

### 4.3 确认扣减

一次确认 = 一个打印记录 + 多盘料扣减。采用"先算后扣、一次写盘"：把 `items[{spoolId, grams}]` 交给服务端，服务端在同一个 JSON 写入里完成所有扣减（原子写：临时文件 + rename），避免"记录成功但没扣"。

---

## 5. 功能设计

### 5.1 拍照与颜色采集

| 问题 | 方案 |
| --- | --- |
| 手机照片太大 | 浏览器端 canvas 压缩到最长边 ≤1100px、JPEG 0.82，约 150~300 KB |
| 拍出来偏色 | 不自动白平衡（易过度校正）；提示"自然光、避免高光/阴影"；点取色后允许手动改 |
| 取哪一点 | 点"耗材丝/料盘平整侧面"；取 13×13 像素**中位色**抗噪、抗高光（已按 object-fit:contain 校正点击坐标） |
| 颜色命名 | 26 个常见耗材色名做 ΔE 最近邻，超过阈值显示"自定义"而不是瞎猜 |
| 色值格式 | 统一 `#RRGGBB` 大写；容忍 `#RRGGBBAA`（忽略 alpha） |

> 后续增强：拍摄时放一张白纸/灰卡做白平衡参考；或在照片边缘画参考色块。MVP 不做，因为增加拍摄步骤会降低录入意愿。

### 5.2 拍照添加：识别 / 手动二合一（可选视觉模型）

「拍照记录」和「图片识别」在产品上是同一件事，因此**只有一个入口**：「＋ 拍照添加耗材」。打开后：拍照/选图 → 有引擎就自动识别、没有就手填 → 结果列表（自动识别与手动行可混排）→ 核对 → 批量入库。单张照片含多盘时会展开成多条。

识别能力本身：家庭场景经常一次买一整箱（常见 6~10 盒），逐盒手填品牌/颜色/SKU 很烦，所以提供**图片识别**：

- **输入**：一张照片（单盒标签、整箱俯拍、料盘堆叠均可）。
- **识别引擎**：可插拔的视觉模型；默认自动检测本地 **Ollama**，也可配置任意 **OpenAI 兼容**接口（GLM-4.6V / Qwen-VL / GPT-4o 等）或 Anthropic 兼容接口。不配置时降级为「拍照取色 + 手填」，不影响主流程。
- **输出**：`items[]`，每项含 `brand / productLine / material / colorName / colorHex / sku / spoolWeightG / count / confidence / labelText`。
- **颜色校正**：模型只给近似色；本地色卡（SpoolmanDB 的 Polymaker Panchroma，340 条）按颜色名匹配到官方 `color_hex`，优先级高于模型估算。模型估算值与色卡值都保留（`modelColorHex` / `hexSource`），UI 标注来源。
- **人工确认**：识别结果全部可编辑（名称、颜色、品牌、材料、SKU、克重、数量），可删除误识别项、可手动「＋ 手动添加一行」与识别结果混排；确认后 `POST /api/spools/bulk` 一次创建多盘、共用一张照片。**绝不直接静默写库存**，避免模型幻觉污染账本。
- **图片放大与取色**：点击照片打开全屏浮层，支持滚轮/按钮缩放（1:1、放大、缩小）与拖动平移；点击放大图按点击坐标（含缩放换算）取 13×13 中位色，填入"当前选中"的条目（结果卡片可点选切换取色目标）。
- **失败处理**：未配置 / Ollama 未启动 / 模型不存在 / 超时 / JSON 不合法，都返回可读原因与下一步操作；识别失败不影响手动录入。

工程细节：
- Prompt 强制 JSON，并要求「每盒一条、不确定填 null、不编造 SKU」；Ollama 用 `format:"json"`，OpenAI 用 `response_format`。
- 解析容忍 markdown 代码块/前后废话；规范化时做材料推断、颜色兜底、同 SKU 去重并累加数量。
- 网关类服务可能需要额外的会话路由头（如 `x-opencode-session`），客户端默认附带随机值，普通 OpenAI 兼容服务会忽略。
- 实测踩坑（已写进代码）：① 部分网关对 `response_format: json_object` 会返回 `content` 为空，因此不发送该字段，靠提示词 + 容错解析；② 输出上限 `max_tokens` 超过 4k 会被上游 400，默认取 3500 并可通过 `settings.vision.maxTokens` / `VISION_MAX_TOKENS` 调整；推理型模型（DeepSeek）默认带 `reasoningEffort: "low"` + 「直接输出 JSON」的 system 提示，否则思考会耗尽 token 让正文为空（实测：不加时 12k reasoning / 正文 0；加了 10~11s、正文 3.5k、10 项全对）；③ 模型输出被截断时用宽松解析器恢复已完整的 item 并给出警告；④ 提示词要求先输出 `boxCount`（独立包装盒数量），后处理按"品牌+材料+颜色 ΔE≤4 且颜色名互相包含"合并疑似重复项，并在 `boxCount ≠ items.length` 时提示用户核对，解决"10 盒识别成 11 项"的模型计数漂移。
- 隐私：调用云端视觉接口意味着照片会上传；本地 Ollama 则完全离线。设置页会明确提示。

### 5.3 库存模型

料盘字段（`data/db.json`）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `s_` + 12 hex |
| `name` | string | 显示名，如「黑武士 PLA」 |
| `brand` / `type` | string | 品牌、材料类型（PLA/PETG/ABS/ASA/TPU/PA/PC/其他） |
| `colorHex` / `colorName` | string | 颜色与命名 |
| `totalGrams` / `remainingGrams` | number | 总重、剩余（g，0.1 精度） |
| `opened` | boolean | 由剩余量推导：剩余 < 总重即已开封 |
| `photo` | string | `/data/photos/…`，可为空 |
| `note` | string | 购买日期、烘干情况等 |
| `createdAt`/`updatedAt` | ISO string | 审计 |

不单独建"品牌/材料字典表"：家庭规模（<100 盘）下冗余字段更简单，匹配时用字符串归一化处理。

### 5.4 MakerWorld 数据获取（四层降级）

这是本设计里**最需要工程判断**的部分。2026-10 实测（本机、无登录、无代理）：

| 请求 | 结果 | 能拿到什么 |
| --- | --- | --- |
| `makerworld.com/.../models/<id>` | **403** + `Just a moment...`（Cloudflare） | 服务端抓页不可用 |
| `makerworld.com/v1/design-service/...` | **403** | 社区逆向库的默认 base，照抄必被拦 |
| `api.bambulab.com/v1/design-service/design/<id>` | **200** | 标题、slug、封面 `coverUrl`、作者、统计 |
| `.../design/<id>/instances` | **200** | 打印配置列表 `hits[]`：`id`、`profileId`、`title`、`cover`、`detail.*` |
| `.../instance/<id>/f3mf` | **403** `Please log in to download models.` | 下载直链需要登录 |

**关键陷阱：匿名请求是 HTTP 200 但字段被抹平**——`detail.weight = 0`、`detail.prediction = 0`、
`detail.instanceFilaments = null`、`detail.extention.modelInfo.f3mf.url = ""`、`detail.needAms = false`。
客户端必须用「`weight > 0 && f3mf.url`」识别"未登录态"，**绝不能把 0 克当成真实材料需求**。

`hits[]` 中的 `id`（instanceId）与 `profileId` 是**两个不同的 ID**；URL 锚点
`#profileId-<数字>` 对应后者。按锚点选配置时两个都要尝试匹配，否则会选错配置。

因此按可靠性分层，任何一层成功都能继续：

| 层 | 数据来源 | 可靠性 | 克重精度 | 触发方式 |
| --- | --- | --- | --- | --- |
| L1 | 打印配置 `.3mf`（`slice_info.config`） | **高**（离线文件） | 0.1 g | 用户上传（推荐）；登录态下服务端自动下载 |
| L2 | `api.bambulab.com` 匿名元数据 | 中高（实测 200） | 无 | 粘贴链接自动请求 |
| L3 | 登录态接口 / f3mf 直链 | 中（token 有效期/合规限制） | 0.1 g | 环境变量临时注入 Cookie，不落盘 |
| L4 | 页面 `__NEXT_DATA__`（油猴脚本） | 中低（页面结构会变） | 无 | 用户在 MakerWorld 页面点一下导入 |

最后兜底：**手动录入**（颜色/材料/克重由用户填写），任何一层失败都能继续。

设计取舍：

- **不做服务端硬刚 Cloudflare**：只使用常规公开接口与浏览器 UA 提升兼容性（不伪造登录态/IP/cookie）、不持久化 Cookie/clearance、不用无头浏览器过 Turnstile——"绕过访问控制"的做法既有 ToS/账号风险，工程上也不稳。
- **元数据链路仍有价值**：贴链接后立刻显示"模型名/作者/配置列表"，让用户确认贴对了，并把"下载打印配置"作为下一步引导，而不是只报错。
- **油猴脚本是合规性最好的自动化**：在用户已登录页面内、由用户点击触发，读取当前页面已有的 `__NEXT_DATA__` 后 POST 给本地服务，等价于"用户主动复制数据"；脚本不后台轮询、不批量抓取。
- **合规边界**：只处理用户主动粘贴的链接/主动上传的文件；单域名限速、失败指数退避、403/429 立即停并提示；不镜像、不再分发模型文件；不保存登录态。

失败时的 UX：明确区分三种情况——「站点拒绝（不是你的错）」「匿名态没有克重」「文件没切片」，并把「上传 3mf」「手动录入」按钮直接放在结果旁边。

### 5.5 3mf 解析（精确克重的关键）

`.3mf` 是 zip。与耗材相关的两个文件：

**`Metadata/slice_info.config`**（切片后才有，XML）—— 精确克重来源：

```xml
<config>
  <header><header_item key="X-BBL-Client-Version" value="01.10.00.89"/></header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="4823"/>       <!-- 秒 -->
    <metadata key="weight" value="165.6"/>          <!-- 平台总克重 -->
    <filament id="1" tray_info_idx="GFA00" type="PLA" color="#17181A" used_m="4.823" used_g="120.4"/>
    <filament id="2" tray_info_idx="GFA01" type="PLA" color="#F2F2EE" used_m="1.432" used_g="45.2"/>
  </plate>
</config>
```

要点：
- `filament.id` 是 **1-based** 的槽位号，转数组下标要减 1。
- 颜色以 `color` 为准；支持 6/8 位 hex（8 位含 alpha）。
- `used_g` 是切片器算出的真实克重，**比任何体积估算都准**（已含支撑、擦料塔、填充率等）。
- 一个 3mf 可能有多个平台（plate），每个平台单独列出耗材用量。
- 同一耗材可能出现在多个平台 → 按「类型 + 颜色」合并求和，得到整单需求。
- `tray_info_idx` 是**耗材配置 ID**，不是某个物理料盘的唯一 ID，不能当 spool_id 用。
- `metadata.weight` 可用于交叉校验：`|Σ used_g − weight| / weight < 2%`，超出则提示"数据可疑"。

**`Metadata/project_settings.config`**（切片前后都有，JSON）—— 兜底：

```json
{
  "printer_model": "Bambu Lab A1",
  "filament_type": ["PLA", "PLA"],
  "filament_colour": ["#17181A", "#F2F2EE"],
  "filament_ids": ["GFA00", "GFA01"],
  "filament_density": ["1.24", "1.24"]
}
```

未切片（没有 `slice_info.config`）时只能拿到颜色/类型，**没有克重**：UI 明确标注"克重未知"，匹配只按颜色/类型，扣减前要求补克重。后续可加网格体积估算（PLA 1.24 / PETG 1.27 / ABS 1.04 g/cm³，取 `project_settings.filament_density` 优先），但体积×密度会**高估 1.5~3 倍**（实际有填充率与壁厚），只能作为"估算值"让用户确认，不能假装精确。

待验证：MakerWorld 上「下载打印配置」得到的 3mf 是否一定自带 `slice_info.config`（自带则"下载即精确"，不带则需引导用户在 Bambu Studio 里切片后另存）。因此代码同时支持"已切片"和"未切片"两条路径，并以 UI 明确标注。

实现细节与容错：
- 只解压需要解析的两个元数据文件，跳过 `gcode`（MakerWorld 的 3mf 可能几十 MB），避免内存与耗时问题。
- 解析不依赖 XML 库：对 `<plate>`/`<metadata>`/`<filament>` 做逐标签解析，字段缺失给默认值并记 warning；文件损坏/非 zip 返回可读错误。
- 平台名（`model_settings.config` 的 `plater_name`）可用于 UI 展示，但不是必需品，MVP 未接。

### 5.6 匹配算法

输入：需求数组 `requirements[]`（type、colorHex、grams，可含平台/图号）+ 库存 `spools[]`；输出：每个需求一条分配结果。

**评分（越小越优先）**

```
score = 5 × ΔE2000(需求色, 料盘色)
      + (类型不符 ? 10000 : 0)          // 默认硬约束
      + (余量不足 ? 60 + 缺口比例×40 : 0) // 单盘不够时降级
      + (余量刚好够用 ? 0~3 : 0)         // 少留零头
      + (已开封 ? -2 : 0)               // 先清仓
```

**分配流程**

1. 需求按克重降序处理（大件优先占料盘）。
2. 过滤可用余量 > 0 的料盘（可用 = 库存剩余 − 本次已预留）。
3. 计算评分，取颜色在阈值内的最优者；没有则退回类型兼容集合的最优者，并标"颜色差异大"。
4. 单盘不够时，找同色（ΔE ≤ 阈值）且类型兼容的其它盘凑够（最多 3 盘），标"需拼盘"。
5. 记录本次预留，防止同一盘被两个不同需求重复占用（同色多需求可复用，剩余量累计扣）。

**状态机**

| 状态 | 触发 | UI |
| --- | --- | --- |
| `ok` | ΔE ≤ 5 且余量够 | 绿色「匹配成功」 |
| `color_near` | 5 < ΔE ≤ 12 且余量够 | 黄色「颜色相近」 |
| `combine` | 单盘不够、同色多盘可凑 | 黄色「需同色拼盘」+ 每盘取值 |
| `color_far` | ΔE > 12 | 红色，**不自动通过**，展示最接近项 |
| `insufficient` | 余量不够且无法拼盘 | 红色 + 缺口克重 |
| `no_type` | 没有类型兼容的料盘 | 红色 |
| `type_mismatch` | 开了"允许跨类型" | 红色 + 提示 |
| `no_stock` | 库存为空 | 红色 |

阈值默认 `goodΔE=5, maxΔE=12`（可在设置里改）。依据：CIEDE2000 下 ΔE≈1 为刚可察觉，2~5 为"近似可互换"，5~10 肉眼可辨，>10 明显不同；耗材还有光泽/纹理/批次差异，所以"同色"阈值宁可保守，让用户手动确认。颜色计算链路固定为 **sRGB(D65) → XYZ(D65) → Lab(D65) → CIEDE2000** 并已用 Sharma 测试集校验；不要混入 CSS `lab()` 的 D50 白点，否则蓝色/中性灰会出现 ΔE 2~4 的系统偏差。

**为什么不做全局最优（匈牙利算法）**：家庭场景需求 ≤ 10 项、料盘 ≤ 100，贪心 + 预留已足够；全局最优反而让"为什么选它"不好解释。等出现"多模型排队选料"再升级。

### 5.7 结果呈现与人工干预

- 每个需求卡片回答三个问题：**用哪盘（照片/色块+名称）、为什么（ΔE/余量/状态）、扣完还剩多少**。
- 下拉框可手动改选；改选后实时重算 ΔE 与扣减后余量，并重新判断状态（余量不足会阻止扣减）。
- "确认并扣减"只处理**可扣减项**；有问题项在提示里说明会被跳过，避免静默漏扣。缺克重的需求禁止确认，引导去编辑。

---

## 6. 数据模型

```
Spool 1 ────< JobItem >──── Job
                 │
                 └── 记录 spoolName/colorHex 快照（料盘删除后记录仍可读）
Requirement（运行时对象，不落库）：{index, type, colorHex, colorName, grams, display}
MatchResult：{assignments[], summary{totalGrams, okCount, problemCount, spoolsUsed}}
```

`data/db.json` 顶层：`{version, createdAt, updatedAt, spools[], jobs[], settings{match{}, vision{provider, baseUrl, model, apiKey}}}`。`vision.apiKey` 只存本地，不返回给前端。

- 打印记录里的 `items` 存料盘**快照**（名称/颜色），保证删料盘后历史记录不丢信息。
- 字段命名当前以可读性优先（`remainingGrams`/`totalGrams`）；后续与 Spoolman 互通时再映射到 `remaining_weight`/`initial_weight`/`used_weight`/`location` 等字段，避免一开始被外部 schema 绑死。
- **库存视图**：料盘只增不减时平铺卡片很占空间，因此提供「平铺 / 紧凑列表」切换、按品牌/材质/颜色/品牌+材质分组（默认按品牌，可折叠）、品牌与材质筛选下拉、搜索过滤；视图与分组偏好存 localStorage。列表行保留缩略图、余量与常用操作。
- **同款多盒**：识别结果里的 `count` 表示同款盒数。入库默认**合并为一条**（`count=N`、`spoolWeightG` 单盘克重、总量/余量=单盘×N，界面显示 ×N），避免同色料盘被拆成多条；需要逐盘记录时勾选「同款多盒拆成多盘」。另提供 `POST /api/spools/merge-duplicates` 与「🧩 合并同款」按钮，合并历史重复记录（数量/余量相加，共享照片按引用计数安全删除）。
- **商品图**：实拍图（`photo`）用于人眼核对；另异步抓一张「商品图」（`productPhoto`）美化列表。抓取流程：按「品牌 + 颜色名 + 材料」拼搜索词 → Bing 图片搜索 HTML 解析 `murl` → 按 URL 相关词打分（**品牌官网域名 +4**）排序 → 下载候选（校验 content-type、magic bytes、6KB~4MB）→ 落盘 `data/photos/product-*`。只接受公网 http(s)（防 SSRF）。
  - **入库自动拉图**：新增/批量入库后把新料盘 id 放入服务端内存队列，串行抓取（300ms 节流），进度通过 `/api/state.productImageQueue` 暴露；前端轮询并刷新列表。`AUTO_PRODUCT_IMAGES=off` 关闭自动、`PRODUCT_IMAGES=off` 整体关闭；失败不影响入库。
  - **相关性门槛**（血泪教训：曾把地图/猫/车轮当成商品图）：解析结果的 `title/purl/murl` 打分，必须命中品牌或颜色词且总分 ≥ 阈值，否则放弃；垃圾词黑名单；下载后用主色与料盘 `colorHex` 做 ΔE 校验（python3+Pillow，缺失自动跳过）；品牌官网域名 +4 分；Bing async 为主、百度图片 JSON 兜底。
- 设置里只存匹配阈值；**不保存** MakerWorld Cookie/账号信息。需要登录态时可临时用环境变量 `MAKERWORLD_COOKIE=... node server.mjs`，重启即失效。

---

## 7. 技术架构

### 选型

| 层 | 选择 | 理由 |
| --- | --- | --- |
| 服务端 | Node 18+ 原生 `http`，**零第三方依赖** | 家里/NAS 一条命令跑起来；无供应链风险；解析 zip 用 `node:zlib` |
| 前端 | 原生 HTML/CSS + ES Module，**无构建** | 改完刷新即生效；模块直接复用服务端颜色算法 `/lib/color.mjs` |
| 存储 | 单个 JSON + 照片文件，原子写 | 家庭数据量小；可直接备份/同步到网盘；`FM_DATA_DIR` 可指到 NAS |
| 测试 | `node:test` + HTTP 集成 | 零依赖，CI 友好 |

为什么不上 React/数据库：MVP 的复杂度在**解析与匹配**，不在 UI 状态管理；零依赖让"给家里老人/自己随便部署"成为可能。等 PWA/多用户阶段再评估。

部署形态：单机 `node server.mjs`（默认）／Docker（仓库含 `Dockerfile`，data 目录挂卷）／NAS 常开；手机端用 `--lan` 同 Wi-Fi 访问（或装 `harmony-client/` 鸿蒙客户端，API 23+，协议见 [CLIENT_PROTOCOL.md](./CLIENT_PROTOCOL.md)），若要用 PWA/相机高级能力则需 HTTPS 反代。暴露到局域网外时用 `FM_TOKEN` 开启接口令牌（除 `/api/health` 外都要 `x-fm-token`）。

### 架构

```
浏览器(手机/桌面)                Node 本地服务                本地文件
┌────────────────┐   HTTP    ┌──────────────────────┐   ┌──────────────┐
│ web/ 原生前端   │ ────────▶ │ server.mjs           │──▶│ data/db.json │
│ 拍照/取色       │           │ ├ /api/spools|match  │   │ data/photos/ │
│ 匹配结果/记录   │ ◀──────── │ ├ /api/import/3mf    │   └──────────────┘
└────────────────┘           │ ├ /api/makerworld    │
        ▲                    │ └ /api/jobs|settings │
        │ 油猴脚本导入        │ lib/{color,zip,       │
   makerworld.com ──POST────▶│     threemf,match,    │
                              │     makerworld,store}│
                              └──────────────────────┘
```

### API 一览

| 方法/路径 | 作用 |
| --- | --- |
| `GET /api/state` | 库存、记录、设置、匹配默认值 |
| `POST/PUT/DELETE /api/spools[/:id]` | 材料增改删（照片走 `photoDataUrl` base64） |
| `POST /api/spools/:id/consume` | 手动扣减 |
| `POST /api/match` | 需求 + 库存 → 匹配结果 |
| `POST /api/import/3mf` | base64 3mf → 精确需求 |
| `POST /api/makerworld/resolve` | 链接 → 需求（内部四层降级） |
| `POST /api/import/page` | 油猴脚本页面数据 → 需求 + `importId` |
| `GET /api/pending/:id` | 油猴导入结果（页面 `#import=id` 自动载入） |
| `POST /api/recognize` | 图片 → 结构化耗材清单（视觉模型） |
| `GET /api/vision/status` | 检测识别服务是否可用（不含 key） |
| `POST /api/spools/bulk` | 批量创建材料（识别结果导入，共用照片） |
| `POST/DELETE /api/spools/:id/product-image` | 单盘找/删商品图（Bing 图片搜索） |
| `POST /api/spools/product-images` | 批量补商品图（≤10 盘/次） |
| `POST /api/jobs` | 扣减 + 打印记录（原子；服务端校验余量/料盘存在） |
| `GET/POST /api/settings` | 匹配阈值（不保存 Cookie） |
| `GET /api/sample` | 内置示例模型 |

错误码语义：`invalid_url`（链接格式）、`upstream_blocked`（Cloudflare）、`no_requirements`（解析不到材料）、`download_unavailable`、`malformed_payload`。响应带 `fallbacks` 数组，前端据此展示退路。

---

## 8. 关键接口示例

**匹配** `POST /api/match`

```json
{
  "requirements": [
    { "index": 1, "type": "PLA", "colorHex": "#17181A", "grams": 120.4 },
    { "index": 2, "type": "PLA", "colorHex": "#F2F2EE", "grams": 600 }
  ]
}
```

```json
{
  "assignments": [
    {
      "requirement": { "index": 1, "type": "PLA", "colorHex": "#17181A", "grams": 120.4 },
      "status": "ok",
      "spool": { "id": "s_…", "name": "黑武士 PLA", "remainingGrams": 900, "colorHex": "#17181A" },
      "deltaE": 0.3,
      "alternatives": [],
      "parts": [],
      "shortfallGrams": 0,
      "message": ""
    },
    {
      "requirement": { "index": 2, "type": "PLA", "colorHex": "#F2F2EE", "grams": 600 },
      "status": "insufficient",
      "spool": { "name": "象牙白 PLA", "remainingGrams": 520 },
      "deltaE": 0,
      "shortfallGrams": 80,
      "message": "库存不足：还差约 80 g"
    }
  ],
  "summary": { "requirementCount": 2, "totalGrams": 720.4, "okCount": 1, "problemCount": 1, "spoolsUsed": 2 }
}
```

**扣减** `POST /api/jobs`

```json
{
  "title": "三色小夜灯",
  "sourceUrl": "https://makerworld.com/zh/models/1234567",
  "items": [{ "spoolId": "s_abc123", "grams": 120.4 }]
}
```

---

## 9. 错误处理与可观测性

- 解析层统一返回 `{ok, reason, message, fallbacks, warnings}`，不抛业务异常给用户；服务端只对真正 500 记录日志。
- **跨域防护**：默认只监听 `127.0.0.1`；CORS 不再使用 `*`，仅允许同源请求与「MakerWorld 页面 → `/api/import/page`」这一条跨域写路径，其余跨域读写返回 403（防止任意网页读取/删除本地库存）。
- API Key 只存本地 `data/db.json`，`/api/state`、`/api/settings` 只返回 `hasApiKey` 布尔值；错误响应不泄漏内部路径。
- 只把 `/api/health`（仅 `ok/version`，无数据）开放给任意本地来源，供前端探测"新版服务是否在跑"；检测到页面连的是旧实例时，页头提示并自动跳转到新端口，避免"静态页是新的、接口是旧的"这种割裂状态。
- `warnings` 在 UI 用黄色条展示（未切片、页面数据不完整、接口超时等）。
- 所有外网请求有超时（默认 8~20s）、重试上限、下载大小上限；不记录、不持久化用户 Cookie。
- 数据文件损坏时服务端报可读错误，不静默重建（避免覆盖用户数据）。

---

## 10. 测试策略（已实现 77 个）

| 层 | 覆盖 |
| --- | --- |
| 颜色 | CIEDE2000 与 Sharma 参考数据 12 组逐一比对（误差 <1e-3）；hex/rgb/lab 转换；颜色命名 |
| 匹配 | 精确匹配、类型家族、先清仓、拼盘、余量不足、颜色差异、类型不符、多需求预留、克重未知、空库存、单候选评估 |
| 3mf | zip 读取、已切片双平台解析、8 位色值归一化、多平台合并/单平台过滤、未切片退化 + 警告、XML 容错、标题工具 |
| HTTP | 健康检查/首页/静态 lib、初始库存、示例匹配状态断言、3mf 上传、材料增改删扣、扣减落库与二次校验（不存在/超量/重复）、CORS 拒绝陌生 origin、批量创建、非法请求、设置持久化 |
| 图片识别 | 真实模型响应 fixture（Panchroma 10 盒）解析/规范化、色卡校正、JSON 容错、Ollama/OpenAI 两种 provider（mock fetch）、`/api/recognize` + 批量入库端到端（mock 视觉服务） |

测试数据用 `tools/make_fixture_3mf.py` 生成真实 zip 结构（含 `slice_info.config`/`project_settings.config`），避免 mock 得太理想。

---

## 11. 竞品与差异化

| 产品 | 强项 | 缺什么（相对本设计） |
| --- | --- | --- |
| **Spoolman**（自托管，MIT，约 2.9k★） | 成熟的料盘账本、REST API + WebSocket、SpoolmanDB（67 厂商 / 8120 条色号）、QR 标签、OctoPrint/Fluidd/HomeAssistant 集成 | 没有拍照取色；没有"MakerWorld 模型需求 → 从我的库存选料"；偏打印机侧用量统计 |
| **SimplyPrint Filament Manager**（商业 SaaS） | 单盘"数字孪生"、OpenPrintTag/OpenSpool 等 6 种 NFC 标准、称重校准、近空提醒 | 云依赖、免费套餐限 50 盘；无 MakerWorld 选料 |
| **Filament Manager**（OctoPrint 插件，AGPL） | 与打印任务联动、余量告警 | 2021 年后停更；绑定 OctoPrint |
| **Printago**（商业） | 云切片管线、3MF 解析、农场管理 | 面向打印农场，非家庭场景；无拍照录入 |
| **3DPrintLog** | 打印日志 | 库存精细度与 API 能力弱 |

**空白点确认**：以上产品没有一家做「粘贴 MakerWorld 链接 → 从我的库存挑一盘 → 明确提示缺色/缺料/缺重量」的闭环。这是本项目的差异化，也是唯一值得投入的复杂度。

可复用生态：
- **SpoolmanDB**（MIT，`filaments.json` 8120 条 / `materials.json` 34 种密度）可作为色号与品牌预设种子库；后续字段命名向 Spoolman 对齐（`remaining_weight`/`used_weight`/`spool_weight`/`location`）以便互通。
- **拓竹 RFID / OpenSpool**（v2 可选硬件）：官方标签为 MiFare Classic，数据块含 RSA-2048 签名，可克隆但改一字节即失效；OpenSpool 用 NTAG215/216 写 NDEF JSON + ESP32/PN532 读卡，经 MQTT 推送。成本和排障门槛高于收益，**不进 v1 关键路径**。

## 12. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| MakerWorld 反爬升级/接口变化 | 链接解析失败 | 四层降级 + 3mf 上传是主路径；解析代码防御式取值，字段缺失不崩 |
| 匿名接口字段被抹平（`weight=0`） | 把 0 克当真实需求 | 用 `weight > 0 && f3mf.url` 判定登录态；0/空值不参与匹配 |
| 保存登录 Cookie 的合规风险 | ToS/账号风险 | 不落盘；仅环境变量临时注入；油猴脚本走"用户主动触发"路径 |
| 3mf 无切片数据 | 无精确克重 | 明确标注"克重未知"，禁止直接扣减，引导补录；P1 做体积估算 |
| 照片偏色 | 选错颜色 | 允许手动改色；ΔE 阈值偏保守；展示照片供人核对 |
| 同色多盘拼接实际打印难做 | 方案不可执行 | 只作建议，需人工确认；后续可按 AMS 槽位约束 |
| 本地数据丢失 | 库存记录没了 | `data/` 一键备份；建议放 NAS/网盘同步；后续加导出 |
| 局域网无鉴权 | 同网段可访问 | 默认只绑 127.0.0.1；`--lan` 提示仅临时使用 |
| 用户填的克重不准 | 余量账本漂移 | 记录可追溯；P1 加"盘点校准"与打印机回写 |
| 视觉模型幻觉（品牌/SKU/数量） | 库存数据错乱 | 结果只作候选、逐项可编辑、需人工确认才入库；色卡覆盖模型颜色；SKU 不做唯一键 |
| 云端视觉接口上传照片 | 隐私顾虑 | 支持本地 Ollama 完全离线；设置页明示；不配置则只用本地取色 |
| 视觉服务不可用/超时 | 识别失败 | 明确错误原因与配置指引；手动录入/取色始终可用 |
| 商品图搜索不稳定/不相关 | 图片不对 | 可从卡片换图/删图；关键词含品牌+颜色+材料；可整体关闭 |
| 商品图版权 | 版权风险 | 仅个人库存展示、保留来源 URL；不二次分发；可关闭 |

---

## 13. 路线图

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| v0.1（本版） | 拍照入库、3mf/链接解析、匹配、扣减、记录 | 本地 3 分钟跑通示例；31 测试通过 |
| v0.2（部分完成） | 图片识别（单盒/整箱）、批量入库、颜色色卡校正 | 已可用：识别 10 盒 Panchroma 入库 |
| v0.3 | PWA 离线、拍照直传、撤销扣减、CSV 导出 | 手机添加到主屏可用 |
| v0.4 | 未切片体积估算、识别结果与官方色卡持续同步 | 拍照命中率与人工确认流程可量化 |
| v0.5 | Spoolman 同步、打印机真实用量回写 | 与 Spoolman 双向导入导出 |
| v1.0 | RFID/NFC 自动识别、多用户/家庭共享 | 硬件可选，不影响无硬件体验 |

---

## 14. 验收清单（给使用者/评审）

- [ ] `npm start` 后打开 `http://127.0.0.1:4173`，能看到 6 盘示例库存。
- [ ] 添加一盘料：拍照 → 点照片取色 → 颜色/色名自动变化 → 保存后出现在列表且余量条正确。
- [ ] 点「试用示例模型」→ 自动出现 4 项需求与匹配结果：黑色匹配成功、白色余量不足（差 80 g）、红色匹配成功、琥珀 PETG 颜色差异大。
- [ ] 上传 `data/examples/sample-multicolor.3mf` → 显示两个平台、3 项合并需求、克重精确。
- [ ] 确认扣减 → 打印记录出现该次打印，库存剩余量减少。
- [ ] 设置里把 ΔE 上限调到 6 后重新匹配，结果变严格（更多"颜色差异大"）。
- [ ] 材料库 →「＋ 拍照添加耗材」→ 选一张整箱照片 → 自动得到可编辑的耗材清单（品牌/颜色/SKU/克重）→ 批量入库。
- [ ] 点击照片能放大，滚轮/按钮缩放、拖动平移；在放大图上点一下能把颜色取到当前选中的条目。
- [ ] 没有识别引擎时，同一个入口仍可手动添加一行并入库（不用换页面）。
- [ ] 手机同一 Wi-Fi 用 `--lan` 打开，能拍照并完成一次录入。

---

## 15. 参考

- MakerWorld 社区逆向工程（接口/`__NEXT_DATA__` 解析思路）：<https://github.com/kloshi-io/makerworld-api-reverse>
- 3MF（Bambu/Orca）结构与 `slice_info.config` 字段说明：<https://printago.io/blog/3mf-file-format>
- Bambu Studio 3mf 切片信息解析参考实现：<https://github.com/maziggy/bambuddy>
- CIEDE2000 与测试数据：Sharma, Wu & Dalal, *The CIEDE2000 Color-Difference Formula* (2005)
- Spoolman（自托管耗材管理生态）：<https://github.com/Donkie/Spoolman> · 色号库 SpoolmanDB：<https://github.com/Donkie/SpoolmanDB>
- 拓竹 RFID 与 OpenSpool（v2 可选硬件）：<https://github.com/ChristopherUC/rfid-tag-guide> · <https://github.com/spuder/OpenSpool>
- 更细的调研（RFID/OpenSpool、竞品、拍照颜色科学）：见 [research.md](./research.md)
