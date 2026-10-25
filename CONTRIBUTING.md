# 贡献指南

感谢你关注「耗材管家」！这是一个家庭 3D 打印耗材管理工具（拍照识别 + MakerWorld 自动选料），后端零依赖 Node，另带 HarmonyOS 客户端。

## 开发环境

- Node.js 18+（CI 覆盖 20 / 22）
- 可选：Docker（部署测试）、DevEco Studio 5.0+ / API 23+（鸿蒙客户端）、python3 + Pillow（商品图主色校验，缺省时自动跳过）

```bash
git clone https://github.com/ayouwish/filament-manager.git
cd filament-manager
npm test          # 77 个测试，无需安装依赖
npm start         # http://127.0.0.1:4173
```

## 提交前检查

1. `npm test` 全部通过；
2. 不要提交 `data/db.json`、`data/photos/`、`.env`（已在 `.gitignore`）；
3. 前端改动请自带版本号更新（`web/index.html` 里 `?v=YYYYMMDD`），方便用户强刷；
4. 新增接口/字段时同步更新 `docs/CLIENT_PROTOCOL.md`；
5. 涉及识别的改动，请补一条不依赖真实网络的测试（mock `fetch`）。

## 提交信息

建议使用 Conventional Commits：

```
feat: 入库后自动抓取商品图
fix: 修复列表视图分组被压成单列
docs: 补充 NAS 部署说明
```

## 目录速览

| 路径 | 说明 |
| --- | --- |
| `server.mjs` | HTTP 服务 / API / 静态资源 |
| `lib/` | 颜色、3mf、匹配、识别、MakerWorld、商品图、存储 |
| `web/` | 原生前端（无构建） |
| `harmony-client/` | 鸿蒙客户端工程（API 23+） |
| `docs/` | 设计、协议、NAS 部署、调研、QA |
| `test/` | node:test 单元 + HTTP 集成测试 |

## 开源协议

提交代码即表示同意以 [MIT License](LICENSE) 发布。
