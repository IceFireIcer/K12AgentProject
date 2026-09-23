# AI 生成套件（generator-kit）

给后续 AI **自定义生成**闯关题、动画讲解、编程模板的说明书与提示词模板。

## 分学段情况

**已按四学段分类生成**（不是只改难度数字）：

| 层 | 分学段方式 |
| --- | --- |
| 题库 | 每 KP 一档一份（`kp_id` 后缀 `pl/ph/jr/sr`），题干语气随学段变 |
| 代码模板 | 228 = 57 概念 × 4 学段，脚手架难度与例子分档 |
| 动画 | `by-kp/<kp_id>.json` 分学段步骤/降级文案；`templates/` 一概念盖四档 `kp_ids` |

源：`_meta/generation-input.json` 的 `concepts[].by_grade.{primary_low,primary_high,junior,senior}`。

## 文件

| 文件 | 用途 |
| --- | --- |
| `grade-style.md` | 四学段语气/难度/禁用项（生成前必读） |
| `PROMPT-quiz.md` | 闯关题生成提示词 + JSON 契约 |
| `PROMPT-animation.md` | 动画模板生成提示词 + JSON 契约 |
| `PROMPT-code.md` | 代码模板生成提示词 + JSON 契约 |
| `workflow.md` | 生成 → 自检 → 落盘流程 |
| `examples/` | 各类最小合法样例 |

## 快速调用（给 agent）

```text
你要为 kp_id={KP_ID}（学段={GRADE}）生成 {quiz|animation|code}。
1. 读 preset-content/generator-kit/grade-style.md 对应学段
2. 读 preset-content/generator-kit/PROMPT-{kind}.md
3. 读 server/knowledge/<grade-dir>/{KP_ID}.md 作为唯一事实来源
4. 按 schema/examples 输出 JSON 到约定路径
5. 跑 workflow.md 自检清单
```

学段目录：`primary-low` / `primary-high` / `junior` / `senior`；后缀 `-pl/-ph/-jr/-sr`。

## 硬约束（违反即废稿）

1. `kp_id` 必须已在 `server/knowledge/` 存在。
2. **答案不外发**：quiz 的 `answer`、code 的 `solution` 只留在文件内。
3. 学生面禁内部 id、技术黑话、`——`、未渲染 `**`。
4. `pl` **禁英文缩写与公式**。
5. 动画脚本必须 `Sandbox.ready(` + `Sandbox.play(`；禁 `Sandbox.animate`、外链、顶层 throw。
6. 代码 `scaffold` ≥2 处 `# TODO`；`expected_output` 与 `solution` 真实 stdout **逐字一致**。
