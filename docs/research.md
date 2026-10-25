# 家庭 3D 打印耗材管理软件 · 调研笔记
> 目标：拍照记录耗材 + 粘贴 MakerWorld 链接自动选料盘（颜色/材料/余量匹配）并提示缺料。
> 方法：2026-10-18 本机（Linux，直连）实测 `makerworld.com` / `api.bambulab.com` / `wiki.bambulab.com` 的 HTTP 行为，其余引自文末链接。**【实测】**=本次 curl/读源码确认；**【待验证】**=有线索未亲验；未标记=引自公开资料。

## 0. 一句话结论
MakerWorld 分两层：被 Cloudflare 挡住的网站层，和**元数据匿名可读、下载必须登录**的 `api.bambulab.com` 接口层；而"克重/材料"真正可靠的来源不是接口，是**用户主动提供的 `.3mf` 里的 `Metadata/slice_info.config`**。故架构为「3mf 解析为主、链接解析为辅、拍照取色只做排序建议」。

## 1. MakerWorld 链接形态与数据获取
### 1.1 URL 形态与解析规则
| 形态 | 示例 | 要点 |
|---|---|---|
| 标准模型页 | `https://makerworld.com/zh/models/1400373-self-watering-seed-starter` | `/models/(\d+)` 取 designId；**slug 可省、可任意**，无语义 |
| 站点语言前缀 | `https://makerworld.com/en/models/1400373` | `/en/`、`/zh/` 等 locale 前缀不影响 ID |
| 打印配置锚点 | `.../models/1400373#profileId-1452154` | 锚点是 **fragment，不发给服务端**，必须前端读 `location.hash`；容错 `#profileId=<id>`、省略 `https://` 的写法 |

- 规范化主键用 `(designId, profileId?)`，不要用整条 URL——同模型多配置、slug/locale 会变。
- 【实测】[OpenSpool README](https://github.com/spuder/OpenSpool) 含真实带锚点链接 `makerworld.com/en/models/944499-openspool-mini#profileId-910780`，形态成立。
- 参考实现：[bambuddy `makerworld/url.py`](https://github.com/maziggy/bambuddy/blob/main/backend/app/services/model_providers/makerworld/url.py)（`\/models\/(\d+)`、`#profileId[-=](\d+)`，严格校验 host）。

### 1.2 链路可达性【实测 2026-10-18】
| 目标 | 结果 | 含义 |
|---|---|---|
| `GET makerworld.com/en/models/1400373` | **403** `Just a moment...` | 服务端抓 HTML 不可用 |
| `GET makerworld.com/v1/design-service/design/1400373` | **403** | 站点侧 API 路径同样被 CF 拦 |
| `GET makerworld.com/en/robots.txt` | 200 | 内容可读，见 §1.6 |
| `GET api.bambulab.com/v1/design-service/design/{id}` | **200，零凭证** | 标题/封面/作者/统计全给 |
| `GET .../design/{id}/instances` | **200** | 配置列表有，**关键数字被抹空**（§1.3） |
| `GET .../instance/{id}/f3mf`、`.../design/{id}/model` | **403** `{"code":1,"error":"Please log in to download models."}` | 下载须 Bambu Cloud Bearer |
| `GET .../profile/{profileId}` | 200，仅 4 字段 | 信息量极低，不可依赖 |

> **"本机 curl 被 403"只对网站域成立**；匿名可读元数据 ≠ 可拿克重。`wiki.bambulab.com` 可正常访问；`bambulab.com`（官方商城）同样 403。

### 1.3 匿名 payload 字段（来自真实响应，非猜测）
`/design/{id}` 有 65 个顶层键，可用：`id`、`title`、`slug`、`coverUrl`（CDN `makerworld.bblmw.com`）、`summary`(HTML)、`tags`、`designCreator`、`license`、`defaultInstanceId`、`likeCount/printCount/downloadCount`、`createTime`。
`/design/{id}/instances` → `{total, hits[]}`，单条 `hit`：

| 字段 | 匿名态 | 说明 |
|---|---|---|
| `id` / `profileId` | 有值 | instanceId 与 profileId **是两个 ID**，勿混用 |
| `title` / `cover` / `creator.{uid,name,handle,fanCount}` | 有值 | `title` 是配置名（如 `0.2mm layer, 2 walls, 10% infill`），非模型名 |
| `detail.prediction` / `detail.weight` | **0 / 0** | 预计秒数 / 预计克重，登录后才有 |
| `detail.materialCnt` / `materialColorCnt` / `needAms` | **0 / 0 / false** | 材料数、颜色数、是否需 AMS |
| `detail.instanceFilaments` | **null** | 耗材清单（类型+颜色）——**本项目最想要，匿名不可得** |
| `detail.extention.modelInfo.f3mf.{url,size}` | **`""`** | 3mf 直链，登录后才有 |
| `detail.extention.modelInfo.plates` / `compatibility.{devModelName,nozzleDiameter}` | **null / `""`,0** | 分盘信息；机型与喷嘴 |

> 危险点：匿名请求 **HTTP 200 但字段静默抹平**（非 404/403），客户端极易写出"预计 0 克"的假数据——必须用 `weight > 0 && f3mf.url` 判据识别未登录态。
> 【待验证】带合法 token 时的真实取值；`instanceFilaments` 元素结构未知，勿提前写死解析器。

### 1.4 社区逆向库：`kloshi-io/makerworld-api-reverse`
- 事实核对：README/MANUAL/API 确实写了 base `https://makerworld.com/v1/design-service`、端点 `/design/{id}`、`/design/{id}/instances`、`/profile/{profileId}`、`/instance/{instanceId}/f3mf`、`/design/{id}/model`，以及"API 失败 → 抓页面 `__NEXT_DATA__` 兜底"的两级管线——与任务描述一致。
- **但成熟度要打折**：仅 **2 star**、Apache-2.0、最后推送 2026-02-21；**base 指向被 CF 挡的 `makerworld.com`**，照抄必 403。
- 代码层的诚实信号：它不用固定字段名，而用 `findStringByHints(payload,["printername","printer","machine"])`、`findNumberByHints(["estimatedweight","filamentweight","grams","weight"])` 这类**模糊提示匹配**——恰好证明上游字段名不稳定。`src/api.ts` 唯一硬编码是四个头：`x-bbl-client-type: web`、`x-bbl-client-version`、`x-bbl-app-source: makerworld`、`x-bbl-client-name: MakerWorld`。
- 更值得参考的生产实现是 [bambuddy](https://github.com/maziggy/bambuddy/tree/main/backend/app/services/model_providers/makerworld)：base 用 **`https://api.bambulab.com/v1/design-service`**（注释明写"网站域在 CF 后，纯 httpx 被指纹成 bot 并返回 Please log in"）；复用 Bambu Cloud bearer token；3mf 走 S3 预签名（`*.amazonaws.com`）；CDN 白名单仅 `makerworld.bblmw.com`、`public-cdn.bblmw.com`；3mf 上限 200 MB；**如实声明 UA** 而非伪装浏览器。

### 1.5 四条获取路径的工程评价
| 路径 | 能/不能 | 稳定性 | 工作量 | 合规 |
|---|---|---|---|---|
| A 服务端直抓 `api.bambulab.com`（匿名） | 元数据 ✅；克重/材料/下载 ❌ | 中（字段会变、可能加签） | 低 | 中（公开数据 + 未文档化接口） |
| B 浏览器扩展/油猴在**已登录页面**内读 DOM 或 `__NEXT_DATA__`，POST 到本地 | 全量 ✅（含 `instanceFilaments`、3mf 链接） | **高**（随页面变，但用户当场可见失败） | 中 | **最好**：用户在自己会话主动提交 |
| C 用户手动下载打印配置 `.3mf` 再上传 | 精确克重/材料/颜色 ✅ | **最高**（离线文件，无网络依赖） | 低 | **最好**（用户主动提供文件） |
| D 服务端持 cookie / CF clearance | 全量 | **低**（clearance 分钟级过期、绑 IP/UA、Turnstile 打不过） | 高 | **差**：违反"不绕过访问控制"，有 ToS/封号风险 |

**建议**：v1 只做 **C（上传 3mf）+ A（贴链接补标题/封面，失败则只存 URL）**；**B** 作可选插件增强并明示"需你已登录"；**D 不做**。降级链：链接 → A 元数据（无克重）→ 提示"下载打印配置并拖进来" → C 精确解析 → 兜底"只存链接、手填克重"。

### 1.6 合规、robots 与速率
- `robots.txt`【实测原文】：`User-agent: * / Allow: /`，仅 `Disallow` `/sign-in`、`/my`、`/policies` 及 locale 变体（`/*/sign-in` 等），另有 `Sitemap`。→ 模型页**未被 robots 禁止**，但这只是最低门槛，不等于授权。
- MakerWorld 服务条款正文【待验证】：`/en|/zh/policies/terms` 从本机均 CF 403，无法核对，**上线前必须人工读**（重点：automated access、数据再利用、模型文件再分发）。
- 把合规做成**架构属性**：① 只解析用户主动粘贴的链接/上传的文件，不站内爬取、不批量导入、不目录浏览；② 只缓存元数据与用户自己的匹配结果，不镜像/不再分发 3mf 与原图；③ 单域名 QPS≤1、指数退避、遵守 `Retry-After`，403/429 立即停并提示"需登录/被限流"；④ 不伪装 UA、不伪造 Referer 绕校验；⑤ 上游失败一律给可解释原因 + 人工兜底入口。

## 2. 3mf 文件结构（Bambu Studio / OrcaSlicer）
`.3mf` 就是 **zip**，改名 `.zip` 即可解开，无需 3MF SDK；判断"是否已切片"最稳的判据是 zip 内是否存在 `metadata/*.gcode`（或 `slice_info.config` 里有真实 `<plate>`），**不要看文件名**（OS 会造出 `model.gcode (1).3mf`）。

### 2.1 `Metadata/` 关键文件
| 文件 | 格式 | 作用 | 本项目用途 |
|---|---|---|---|
| `slice_info.config` | XML | 每盘耗材用量 + 时间，**仅切片后存在** | ★ 精确克重唯一权威来源 |
| `project_settings.config` | **JSON**（扩展名骗人） | 全部切片设置：`filament_colour`/`filament_type`/`filament_density`/`filament_diameter`/`filament_ids`（按槽位 0-based 平行数组）、`printer_model`/`printer_variant`/`print_compatible_printers` | ★ 颜色/材料/密度权威来源 |
| `model_settings.config` + `plate_N.json` | XML / JSON | 盘布局、对象/部件 `extruder`（**1-based 槽位**）、缩略图与 gcode 路径；`plate_N.json` 为盘级对象/bed/喷嘴补充（新版才有） | 未切片时推断用了哪些槽；盘名/喷嘴 |
| `plate_N.gcode` / `plate_N.png` | 文本 / PNG | G 代码；盘缩略图（无头切片可能空白） | 兜底解析尾部统计；UI 展示 |
| `custom_gcode_per_layer.xml` | XML | 换色/换料事件（`extruder`、`top_z`） | 交叉校验用了哪些槽；**其中 `color` 是陈旧值，禁用** |
| `3D/3dmodel.model` + `3D/Objects/*.model` | XML | 几何（production extension 拆分）+ `<metadata name="Application">` 判 slicer 版本 | 未切片时算体积；逐面 `paint_color` |

来源：[Printago《3MF File Format》](https://printago.io/blog/3mf-file-format)（逐文件给示例与代码，公开资料中最完整）。

### 2.2 `slice_info.config` 结构与易错点
```xml
<config><header><header_item key="X-BBL-Client-Version" value="01.10.00.89"/></header>
 <plate><metadata key="index" value="1"/><metadata key="prediction" value="4823"/>
  <metadata key="weight" value="18.46"/><metadata key="printer_model_id" value="Bambu Lab X1 Carbon"/>
  <filament id="1" tray_info_idx="GFB98A2CA6" type="PLA" color="#FF0000" used_m="4.823" used_g="14.21"/>
  <warning msg="..." level="1" errorCode="1000C001"/></plate></config>
```

| 字段 | 语义 |
|---|---|
| `filament/@used_g` / `@used_m` | 该盘该槽**克重**（本项目主指标）/ 米数（×1000=mm，按长度扣减） |
| `filament/@id` | **1-based 槽位**，转数组索引要 `-1`（几乎人人都踩） |
| `filament/@type` / `@color` | 与 `project_settings.filament_type` / `filament_colour` 对应 |
| `filament/@tray_info_idx` | 耗材**配置** ID（与 `filament_ids` 同族），**不是物理料盘唯一 ID**，不能当 `spool_id`（社区实践是拿它比对 AMS 当前装载） |
| `metadata/@weight` / `@prediction` | 整盘合计克重（应≈Σ`used_g`，误差 >2% 标"数据可疑"）/ 预计秒数（不是分钟） |
| 多盘 | `<plate>` 可多个；同名 `filament id` 跨盘重复 → 按槽位去重求和 |

### 2.3 精确克重优先级与未切片退化
① `slice_info.config` → `plate/filament/@used_g`（**首选**：切片器算的，含填充/支撑/擦料塔）；② 同文件 `plate/metadata/@weight`（校验）；③ `plate_N.gcode` 尾部统计（部分导出缺 `slice_info`，`filament-meter` 即这么兜底）；④ 体积×密度估算——**误差最大**。
估算公式：`g/mm = ρ × π × (d/2)² / 1000`，PLA/1.75 mm ≈ **0.002954 g/mm**（1 kg ≈ 338 m）。密度（[SpoolmanDB materials.json](https://donkie.github.io/SpoolmanDB/materials.json) **实测抓取**，34 种）：PLA/PLA+ 1.24、PETG 1.27、ABS 1.04、ASA 1.05、TPU(88A) 0.89、PC 1.30、PA 1.52、HIPS 1.03、PVA 1.23、Wood 1.28、CF 1.30、PVB 1.10。
**陷阱**：模型体积是实心体积，直接乘密度会**高估 1.5~3 倍**（填充率+壁厚）。UI 必须标"估算"，用 `solid_ratio ≈ min(1, 壁数×0.4mm/特征厚度 + infill%)` 折算，或直接建议切片后另存——**不要假装精确**。密度优先取 `project_settings.filament_density`（作者实际用的），库值仅兜底：同材料跨厂商差异真实（实测 Sunlu ABS 1.04 vs Overture ABS 1.15）。

### 2.4 现成解析库
| 库 | 许可 | 能力 | 评价 |
|---|---|---|---|
| [lib3mf](https://pypi.org/project/lib3mf/) 2.5.0 | BSD-2 | 3MF 官方参考实现（几何/生产扩展） | 重；**不解析 Bambu 私有 metadata**，收益低 |
| [filament-meter](https://pypi.org/project/filament-meter/) | MIT | `slice_info` → gcode 尾部 → `plate_N.json` 降级链；缺切片自动调 OrcaSlicer | **思路可直接抄**；依赖重，只借鉴优先级设计 |
| [bambuddy `filament_requirements.py`](https://github.com/maziggy/bambuddy/blob/main/backend/app/services/filament_requirements.py) | — | `zipfile`+`ElementTree`，按 `plate_id` 过滤、跨盘按槽位取最大 `used_g`，输出 `[{slot_id,type,color,tray_info_idx,used_grams,nozzle_id}]` | **最佳参考**，约百行、零第三方依赖 |

> 结论：**不必引库**。`python zipfile + xml.etree`（或 `jszip + DOMParser`）足够，且能把"新旧格式兼容"的脏活握在自己手里（bambuddy 同时支持新版 `<plate>` 包裹与旧版 `filament` 直挂 root）。多色 `paint_color` 逐面着色是序列化的 `TriangleSelector` 细分树（[dev.to 解码](https://dev.to/bubudong/how-bambu-studio-stores-multi-color-painting-in-a-3mf-decoding-paintcolor-in-the-browser-20n7) 与 [Printago 码表](https://printago.io/blog/3mf-file-format) 说法冲突），本项目只需槽位级信息，**v1 不必碰**。

## 3. 拍照记录与颜色匹配的颜色科学
手机拍照到"可比较颜色"要过 5 关：镜头/传感器 → 自动曝光 → **自动白平衡（最大误差源）** → sRGB 编码 → JPEG。同一盘料在窗边/暖光下拍出的 hex 差异可超 ΔE 20，**"拍一张就自动定色"的承诺必然是错的**；正确形态是"拍照 → 给候选 → 人确认"。

### 3.1 白平衡三手段
| 手段 | 做法 | 效果 | 成本 |
|---|---|---|---|
| 灰卡/白纸参考 | 同图放 18% 灰卡或白纸，取中位色做通道增益 | **最好**，可压到 ΔE 2–5 | 多一个动作；可做成拍摄引导 |
| Gray-world | 假设整图均值中性，RGB 均值归一 | 凑合；**画面有大面积单色（一整卷红料）时失效**——恰是本项目典型场景，慎用 | 零 |
| 手动吸管 | 用户点"这是白/这是该色" | 最可控，符合"必须允许手动校正" | 低 |

参考：[Color balance](https://en.wikipedia.org/wiki/Color_balance)（gray-world/white-patch/Retinex 来历）；OpenCV 有 `cv::xphoto::createGrayworldWB()`（[文档](https://docs.opencv.org/4.x/d7/dd5/classcv_1_1xphoto_1_1GrayworldWB.html)，本机 curl 被 CF 拦，链接本身有效）。

### 3.2 sRGB → CIELAB：**D50 陷阱**
sRGB 白点是 **D65**（x=0.3127,y=0.3290），而 CSS Color 4 的 `lab()` 用 **D50**（x=0.3457,y=0.3585）——规格原文："The white point is D50, the same as is used by CIE Lab… convert from a D65 whitepoint (used by sRGB…) to the D50 whitepoint used in Lab, with the linear Bradford transform"（[CSS Color 4](https://www.w3.org/TR/css-color-4/)【实测抓取】）。
后果：直接用浏览器 `lab()` 或默认 D50 的库算 ΔE00 会引入白点错配，**蓝色/中性灰最明显，量级 ΔE 2–4**——正落在我们的判据区间内。做法：固定链路并写测试用例——sRGB(8bit,D65) → 线性化 → XYZ(D65) →（ΔE00 前 Bradford 适应到 D50）→ Lab → ΔE00；或用 **Oklab** 粗筛（D65，快），只在终判用 ΔE00。参考：[CIELAB](https://en.wikipedia.org/wiki/CIELAB_color_space)、[Sharma 2005 CIEDE2000 注记（含测试数据）](http://www.ece.rochester.edu/~gsharma/ciede2000/ciede2000noteCRNA.pdf)。

### 3.3 ΔE 阈值：能引用与不能引用的
| 来源 | 说法 | 可信度 |
|---|---|---|
| [Delta E 101](https://zschuessler.github.io/DeltaE/learn/) | `≤1.0` 不可感知；`1–2` 需细看；`2–10` 一眼可辨；`11–49` 更接近而非相反 | 作者**自述为个人测试、非权威**，仅作序参 |
| 纺织/涂料业界 | 验收常卡 `ΔE00 ≤ 1.0`（严）～`2.0`（宽） | 行业惯例（Datacolor《Color Differences & Tolerances》） |
| Sharma 2005 | 正确实现 + 测试对；180° 色相处不连续约 ΔE 0.27 | 权威，用于**验证实现正确性**而非定阈值 |

**本项目阈值（工程折中，需用自家照片标定后再调）**：`<2` 同色可互换→置顶推荐；`2–5` 近似（同色系/批次差异）→推荐并标"近似"；`5–10` 肉眼可辨→列出但降权、要求确认；`>10` 明显不同→仅作"缺色替代"并明确警告。配套：**别只比平均色**——取料盘侧面 ROI 中位色、剔除 L\* 最高/最低各 10% 像素；比较时 **a\*/b\* 优先于 L\***（认色靠色相，明度最受光照影响）；`translucent`/`silk`/`matte` 单独标记（同 hex 不同光泽实拍差异巨大）。

### 3.4 色名 ↔ hex 数据源
| 来源 | 规模【实测】 | 字段 | 许可 | 备注 |
|---|---|---|---|---|
| [SpoolmanDB `filaments.json`](https://donkie.github.io/SpoolmanDB/filaments.json) | **8120** 条（重量/颜色/直径笛卡尔展开）、**67** 厂商；Bambu Lab **287**、Polymaker 1291、eSun 321 | `manufacturer/material/name/color_hex/color_hexes/density/weight/spool_weight/spool_type/extruder_temp/bed_temp/finish/pattern/translucent/glow` | MIT | 事实标准，Spoolman 原生使用，**首选** |
| [Open Filament Database](https://github.com/OpenFilamentCollective/open-filament-database) | 58★ MIT，2026-10 活跃 | 品牌/材料线/颜色/温度/密度/盘重 | MIT | SimplyPrint 预设来源，结构更规整 |
| Bambu 官方商城色卡 | — | — | 版权保留 | 实测 403，只能人工抄录，**不要爬** |

真实样例（可当种子数据）：`Bambu Lab / PLA / Bambu Green / #00AE42 / 1.24`、`Bambu Lab / ABS / Azure / #489FDF / 1.05`、`Polymaker / ABS / PolyLite ABS Black / #16161A / 1.12`。两个坑：① 厂商色名≠单一 hex（`Jade White`、`Galaxy Black` 带纹理/闪粉，实拍会漂）；② 同色名跨厂商差异大 → **hex 当主键、色名只作展示**，并允许"我这盘实际颜色"覆盖库值。

### 3.5 要不要用多模态大模型
| 用法 | 可行性 | 风险 |
|---|---|---|
| 读标签文字（品牌/材料/色名/批号） | **可行**（OCR 任务）；本地 PaddleOCR 零成本零隐私风险 | 反光/暗光误读；全角与艺术字 |
| 直接判"这是什么颜色" / 识别品牌型号 | **不推荐** | 颜色命名不稳定（同图两次答案可能不同）、无法校准置信度、幻觉品牌名是高频失败模式；外观相似的盘无法区分 |

成本量级【待验证】：主流 VLM 单图约几厘到几分人民币，家庭场景（每天几张）可忽略；**真正成本是误判导致的错料打印**。结论：VLM 只用于"提取候选文本、预填表单"，一律人工确认，**不参与最终匹配决策**。

## 4. 竞品与可复用生态
### 4.1 横向对比
| 产品 | 形态/许可 | 强项 | 缺什么 |
|---|---|---|---|
| [Spoolman](https://github.com/Donkie/Spoolman) 2920★ MIT | 自托管，SQLite/PG/MySQL | REST+WebSocket 实时扣减；SpoolmanDB 预设；QR 标签；OctoPrint/Moonraker/Fluidd/Mainsail/HA/MCP 全家桶 | **无拍照取色**；**不支持 MakerWorld 链接选料**（纯账本） |
| [Filament Manager](https://plugins.octoprint.org/plugins/filamentmanager/) AGPLv3 | OctoPrint 插件 | 按重量显示、软件里程计、余量不足告警、打完自动暂停、导入导出 | 最后发版 1.9.1（**2021-11**）、≈948 装机/月，生态停滞；绑 OctoPrint |
| [SimplyPrint](https://help.simplyprint.io/en/article/the-filament-manager-feature-track-organize-and-manage-your-filament-inventory-bpy529/) 商业 SaaS | 云 + 手机 App | **按单盘"数字孪生"**、QR/NFC（6 标准）、hex 可搜、50g/10% 判近空、称重/长度/百分比三路校正 | 云依赖、Free 限 50 盘；**无 MakerWorld 选料** |
| [Printago](https://printago.io/) 商业 | 云切片 + 农场 | 云端切片管线、3MF 解析（本文 §2 来源）、成本核算 | 面向农场，非家庭；无拍照取色 |

**空白点确认**：以上无人做"贴 MakerWorld 链接 → 从我的库存挑一盘 → 提示缺料"。这是差异化所在，也是唯一值得投入的复杂度。

### 4.2 Spoolman API 速查（兼容/迁移用）
| 能力 | 端点 | 关键字段【读源码确认】 |
|---|---|---|
| 料盘 CRUD | `GET/POST/PATCH /api/v1/spool` | `filament_id, remaining_weight, used_weight, initial_weight, spool_weight, price, location, lot_nr, comment, archived, extra` |
| 扣减 / 校准 | `PUT /api/v1/spool/{id}/use`、`/measure` | `use_weight`(g) / `use_length`(mm) 择一；`weight` = 当前**毛重**（含空盘） |
| 耗材/厂商/扩展/外部库 | `/api/v1/filament`、`/vendor`、`/field`、`/setting`、`/external/{filament,materials,search}` | 材料、密度、温度、颜色；自定义字段；直连 SpoolmanDB |

→ 建议**数据模型对齐 Spoolman 字段命名**（`remaining_weight`/`used_weight`/`spool_weight`/`location`/`archived`），既可"与 Spoolman 共存（双写/代理）"，也白送一条 import/export。

### 4.3 拓竹 RFID 与开源 NFC
| 项 | 结论 | 依据 |
|---|---|---|
| 官方 | AMS 读原厂盘 RFID，Studio/打印机自动带出材料与颜色 | 官方行为 |
| 芯片/密钥 | MiFare Classic 1k（13.56 MHz），UID 明文、数据块加密；每标签独立密钥，但**2024-11 起可由 UID 推导**（KDF），另发现 FM11RF08s 后门（[eprint 2024/1275](https://eprint.iacr.org/2024/1275.pdf)），无需嗅探 | [RFID Tag Guide](https://github.com/ChristopherUC/rfid-tag-guide) |
| 克隆 / 自造 | 克隆**可以**（同 UID+数据+签名）；自造**不行**——数据块含 **RSA-2048 签名**，改一字节即失效，除非改 AMS 固件忽略签名 | 同上 |
| OpenSpool | NTAG215/216 写 NDEF JSON（`protocol/version/type/color_hex/brand/min_temp/max_temp`），ESP32+PN532 读卡后经 **MQTT** 推给打印机；Bambu 协议仍"进行中"、写入不支持；X1C ≥1.08.05.00 需开 **LAN Mode + Developer Mode**，A1/P1 MQTT 最多 4 连接 | [spuder/OpenSpool](https://github.com/spuder/OpenSpool) 775★ |

**评价**：RFID 是锦上添花，**不进 v1**——需额外硬件（PN532+ESP32+贴纸 ≈¥60–120/套）、只能读原厂或自写 OpenSpool 标签、MQTT 与固件开关排障成本远高于收益。v1 用"拍照 + 手动确认"足够；v2 可复用 OpenSpool 的 NDEF JSON 做"刷卡快速选中某盘"（成本最低且生态兼容）。

### 4.4 家庭部署形态
| 形态 | 优势 | 劣势 | 结论 |
|---|---|---|---|
| NAS/小主机 **Docker** | 数据在家、可备份、局域网快；Spoolman 已验证；arm64 镜像还可上树莓派 | 需一台常开机器 + 少量运维 | **v1 默认**（单容器+SQLite+本地图片卷） |
| **PWA**（手机拍照） | 一套代码、免上架、直接调 `getUserMedia`、可离线 | **必须 HTTPS 安全上下文**（`localhost` 除外）→ 局域网自签证书是最大坑；iOS PWA 能力受限 | **v1 拍照端**；用 mkcert / Tailscale / Cloudflare Tunnel 解决 HTTPS |
| 微信小程序 | 大陆家庭**零安装门槛**、微信内分享、扫码即用 | 需**企业主体+域名备案+审核**；本地网络受限（必须公网 HTTPS 后端）；相机/相册与体积限制 | **v2 再考虑**，且后端须先能公网暴露 |

参考：[MDN getUserMedia（安全上下文）](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)【实测可访问】。

## 5. 对设计最重要的 5 条结论
1. **3mf 精确解析 > 页面抓取**。克重/材料/颜色只有 `slice_info.config` + `project_settings.config` 给得准；MakerWorld 接口匿名态 **HTTP 200 但 `weight=0`、`f3mf.url=""`、`instanceFilaments=null`**，据它实现会产出"0 克"假数据。主路径：贴链接→拿标题/封面→引导用户下载并拖入打印配置 3mf。
2. **不要在服务端硬刚 Cloudflare**。`makerworld.com`（含其 `/v1/design-service`）本机 403；可用的是 `api.bambulab.com/v1/design-service`（元数据匿名、下载需登录）。**绝不持久化用户 cookie/clearance**；要更多数据就做"已登录页内取数"的扩展，且必须用户主动触发。
3. **拍照取色只做候选排序，不做判决**。自动白平衡误差可超 ΔE 20，而"可互换"的判据只有 ΔE 2–5。必须提供灰卡/白纸引导、图上吸管校正、ROI 中位色（剔高光阴影）、a\*/b\* 为主 L\* 为辅；并**统一白点**（sRGB=D65 vs `lab()`=D50 显式转换），否则蓝色系系统性错配。
4. **匹配是带约束的多目标问题，不是"找最近 hex"**。硬约束：材料工艺兼容（PLA≠ABS）、`needAms`/喷嘴、单盘余量 ≥ 该槽 `used_g`；软目标：ΔE00 最小、余量最少浪费（先用小盘/旧盘）、同品牌优先。必须支持**多料盘拼接**（"14.2g 需求 / 盘中剩 9g → 换盘或拼接"），并把缺料拆成三种可执行提示：**缺颜色**（可色差替代）、**缺材料**（类型不符）、**缺重量**（换盘/补料）。
5. **数据模型向 Spoolman 对齐，v1 刻意做小**。字段照抄 `remaining_weight/used_weight/spool_weight/location/archived/extra`，色库用 MIT 的 SpoolmanDB，导出兼容 Spoolman CSV——即便只做"拍照 + MakerWorld 选料"两件事，用户也不被锁死；RFID/小程序/多模态识别都是可插拔 v2，不进 v1 关键路径。

## 附：待验证清单（上线前消掉）
- [ ] MakerWorld 服务条款正文（本机 CF 403）：自动化访问、数据再利用、模型文件再分发。
- [ ] **MakerWorld 下载的打印配置 3mf 是否自带 `slice_info.config`**——自带则"下载即精确"；不带则 §2.3 估算成主路径。此项直接决定 §2.3 的优先级是否成立。
- [ ] 带合法 token 时 `detail.weight`/`prediction`/`instanceFilaments`/`f3mf.url` 的真实取值与结构；`plate_N.json` 字段（新版才有，本次无样本）。
- [ ] `paint_color` 两种解码说法谁对（见 §2.4 末；v1 可绕开，将来做多色预览时用真实文件验证）。
- [ ] 3DPrintLog 是否有公开 API；`api.bambulab.com` 是否对高频匿名请求加签/限流；小程序备案与类目要求。

## 参考链接
- MakerWorld：[makerworld-api-reverse](https://github.com/kloshi-io/makerworld-api-reverse)（README/MANUAL/API/src/api.ts）· [bambuddy makerworld provider](https://github.com/maziggy/bambuddy/tree/main/backend/app/services/model_providers/makerworld)
- 3MF：[Printago 3MF 详解](https://printago.io/blog/3mf-file-format) · [paint_color 解码](https://dev.to/bubudong/how-bambu-studio-stores-multi-color-painting-in-a-3mf-decoding-paintcolor-in-the-browser-20n7) · [filament-meter](https://pypi.org/project/filament-meter/) · [lib3mf](https://pypi.org/project/lib3mf/) · [bambuddy filament_requirements.py](https://github.com/maziggy/bambuddy/blob/main/backend/app/services/filament_requirements.py)
- 颜色：[Sharma CIEDE2000 注记](http://www.ece.rochester.edu/~gsharma/ciede2000/ciede2000noteCRNA.pdf) · [Delta E 101](https://zschuessler.github.io/DeltaE/learn/) · [CSS Color 4（D50/D65）](https://www.w3.org/TR/css-color-4/) · [Color balance](https://en.wikipedia.org/wiki/Color_balance) · [CIELAB](https://en.wikipedia.org/wiki/CIELAB_color_space) · [SpoolmanDB](https://github.com/Donkie/SpoolmanDB)（[filaments](https://donkie.github.io/SpoolmanDB/filaments.json) / [materials](https://donkie.github.io/SpoolmanDB/materials.json)）· [Open Filament Database](https://github.com/OpenFilamentCollective/open-filament-database)
- 生态 / RFID / 部署：[Spoolman](https://github.com/Donkie/Spoolman) · [OctoPrint FilamentManager](https://plugins.octoprint.org/plugins/filamentmanager/) · [SimplyPrint](https://help.simplyprint.io/en/article/the-filament-manager-feature-track-organize-and-manage-your-filament-inventory-bpy529/) · [Printago](https://printago.io/) · [3DPrintLog](https://www.3dprintlog.com/docs/materials) · [RFID Tag Guide](https://github.com/ChristopherUC/rfid-tag-guide) · [OpenSpool](https://github.com/spuder/OpenSpool) · [eprint 2024/1275](https://eprint.iacr.org/2024/1275.pdf) · [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia) · [Bambu Wiki: Filament guide](https://wiki.bambulab.com/en/general/filament-guide-material-table)


---

## 6. 图片识别的落地补充（2026-10-18 实测）

- **视觉模型可以用**：本机通过已配置的 OpenAI 兼容网关（DSH profile 的 new-api，base `…/v1`，需要 `x-opencode-session` 路由头）调用 `glm-5.3-flash-g` / `deepseek-flash`，都能正确识别一张 10 盒 Panchroma 包装照片；17 秒左右返回，结构化 JSON 质量足够。
- **本地 Ollama 视觉模型**：本机 Ollama 0.34 只有 `qwen2.5-coder`（文本），拉取 `qwen2.5vl:3b`（3.2 GB）在本环境网速下太慢，测试改用网关；代码仍默认支持「自动检测 Ollama + 视觉模型」，适合离线家庭部署。
- **识别的主要误差**：SKU 数字（模型会读错 1~2 位）、颜色 hex（模型给的是"照片观感"，与官方色号有偏差）。因此产品上必须：① 用官方色卡按颜色名校正 hex；② SKU/克重/数量全部可编辑；③ 不直接入库。
- **色卡数据源**：SpoolmanDB（MIT）`filaments.json` 中 Polymaker Panchroma 共 340 条（含 `color_hex`），已提取为 `data/catalog/panchroma-pla.json`；颜色名匹配规则：完全匹配或词元全覆盖（多余词 ≤2），泛色名（Black/Blue）只走内置字典，避免误命中某个变体（如 Silk Black）。
- **成本/隐私**：云端视觉接口按图计费（家庭每天几张，可忽略）；照片会上传。本地 Ollama 零成本、零上传，代价是首次加载与硬件要求。产品默认不配置识别引擎，拍照取色/手动录入始终可用。

### 6.1 网关实测的坑（写进实现的依据）

| 现象 | 实测 | 处理 |
| --- | --- | --- |
| `response_format: {"type":"json_object"}` | 网关返回 200 但 `content` 为空（推理内容另存） | 不发送该字段，靠提示词 + 容错解析 |
| `max_tokens: 4096 / 6000` | 上游 400 `bad_response_status_code` | 默认 3500，可配置 `maxTokens` |
| 模型输出被截断 | JSON 尾部不完整 | 宽松解析器逐对象恢复完整 item，并给 warning |
| 会话路由 | 缺 `x-opencode-session` 时 400 `MissingSessionID` | 客户端自动附带随机值（普通服务忽略） |
| 重试 | 偶发上游 5xx/`bad_response_status_code` | 自动重试一次（不重试鉴权/参数错误） |
