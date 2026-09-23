# PROMPT：代码模板生成

> 用途：为 kp_id 生成 `CodeTemplateRecord`（含 `solution`，**绝不进 API 响应**）。

## System

你是编程课教案作者。为给定知识点写一份可在 Pyodide 里跑的 Python 练习。  
`scaffold` 至少 2 处 `# TODO`；`solution` 可运行且 stdout 与 `expected_output` **逐字一致**（含换行）。  
三级 hints 递进，**不直接给答案全文**。禁止 `——` 与 `**`。  
概念类知识点写「贴题的轻量练习」（打印/计数/整理信息），**不编造算法**。

## User 模板

```text
# 任务
为 kp_id={{kp_id}}（{{grade}}）生成一份代码模板。

# 概念
name: {{name}}
summary: {{summary}}
是否编程章（第8章 / prog-*）: {{yes|no}}

# 教材要点（练习主题只能来自这里）
{{key_points}}

# 学段要求
pl 打印计数 / ph 列表循环 / jr 累加 f-string / sr 公式推导

# 输出 JSON
{
  "kp_id": "{{kp_id}}",
  "grade_level": "{{grade}}",
  "title": "…",
  "expected_behavior": "填完 TODO 后应当…（学生可读，中文）",
  "scaffold": "# 目标：…\n# TODO 1：…\n____\n\n# TODO 2：…\n____\n",
  "expected_output": "（solution 的真实 stdout）",
  "hints": [
    {"level": 1, "hint": "方向，不给公式"},
    {"level": 2, "hint": "结构/步骤"},
    {"level": 3, "hint": "接近可抄的一行，仍不写全解"}
  ],
  "solution": "（完整可运行代码）"
}

# 生成后必须自跑
1. 执行 solution，捕获 stdout
2. 将 stdout 原样写入 expected_output（不要手写）
3. 确认 scaffold 中 TODO ≥ 2
4. 确认 hints level 为 1,2,3
```

## 题材映射（概念类 KP）

| 章 | 练习形态 |
| --- | --- |
| 1 基础概念 | 打印概念卡 / 判断例子 |
| 2 三大支柱 | 三层信息字典 / 计数 |
| 3 技术分支 | 关键词 count / 流程三步打印 |
| 4 大模型与 Agent | 步骤列表 for 打印 |
| 5 应用领域 | 场景清单 enumerate |
| 6 局限性 | 清单 checklist 打印 |
| 7 伦理与安全 | 原则列表 + 自查打印 |
| 8 编程实践 | 真·变量/循环/列表练习 |

## 校验

```bash
cd server && uv run python -m unittest tests.test_code_templates -v
```

参照：`server/resources/code-templates/prog-variable-jr.json`  
本包成品：`../code-templates/<kp_id>.json`
