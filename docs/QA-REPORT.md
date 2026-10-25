# 独立 QA 复核报告

> 快照时间：2026-10-18 00:34（复核期间源码有并行修改）。
> 后续修复（00:35~00:55）：严格余量覆盖 + 服务端扣减二次校验；CORS 改为同源/`makerworld.com` 页面导入白名单；匹配失败/需求变更后旧结果失效；缺克重禁止扣减；`color_far` 不预留库存；照片清除后重选复位；取色坐标按 `object-fit:contain` 校正；zip 解压上限；PENDING TTL；500 错误不泄漏路径；文档计数/链接/UA 描述更新；新增图片识别与 16 个测试（共 54）。

---

# 耗材管家 · 独立 QA 复核报告

- 复核对象：`/home/wangsimeng/project/dsh/filament-manager`
- 复核方式：**只读**（未改源码、未安装依赖）+ 临时 `FM_DATA_DIR` 启动服务 + curl / node 直接调用
- 复核时间：2026-10-18 00:22–00:37（Asia/Shanghai）
- 结论摘要：**P0 0 项；P1 3 项；P2 8 项；P3 35 项**。核心流程（拍照录入、链接/3mf 解析、匹配、扣减）可以跑通，测试 38/38 通过；但扣减数据一致性、跨站访问控制和“旧匹配结果仍可确认”这三类问题需要优先处理。

> 说明：复核期间源码被并行修改过（`server.mjs`/`README.md`/`web/app.js` 等在 00:20–00:31 多次变更），另有并行进程在项目 `data/` 下写入了 `db.json` 和一张照片。本报告以以下快照为准，未删除上述并行数据：
>
> `server.mjs 472d5de2…`、`web/app.js b1b2210f…`、`lib/match.mjs 1cca4bf1…`、`lib/store.mjs cc467c05…`、`lib/makerworld.mjs d14d275b…`、`lib/threemf.mjs c257a6e1…`、`README.md d791cc7b…`、`docs/DESIGN.md dfcf6a2d…`、`test/api.test.mjs c4e2a496…`。
> 后续若继续改代码，行号可能漂移，请以文件内容为准。

## 运行环境

- Linux 6.6.87.2-microsoft-standard-WSL2 x86_64
- Node.js v24.15.0（项目声明 `engines.node >= 18`）
- npm 11.12.1
- 浏览器自动化不可用（无 Chromium/Firefox/jsdom），前端结论来自静态检查和代码路径分析

---

## 一、确认通过清单

### 1. 测试与启动

| 检查 | 结果 | 证据/备注 |
| --- | --- | --- |
| `npm test` | **38 passed / 0 failed**，无警告 | 任务书写的是“35 通过”；实际代码在复核前新增了 3 个测试，README 与 DESIGN §10 已写 38。DESIGN 路线图仍写 31（见 P3） |
| `FM_DATA_DIR=$(mktemp -d) PORT=4300 node server.mjs` | 正常启动 | 首次请求自动生成 6 盘示例库存；数据目录可配置 |
| `GET /`、`/style.css`、`/app.js`、`/lib/color.mjs` | 全部 **200** | `/lib/color.mjs` 可被前端直接 import |
| `GET /api/health` | **200** `{ok:true,version:1}` | 不再泄漏数据目录（早期版本曾返回 `dataDir`，当前已移除） |
| `--lan` 启动 | 打印 `0.0.0.0` 监听与全部局域网 IPv4 地址 | 实测输出 `http://172.29.27.128:4312 (eth0)` |
| `--port 4174`/`--port=4174` | 生效 | 实测 `--port 4312` 正常 |
| 端口占用检测 | 正常退出并给出旧实例提示 | 实测在 4300 已有实例时提示“检测到已有一个耗材管家”，并给出换端口命令 |

### 2. 主要 API 手工验证

| 检查 | 结果 |
| --- | --- |
| `GET /api/state` | 200；6 盘示例库存、空 jobs、空 match 设置、默认阈值 `goodDeltaE=5, maxDeltaE=12` |
| `GET /api/sample` | 200；4 项需求（黑 120g / 白 600g / 红 30g / 琥珀 60g） |
| `POST /api/match`（示例需求） | 200；黑 `ok`、白 `insufficient` 缺口 80g、红 `ok`、琥珀 PETG `color_far` |
| `POST /api/import/3mf`（`data/examples/sample-multicolor.3mf`） | 200；2 个平台、3 项合并需求；黑 120.4g、白 45.2g、琥珀 PETG 60.3g；未切片文件退化出警告 |
| `POST /api/jobs` | 201；库存扣减、jobs 写入、返回更新后的 spools |
| `GET /api/jobs` | 200；记录包含 title/sourceUrl/items/totalGrams/createdAt |
| `POST/GET /api/settings` | 阈值可保存、可读回 |
| `POST /api/import/page` → `GET /api/pending/:id` | 200；油猴导入链路可走通 |
| 实时 MakerWorld 解析 | **200**；`ok=true, source=makerworld+metadata, needs3mf=true, requirements=[]`，标题/作者/封面/配置列表均拿到，警告明确说明“匿名接口拿不到克重，请上传 .3mf”；耗时约 2.9s |
| 非法请求 | 非 JSON → 400；空 requirements → 400；非 zip → 400；损坏 PK → 422；错误 host → 400；http 链接 → 400；未知 pending → 404 |
| 路径穿越 | `/../server.mjs`、`/%2e%2e/server.mjs`、`/lib/..%2fserver.mjs`、`/data/photos/..%2f..%2fdb.json`、`%2e%2e` 变体均被 403/404 拒绝；`/%E0%A4%A`、`/%ZZ` 返回 400，未崩溃 |
| 请求体上限 | 70,000,000 字节（>64MiB）POST 返回 **413** `请求体过大`，服务仍正常响应 health |
| 非法 Host 头 | 返回 500 `Invalid URL`（未崩溃，但状态码/错误语义不对，见 P3） |
| 无浏览器 | 无 Chromium/Firefox/jsdom，无法做真实点击回归；已用静态脚本核对 DOM id/事件绑定 |

### 3. 前端静态一致性

| 检查 | 结果 |
| --- | --- |
| `web/app.js` 中所有字面量 `$('#id')` 引用 | 全部存在；缺失 **0** |
| 动态 id `btnAddReq` | 由 `renderRequirementEditor()` 生成，`box.onclick` 事件委托，正常 |
| 模板 id `view-${name}`（inventory/match/jobs） | HTML 中均存在 |
| `#modelCover` | HTML 已存在并被 `renderModelCard()` 使用 |
| 所有 `addEventListener` 绑定 id | `btnAdd`、`btnAddEmpty`、`btnSettings`、`btnSaveSettings`、`photoInput`、`btnClearPhoto`、`btnSaveSpool`、`btnResolve`、`mwUrl`、`btnSample`、`btnManual`、`file3mf`、`btnEditReqs`、`btnMatch`、`btnConfirm` 均存在 |
| 已删除 Cookie UI 残留 | `setCookie` / `hasMakerworldCookie` / `makerworldCookie` 在 `web/` 中 **0 处**；设置弹窗只显示“不保存 Cookie”的说明 |
| HTML 重复 id | **0**；section/div/form/label/main/header 标签数量平衡 |
| JS 语法 | `node --check` 检查 `server.mjs`、全部 `lib/*.mjs`、`web/app.js`、油猴脚本均通过 |
| `escapeHtml` 覆盖 | name/brand/type/colorName/title/spoolName/warnings/message/photo 属性均转义；title/sourceUrl 使用 `textContent`，未发现可由正常 API 触发的 DOM XSS |
| `/api/state` 中 photo 是服务器相对路径 | 前端判断 `img.src.startsWith('data:')`，编辑已有照片保存时不会把服务器路径当 base64 重传 |
| API 1x1 PNG 照片 | 保存 → `/data/photos/...png` 可 200 访问；替换后旧文件删除、新文件可访问；`photo:''` 清除后文件返回 404 |

### 4. 逻辑边界（直接 import / API）

| 用例 | 结果 |
| --- | --- |
| 空库存 | `no_stock` |
| `grams:null` | `ok`，`summary.gramsKnown=false`，不按克重卡 |
| 类型家族 `PLA+` vs `PLA` | 兼容，`ok` |
| 多需求共享库存 | 预留生效，同一盘不会被两个自动需求重复占用 |
| 单盘不够、同色多盘 | `combine`，parts 合计 ≥ 98% 需求（见 P1：98% 容差本身有问题） |
| `allowTypeMismatch` | 返回 `type_mismatch`，附建议 |
| `allowCombine=false` | 返回 `insufficient`，缺口正确 |
| 极小余量 1.5g / 需 1g（`minRemainingGrams=2`） | **仍返回 `ok`**（P3：兜底候选绕过了最小余量过滤） |
| 3mf 不存在/非 zip | `parse3mf` 抛“找不到 EOCD” |
| 3mf 中央目录损坏 | 抛“zip 中央目录损坏” |
| `slice_info` 无 filament | 退化到工程设置并给 warning |
| `project_settings` 非 JSON | 静默忽略，最终 warning 说“两个文件均缺失”，提示不准确（P3） |
| URL 边界 | http 拒绝、非 makerworld 拒绝、无 id 拒绝、`#profileId=`/`#profileId-` 均支持、伪造后缀 `makerworld.com.evil.com` 拒绝、大小写 host 支持 |
| 颜色非法 | `POST /api/spools` 400；`POST /api/match` 400 |
| `remaining > total` | 不报错，静默钳制为 total（P3：API 未拒绝） |
| 超长 name | 截断到 60 字符 |
| photo 上传 | 1x1 PNG data URL 正常保存、返回服务器相对路径 |
| 并发写 jobs | 单进程 20 个并发 POST 全部 201，余量 900→700，jobs 20 条，未丢更新；多进程共享同一 db 时仍有覆盖风险（README 已警告） |

---

## 二、问题清单

### P0（阻断）

未发现 P0。`npm test`、启动、首页、核心 API 均可用。

### P1（严重）

#### P1-1　扣减链路缺少严格的余量校验：少 2% 仍显示“匹配成功”，实际会记录超过库存的克重

**位置**

- `lib/match.mjs:69`：`coverage = ... available >= needed * 0.98`
- `lib/match.mjs:215-217`：拼盘也以 `sum >= needed * 0.98` 判定成功
- `web/app.js:679-705`：`buildItems()` 直接按需求克重扣减，不检查真实余量
- `lib/store.mjs:228-235`：服务端扣减用 `Math.max(0, remaining - grams)`，静默钳到 0，但 job 里仍记录原始克重
- `server.mjs:278-290`：`POST /api/jobs` 没有校验 spoolId 是否存在、余量是否足够、items 是否重复

**复现（已实测）**

```bash
# 1) 建一盘只剩 588g 的同色料
SID=$(curl -s -X POST http://127.0.0.1:4300/api/spools \
  -H 'Content-Type: application/json' \
  -d '{"name":"588g 测试盘","type":"PLA","colorHex":"#010101","totalGrams":1000,"remainingGrams":588}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["spool"]["id"])')

# 2) 需求 600g → 仍返回 ok
curl -s -X POST http://127.0.0.1:4300/api/match -H 'Content-Type: application/json' \
  -d '{"requirements":[{"index":1,"type":"PLA","colorHex":"#010101","grams":600}]}'
# 实测 status=ok, shortfallGrams=0, spool.remainingGrams=588

# 3) 确认扣减 → 记录 600g，但库存只能扣到 0
curl -s -X POST http://127.0.0.1:4300/api/jobs -H 'Content-Type: application/json' \
  -d "{\"title\":\"588 overdraw\",\"items\":[{\"spoolId\":\"$SID\",\"grams\":600}]}"
# 实测 job.totalGrams=600, remainingGrams=0
```

**影响**

- 用户看到“匹配成功 / 可用 588g / 扣减后 0g”，会以为够用，实际少 12g，可能打到一半断料——这正是本工具要避免的核心问题。
- 打印记录写 600g、库存只扣 588g，账本从此不一致。
- 拼盘同样：需求 600g、parts 300+288=588g 时返回 `combine`，没有任何“差 12g”的提示。
- 同一端点还可传任意 `spoolId`（未知 ID 返回 201，job 里 spoolName 为空）和重复 items；`grams:99999` 也会 201，并把余量钳到 0。

**建议**

1. 覆盖率改为严格比较（仅允许 0.01g 级浮点误差），或在差额 > 0 时明确标 `insufficient` 并给出缺口。
2. `combine` 必须返回 `shortfallGrams`，不能以 98% 通过。
3. `/api/jobs` 在服务端二次校验：spool 必须存在、grams 有限且 ≥ 0、同一 spool 聚合后的克重 ≤ 当前 remaining；不足返回 409/400，不能静默钳 0。
4. 前端确认前用最新 `/api/state` 重新校验，或由服务端返回“实际可扣/缺口”。

#### P1-2　CORS 为 `*` 且所有写接口无鉴权：任意网页可读取/删除本地库存、伪造打印记录

**位置**

- `server.mjs:316-319`：所有 `/api/*` 响应设置 `Access-Control-Allow-Origin: *`，并允许 `GET,POST,PUT,DELETE,OPTIONS`
- `server.mjs:324-330`：API 无 Origin 校验、无 token、无 CSRF 防护
- `Dockerfile:3-5`：容器固定 `HOST=0.0.0.0`；README 的 `-p 4173:4173` 还会绑定到所有网卡

**复现（已实测）**

```bash
curl -s -D - -o /dev/null -H 'Origin: https://evil.example' \
  http://127.0.0.1:4300/api/state
# 返回 Access-Control-Allow-Origin: *

curl -s -D - -o /dev/null -X OPTIONS \
  -H 'Origin: https://evil.example' \
  -H 'Access-Control-Request-Method: DELETE' \
  -H 'Access-Control-Request-Headers: content-type' \
  http://127.0.0.1:4300/api/spools
# 204，且 Allow-Methods 含 DELETE
```

任意网页只要知道 `127.0.0.1:4173/4300`，就能：

- `GET /api/state` 读出全部库存、备注、照片路径；
- `DELETE /api/spools/:id` 删除料盘；
- `POST /api/jobs` 伪造记录、扣减库存；
- `POST /api/settings` 篡改阈值（我们实测传入 `maxDeltaE:"abc"` 也被持久化）。

**建议**

- 只对油猴脚本需要的 `https://makerworld.com` / `https://www.makerworld.com` 放行，并校验 `Origin`；其余跨域一律拒绝。
- 更稳妥：本地生成一次性 token，油猴脚本首次配对后携带 token；写接口必须校验 token。
- `--lan` 和 Docker 部署必须显式提示无鉴权风险；Docker 默认不应在无防护情况下暴露到 `0.0.0.0`。

#### P1-3　清空需求或匹配失败后，旧匹配结果仍留在页面上，“确认并扣减”仍会按旧结果扣减

**位置**

- `web/app.js:558-564`：`runMatch()` 在没有需求时 `setStatus(...); return;`，**没有清空 `state.matches`、没有隐藏 `#matchCard`、没有禁用 `#btnConfirm`**
- `web/app.js:565-578`：只有请求成功才更新结果；请求失败只设置状态，旧结果继续显示
- `web/app.js:710-722`：确认按钮状态只在 `renderMatches()` 中更新；上述早退路径不会调用
- `web/app.js:724-737`：`confirmJob()` 直接使用 `state.matches` 的旧 assignments

**复现步骤（无需浏览器工具，按代码路径即可）**

1. 「智能选料」→「试用示例模型」，等待匹配成功。
2. 点「材料需求」右侧「编辑」→ 用每行末的 `✕` 删除全部 4 项需求。
3. 点「完成」。顶部出现红色 `没有可匹配的材料需求…`。
4. 观察：下方「匹配结果」卡片仍是上一次的 4 项，`确认并扣减余量` 按钮仍可点击。
5. 点击确认：会按旧的 4 项 assignments 生成 `/api/jobs`，扣减旧库存。

**同类路径**：匹配请求失败（服务重启/网络错误）时，旧结果也不会被清空；用户可能把旧结果当作新结果确认。

**建议**

- `runMatch()` 一开始就清空 `state.matches`、隐藏/清空 `#matchCard`、禁用确认按钮；失败时保持清空状态并显示错误。
- 给匹配请求加递增 `requestId`/AbortController，丢弃过期响应。
- 确认前再次校验 `state.requirements` 与 `state.matches.assignments` 的对应关系（或直接由服务端按最新需求和库存重新计算）。

### P2（一般）

#### P2-1　“清除照片”后再选择新照片：新照片被忽略，旧照片反被删除

**位置**

- `web/app.js:824-831`：点击清除把 `state.photo.cleared = true`
- `web/app.js:312-334`：`onPhotoPicked()` 只设置 `dataUrl`，**没有把 `cleared` 重置为 false**
- `web/app.js:350-351`：保存时 `if (state.photo.cleared) payload.photo = ''; else if (dataUrl) ...`，`cleared` 优先

**复现**

1. 编辑一盘已有照片的料盘。
2. 点「清除照片」。
3. 再点「拍照 / 选图」选一张新照片，取色正常。
4. 点「保存」。
5. 结果：请求只带 `photo:''`，新照片没有上传，服务器把旧照片删掉。

新建料盘时“先清除再选图”同样会丢新照片。

**建议**：`onPhotoPicked()` 成功后设置 `state.photo.cleared = false`；保存时优先判断 `dataUrl`，`cleared` 只在没有新 dataUrl 时生效。

#### P2-2　照片预览用 `object-fit: cover`，但取色坐标按完整 canvas 映射，点击位置会偏

**位置**

- `web/style.css:257-261`：`.photo-preview` 固定 `4/3`，`canvas { width:100%; height:100%; object-fit:cover }`
- `web/app.js:245-249`：`x = (clientX - rect.left) / rect.width * canvas.width`

当照片比例不是 4:3（手机竖拍很常见）时，canvas 被 `cover` 裁切显示，但点击坐标仍按整个 rect 映射到 canvas 全尺寸，实际取样点会偏离手指位置，可能取到背景/阴影而不是料盘颜色。

**复现**：选一张 3:4 竖拍照片，点击预览中靠上/靠下的料盘区域；与把同一 canvas 以 `contain` 显示相比，取色点明显偏移。

**建议**：改用 `object-fit: contain`；或按 `cover` 的缩放/裁切偏移计算 canvas 坐标；或让预览容器随图片比例自适应。

#### P2-3　部分需求缺克重时确认按钮仍可点，但文案说“补全后再扣减”；未知项会被静默跳过

**位置**

- `web/app.js:679-690`：缺克重的需求 `missingGrams++` 后 `continue`
- `web/app.js:710-721`：只有 `!items.length` 才禁用按钮；`missingGrams > 0` 只改提示文案，不禁用
- `docs/DESIGN.md:288`：文档写“缺克重的需求禁止确认，引导去编辑”

**复现**

1. 上传未切片的 3mf（或手动录入两条需求），其中一条克重留空。
2. 给另一条补上克重，匹配。
3. 提示显示“有 1 项缺少克重，请点「编辑」补全后再扣减”，但按钮可点。
4. 点击确认：只提交有克重的那条，缺克重项静默跳过；若此时还有其他未匹配项，`skipped` 提示也会被缺克重提示覆盖。

**建议**：只要有 `missingGrams` 就禁用确认；或者明确提供“仅扣减已填项”的二次确认，并列出被跳过的项。

#### P2-4　`color_far` 卡片显示“已选中料盘”，并提示“也可直接按上方结果扣减”，实际确认时会被跳过

**位置**

- `lib/match.mjs:141-143`：`color_far` 仍返回 `spool`（用于展示最接近项）
- `web/app.js:697-701`：`buildItems()` 对非手动指定的 `color_far` 跳过
- `web/app.js:662`：只要有 `spool` 就显示“也可直接按上方结果扣减”

**复现**：示例模型 → 琥珀 PETG 需求显示“透明 PETG / 颜色差异大”，同时下方提示“也可直接按上方结果扣减”；点确认后该项被跳过，不会扣减。

**建议**：`color_far` 卡片明确显示“仅建议，不会自动扣减”；不要显示“也可直接扣减”。若用户从下拉框手动改选，再显示“将按手动选择扣减”。

#### P2-5　不可扣减的 `color_far` 仍预留库存，导致后续需求被误判“缺料”

**位置**

- `lib/match.mjs:164-169`：只要克重已知且 >0、且没有 parts，就对 `picked.spool` 预留 `totalNeeded`，**不区分 status 是否为 `color_far`/`insufficient`**
- `web/app.js:697-701`：`color_far` 最终不会扣减

**复现（已实测，基于示例库存的透明 PETG 800g）**

```bash
# 第一个需求是琥珀色（color_far，不会扣减），但预留了 700g
curl -s -X POST http://127.0.0.1:4300/api/match -H 'Content-Type: application/json' \
 -d '{"requirements":[
   {"index":1,"type":"PETG","colorHex":"#E0A030","grams":700},
   {"index":2,"type":"PETG","colorHex":"#F2F2EE","grams":200}
 ]}'
# 实测：
#   1 color_far   透明 PETG  ΔE=29.2
#   2 insufficient 透明 PETG  缺口 100g
# 而单独匹配第 2 项：
#   2 ok          透明 PETG  ΔE=2.4
```

第一项根本不会被扣减，却让第二项误报缺 100g。

**建议**：只对最终会扣减的状态（`ok` / `color_near` / `combine`，以及允许跨类型时的 `type_mismatch`）做预留；`color_far` / `insufficient` 不预留。

#### P2-6　页面导入会把 `__NEXT_DATA__` 里无关的 filament 节点也当成该模型需求

**位置**

- `lib/makerworld.mjs:209-230`：`deepCollect` 在整个页面 JSON 中找所有“同时有 type 和 color 键”的对象，**没有限定在目标 design/instance 下**
- `server.mjs:258-275`：直接把这些 requirements 返回给前端

**复现（已实测）**：向 `/api/import/page` POST 一个包含目标 design 123、另一个推荐模型 ABS filament 的 `__NEXT_DATA__`，返回的 requirements 包含 3 项，其中 ABS `#C62828 999g` 来自无关推荐节点，`warnings` 为空。

**影响**：真实 MakerWorld 页面若包含推荐模型/相关联的打印配置数据，会把别家模型的耗材算进来，导致多买/错扣。

**建议**：从目标 design 节点或其 `instances`/`plates` 子树内提取；至少按 `designId`/`plate` 上下文过滤，并给“来源未确认”的条目 warning。

#### P2-7　数值未校验有限性：`1e309` 被写成 `null`，生成不可用库存/记录

**位置**

- `lib/store.mjs:123-124`：`totalGrams/remainingGrams` 仅 `Math.max(0, Number(...))`
- `lib/store.mjs:215,223`：job grams/total 同样只做 `Math.round`
- `lib/store.mjs:90`：`JSON.stringify` 会把 `Infinity` 写成 `null`

**复现（已实测）**

```bash
curl -s -X POST http://127.0.0.1:4300/api/spools -H 'Content-Type: application/json' \
  --data-binary '{"name":"inf","colorHex":"#010203","totalGrams":1e309,"remainingGrams":1e309}'
# 201，但 spool.totalGrams=null、remainingGrams=null

curl -s -X POST http://127.0.0.1:4300/api/jobs -H 'Content-Type: application/json' \
  --data-binary '{"title":"inf","items":[{"spoolId":"x","grams":1e309}]}'
# 201，job.items[0].grams=null、job.totalGrams=null
```

**影响**：库存列表显示 0/空值，匹配时该盘被当成 0 余量；后续编辑/统计异常。

**建议**：统一用 `Number.isFinite` + 上限（如 1e6 g）+ 非负校验；非法返回 400。`totalGrams > 0`、`remainingGrams <= totalGrams` 也应在 API 层校验，而不是静默钳制。

#### P2-8　Docker 部署固定 `0.0.0.0` 且无鉴权，与 README “默认只监听 127.0.0.1”的安全表述冲突

**位置**

- `Dockerfile:3-5`：`HOST=0.0.0.0`
- `Dockerfile:12`：直接 `node server.mjs`
- `README.md:20-26`：Docker 运行命令 `-p 4173:4173`，未提示无鉴权
- `README.md:144`：安全说明写“默认只监听 127.0.0.1”

**复现/风险**：按 README 的 Docker 命令在 NAS 上运行，4173 会绑定到所有网卡；同网段任何人都能读写库存（再叠加 P1-2 的 CORS）。容器还以 root 运行。

**建议**：Docker 模式增加访问 token / 反向代理鉴权，或在 README 明确写“仅限可信内网 + 防火墙限制”，并考虑非 root 用户运行。

### P3（建议）

#### 安全/健壮性

1. **损坏 db.json 时 500 响应泄漏绝对路径**  
   `lib/store.mjs:74-83`、`server.mjs:326-329`。复现：把 `db.json` 写成 `{ broken`，`GET /api/state` 返回  
   `{"error":"数据文件损坏（/home/.../data/db.json）：Expected property..."}`。本地工具风险低，但建议返回通用错误，路径只写服务端日志。

2. **非法 `Host` 头返回 500 `Invalid URL`**  
   `server.mjs:312`。复现：`curl -H 'Host: [' http://127.0.0.1:4300/` → 500。建议捕获 URL 解析错误并返回 400。

3. **畸形 URL fragment 返回 500 `URI malformed`**  
   `lib/makerworld.mjs:44` 的 `decodeURIComponent(u.hash)` 未捕获。复现：  
   `POST /api/makerworld/resolve {"url":"https://makerworld.com/models/1#%E0%A4%A"}` → 500。建议返回 400 `invalid_url`。

4. **`minRemainingGrams` 在兜底候选里失效**  
   `lib/match.mjs:112-116`：`colorOk` 过滤了 `< minRemainingGrams`，但 `picked` 会退回 `compatible[0]`，该候选没有最小余量限制。实测 1.5g 盘 / 需 1g（阈值 2g）仍返回 `ok`。建议在最终 `picked` 上再卡一次 `available >= minRemainingGrams`（除非克重未知）。

5. **`allowTypeMismatch=true` 时，拼盘 parts 可混入不兼容类型且状态标成 `combine`**  
   `lib/match.mjs:111,201-218`。实测：需求 PLA 300g，库存 PLA 250g + PETG 100g，`allowTypeMismatch=true` → `combine`，parts 为 PLA 250 + PETG 50，不再显示类型不符。建议 parts 也做类型检查，或单独标记 `type_mismatch_combine`。

6. **`project_settings.config` 非 JSON 时提示误导**  
   `lib/threemf.mjs:79-84` 静默返回空工程；`:146-160` 统一报“slice_info / project_settings 均缺失”。实际文件存在但内容坏。建议单独 warning “project_settings 不是合法 JSON”。

7. **`used_g=0` 被当成有效的切片克重**  
   `lib/threemf.mjs:47-54`、`:163-173`。实测 `<filament ... used_g="0"/>` → `sliced=true`、总克重 0，无 warning；UI 会视为“精确 0g”，确认时又被当作缺克重跳过。建议 0/缺失 used_g 视为未知并 warning。

8. **油猴导入缓存无 TTL，ID 使用 `Math.random`**  
   `server.mjs:48-55`、`:208-212`。`createdAt` 从未使用；超过 20 条只淘汰最旧；ID 不是密码学随机；配合 CORS 可被任意 origin 读取。建议 TTL + `crypto.randomUUID()`。

9. **设置接口无 schema 校验**  
   `server.mjs:293-303`、`lib/store.mjs:248-253`。实测可保存 `maxDeltaE:"abc"`、`allowCombine:"no"`、`minRemainingGrams:-5`，随后所有匹配异常。建议只接受白名单字段与数值范围。

10. **压缩炸弹/无解压上限**  
    `lib/zip.mjs:60-69` 对 metadata 条目直接 `zlib.inflateRawSync`，没有解压后大小上限；上传上限只限制 HTTP body。1KB 压缩数据可解压出 GB 级内容，配合 CORS 可远程触发内存耗尽。建议解压前限制 `uncompSize`，解压后校验，并对元数据条目设置总大小上限。

11. **下载 3mf 无大小上限、无重试/退避**  
    `lib/makerworld.mjs:243-263` 直接 `arrayBuffer()`；文档 `DESIGN.md:193,417` 声称单域名限速/指数退避/下载大小上限，代码均未实现。建议限制下载大小，至少对文档做修正。

#### API/数据边界

12. **`remaining > total` 静默钳制；空 body 创建默认料盘；未支持方法返回 404 而非 405**  
    `lib/store.mjs:123-128`、`server.mjs:165-171`、`:306`。实测 `remainingGrams:200,totalGrams:100` → 201 且 remaining=100；`POST /api/spools` 空 body → 201 灰色 PLA 1000g；`PUT /api/state` → 404。建议显式 400/405，避免误操作。

13. **手动扣减/超量扣减被静默钳到 0**  
    `lib/store.mjs:189-199`。`grams:99999` 从 780g 扣到 0，仍 200。建议返回实际扣减量与是否不足。

14. **`POST /api/jobs` 接受未知 spoolId、重复 items、0 克 item**  
    `lib/store.mjs:207-217`、`server.mjs:278-290`。实测未知 spoolId → 201（spoolName 空），重复同一盘 500+500 → job total 1000、库存只扣到 0。建议校验并聚合前端已聚合的 items。

15. **照片过大/格式不支持返回 500**  
    `lib/store.mjs:259-264`。应返回 413/415；前端只显示“保存失败”。

16. **job title/note 无长度上限**  
    `lib/store.mjs:218-225`。64MB body 内可写入超长 title/note，列表渲染/备份变大。建议 clamp。

#### 前端/UX

17. **油猴脚本硬编码 `http://127.0.0.1:4173`，与新增的 `--port`/`PORT` 功能冲突**  
    `extensions/makerworld-helper.user.js:19`。启动 `--port 4174` 后点脚本按钮会请求 4173 失败。建议脚本提供端口配置或首次配对。

18. **`range` 设置允许 good > max**  
    `web/index.html:178-184`；`web/app.js:789-795`。UI 没有校验 `goodDeltaE <= maxDeltaE`，保存后颜色状态逻辑会变得不可解释。建议保存时校验并提示。

19. **`allowCombine` / `maxCombineParts` / `minRemainingGrams` 无 UI 入口**  
    `lib/match.mjs:21-24`、`web/app.js:789-795`。API 支持，但设置弹窗只有 4 项；文档说“可在设置里调整”容易让用户误解。建议补齐或明确只读默认值。

20. **`openSpoolModal` 对非下拉选项类型（如 API 写入的 `PLA+`）会回落到 PLA**  
    `web/app.js:208`、`web/index.html:141-145`。编辑这类料盘直接保存会改类型。建议动态加入当前类型 option 或拒绝未知类型。

21. **匹配请求无竞态保护**  
    `web/app.js:558-578`、`:442-453`。快速切换平台/连续点匹配时，较慢的旧响应可能覆盖新结果。建议请求序号 + AbortController。

22. **确认扣减后 `refreshState()` 失败会提示“扣减失败”，但 job 可能已经成功**  
    `web/app.js:739-745`：`state.matches.done = true` 后 `refreshState` 抛错，catch 重新启用按钮并 toast 失败；后续点击会被 `done` 静默拦截。建议先标记成功，再单独重试刷新，或把刷新失败提示为“已扣减但刷新失败”。

23. **确认后 assignments 里的 spool 对象仍是旧余量**  
    `web/app.js:739-741`：`refreshState` 更新 `state.spools`，但 `state.matches.assignments[].spool` 是旧对象，`renderMatches` 的“可用/扣减后”仍是旧值。建议扣减后重算或清空结果。

24. **可访问性**：tab 无 `aria-selected`、modal 无 `role="dialog"/aria-modal`、无焦点陷阱、canvas 取色无键盘替代、toast 无 `aria-live`。建议后续补。

25. **`/favicon.ico` 404、无 CSP/X-Frame-Options**  
    `server.mjs:333-343`。本地工具影响小；若日后走反向代理，建议补安全头。

#### 文档一致性

26. **DESIGN 的 README 链接失效**  
    `docs/DESIGN.md:8` 写 `[README](./README.md)`，从 `docs/` 解析为 `docs/README.md`，该文件不存在；应为 `../README.md`。

27. **DESIGN 路线图仍写“31 测试通过”**  
    `docs/DESIGN.md:471`，当前实际 38，同文档 §10 已写 38；任务书又写 35。三者不一致，建议统一为实际数量（38）。

28. **取色算法描述与实现不一致**  
    `docs/DESIGN.md:53` 写“邻域平均”、`:86` 写“7×7 邻域均值”、`:134` 写“7×7 像素中位色”；实现是 `radius=6`（13×13）逐通道中位色，见 `web/app.js:249,258-284`。建议改文档为 13×13 中位色，或把代码 radius 调成 3。

29. **数据模型说明与实现不一致**  
    `docs/DESIGN.md:303` 写 `settings{match{}, makerworldCookie}`；实际 `store.emptyDb()` 只有 `settings.match`（`lib/store.mjs:22-33`），`/api/state` 也只返回 `match`。建议删掉 `makerworldCookie`。

30. **“不伪装浏览器 UA”与代码不一致**  
    `docs/DESIGN.md:190` 声称不伪装 UA；`lib/makerworld.mjs:18-23` 的 `BROWSER_HEADERS` 固定使用桌面 Chrome UA。若这是有意的反爬策略，应改文档并评估合规；否则应如实声明 UA。

31. **“单域名限速、失败指数退避、403/429 立即停、下载大小上限”未实现**  
    `docs/DESIGN.md:193,417`；`lib/makerworld.mjs:271-421` 只顺序尝试两个 base，无重试/退避/QPS；`:243-263` 无下载上限。建议实现或删掉这些承诺。

32. **`malformed_payload` 错误码在文档中存在、代码中未使用**  
    `docs/DESIGN.md:355`；代码实际返回 `invalid_url`/`upstream_blocked`/`no_requirements`/`download_unavailable`。建议补实现或删文档。

33. **调研文档声称支持省略 `https://` 的链接，代码不支持**  
    `docs/research.md:14` 写“容错省略 https:// 的写法”；实测 `parseMakerWorldUrl('makerworld.com/zh/models/1')` 返回 `链接格式不正确`。建议改文档或增加补全逻辑（补 `https://` 后仍需严格校验 host）。

34. **README 目录树遗漏 Dockerfile/docs 等**  
    `README.md:95-110` 未列 `Dockerfile`、`.dockerignore`、`docs/`；不影响运行，但会误导新维护者。

35. **`tools/make_fixture_3mf.py` 顶部注释产物名过时**  
    `tools/make_fixture_3mf.py:8` 写 `data/examples/sample-3mf.3mf`，实际生成 `data/examples/sample-multicolor.3mf`（`:110`）。建议同步。

---

## 三、覆盖缺口与后续建议

### 当前自动化测试未覆盖的关键路径

- 前端 `web/app.js` 完全没有自动化测试：DOM id 缺失/事件绑定错误（例如历史上删除 Cookie UI 后的残留）只能靠人工或静态脚本发现；本次已用脚本补做，但建议加 Playwright 或最小 jsdom 冒烟。
- 未覆盖：路径穿越、CORS、64MB body、损坏 db、非法 Host、畸形 URL fragment、照片上传/替换/清除、settings 非法值、未知/重复/超量 job、页面导入混入无关节点、`allowCombine=false`、`minRemainingGrams`、`preferOpened` 的断言。
- 未覆盖：真实 MakerWorld 网络（本次手工实测通过；单测使用 mock）。
- 未覆盖：多进程共享同一 `FM_DATA_DIR` 的写竞争（单进程 20 并发已测，无丢更新；README 已警告不要开两个实例）。
- 本次未执行 `npm run fixtures`（会重写 `test/fixtures/*.3mf`，属于源码文件）；仅静态检查生成脚本，输出文件名正确、需要 python3。

### 建议的优先修复顺序

1. **P1-1 扣减校验**：严格覆盖率 + `/api/jobs` 服务端二次校验（避免账本/断料）。
2. **P1-2 CORS/鉴权**：Origin 白名单 + token；Docker 默认安全提示。
3. **P1-3 旧匹配结果**：`runMatch` 开始即清空/禁用，失败保持禁用；请求序号防竞态。
4. **P2-1/P2-2 照片流程**：清除后重置状态；取色坐标按 `contain` 或裁切偏移修正。
5. **P2-3/P2-4/P2-5 匹配 UX/预留**：缺克重禁用确认；`color_far` 只建议不扣减；只预留可扣减项。
6. **文档**：DESIGN 链接、测试数量、7×7、cookie schema、UA/限速描述；README 目录树与 Docker 安全说明。

---

## 四、复核结论

- **可运行性：通过**。零依赖启动、静态资源、核心 API、示例 3mf、示例匹配、真实 MakerWorld 元数据链路均正常；38 个测试全部通过。
- **核心业务正确性：有严重风险**。98% 容差 + 服务端无余量校验会导致“少料也成功、记录多扣”；手动改选和超量 API 调用同样能制造不一致账本。
- **安全：本机工具默认 127.0.0.1 的假设不足以防护**。CORS `*` + 无鉴权使任意网页能操作本地库存；Docker 部署会把同一问题暴露到局域网。
- **前端：静态一致性良好，无 Cookie UI 残留、无缺失 DOM id；但照片清除/重选、缺克重确认、`color_far` 提示、旧匹配结果等流程会误导用户或造成数据丢失。
- **建议**：在修复 P1 三项后再做一次浏览器端回归（拍照录入、编辑已有照片、清空需求、断网后重试、手机竖拍取色、手动改选同色异类型料盘）。

---

*本报告由独立 QA 以只读方式生成；未修改任何源文件。复核中使用的服务已停止，临时数据目录已清理。*
