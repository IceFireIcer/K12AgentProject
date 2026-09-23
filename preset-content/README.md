# 预置内容包（preset-content）

供后续导入 `server/resources/` 的**内容资产**总包。按现有加载器契约生成，导入即可被读取。

## 目录

| 路径 | 对应加载器 | 数量 |
| --- | --- | --- |
| `quizbank/ch01.json` … `ch08.json` | `routes/quiz.py` → `resources/quizbank/` | 684 题（228 KP × 3） |
| `code-templates/<kp_id>.json` | `routes/code.py` → `resources/code-templates/` | 228 份（每 KP 一份） |
| `animations/templates/<id>.json` | `routes/resources.py` → `resources/templates/` | 57 概念模板 + 覆盖 228 KP 的 `kp_ids` |
| `animations/by-kp/<kp_id>.json` | 导入映射（每 KP 的文案/步骤/参数） | 228 份 |
| `_meta/` | 生成输入与目录，不导入 | — |

## 导入接线（给后续 AI）

```text
# 题库（已与仓库一致，可整目录覆盖）
copy preset-content/quizbank/*.json  →  server/resources/quizbank/

# 代码模板
copy preset-content/code-templates/*.json  →  server/resources/code-templates/

# 动画：概念模板进 templates/；by-kp 是文案源，可选择：
#   A. 直接用 animations/templates/（每模板 kp_ids 已覆盖四学段同概念）
#   B. 若产品要「一 KP 一模板」，用 by-kp 里的 body/script/fallback 再展开
copy preset-content/animations/templates/*.json  →  server/resources/templates/
```

> ★ 2026-09-23 实际走的是 **方案 B**（展开成 206 份一 KP 一模板）——**方案 A 不能直入**：
> 概念模板的 `kp_ids` 虽盖四学段，但文案只按初中写（`fallback_text` 全以「（初中讲法）」开头），
> 步骤字幕还写死在 `script` 里。详见文末「导入状态」与 `docs/report-material/decisions.md` 的 **D-078**。

### 环境变量覆盖（不改包内路径也能验）

| 变量 | 指向 |
| --- | --- |
| `K12_QUIZ_BANK_DIR` | `preset-content/quizbank` |
| `K12_CODE_TEMPLATES_DIR` | `preset-content/code-templates` |
| `K12_ANIMATION_TEMPLATES` | `preset-content/animations/templates` |

## 格式红线（与 `server/tests/` 对齐）

1. **题库** `type ∈ {choice, blank, code_blank}`；`answer` 只在文件内，对外投影不得带出。
2. **代码模板** `scaffold` 至少 2 处 `# TODO`；`solution` 不外发；`expected_output` 与 solution 真实输出逐字一致。
3. **动画模板** 字段封闭（未知字段会被跳过）；`script` 必须含 `Sandbox.play(`；无外链；`params` 与 `{{placeholder}}` 双向对齐。
4. **kp_id** 必须存在于 `server/knowledge/*/<id>.md`（228 个）。

## 覆盖说明

| 功能 | 仓库现状 | 本包 |
| --- | --- | --- |
| 闯关题库 | 已满编 684 | 原样收录，便于一次导走 |
| 代码模板 | 仅 `prog-*-jr` 3 份 | **228 份**（编程章加重，其余概念做成轻量练习） |
| 动画模板 | 8 份 / 盖 22 KP | **57 概念模板 / 盖 228 KP** + by-kp 文案 |

生成日：2026-09-22。源：`server/_data/shared/kb.sqlite` + `server/knowledge/`。

---

## 导入状态（2026-09-23）

三样已按「**以包为准 + 全量覆盖**」导入 `server/resources/`，覆盖后按同一口径重做了一遍学生可见字段的卫生清理（`——` / 反引号 / `**`）：

| 产物 | 导入到 | 结果 |
| --- | --- | --- |
| `quizbank/*.json`（8 份） | `server/resources/quizbank/` | 覆盖 + 清理；**包内这份同步清理**，两边逐字节一致 |
| `code-templates/*.json`（228 份） | `server/resources/code-templates/` | 覆盖 + 清理；两处 level 1 泄漏 `range(` 已改写 |
| 动画 | `server/resources/templates/` | **按 `by-kp/` 展开成 206 份一 KP 一模板**；`templates-premium/` 覆盖既有 8 份 |

**206 = 228 − 22**：那 22 个 KP 由仓库既有 8 份手作高保真模板服务。跳过它们是为了避免同 kp 双模板 —— `pick_template()` 在同 kp 多命中时**默默返回 `exact[0]`**（靠目录顺序），重叠必须在数据层消除。

`by-kp/`、`generator-kit/`、`_meta/`、`templates-premium/` **不入产品**（前两者是文案源与工具箱，后者是既有 8 份的备份）。

⚠️ 再导入前先看 `server/tests/test_content_copy_hygiene.py` —— 本包红线「文案禁 `——` 与 `**`」由它机器校验；判据口径见 `docs/report-material/decisions.md` 的 **D-078** 与 `pitfalls.md` 的 **P-130**。
