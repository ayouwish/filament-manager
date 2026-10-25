# 测试夹具说明

| 文件 | 来源 | 说明 |
| --- | --- | --- |
| `sliced.3mf` / `unsliced.3mf` | `tools/make_fixture_3mf.py` 生成 | 模拟 Bambu Studio 打印配置结构，用于 3mf 解析测试 |
| `recognize-panchroma.raw.txt` / `.expected.json` | 真实视觉模型输出 | 用于图片识别解析/规范化回归测试，不含个人隐私 |
| `panchroma-boxes.jpg` | 项目作者拍摄 | 整箱 Panchroma 耗材照片，用于识别/批量入库端到端演示；包装与品牌归 Polymaker 所有 |
| `recognize-panchroma.expected.json` | 由上述原始输出规范化 | 断言颜色/品牌/材料等字段 |
