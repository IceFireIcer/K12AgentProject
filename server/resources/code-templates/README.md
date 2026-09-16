# 代码模板（票 19）

按知识点预置的 Python 代码框架，`GET /api/code/templates/{kp_id}` 从这里读取。
**本地文件读取，不经 LLM** —— 断网时进编程卡片仍能取到模板（票 19 验收项之一）。

## 文件命名

一个知识点一个文件：`<kp_id>.json`，`kp_id` 必须与 `server/knowledge/*/<file>.md`
的 front matter 逐字一致（`server/tests/test_code_templates.py` 会断言这件事）。
模板与题库（`../quizbank/`）是同一类**随包分发的内容资产**：人工编写、离线可用。

## 字段

| 字段 | 对外？ | 说明 |
| --- | --- | --- |
| `kp_id` / `grade_level` | ✅ | 知识点与学段（与教材对齐） |
| `title` | ✅ | 卡片标题 |
| `expected_behavior` | ✅ | 填完 TODO 后应当表现出的行为（面向学生，中文） |
| `scaffold` | ✅ | 预置代码框架，**必须含 `TODO` 标记** |
| `expected_output` | ✅ | 正确完成后的标准输出（学生在界面上自己比对） |
| `hints` | ✅ | 三级提示 `level` 1→2→3，**绝不直接给答案** |
| `solution` | ❌ | ★★ **内部字段：绝不外发**（同题库的 `answer` 纪律） |

## ★★ `solution` 不外发（与「答案不出后端」同一条纪律）

`solution` 只用于**测试**断言「填完 TODO 即可通过」（票 19 的实测口径），
以及将来做自动判分时的参照。它**绝不能**进入 API 响应：

- 契约层有两个模型 —— 内部 `CodeTemplateRecord`（含 `solution`，只在 Python 侧）
  与对外 `CodeTemplate`（`contracts.py`，**结构上没有 `solution` 字段**）；
- 路由**不用 `exclude` 临时裁剪**，而是由内部模型投影成对外模型
  （`routes/code.py` 的 `to_code_template()`）—— 这与题库用
  `QuizQuestionOut` 而不是 `exclude=True` 是同一个理由：
  「临时裁剪」是最容易漏掉一处的地方（执行文档 §6.3）。

## TODO 标记约定

`scaffold` 里的空缺一律写成 `# TODO:` 开头的注释行（可带编号 `# TODO 1:`）。
学生在 Monaco 里按注释改代码；`tests/test_code_templates.py` 断言
**每个模板至少有 2 处 TODO**，且「把 TODO 换成 solution 的对应行」后代码可运行。

## 新增模板

1. 在 `server/knowledge/` 里确认 `kp_id` 已存在（模板不凭空造知识点）；
2. 写 `<kp_id>.json`，`scaffold` 留 TODO、`solution` 写完整可运行版本、
   `expected_output` 与 solution 的实际输出逐字一致（测试会真跑 solution 比对）；
3. 跑 `uv run python -m unittest discover -s tests` —— 四类常见错误样例与
   「逐字一致」两条断言都在里面。
