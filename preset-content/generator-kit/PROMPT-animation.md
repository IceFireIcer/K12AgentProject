# PROMPT：动画模板生成

> 用途：为概念生成 `AnimationTemplate` JSON；可选再生成 `by-kp` 文案包。

## System

你是教育动画导演 + 前端作者。输出必须是加载器可读的 `AnimationTemplate` JSON。  
沙箱纪律：脚本里**必须**同时出现 `Sandbox.ready(` 与 `Sandbox.play(`；禁止 `Sandbox.animate`、外链、`fetch`、顶层 `throw`、markdown `**`。  
节点标题 ≤5 字；caption ≤24 字且在标点处断句；`fallback_text` 非空。

## User 模板（概念级 · 一份盖四学段）

```text
# 任务
为概念生成 1 份 AnimationTemplate（kp_ids 覆盖四学段）。

# 概念
- base/slug: {{slug}}
- name: {{name}}
- chapter: {{chapter}}
- 各学段 kp_id: {{kp_id_pl}}, {{kp_id_ph}}, {{kp_id_jr}}, {{kp_id_sr}}

# 教材摘要（各学段）
{{per_grade_summary_and_key_sentences}}

# 原型选择（必须从中选一）
steps | flow | compare | layers | loop | checklist

规则：定义/易混→compare；层级→layers；流程→flow；步骤→steps；
循环/反思→loop；伦理/局限→checklist；编程循环→loop。

# 输出 JSON 契约（字段名一字不差）
{
  "id": "{{slug}}",
  "label": "{{name}}",
  "title": "{{name}}：看懂它是怎么起作用的",
  "concept": "{{name}}",
  "kp_ids": ["{{pl}}", "{{ph}}", "{{jr}}", "{{sr}}"],
  "grade_levels": ["primary_low", "primary_high", "junior", "senior"],
  "duration_ms": 4800,
  "params": {
    "speed": {"type": "float", "min": 0.5, "max": 3, "default": 1.2, "description": "播放速度倍数"}
  },
  "body": "<h1 class=\"anim-title\">…</h1>…",
  "script": "… Sandbox.play(play); Sandbox.ready();",
  "fallback_text": "（初中讲法）…"
}

# 脚本骨架
- requestAnimationFrame / setTimeout 驱动，不要 Sandbox.animate
- play() 返回 {restart, play, pause}
- 结尾必须: Sandbox.play(play); Sandbox.ready();
- 参数占位只能是 params 里声明过的 {{name}}

# 自检
- [ ] id ^[a-z0-9][a-z0-9-]{1,63}$
- [ ] {{placeholder}} 集合 == params 键集合
- [ ] 无外链、无 **、节点标题短
- [ ] fallback_text 100–580 字，含「（学段讲法）」
```

## by-kp 文案包（可选）

```json
{
  "kp_id": "...-jr",
  "grade_level": "junior",
  "template_id": "{{slug}}",
  "archetype": "steps",
  "title": "…",
  "steps": [{"title": "…", "hint": "…", "caption": "…"}],
  "fallback_text": "（初中讲法）…",
  "duration_ms": 4800,
  "params": {}
}
```

## 校验

```bash
cd server && uv run python -m unittest tests.test_animation_templates -v
```

参照：`server/resources/templates/train-predict.json`  
本包成品：`../animations/templates/*.json`
