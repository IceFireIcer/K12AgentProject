# Triage 标签词汇

各技能以五个规范 triage 角色沟通。下表把角色映射到本仓库实际使用的标记串。

| mattpocock/skills 中的标签 | 本仓库使用的标记 | 含义 |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 维护者需评估 |
| `needs-info` | `needs-info` | 等待补充信息 |
| `ready-for-agent` | `ready-for-agent` | 已充分规格化，可交给无人值守的 agent |
| `ready-for-human` | `ready-for-human` | 需人工实现 |
| `wontfix` | `wontfix` | 不予处理 |

当技能提到某个角色（如「打上 AFK-ready 标签」）时，使用上表右列对应的标记串。

本项目使用本地 markdown tracker，标记串记录在各票文件顶部的 `Status:` 行，而非 issue 标签。

## 本项目特有约定

- 所有切片默认 `ready-for-agent`（按构造即为 agent 可抓取）。
- **关卡 A–E 不单独成票**，而是内嵌为对应票的验收条件；某票若标注「关卡 X」，通过关卡即该票的硬性验收线。
- `ready-for-human` 用于必须人工判断的环节（如教材内容抽检、演示视频录制、汇报准备）。
