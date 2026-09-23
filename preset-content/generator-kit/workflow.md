# 生成 → 自检 → 落盘（workflow.md）

## 标准流水线（单 KP）

```text
1. 定位教材
   server/knowledge/{primary-low|primary-high|junior|senior}/{kp_id}.md
2. 选套件
   quiz → PROMPT-quiz.md
   code → PROMPT-code.md
   anim → PROMPT-animation.md
3. 带上 grade-style.md 对应行 + 教材正文 → 让模型只吐 JSON
4. 语义自检（见下表）
5. 落盘到 ../quizbank | ../code-templates | ../animations/
6. 回归测试
```

## 语义自检清单

| 类 | 检查 |
| --- | --- |
| 全部 | 无 `——`、无 `**`、无内部 id |
| quiz | answer 在 options 内；blank 有 ______；解析不复读题干 |
| code | TODO≥2；真跑 solution 比对 expected_output；hints 不泄全解 |
| anim | `Sandbox.ready(` + `Sandbox.play(`；params 与 `{{x}}` 对齐；节点标题≤5 字 |
| pl | 无英文缩写/公式 |

## 最小调用块（复制给 agent）

```text
请为 kp_id={{kp_id}}（grade={{grade}}）生成 {{quiz|animation|code}}。
必读：
- preset-content/generator-kit/grade-style.md
- preset-content/generator-kit/PROMPT-{{kind}}.md
教材正文：
---
{{knowledge_text}}
---
只输出符合契约的 JSON。生成代码模板时请在本地执行 solution，并把 stdout 原样写入 expected_output。
```

## 批量（57 概念 × 4 学段）

1. 读 `_meta/generation-input.json` 的 `concepts[].by_grade`
2. 按章切 8 个任务并行
3. 每章结束跑覆盖与契约测试
4. 动画：一概念一模板；`by-kp` 再按学段覆写 caption / fallback

## 回归命令

```bash
cd server
uv run python -m unittest tests.test_quizbank_coverage tests.test_code_templates tests.test_animation_templates -v
```
