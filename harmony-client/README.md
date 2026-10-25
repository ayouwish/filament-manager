# 耗材管家 · 鸿蒙客户端（HarmonyOS NEXT / ArkTS）

配合家里 NAS 上的「耗材管家」后端使用：

- 📷 **拍照 / 相册 → 自动识别 → 批量入库**（调系统相机，不申请相机权限）
- 📦 **查看库存**、快捷扣减（-20g / -100g）、删除
- ⚙️ **设置** NAS 地址与访问令牌（`FM_TOKEN`），一键测试连接与识别引擎状态

> 复杂的「MakerWorld 链接自动选料」仍建议用手机浏览器打开同一个地址（网页版已适配移动端）。
> **接口契约见 [../docs/CLIENT_PROTOCOL.md](../docs/CLIENT_PROTOCOL.md)**（完整字段、错误码、限制与示例）。

---

## 1. 环境要求（Windows 开发）

| 项 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11（64 位） |
| 开发工具 | **DevEco Studio**（需支持 API 23 的版本，建议用官网最新版） |
| SDK | **HarmonyOS SDK API 23 及以上**（在 DevEco 的 SDK Manager 里安装） |
| 工程配置 | `build-profile.json5` 里 `compileSdkVersion: 23`、`compatibleSdkVersion: 23` |
| 运行 | 鸿蒙真机（推荐）或 API 23 模拟器 |
| 后端 | 本仓库 `filament-manager`，部署在 NAS（见第 4 节） |

> 工程使用 `@kit.*` 形式的 Kit 导入（API 12+ 推荐写法，API 23 继续适用）。
> 本工程**未在 Windows/DevEco 实机编译验证**（生成环境没有 HarmonyOS SDK），首次 Sync 若有版本提示，按第 2.3 节处理。

---

## 2. Windows 上编译运行

### 2.1 安装工具链

1. 从华为开发者官网下载 **DevEco Studio**（Windows 版）并安装。
2. 打开 DevEco → `File → Settings → SDK`（或欢迎页 SDK Manager）→ 安装 **HarmonyOS API 23** 及对应工具链。
3. 真机调试需要：
   - 手机：设置 → 关于手机 → 连点版本号进入开发者模式 → 开启 **USB 调试**；
   - Windows 驱动：安装华为手机助手（HiSuite）或按 DevEco 提示安装 HDB 驱动；
   - DevEco 自带 `hdc`，默认在类似
     `C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe`
     （路径随版本不同，可在 `Settings → SDK` 里看到）。插上手机后在终端执行 `hdc list targets` 应能看到设备。

### 2.2 打开工程

1. DevEco → **Open** → 选择本目录 `harmony-client`（**路径不要含中文/空格**，例如 `D:\dev\harmony-client`）。
2. 等待 Sync。工程没有第三方依赖，不需要 ohpm 安装。
3. `File → Project Structure → Signing Configs` 勾选 **Automatically generate signature**（需登录华为账号）。真机安装必须签名。
4. 选择设备（手机或模拟器）→ 点 ▶ **Run**。

### 2.3 如果 Sync 报 SDK / hvigor 版本问题

生成环境无法预知你本机 DevEco 的精确版本号，按以下顺序处理：

1. 打开 `File → Project Structure → Project`，把 **Compile SDK / Compatible SDK** 选成 **API 23**，让 IDE 自动改写 `build-profile.json5`（可能变成 `"6.x.x(23)"` 这类字符串，属正常）。
2. 若提示 hvigor 配置/模型版本不匹配：`Build → Clean Project`，然后 `File → Sync and Refresh Project`；仍不行就让 DevEco 新建一个 **Empty Ability（API 23）** 工程，把本项目 `entry/src/main/ets/` 整个目录、`entry/src/main/module.json5` 的权限与 metadata 段、资源文件拷过去（其余按新工程默认配置即可）。
3. 若提示明文 HTTP 网络配置无效：见第 5 节。

### 2.4 模拟器（可选）

- DevEco → `Device Manager` → 新建 **API 23** 模拟器（Windows 需开启 Hyper-V / Windows Hypervisor Platform）。
- 模拟器里访问**电脑本机**的后端不要用 `127.0.0.1`（那是模拟器自己），用电脑的局域网 IP（后端用 `--lan` 启动并放行 Windows 防火墙）；访问 **NAS** 直接用 NAS 的 IP。

### 2.5 首次使用

App 打开 → 「设置」：

- **NAS 服务器地址**：如 `http://192.168.1.10:4174`（HTTPS 反代则写 `https://…`）；
- **访问令牌**：后端启动时设了 `FM_TOKEN` 就填同一个值，没设就留空；
- 点「保存并测试连接」，看到“连接成功 / 识别引擎 …”即可。

然后到「添加」页：`📷 拍照` 或 `🖼️ 相册` → 自动识别 → 核对 → 「全部入库」；识别不了可在下方手动添加。

---

## 3. 客户端功能与网页版的分工

| 场景 | 推荐 |
| --- | --- |
| 随手拍 → 识别入库 | **鸿蒙客户端**（快，系统相机） |
| 看库存 / 扣减 / 删料 | **鸿蒙客户端** |
| MakerWorld 链接选料、3mf 上传、打印记录管理、设置识别引擎 | 手机浏览器打开同一个地址（网页版） |

---

## 4. NAS 后端部署

```bash
# 方式 A：直接跑（NAS 上装了 Node 18+）
cd filament-manager
FM_TOKEN=换成你的随机令牌 node server.mjs --lan

# 方式 B：Docker（推荐）
docker build -t filament-manager .
docker run -d --name filament-manager -p 4174:4174 \
  -e FM_TOKEN=换成你的随机令牌 \
  -v /volume1/docker/filament:/app/data \
  filament-manager
```

- `FM_TOKEN` 可选：不设 = 接口开放（仅限完全可信的家庭网络）；设了之后**除 `/api/health` 外**所有接口都要带 `x-fm-token`，客户端在「设置」里填同一个值即可。
- 建议给 NAS 端口配 **HTTPS 反向代理**（群晖/威联通自带，或 Caddy/Nginx），客户端写 `https://…` 更安全。

---

## 5. 明文 HTTP 说明

HarmonyOS 默认可能禁止明文 HTTP。本工程通过：

- `entry/src/main/resources/base/profile/network_config.json`：`cleartextTrafficPermitted: true`
- `entry/src/main/module.json5` 的 metadata：`ohos.net.http.NetworkSecurityConfig` → `$profile:network_config`

如果 DevEco/你的 SDK 版本提示该 metadata 名称或字段无效：

1. **推荐**：给 NAS 配 HTTPS，客户端地址改成 `https://…`，并删掉 module.json5 里的那条 metadata；
2. 或者按 IDE 提示调整 `network_config.json` 的字段（不同版本可能用 `cleartextTraffic`）。

---

## 6. 目录结构

```
harmony-client/
├── AppScope/                        # 应用级配置与图标
├── build-profile.json5              # 工程/产品配置（API 23）
├── hvigor/hvigor-config.json5       # hvigor 模型版本（可让 IDE 自动改写）
├── entry/
│   ├── build-profile.json5
│   └── src/main/
│       ├── module.json5             # 入口 Ability、INTERNET 权限、明文 HTTP 配置
│       ├── resources/               # 字符串/颜色/页面清单/网络配置/图标
│       └── ets/
│           ├── entryability/EntryAbility.ets
│           ├── common/Api.ets       # 后端 REST 封装（含 x-fm-token）
│           ├── common/Config.ets    # 服务器地址/令牌本地持久化（preferences）
│           ├── common/ImageUtil.ets # 照片压到 ≤1400px、JPEG 72 后转 base64
│           ├── model/Types.ets      # 数据结构（与协议文档一致）
│           └── pages/Index.ets      # 库存 / 添加 / 设置 三个 Tab
```

---

## 7. 用到的接口（详见协议文档）

| 客户端动作 | 接口 |
| --- | --- |
| 拉库存/记录 | `GET /api/state`（带 `x-fm-token`） |
| 测试连接 | `GET /api/health` + `GET /api/vision/status` |
| 图片识别 | `POST /api/recognize` |
| 批量入库 | `POST /api/spools/bulk` |
| 手动添加 | `POST /api/spools` |
| 扣减 | `POST /api/spools/{id}/consume` |
| 删除 | `DELETE /api/spools/{id}` |

完整字段、错误码、限制、curl/PowerShell 示例：**[../docs/CLIENT_PROTOCOL.md](../docs/CLIENT_PROTOCOL.md)**。

---

## 8. 排错

| 现象 | 处理 |
| --- | --- |
| Sync 报 SDK 版本 | Project Structure 里选 API 23，让 IDE 改写 `build-profile.json5` |
| 真机装不上 / 签名失败 | 登录华为账号开自动签名；或配置手动签名（p12/p7b/profile） |
| `hdc list targets` 看不到设备 | 开 USB 调试；装 HiSuite/HDB 驱动；换数据线/USB 口；`hdc kill` 后重试 |
| 连接失败 | 手机与 NAS 同网段；用 NAS 的局域网 IP（不是 127.0.0.1）；检查 NAS 防火墙/端口映射；浏览器先访问 `http://NAS:4174/api/health` 验证 |
| 401 | 客户端「设置」里的 `FM_TOKEN` 与后端环境变量不一致 |
| 识别失败 | 先在网页版 ⚙ 设置里确认识别引擎可用；客户端“设置→保存并测试连接”会显示引擎状态 |
| 明文 HTTP 报错 | 见第 5 节，或改用 HTTPS |
| 模拟器连不上本机后端 | 用电脑局域网 IP，后端 `--lan` 启动，放行 Windows 防火墙 |

---

## 9. 已知限制

- 本工程**未在真实 DevEco/真机环境编译验证**：代码按 API 23 ArkTS 编写，配置文件已做 JSON5 校验。首次打开可能需要按第 2.3 节微调版本号。
- 客户端只做「拍照识别入库 + 库存查看/扣减」；选料匹配、3mf、打印记录管理请用网页版。
- 图片会压缩后上传到 NAS；若 NAS 上识别引擎是云端服务，图片会再转发给该服务；想完全离线可在 NAS 上跑本地 Ollama。
