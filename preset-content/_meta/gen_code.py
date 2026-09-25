# -*- coding: utf-8 -*-
"""为 228 个 KP 生成 code-templates（含 solution，导入后由投影层屏蔽）。

设计口径（2026-09-25 改造）
==========================

旧版对 54 个非编程概念只用 4 句模板（「数一数……出现了几次」「列一张要点清单」
「把关键句打出来」「把要点的要点做成字典」），学生练到的只是「把概念名塞进字符串
处理」，与知识点没有真实关联。

新版把「机制」扩成 14 个**家族**，每族练一种真实的编程能力；学段差异是真的，
不是换词：

  primary_low   变量求和 / 列表计数 / 两项求差           —— 变量、打印、简单运算
  primary_high  循环逐条枚举 / 循环累加 / 条件筛选        —— 列表与循环
  junior        字典建表查表 / 函数求平均 / 频次统计 / 字符串切分
  senior        统计量 / 嵌套循环(二维) / 标准化 / 函数分类

每个家族都吃一份**概念主题数据**（``THEMES``）：条目名、数量、类别都取自该知识点
的语义（计算机视觉用「手写数字 / 猫脸 / 斑马线 / 二维码」，语音合成用
「欢迎回来 / 这题做得好」……），所以脚手架里出现的数据与知识点真的对得上。

★ 12 份手作标杆（变量 / 循环 / 列表 的四学段，含 BMI、冒泡排序、标准化）原样保留，
  生成器跳过它们（``KEEP``），与动画侧 ``expand_templates.py`` 跳过 premium 同理。

``expected_output`` 不手写：直接真跑 ``solution`` 取 stdout，保证「声称的输出」
与参考解逐字一致（``main()`` 再复跑一遍做二次校验）。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(r"E:\FolderForVibeCoding\Zcode\K12Agent")
META = ROOT / "preset-content" / "_meta"
#: ★ 同时落两个目录：``preset-content/code-templates`` 是内容包 staging，
#: ``server/resources/code-templates`` 是随包目录（守卫与运行都读它）。
#: 两份保持字节一致（导入工作流见 ``preset-content/README.md``）。
OUT_DIRS = [
    ROOT / "preset-content" / "code-templates",
    ROOT / "server" / "resources" / "code-templates",
]
for _d in OUT_DIRS:
    _d.mkdir(parents=True, exist_ok=True)

GRADE_LEVELS = ["primary_low", "primary_high", "junior", "senior"]
data = json.loads((META / "generation-input.json").read_text(encoding="utf-8"))

#: ★ 12 份手作标杆：内容冻结，生成器只从随包目录原样复制，绝不覆写。
KEEP = {
    "prog-variable-pl", "prog-variable-ph", "prog-variable-jr", "prog-variable-sr",
    "prog-loop-pl", "prog-loop-ph", "prog-loop-jr", "prog-loop-sr",
    "prog-list-pl", "prog-list-ph", "prog-list-jr", "prog-list-sr",
}


# ====================================================================== #
# 概念主题数据：每个知识点一套贴合其语义的条目 / 数量 / 量词 / 名词 / 类别
#   mw(量词) + noun(名词) 合起来就是打印里的单位（如「份学习材料」），
#   分开写是为了拼标题时不再叠出「三项份学习材料」这种病句。
# ====================================================================== #
THEMES: dict[str, dict] = {
    "agent-action": dict(mw="份", noun="学习材料", items=["分步讲解", "配套练习", "思维导图", "知识小结"], nums=[3, 5, 4, 2], cats=["讲解", "练习", "导图"]),
    "agent-perception": dict(mw="条", noun="输入", items=["打字的提问", "题目的照片", "说出的语音", "课本的扫描件"], nums=[6, 4, 3, 2], cats=["文字", "图片", "语音"]),
    "agent-planning": dict(mw="个", noun="步骤", items=["复述题意", "拆解难点", "安排顺序", "检查遗漏"], nums=[2, 4, 3, 1], cats=["拆解", "排序", "检查"]),
    "agent-reflection": dict(mw="条", noun="检查", items=["前后不矛盾", "引用有来源", "关键步骤重算", "句子说得清楚"], nums=[2, 3, 4, 1], cats=["矛盾", "来源", "重算"]),
    "agent-tool-use": dict(mw="次", noun="调用", items=["查知识库", "调题库", "搜资料", "算表达式"], nums=[5, 3, 4, 2], cats=["知识库", "题库", "资料"]),
    "ai-definition": dict(mw="条", noun="特征", short="人工智能", items=["模拟人类智能", "延伸人类能力", "扩展人类边界", "需要人来教"], nums=[1, 2, 3, 4], cats=["模拟", "延伸", "扩展"]),
    "ai-hierarchy": dict(mw="个", noun="层次", short="AI 技术层级", items=["人工智能", "机器学习", "深度学习", "生成式大模型"], nums=[4, 3, 2, 1], cats=["人工智能", "机器学习", "深度学习"]),
    "ai-three-values": dict(mw="个", noun="案例", short="AI 价值", items=["模仿人能做到", "做人做不到的事", "创造从未有过的", "教机器替人做"], nums=[3, 2, 1, 2], cats=["模仿", "超越", "创造"]),
    "aigc-media": dict(mw="张", noun="图片", short="文生图", items=["雪山日出", "蓝色机器人", "校园漫画", "太空猫咪"], nums=[4, 2, 5, 3], cats=["风景", "人物", "科幻"]),
    "algorithm": dict(mw="条", noun="规则", items=["找出规律", "自动筛选", "排序打分", "预测结果"], nums=[4, 3, 2, 1], cats=["规律", "排序", "预测"]),
    "artificial-neuron": dict(mw="个", noun="信号", items=["输入信号", "权重", "偏置", "门槛"], nums=[3, 5, 2, 4], cats=["输入", "权重", "门槛"]),
    "autonomous-driving": dict(mw="帧", noun="路况", items=["车道线", "前车距离", "行人位置", "交通灯"], nums=[6, 4, 3, 2], cats=["车道", "行人", "信号灯"]),
    "computer-vision": dict(mw="张", noun="图片", items=["手写数字", "猫脸", "斑马线", "二维码"], nums=[24, 32, 18, 40], cats=["数字", "动物", "标识"]),
    "computing-power": dict(mw="次", noun="运算", items=["训练一轮", "推理一次", "处理一段语音", "渲染一帧画面"], nums=[9, 3, 5, 2], cats=["训练", "推理", "渲染"]),
    "data": dict(mw="条", noun="样本", items=["温度记录", "考试成绩", "图片标注", "语音片段"], nums=[120, 86, 240, 64], cats=["数值", "文本", "图像"]),
    "data-processing": dict(mw="个", noun="环节", items=["清洗脏数据", "人工标注", "划分训练集", "划分测试集"], nums=[40, 35, 20, 5], cats=["清洗", "标注", "划分"]),
    "deep-learning": dict(mw="层", noun="网络", items=["输入层", "隐藏层", "输出层", "特征提取"], nums=[1, 5, 1, 3], cats=["输入层", "隐藏层", "输出层"]),
    "edu-agent": dict(mw="轮", noun="对话", items=["答疑", "批改", "陪练", "提醒复习"], nums=[5, 3, 4, 2], cats=["答疑", "批改", "复习"]),
    "edu-mistake-review": dict(mw="道", noun="错题", items=["概念不清", "计算失误", "审题偏差", "时间不够"], nums=[6, 4, 3, 2], cats=["概念", "计算", "审题"]),
    "edu-notes-mindmap": dict(mw="个", noun="知识点", short="讲义与导图", items=["定义", "公式", "例题", "易错点"], nums=[4, 3, 2, 5], cats=["定义", "例题", "易错点"]),
    "edu-preview-review": dict(mw="次", noun="练习", items=["预习提纲", "课堂笔记", "课后总结", "错题重做"], nums=[2, 3, 4, 1], cats=["预习", "复习", "重做"]),
    "edu-qa": dict(mw="次", noun="提问", items=["复述题意", "拆成小步", "提示方向", "留最后一步"], nums=[1, 2, 3, 4], cats=["复述", "拆解", "引导"]),
    "ethics-anti-misuse": dict(mw="次", noun="请求", items=["要求直接给答案", "要求代写作业", "要求跳过思考", "要求照抄范文"], nums=[4, 5, 2, 3], cats=["要答案", "代写", "照抄"]),
    "ethics-fairness": dict(mw="类", noun="学生群体", items=["低年级学生", "高年级学生", "有视力障碍的学生", "说方言的学生"], nums=[4, 5, 2, 4], cats=["低年级", "高年级", "有障碍"]),
    "ethics-information": dict(mw="条", noun="说法", items=["公司成立年份", "某领域第一人", "某实验成功", "某奖得主"], nums=[3, 2, 4, 1], cats=["时间", "人物", "事件"]),
    "ethics-privacy": dict(mw="条", noun="敏感信息", items=["身份证号", "家庭住址", "手机号", "聊天记录"], nums=[3, 5, 2, 4], cats=["证件", "住址", "联系方式"]),
    "genai": dict(mw="件", noun="作品", items=["一段故事", "一幅插画", "一首短诗", "一段视频"], nums=[4, 3, 5, 2], cats=["文字", "图片", "视频"]),
    "hardware-accelerator": dict(mw="块", noun="芯片", items=["通用处理器", "图形处理器", "专用加速芯片", "内存"], nums=[8, 32, 4, 16], cats=["通用", "图形", "专用"]),
    "industrial-inspection": dict(mw="件", noun="产品", items=["划痕", "气泡", "缺角", "色差"], nums=[7, 5, 3, 2], cats=["划痕", "气泡", "色差"]),
    "limit-hallucination": dict(mw="条", noun="回答", items=["编造的书名", "虚构的人物", "不存在的日期", "假托的实验"], nums=[3, 4, 2, 3], cats=["书名", "人物", "日期"]),
    "limit-interaction": dict(mw="次", noun="追问", items=["换个问法", "补一句背景", "追问细节", "中途改要求"], nums=[3, 4, 2, 5], cats=["改问法", "补背景", "追问"]),
    "limit-knowledge-cutoff": dict(mw="条", noun="资料", items=["去年教材", "今年新规", "上月新闻", "本周赛事"], nums=[4, 3, 2, 1], cats=["教材", "新闻", "赛事"]),
    "limit-teaching": dict(mw="名", noun="学生", items=["基础薄弱", "基础中等", "学有余力", "明显偏科"], nums=[6, 5, 3, 2], cats=["薄弱", "中等", "拔尖"]),
    "limit-understanding": dict(mw="个", noun="句子", items=["预测下个字", "按统计规律", "顺着上下文猜", "表面很流畅"], nums=[4, 3, 5, 2], cats=["预测", "统计", "流畅"]),
    "llm": dict(mw="条", noun="语料", items=["课文", "科普文章", "对话记录", "题目解析"], nums=[1200, 860, 540, 320], cats=["课文", "科普", "对话"]),
    "long-term-memory": dict(mw="条", noun="记录", items=["上次错题", "薄弱知识点", "学习进度", "偏好设置"], nums=[12, 5, 8, 3], cats=["错题", "弱点", "进度"]),
    "machine-learning": dict(mw="条", noun="样本", items=["邮件是不是垃圾", "明天会不会下雨", "图里有没有猫", "手写的是几"], nums=[200, 150, 180, 90], cats=["判断", "预测", "识别"]),
    "medical-imaging": dict(mw="张", noun="影像", short="医疗影像", items=["胸片", "CT 切片", "超声图像", "眼底照片"], nums=[24, 18, 12, 9], cats=["胸片", "CT", "超声"]),
    "narrow-ai": dict(mw="个", noun="场景", items=["下围棋", "识别人脸", "翻译句子", "写代码"], nums=[5, 4, 3, 2], cats=["棋类", "识别", "语言"]),
    "neural-network": dict(mw="个", noun="层次", items=["输入层", "隐藏层一", "隐藏层二", "输出层"], nums=[4, 8, 6, 2], cats=["输入", "隐藏", "输出"]),
    "nlp": dict(mw="句", noun="句子", items=["切分词语", "识别主语", "判断情感", "生成摘要"], nums=[4, 3, 2, 5], cats=["分词", "情感", "摘要"]),
    "prompt": dict(mw="条", noun="提示词", short="Prompt", items=["说明你是谁", "说明要做到什么", "说明输出格式", "给一个示例"], nums=[4, 3, 2, 1], cats=["角色", "要求", "格式"]),
    "rag": dict(mw="条", noun="资料", short="RAG 知识库", items=["课本第3章", "错题本", "课堂笔记", "课程标准"], nums=[6, 4, 3, 2], cats=["课本", "错题", "笔记"]),
    "reinforcement-learning": dict(mw="次", noun="尝试", items=["向左走", "向右走", "原地等", "往回走"], nums=[3, 5, 1, 2], cats=["左转", "右转", "等待"]),
    "short-term-memory": dict(mw="轮", noun="对话", items=["你刚才说的", "你给的条件", "刚发来的数据", "上一句问题"], nums=[3, 4, 2, 5], cats=["上文", "条件", "数据"]),
    "speech-recognition": dict(mw="段", noun="语音", short="语音识别", items=["你好小助手", "打开错题本", "今天天气怎样", "再讲一遍这道题"], nums=[4, 3, 5, 2], cats=["问候", "指令", "提问"]),
    "speech-synthesis": dict(mw="段", noun="语音", short="语音合成", items=["欢迎回来", "这道题做得好", "先休息一下吧", "明天继续加油"], nums=[3, 4, 2, 5], cats=["问候", "鼓励", "提醒"]),
    "strong-ai-agi": dict(mw="个", noun="领域", items=["写诗", "看病", "开车", "教课"], nums=[4, 3, 2, 1], cats=["创作", "诊断", "驾驶"]),
    "supervised-learning": dict(mw="道", noun="题目", items=["输入一张图", "给出标签", "模型预测", "对照答案"], nums=[4, 3, 2, 1], cats=["图片", "标签", "答案"]),
    "token": dict(mw="段", noun="文字", items=["人工", "智能", "是", "未来"], nums=[2, 2, 1, 2], cats=["词", "单字", "标点"]),
    "training-inference": dict(mw="个", noun="阶段", short="训练与推理", items=["收集数据", "训练模型", "验证效果", "上线答题"], nums=[4, 3, 2, 1], cats=["训练", "验证", "推理"]),
    "transformer": dict(mw="个", noun="词", short="Transformer", items=["猫", "坐", "在", "垫子"], nums=[3, 1, 1, 2], cats=["名词", "动词", "虚词"]),
    "unsupervised-learning": dict(mw="条", noun="数据", items=["身高体重", "购物记录", "听歌历史", "浏览轨迹"], nums=[120, 90, 60, 75], cats=["一簇", "二簇", "三簇"]),
    "voice-assistant": dict(mw="轮", noun="问答", items=["听懂指令", "查询信息", "念出答案", "继续追问"], nums=[4, 3, 5, 2], cats=["识别", "查询", "播报"]),
}


def run_solution(code: str) -> str:
    p = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=5,
    )
    return p.stdout


def lit_list(values: list) -> str:
    """把 Python 列表渲染成源码里的字面量（双引号，与标杆模板风格一致）。"""
    return "[" + ", ".join(json.dumps(v, ensure_ascii=False) for v in values) + "]"


def short_name(name: str) -> str:
    """标题里用的短名：去掉「：」后的解释、去掉斜杠后的并列项、去掉括号里的注释。"""
    s = name
    for sep in ("：", "/", "（"):
        if sep in s:
            s = s.split(sep)[0]
    return s.strip() or name


def pick_threshold(nums: list[int]) -> int:
    """挑一条门槛，使「达标」的项数既不为空也不为全部（保证筛选真的发生）。"""
    for cand in sorted(set(nums)):
        hit = sum(1 for v in nums if v >= cand)
        if 0 < hit < len(nums):
            return cand
    return nums[0]


# ====================================================================== #
# 14 个家族：每族 = 一种真实编程能力
# 入参统一为 (short, items, nums, unit, cats, noun)，返回 dict(title/scaffold/
# solution/expected_behavior/hints)。
# ====================================================================== #
def fam_pl_vars_sum(short, items, nums, unit, cats, noun):
    a, b, c = nums[0], nums[1], nums[2]
    total = a + b + c
    title = f"变量：把{short}的三组{noun}加起来"
    scaffold = (
        "# 目标：用变量存下三项数据，算出总数并打印\n"
        f"a = {a}\n"
        f"b = {b}\n"
        f"c = {c}\n"
        "\n"
        "# TODO 1：把三项加起来，存进 total\n"
        "total = ____\n"
        "\n"
        f"# TODO 2：打印「一共 N {unit}」\n"
        "____\n"
    )
    solution = (
        f"a = {a}\n"
        f"b = {b}\n"
        f"c = {c}\n"
        "\n"
        "total = a + b + c\n"
        "\n"
        f'print(f"一共 {{total}} {unit}")\n'
    )
    expected_behavior = f"填好 TODO 1-2 后，程序打印「一共 {total} {unit}」。"
    hints = [
        {"level": 1, "hint": "「一共」是把几个数合起来，先想好用哪个运算符号。"},
        {"level": 2, "hint": f"把 {a}、{b}、{c} 三个数用加号连起来，结果存进 total。"},
        {"level": 3, "hint": f'total 那一行写成 a + b + c；再打印 print(f"一共 {{total}} {unit}")。'},
    ]
    return dict(title=title, scaffold=scaffold, solution=solution, expected_behavior=expected_behavior, hints=hints)


def fam_pl_count(short, items, nums, unit, cats, noun):
    lit = lit_list(items)
    n = len(items)
    title = f"列表：清点{short}的{noun}"
    scaffold = (
        "# 目标：数出列表里有几项\n"
        f"parts = {lit}\n"
        "\n"
        "# TODO 1：用 len 数出项数，存进 count\n"
        "count = ____\n"
        "\n"
        f"# TODO 2：打印「一共有 N {unit}」\n"
        "____\n"
    )
    solution = (
        f"parts = {lit}\n"
        "\n"
        "count = len(parts)\n"
        "\n"
        f'print(f"一共有 {{count}} {unit}")\n'
    )
    expected_behavior = f"填好 TODO 1-2 后，程序打印「一共有 {n} {unit}」。"
    hints = [
        {"level": 1, "hint": "「有几项」不用一个一个数，有一个现成的函数帮你算出长度。"},
        {"level": 2, "hint": "把列表交给这个函数，返回值存进 count。"},
        {"level": 3, "hint": f'count = len(parts)；再打印 print(f"一共有 {{count}} {unit}")。'},
    ]
    return dict(title=title, scaffold=scaffold, solution=solution, expected_behavior=expected_behavior, hints=hints)


def fam_pl_diff(short, items, nums, unit, cats, noun):
    big, small = max(nums), min(nums)
    gap = big - small
    title = f"变量：算{short}两组{noun}相差多少"
    scaffold = (
        "# 目标：算出两组数据相差多少\n"
        f"big = {big}\n"
        f"small = {small}\n"
        "\n"
        "# TODO 1：用大的减去小的，存进 gap\n"
        "gap = ____\n"
        "\n"
        f"# TODO 2：打印「相差 N {unit}」\n"
        "____\n"
    )
    solution = (
        f"big = {big}\n"
        f"small = {small}\n"
        "\n"
        "gap = big - small\n"
        "\n"
        f'print(f"相差 {{gap}} {unit}")\n'
    )
    expected_behavior = f"填好 TODO 1-2 后，程序打印「相差 {gap} {unit}」。"
    hints = [
        {"level": 1, "hint": "「相差多少」要用大的数减去小的数，先看清哪个大。"},
        {"level": 2, "hint": "把 big 写在减号前面、small 写在后面，结果存进 gap。"},
        {"level": 3, "hint": f'gap = big - small；再打印 print(f"相差 {{gap}} {unit}")。'},
    ]
    return dict(title=title, scaffold=scaffold, solution=solution, expected_behavior=expected_behavior, hints=hints)


def fam_ph_loop_list(short, items, nums, unit, cats, noun):
    lit = lit_list(items)
    n = len(items)
    title = f"循环：把{short}的{noun}逐条列出来"
    scaffold = (
        "# 目标：把列表里的每一项逐条列出来\n"
        f"parts = {lit}\n"
        "\n"
        "# TODO 1：用循环依次取出每一项，编号从 1 开始\n"
        "____\n"
        "# TODO 2：打印「第N项：内容」\n"
        "    ____\n"
    )
    solution = (
        f"parts = {lit}\n"
        "\n"
        "for i, p in enumerate(parts, 1):\n"
        '    print(f"第{i}项：{p}")\n'
    )
    expected_behavior = f"填好 TODO 后，程序打印 {n} 行，第一行是「第1项：{items[0]}」，最后一行是「第{n}项：{items[-1]}」。"
    hints = [
        {"level": 1, "hint": "重复的动作交给会循环的句式，让它一项一项地从列表里取。"},
        {"level": 2, "hint": "用 enumerate 一边取内容、一边给出从 1 开始的编号。"},
        {"level": 3, "hint": 'for i, p in enumerate(parts, 1): 下一行缩进写 print(f"第{i}项：{p}")。'},
    ]
    return dict(title=title, scaffold=scaffold, solution=solution, expected_behavior=expected_behavior, hints=hints)


def fam_ph_loop_sum(short, items, nums, unit, cats, noun):
    lit = lit_list(nums)
    total = sum(nums)
    title = f"循环：累加{short}的{noun}数量"
    scaffold = (
        "# 目标：把列表里的数全部加起来\n"
        f"nums = {lit}\n"
        "total = 0\n"
        "\n"
        "# TODO 1：用循环依次取出每个数\n"
        "____\n"
        "# TODO 2：把当前数加进 total\n"
        "    ____\n"
        "\n"
        f'print(f"合计 {{total}} {unit}")\n'
    )
    solution = (
        f"nums = {lit}\n"
        "total = 0\n"
        "\n"
        "for x in nums:\n"
        "    total = total + x\n"
        "\n"
        f'print(f"合计 {{total}} {unit}")\n'
    )
    expected_behavior = f"填好 TODO 后，程序打印「合计 {total} {unit}」。"
    hints = [
        {"level": 1, "hint": "先准备一个从零开始的变量，再把每一项都加进去。"},
        {"level": 2, "hint": "循环取出的每个数都加进 total，算完要重新存回 total。"},
        {"level": 3, "hint": "for x in nums: 下一行缩进写 total = total + x。"},
    ]
    return dict(title=title, scaffold=scaffold, solution=solution, expected_behavior=expected_behavior, hints=hints)


def fam_ph_filter(short, items, nums, unit, cats, noun):
    lit_items = lit_list(items)
    lit_nums = lit_list(nums)
    th = pick_threshold(nums)
    picked = [items[i] for i in range(len(items)) if nums[i] >= th]
    title = f"条件判断：挑出{short}里达标的{noun}"
    scaffold = (
        "# 目标：挑出达到门槛的项目\n"
        f"names = {lit_items}\n"
        f"values = {lit_nums}\n"
        f"threshold = {th}\n"
        "\n"
        "# TODO 1：准备一个空列表，用来装选中的名字\n"
        "picked = ____\n"
        "# TODO 2：逐项比较，达到门槛就放进去\n"
        "____\n"
        "# TODO 3：打印选中的结果\n"
        "____\n"
    )
    solution = (
        f"names = {lit_items}\n"
        f"values = {lit_nums}\n"
        f"threshold = {th}\n"
        "\n"
        "picked = []\n"
        "for i in range(len(names)):\n"
        "    if values[i] >= threshold:\n"
        "        picked.append(names[i])\n"
        "\n"
        "print(picked)\n"
    )
    expected_behavior = f"填好 TODO 后，程序打印达到门槛的 {len(picked)} 项：{'、'.join(picked)}。"
    hints = [
        {"level": 1, "hint": "先确定一条门槛，再逐项看它够不够格。"},
        {"level": 2, "hint": "准备一个空列表，把达到门槛的名字一个个追加进去。"},
        {"level": 3, "hint": f"for i in range(len(names)): 下一行缩进写 if values[i] >= {th}: picked.append(names[i])。"},
    ]
    return dict(title=title, scaffold=scaffold, solution=solution, expected_behavior=expected_behavior, hints=hints)


def fam_jr_dict(short, items, nums, unit, cats, noun):
    lit_items = lit_list(items)
    lit_nums = lit_list(nums)
    title = f"字典：给{short}的{noun}建一张对照表"
    scaffold = (
        "# 目标：把项目名和数量配对成字典，再按名字查数量\n"
        f"names = {lit_items}\n"
        f"counts = {lit_nums}\n"
        "\n"
        "# TODO 1：用 zip 把两个列表配成字典 table\n"
        "table = ____\n"
        "\n"
        f"# TODO 2：打印「名字 有 N {unit}」（用 names[0] 查一次）\n"
        "____\n"
    )
    solution = (
        f"names = {lit_items}\n"
        f"counts = {lit_nums}\n"
        "\n"
        "table = dict(zip(names, counts))\n"
        "\n"
        f'print(f"{{names[0]}} 有 {{table[names[0]]}} {unit}")\n'
    )
    expected_behavior = f"填好 TODO 后，程序打印「{items[0]} 有 {nums[0]} {unit}」。"
    hints = [
        {"level": 1, "hint": "两个列表一一对应，可以用一个现成的函数一次配成字典。"},
        {"level": 2, "hint": "把两个列表交给配对的函数，外层套上 dict 就得到 table。"},
        {"level": 3, "hint": "table = dict(zip(names, counts))；取数量用 table[names[0]]。"},
    ]
    return dict(title=title, scaffold=scaffold, solution=solution, expected_behavior=expected_behavior, hints=hints)


def fam_jr_func(short, items, nums, unit, cats, noun):
    lit = lit_list(nums)
    mean_txt = f"{sum(nums) / len(nums):.1f}"
    title = f"函数：求{short}的{noun}平均值"
    scaffold = (
        "# 目标：写一个求平均值的函数，再用它算一遍\n"
        f"nums = {lit}\n"
        "\n"
        "# TODO 1：补完函数体，返回平均值\n"
        "def average(data):\n"
        "    ____\n"
        "\n"
        "# TODO 2：调用函数，打印「平均 N」（保留 1 位小数）\n"
        "____\n"
    )
    solution = (
        f"nums = {lit}\n"
        "\n"
        "def average(data):\n"
        "    return sum(data) / len(data)\n"
        "\n"
        "avg = average(nums)\n"
        'print(f"平均 {avg:.1f}")\n'
    )
    expected_behavior = f"填好 TODO 后，程序打印「平均 {mean_txt}」。"
    hints = [
        {"level": 1, "hint": "先想清楚这个函数收进来什么、又交出去什么。"},
        {"level": 2, "hint": "函数体里先求和、再除以个数，然后用 return 把结果交出去。"},
        {"level": 3, "hint": "def average(data): 下面缩进写 return sum(data) / len(data)。"},
    ]
    return dict(title=title, scaffold=scaffold, solution=solution, expected_behavior=expected_behavior, hints=hints)


def fam_jr_freq(short, items, nums, unit, cats, noun):
    tokens = [cats[0], cats[1], cats[0], cats[2], cats[0], cats[1]]
    lit = lit_list(tokens)
    major = tokens.count(cats[0])
    title = f"字典：统计{short}里各类别的出现次数"
    scaffold = (
        "# 目标：统计每个类别出现了几次\n"
        f"tags = {lit}\n"
        "\n"
        "# TODO 1：准备一个空字典 counts\n"
        "counts = ____\n"
        "# TODO 2：逐个统计，同一个类别就加 1\n"
        "____\n"
        "# TODO 3：打印统计结果\n"
        "____\n"
    )
    solution = (
        f"tags = {lit}\n"
        "\n"
        "counts = {}\n"
        "for t in tags:\n"
        "    counts[t] = counts.get(t, 0) + 1\n"
        "\n"
        "print(counts)\n"
    )
    expected_behavior = f"填好 TODO 后，程序打印每个类别的次数，其中「{cats[0]}」会出现 {major} 次。"
    hints = [
        {"level": 1, "hint": "准备一个空字典，一边走一边给类别记次数。"},
        {"level": 2, "hint": "遇到类别就用 counts.get(t, 0) 取旧值再加 1，结果存回 counts。"},
        {"level": 3, "hint": "counts[t] = counts.get(t, 0) + 1，写在循环体里。"},
    ]
    return dict(title=title, scaffold=scaffold, solution=solution, expected_behavior=expected_behavior, hints=hints)


def fam_jr_str(short, items, nums, unit, cats, noun):
    line = "，".join(items)
    n = len(items)
    title = f"字符串：把{short}的要点串拆开再排版"
    scaffold = (
        "# 目标：把一整串要点拆开，重新编号排好\n"
        f'line = "{line}"\n'
        "\n"
        "# TODO 1：按「，」把 line 切分成列表 parts\n"
        "parts = ____\n"
        "# TODO 2：逐条打印「N. 内容」\n"
        "____\n"
    )
    solution = (
        f'line = "{line}"\n'
        "\n"
        'parts = line.split("，")\n'
        "\n"
        "for i, p in enumerate(parts, 1):\n"
        '    print(f"{i}. {p}")\n'
    )
    expected_behavior = f"填好 TODO 后，程序打印 {n} 行，第一行是「1. {items[0]}」。"
    hints = [
        {"level": 1, "hint": "把一整句话按标点切开，会得到一个列表。"},
        {"level": 2, "hint": "字符串自带切分方法，切完再用 enumerate 编号打印。"},
        {"level": 3, "hint": 'parts = line.split("，")；再 for i, p in enumerate(parts, 1): print(f"{i}. {p}")。'},
    ]
    return dict(title=title, scaffold=scaffold, solution=solution, expected_behavior=expected_behavior, hints=hints)


def fam_sr_stats(short, items, nums, unit, cats, noun):
    lit = lit_list(nums)
    mean_txt = f"{sum(nums) / len(nums):.1f}"
    top = max(nums)
    title = f"统计：算{short}这组{noun}的平均值与最大值"
    scaffold = (
        "# 目标：求这批数据的平均值和最大值\n"
        f"nums = {lit}\n"
        "\n"
        "# TODO 1：求平均值，存进 mean\n"
        "mean = ____\n"
        "# TODO 2：求最大值，存进 top\n"
        "top = ____\n"
        "# TODO 3：打印「平均 x，最大 y」（平均保留 1 位小数）\n"
        "____\n"
    )
    solution = (
        f"nums = {lit}\n"
        "\n"
        "mean = sum(nums) / len(nums)\n"
        "top = max(nums)\n"
        "\n"
        'print(f"平均 {mean:.1f}，最大 {top}")\n'
    )
    expected_behavior = f"填好 TODO 后，程序打印「平均 {mean_txt}，最大 {top}」。"
    hints = [
        {"level": 1, "hint": "平均值是把总和摊到每一项上；最大值可以先排好队再看。"},
        {"level": 2, "hint": "平均值用总和除以个数，最大值交给现成的函数。"},
        {"level": 3, "hint": "mean = sum(nums) / len(nums)；top = max(nums)。"},
    ]
    return dict(title=title, scaffold=scaffold, solution=solution, expected_behavior=expected_behavior, hints=hints)


def fam_sr_nested(short, items, nums, unit, cats, noun):
    grid = [nums[0:2], nums[2:4]]
    lit = "[" + ", ".join(lit_list(row) for row in grid) + "]"
    totals = [sum(row) for row in grid]
    title = f"嵌套循环：按行合计{short}的二维数据"
    scaffold = (
        "# 目标：数据按行分组，求每一行的合计\n"
        f"grid = {lit}\n"
        "\n"
        "totals = []\n"
        "# TODO 1：外层循环取出每一行\n"
        "____\n"
        "# TODO 2：内层把这一行的数加起来，追加进 totals\n"
        "    ____\n"
        "\n"
        "print(totals)\n"
    )
    solution = (
        f"grid = {lit}\n"
        "\n"
        "totals = []\n"
        "for row in grid:\n"
        "    s = 0\n"
        "    for v in row:\n"
        "        s = s + v\n"
        "    totals.append(s)\n"
        "\n"
        "print(totals)\n"
    )
    expected_behavior = f"填好 TODO 后，程序打印每行的合计：{totals}。"
    hints = [
        {"level": 1, "hint": "数据分成了好几行，先管每一行，再管行里的数。"},
        {"level": 2, "hint": "外层取出一行，内层把这一行的数加起来，最后把和追加进 totals。"},
        {"level": 3, "hint": "for row in grid: 里面先 s = 0，再 for v in row: s = s + v，最后 totals.append(s)。"},
    ]
    return dict(title=title, scaffold=scaffold, solution=solution, expected_behavior=expected_behavior, hints=hints)


def fam_sr_normalize(short, items, nums, unit, cats, noun):
    lit = lit_list(nums)
    n = len(nums)
    title = f"数据变换：把{short}的{noun}标准化"
    scaffold = (
        "# 目标：把这组数据标准化（先减平均值，再除以标准差）\n"
        "import math\n"
        f"xs = {lit}\n"
        "\n"
        "# TODO 1：求平均值 mu\n"
        "mu = ____\n"
        "# TODO 2：求标准差 sigma\n"
        "sigma = ____\n"
        "# TODO 3：算出标准化后的 zs\n"
        "zs = ____\n"
        "\n"
        "print([round(z, 2) for z in zs])\n"
    )
    solution = (
        "import math\n"
        f"xs = {lit}\n"
        "\n"
        "mu = sum(xs) / len(xs)\n"
        "sigma = math.sqrt(sum((x - mu) ** 2 for x in xs) / len(xs))\n"
        "\n"
        "zs = [(x - mu) / sigma for x in xs]\n"
        "print([round(z, 2) for z in zs])\n"
    )
    expected_behavior = f"填好 TODO 后，程序打印 {n} 个保留两位小数的数，体现每个数偏离平均值的程度。"
    hints = [
        {"level": 1, "hint": "先把每个数减去平均值，再除以这组数据的离散程度。"},
        {"level": 2, "hint": "标准差要先算每个数与平均值差的平方，求平均后再开方。"},
        {"level": 3, "hint": "sigma 用 math.sqrt 计算；zs 用列表推导 (x - mu) / sigma。"},
    ]
    return dict(title=title, scaffold=scaffold, solution=solution, expected_behavior=expected_behavior, hints=hints)


def fam_sr_classify(short, items, nums, unit, cats, noun):
    lit = lit_list(nums)
    th = pick_threshold(nums)
    ok = sum(1 for v in nums if v >= th)
    title = f"函数：给{short}的{noun}按门槛分类"
    scaffold = (
        "# 目标：给每个数按门槛分类，再数一数达标的有几个\n"
        f"nums = {lit}\n"
        f"threshold = {th}\n"
        "\n"
        "# TODO 1：补完函数，达到门槛返回「达标」，否则返回「待改进」\n"
        "def level_of(x):\n"
        "    ____\n"
        "\n"
        "# TODO 2：逐项分类，统计达标个数 ok\n"
        "____\n"
        "# TODO 3：打印「达标 N 项」\n"
        "____\n"
    )
    solution = (
        f"nums = {lit}\n"
        f"threshold = {th}\n"
        "\n"
        "def level_of(x):\n"
        "    if x >= threshold:\n"
        '        return "达标"\n'
        '    return "待改进"\n'
        "\n"
        "ok = 0\n"
        "for x in nums:\n"
        '    if level_of(x) == "达标":\n'
        "        ok = ok + 1\n"
        "\n"
        'print(f"达标 {ok} 项")\n'
    )
    expected_behavior = f"填好 TODO 后，程序打印「达标 {ok} 项」。"
    hints = [
        {"level": 1, "hint": "先想清楚一个数满足什么条件算达标，再逐项判断。"},
        {"level": 2, "hint": "函数里用条件判断返回两种字符串；外面数一数达标的有几个。"},
        {"level": 3, "hint": f'def level_of(x): 下面缩进写 if x >= {th}: return "达标"，否则 return "待改进"。'},
    ]
    return dict(title=title, scaffold=scaffold, solution=solution, expected_behavior=expected_behavior, hints=hints)


FAMILIES = {
    "pl_vars_sum": fam_pl_vars_sum,
    "pl_count": fam_pl_count,
    "pl_diff": fam_pl_diff,
    "ph_loop_list": fam_ph_loop_list,
    "ph_loop_sum": fam_ph_loop_sum,
    "ph_filter": fam_ph_filter,
    "jr_dict": fam_jr_dict,
    "jr_func": fam_jr_func,
    "jr_freq": fam_jr_freq,
    "jr_str": fam_jr_str,
    "sr_stats": fam_sr_stats,
    "sr_nested": fam_sr_nested,
    "sr_normalize": fam_sr_normalize,
    "sr_classify": fam_sr_classify,
}

#: 每学段可用的家族池（难度阶梯真实：pl 只碰变量与运算，sr 上统计量与嵌套）。
POOLS = {
    "primary_low": ["pl_vars_sum", "pl_count", "pl_diff"],
    "primary_high": ["ph_loop_list", "ph_loop_sum", "ph_filter"],
    "junior": ["jr_dict", "jr_func", "jr_freq", "jr_str"],
    "senior": ["sr_stats", "sr_nested", "sr_normalize", "sr_classify"],
}


def build_exercise(entry: dict, grade: str, concept_index: int) -> dict | None:
    item = entry["by_grade"].get(grade)
    if not item:
        return None
    base = entry["base"]
    theme = THEMES[base]
    short = theme.get("short") or short_name(item["name"])
    unit = theme["mw"] + theme["noun"]
    pool = POOLS[grade]
    family = FAMILIES[pool[concept_index % len(pool)]]
    spec = family(short, theme["items"], theme["nums"], unit, theme["cats"], theme["noun"])

    scaffold = spec["scaffold"]
    if scaffold.count("TODO") < 2:
        scaffold = scaffold.rstrip() + "\n\n# TODO：对照 expected_behavior 自查一遍\n"

    return {
        "kp_id": item["kp_id"],
        "grade_level": grade,
        "title": spec["title"],
        "expected_behavior": spec["expected_behavior"],
        "scaffold": scaffold,
        "expected_output": run_solution(spec["solution"]),
        "hints": spec["hints"],
        "solution": spec["solution"],
    }


def _write(payload: str, kp_id: str) -> None:
    """落盘到两个目录。★ ``newline="\\n"`` 必须显式给：Windows 上默认会把 ``\\n`` 翻成
    ``\\r\\n``，而仓库 ``.gitattributes`` 强制 LF —— 不写死就会把 228 份全部改成 CRLF。"""
    for out in OUT_DIRS:
        with open(out / f"{kp_id}.json", "w", encoding="utf-8", newline="\n") as fh:
            fh.write(payload)


def main() -> None:
    written = 0
    errors = []
    concept_index = 0
    for entry in data["concepts"]:
        if entry["base"].startswith("prog"):
            # ★ 编程章：12 份手作标杆原样复制（内容与换行都照搬，绝不重排）
            for grade in GRADE_LEVELS:
                item = entry["by_grade"].get(grade)
                if not item:
                    continue
                kp_id = item["kp_id"]
                src = ROOT / "server" / "resources" / "code-templates" / f"{kp_id}.json"
                if src.exists():
                    _write(src.read_text(encoding="utf-8"), kp_id)
                    written += 1
                else:
                    errors.append((kp_id, "missing-premium", str(src), ""))
            continue

        for grade in GRADE_LEVELS:
            rec = build_exercise(entry, grade, concept_index)
            if not rec:
                continue
            rerun = run_solution(rec["solution"])
            if rerun != rec["expected_output"]:
                errors.append((rec["kp_id"], "output-mismatch", repr(rerun), repr(rec["expected_output"])))
            _write(json.dumps(rec, ensure_ascii=False, indent=2) + "\n", rec["kp_id"])
            written += 1
        concept_index += 1

    print("written", written)
    if errors:
        print("ERRORS", len(errors))
        for e in errors[:20]:
            print(e)
    else:
        print("all solutions ran and matched expected_output")


if __name__ == "__main__":
    main()
