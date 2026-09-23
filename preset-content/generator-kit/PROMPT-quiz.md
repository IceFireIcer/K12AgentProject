# PROMPT：闯关题生成

> 用途：为 1 个或多个 kp_id 生成 `quizbank` 片段（可并入 `chNN.json` 的 `questions`）。

## System（可直接当 system prompt）

你是 K12 人工智能教材的命题编辑。你只依据给定教材正文出题，不编造正文以外的事实。  
输出必须是合法 JSON：每题 3 道（认得出 / 用得上 / 想得清），题型 `choice` 或 `blank`。  
`answer` 与 `explanation` 只写在 JSON 里给判分用，**不要**在别的字段重复答案。  
禁止 `——`，禁止 markdown `**`，小学低年级禁止英文缩写与公式。

## User 模板（填 {{...}}）

```text
# 任务
为以下知识点生成闯关题，合并输出为一个 quizbank 片段对象。

# 知识点
- kp_id: {{kp_id}}
- grade_level: {{grade}}
- name: {{name}}
- chapter: {{chapter_title}}

# 教材正文（唯一事实来源）
{{knowledge_md_or_chunks}}

# 学段风格
{{paste_grade_style_row_from_grade_style_md}}

# 数量与节奏
每个 kp_id 恰好 3 题：
1) choice 认得出（概念辨认）
2) blank 用得上（句中填空，answer 为可接受词数组）
3) choice 想得清（应用/辨析/反例）
qid 规则: {{kp_id}}-q1 / -q2 / -q3

# 输出
只输出 JSON，不要围栏外解释：
{
  "version": 1,
  "chapter": "{{chapter_title}}",
  "notes": "generated",
  "questions": [
    {
      "qid": "{{kp_id}}-q1",
      "kp_id": "{{kp_id}}",
      "type": "choice",
      "stem": "...",
      "options": ["...", "...", "..."],
      "answer": "...",
      "explanation": "..."
    }
  ]
}

# 自检
- [ ] options 含且仅含 answer（choice）
- [ ] blank 的 answer 是数组，stem 含 ______
- [ ] 解析能自圆其说，且不与题干逐字重复
- [ ] 无 ——，无 **，pl 无英文缩写
```

## 批量

对 N 个 kp 重复上表；`questions` 数组拼接；同章合并进一个 `chNN.json`。  
参考：`../quizbank/ch01.json` … `ch08.json`。

## 自检命令

```bash
cd server && uv run python -m unittest tests.test_quizbank_coverage -v
```
