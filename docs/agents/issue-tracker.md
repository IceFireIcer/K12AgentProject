# Issue tracker：本地 Markdown

本项目的工作切片（tickets）以 markdown 文件形式存放在仓库内，不依赖外部 tracker。

> **路径偏离技能默认值**：mattpocock 技能约定本地 tracker 放 `.scratch/<feature>/`。
> 本仓库**有意改为 `docs/tickets/`**——切片是长期维护的项目文档，不是临时草稿，
> 应与 `docs/` 下其他文档一同版本化与检索。**后续技能运行不要把它挪回 `.scratch/`。**

## 约定

- 本次项目切片（15 天冲刺全量任务）位于 `docs/tickets/issues/`，索引为 `docs/tickets/README.md`。
- 文件名为 `NN-<slug>.md`，从 `01` 起**按依赖顺序**编号（被阻塞的票编号在后）。
- **一票一文件**，绝不合并成单个 tickets 文件。
- 每个文件顶部含 `**Blocked by:**`（阻塞它的票号/标题）与 `**Status:**`（triage 状态串，见 `triage-labels.md`）。
- **范围与规格以 `项目执行文档.md` 为唯一权威**；切片只是它的任务视图，二者冲突时以执行文档为准，并顺手修正切片。

## 当技能要求「发布到 issue tracker」

在 `docs/tickets/issues/` 下新建文件（必要时先建目录），并在 `docs/tickets/README.md` 的清单与依赖图中登记。

## 当技能要求「获取相关 ticket」

读取对应路径的文件。用户通常会直接给出路径或票号。

## 前沿（frontier）

`Blocked by` 中列出的票全部完成的票即为可开工票。
扫描 `docs/tickets/issues/`，按编号从小到大取第一个未被阻塞的票。

## 进度记录

- 开工：把 `Status:` 改为 `claimed`（如需要），并在该票的 `## 进度` 小节追加起始时间与当前判断。
- 完工：勾选全部验收条件，把 `Status:` 改为完成态，并把关键决策/踩坑追加到票尾的 `## 进度` 小节。
