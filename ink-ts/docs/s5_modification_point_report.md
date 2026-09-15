# 修改点唯一性抽查报告（S5，N=5）

> 判据（§2.4-3/§12.3 S5）：功能修改 diff 只落 `plugins/`（spec/faces/data）；落 hosts/engine/exec/renderer = 违约（新基建除外，需独立评审）。本报告对迁移波允许装配面/生成物/门禁/文档位为波内例外（各样本 allow 列表）。

> 生成时间：2026-09-15T02:02:57.069Z

| 样本 | commit | 变更文件 | 违约文件 | 结论 |
|---|---|---|---|---|
| S3 命令逻辑下沉（主提交） | 84f7f3a | 252 | 0 | ✅ 零违约 |
| S4 域组2 改口（material.import） | 7868ed2 | 1 | 0 | ✅ 零违约 |
| S4 域组3 collab（convene 并域，execution 拆薄壳） | 5b90c50 | 22 | 0 | ✅ 零违约 |
| S4 域组3 plugin（plugin_command 并域） | ac152ce | 6 | 0 | ✅ 零违约 |
| S4 域组3 exec_client（exec 原生机制件下沉端口） | c22be38 | 31 | 0 | ✅ 零违约 |
