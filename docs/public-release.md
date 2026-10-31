# 公开与私有构建边界

## 目录与授权范围

- `src/main/subtitles/sources/types.ts`：公开的适配器和会话契约。
- `src/main/subtitles/sources/community-provider.ts`：不执行在线搜索的社区版实现。
- `private/subtitle-sources/`：私有站点适配、验证码识别、会话、默认地址、维护文档和测试；不上传。

私有目录需要单独备份或放入私有仓库。Git 忽略规则不会备份它；不要用清理未跟踪文件的命令删除它。

## 开发与构建

默认开发在本地存在私有扩展时加载它，否则使用社区版。发布构建始终显式选择版本：

| 命令 | 行为 |
| --- | --- |
| `npm run dev:community` | 社区版开发，不加载私有实现 |
| `npm run build` | 社区版构建，自动检查编译产物 |
| `npm run dist:portable` / `dist:win` | 社区版发布包 |
| `npm run typecheck:private` / `test:private` | 完整工作区检查私有扩展 |
| `npm run build:private` | 明确包含私有扩展的本机构建 |
| `npm run dist:private:portable` / `dist:private:win` | 私有发布包，输出名或目录与社区版分开 |

两种构建会重建 `out`。公开打包入口额外检查产物，不接受上一次私有构建留下的产物。
发布者需要知道：私有功能会进入私有安装包中的 JavaScript。闭源是分发与许可边界，不能把 Electron 归档当作代码加密。

## 准备 GitHub 源码

执行 `npm run export:public`。只把输出的独立目录作为公开仓库；不要直接上传完整开发目录，也不要把原有 `.git` 复制过去。

导出按文件白名单复制源码、测试、脚本、公开文档和构建配置。不会复制 `private`、个人配置、Chromium 数据、模型、字幕、SQLite、诊断日志、缓存、OpenSpec 历史和旧发布包。导出后的清单不提供需要私有目录的命令。

在公开目录执行 `npm ci`、`npm run typecheck`、`npm test`、`npm run build`。CI 也执行相同检查。公开的自有代码使用 PolyForm Noncommercial 1.0.0，导出会包含完整 `LICENSE`，并保留第三方内容各自的授权。

如果已有 Git 仓库跟踪了私有文件，`check:public` 和默认构建会拒绝通过。不要仅删除最新工作树中的文件后发布旧历史；使用干净导出目录建立新仓库。
