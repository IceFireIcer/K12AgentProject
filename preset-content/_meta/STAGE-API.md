# 动画舞台接口（STAGE-API · 冻结）

> **谁该读这份文档**：给 206 份「一 KP 一模板」写 `body` / `script` 的生成流水线（人 or AI）。
> **冻结的含义**：下面这些名字与签名是**契约**。运行时（`server/resources/templates/_shared/runtime.js`）
> 与守卫（`server/tests/test_sandbox_palette.py::TestStageApiIsFrozen`）都按它们断言 ——
> 你照着写，产物一定过校验；你自创名字，产物一定静止（而且**不会报错**，只是卡片永远不动）。

---

## 0. 一句话心智模型

**模板脚本只描述「讲什么 + 什么顺序」，舞台长什么样由 `skins.css` 按学段决定。**

```
server/app/routes/resources.py           服务端拼装（唯一落点）
  <html data-grade="junior" data-skin="technical">
        │
        ├── base.css      结构 + 兜底取值（学段皮肤缺席也能渲染）
        ├── skins.css     学段调色板（由 design tokens 生成）+ 皮肤刻度 + .k12-* 基元类
        ├── anime.min.js  v3.2.2（内联，锁 v3）
        ├── runtime.js    window.Sandbox（含本文的舞台基元）
        └── 你的 body + script
```

学段 → 皮肤只有一处映射：`server/app/routes/resources.py::GRADE_TO_SKIN`。

---

## 1. 只读状态（不要自己判断学段）

| 成员 | 取值 | 说明 |
| --- | --- | --- |
| `Sandbox.grade` | `'primary_low'` \| `'primary_high'` \| `'junior'` \| `'senior'` \| `'default'` | 读 `<html data-grade>`；学段缺失时是 `'default'` |
| `Sandbox.skin` | `'illustrated'` \| `'technical'` | 读 `<html data-skin>`；小学两个学段 = illustrated，初中高中 = technical |
| `Sandbox.motion` | `{ duration, easing, stagger, holdMs }` | 按皮肤给的动效预设，**模板不要写死时长与缓动** |

```js
// illustrated（小学）：duration 720 · easing 'easeOutBack' · stagger 140 · holdMs 620
// technical （中学）：duration 460 · easing 'easeInOutQuad' · stagger 90  · holdMs 380
```

**想按皮肤分化内容时**（小学多讲一步、中学多给数字）：

```js
if (Sandbox.skin === 'illustrated') { /* 更慢、更少节点、更长的 hold */ }
```

← 但**不要**用它去判断学段（`Sandbox.grade` 才是学段）。两者是两个轴，不要互相推。

---

## 2. 外壳（一直都有，别删）

| 调用 | 语义 |
| --- | --- |
| `Sandbox.caption(text)` | 更新字幕行：优先写 `#caption`，没有就写第一个 `.anim-caption`。每换一个相位都该更新它 |
| `Sandbox.step(n, total)` | 更新步骤条：写 `#stage .chip`，没有就补一个。文本是「第 n 步 / 共 total 步」 |

**body 里必须有一行 `<h1 class="anim-title">`**（在 `<div id="stage">` 之后、脚本之前），
以及一行 `<p class="anim-caption" id="caption">` 与一个 `<span class="chip">`（`step()` 会写它）。
`<div class="anim-canvas">` 是舞台的落点 —— `Sandbox.stage()` 会往里建 SVG。

---

## 3. 舞台基元（冻结）

坐标系一律是 **720 × 420**（`viewBox="0 0 720 420"`，`preserveAspectRatio="xMidYMid meet"`）。
所有基元**只建 DOM、不动时间轴**，所以播放前 / 播放中 / 重播时调用都安全。

**新写模板请从 §3bis 的自动布局层入手**：手算坐标是「文字、图标、小人错位重叠」的直接来源。

### 3.1 `Sandbox.stage()`

建（或取）舞台，返回 `{ svg, width, height }`（`width = 720`，`height = 420`）。
幂等：重复调用返回同一块 SVG。舞台分两层 —— 背景层（`grid` / `axis`）与前景层（其余基元）。

> 通常**不用自己调**：任何一个前景基元第一次被调用时会自动建舞台。

### 3.2 `Sandbox.grid(opts)`

淡淡的网格 + 边框，返回 `<g>`。

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `x, y, w, h` | `34, 30, 652, 360` | 网格区域 |
| `cols, rows` | `8, 5` | 格数 |

★ 工程皮肤（technical）里它接近「刻度纸」，插画皮肤里只是很淡的暗示（由 CSS 的
`.k12-grid` 透明度决定）—— **同一份代码，两种气质**，你不需要分支。

### 3.3 `Sandbox.axis({x, y, w, h, xLabel, yLabel})`

坐标轴（带箭头与刻度），返回 `<g>`，组上带 **`plot`**：

```js
var ax = Sandbox.axis({ x: 90, y: 60, w: 560, h: 280, xLabel: '输入', yLabel: '输出' })
// ax.plot = { x, y, w, h, originX, originY }  ← 轴围出来的绘图区，用它把数据映射进去
var px = ax.plot.originX + (value / max) * ax.plot.w
```

### 3.4 `Sandbox.node({x, y, w, h, label, sub, tone, focus})`

圆角矩形 + 居中文字（+ 可选副标题），返回 `<g>`，组上带 **`body`**（那个 `<rect>`，动画
通常就动它）与 `k12Box`。

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `x, y, w, h` | `0, 0, 180, 78` | 位置与大小（**h 不够时会自动长高**，见「永不截断」） |
| `label` | `''` | 主文字 |
| `sub` | `''` | 副文字（小一号、次要色） |
| `tone` | `'base'` | `'base'` \| `'accent'` \| `'muted'` \| `'warn'` |
| `focus` | `false` | 加粗描边（「当前讲到的是它」） |

```js
var a = Sandbox.node({ x: 60, y: 150, w: 200, h: 90, label: '取数据', sub: '第 1 步', tone: 'accent' })
anime({ targets: a.body, opacity: [0, 1], translateY: [12, 0], duration: Sandbox.motion.duration })
```

### 3.5 `Sandbox.actor({x, y, pose, label, scale})`

人物（插画皮肤的当家角色），返回 `<g>`。

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `x, y` | 必给 | **脚底**落在 `y` 这条线上 |
| `pose` | `'stand'` | `'stand'` \| `'point'` \| `'carry'` \| `'walk'` |
| `label` | `''` | 人物名（画在脚下） |
| `scale` | `1` | 缩放（角色高约 96 × scale） |

★ 同一份代码在两种皮肤下都成立：插画皮肤是圆头圆肩的软角色，工程皮肤自动变成细描边的
示意体（由 CSS 的 `--k12-radius-*` / `--k12-stroke` 决定）。**不要**写 `if (skin === ...)` 去换画法。

### 3.6 `Sandbox.bubble({x, y, text, who, tail, w})`

说话气泡（圆角框 + 小尾巴），返回 `<g>`，组上带 `k12Box`。

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `x, y` | 必给 | 框**左上角** |
| `text` | `''` | 内容（永不截断；框会按内容长高 / 长宽） |
| `who` | `''` | 语气角色：`''` 中性 \| `'narrator'` 叙述（灰面）\| `'accent'` 强调（主色面） |
| `tail` | `'left'` | `'left'` \| `'right'` \| `'none'` |
| `w` | `260` | 最大宽度（实际宽度按内容收敛） |

### 3.7 `Sandbox.link(a, b, {label, style, directed})`

连接线：**从 `a` 盒子的边出发、到 `b` 盒子的边结束**（不是中心到中心，所以线不会穿过盒子）。

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `style` | `'solid'` | `'solid'` \| `'dashed'` \| `'pipe'`（粗管道：数据流） |
| `directed` | `false` | `true` 时末端加箭头 |
| `label` | `''` | 线上的标签（带底色衬垫，压在线上也读得清） |

`a` / `b` 可以是 `Sandbox.node()` / `Sandbox.readout()` 的返回值，也可以是 `{x, y, w, h}` 或 `{x, y}`：

```js
Sandbox.link(a, b, { directed: true, style: 'pipe', label: '每轮 +1' })
```

### 3.8 `Sandbox.readout({x, y, label, value, unit, w, h})`

数值读数（标签 + **等宽数字** + 单位），返回 `<g>`，组上带 **`set(value)`**：

```js
var meter = Sandbox.readout({ x: 520, y: 60, label: '累计', value: 0, unit: '次' })
meter.set(3)   // 在相位里更新它（数字是 tabular-nums，跳动时不会左右抖）
```

### 3.9 `Sandbox.caption(text)` / `Sandbox.step(n, total)`

见 §2。

---

## 3bis. 自动布局层（`zone` / `row` / `stack` / `measure` / `layout` / `safe`）

> **为什么有这一层**：手算坐标必然重叠。旧写法是
> 「可用宽度 − 固定卡宽 × 站点数，再除以站点数 + 1」——站点一多、分子变负，盒子互相压；
> 文案一长，`node()` 为「永不截断」自己长高，又压住下一行；读数框钉死在右下角，与步骤条挤在一起。
> 根因是**没有任何一处知道别人占了多大地方**。这一层只做一件事：让「谁占了多大地方」
> 成为唯一的定位依据。

### 3bis.1 `Sandbox.zone({x, y, w, h, gap})`

保留一条**横带**；**不写 `y` 就自动排在上一条带的下方**（这就是「纵向不重叠」的全部机制）。

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `x, w` | 38 / 到右边距 | 带的左右边界 |
| `y` | 纵向游标 | 显式给 y 就不吃游标（少见的用法） |
| `h` | 0 | **下限**：带至少要这么高；里面的行比它高，带就按行的实际高度长 |
| `gap` | 16 | 带内默认行距 |

返回的带对象带 `{x, y, w, h, top, bottom, left, right, centerX, centerY, rect()}`，
以及三个排布方法：

| 方法 | 语义 |
| --- | --- |
| `band.row({items, h, gap, x, w, y})` | 横着排一行：格子**均分**（带 `w` 的先扣掉、其余按 `weight`），**整行同一个高度**（行里最费的那一项说了算） |
| `band.stack({items, anchor, inset, gap, w, spread})` | 竖着叠一摞；`anchor:'bottom'` 时自下而上（「一层层往上搭」），`inset` 逐层收窄（塔形） |
| `band.rows({rows, gap, h, spread, w})` | 竖排若干**等高**的行（清单 / 判定链：每行自己又是横着排的） |
| `band.place(id, {kind, w, h, align, valign, ...})` | 带里放一个**不参与分行**的块（读数框），按 `align`/`valign` 对齐 |

`row()` 的 `items` 每项可以给：`kind`（`node` / `readout` / `bubble` / `actor` / `blank` / `text`）、
`label` / `sub` / `tone` / `focus`（节点）、`text` / `who` / `tail`（气泡）、`value` / `unit`（读数）、
`w`（写死宽度）或 `weight`（按比例分）。

**返回值**：`{ groups, boxes, centers, cells, height, top, bottom }`。

### 3bis.2 `Sandbox.row({items, x, w, y, gap, h})` / `Sandbox.stack({...})`

不带带的独立一行 / 一摞（等价于 `Sandbox.zone(...).row(...)`，写法短一点）。

### 3bis.3 `Sandbox.measure({kind, w, label, sub, text, tail})`

量一段文字要多大的盒子 —— **与基元内部同一套算式**（折行 + 缩字号 + 内边距）。
用途：同一格里要轮播好几段文案时，按**最大的一段**预留尺寸，这样轮播过程中盒子一次都不会长大。

### 3bis.4 `Sandbox.layout(plan)` —— 声明式：照单画

批量生成的模板走这条：生成侧（`preset-content/_meta/gen_animations.py` 的 `Planner`）
在**离线**就把每一格的位置与尺寸算好，运行时照单建。清单形状：

```js
var L = Sandbox.layout({
  bands: [ { id: 'stops', x: 34, y: 34, w: 652, h: 129 } ],
  cells: [ { id: 'stop-0', band: 'stops', kind: 'node', x: 34, y: 74, w: 152, h: 129,
             label: '取数据', sub: '第一步' } ],
  actors: [ { id: 'guide', x: 110, y: 300, pose: 'walk', scale: 0.85, label: '带路的同学' } ],
  rails: [ { id: 'road', from: [36, 300], to: [684, 300], style: 'pipe' } ],
  plots: [ { id: 'track', kind: 'ellipse', cx: 282, cy: 176, rx: 80, ry: 78, x: 189, y: 85, w: 186, h: 182 } ],
  spread: [ { prefix: 'stop-', param: 'stations', min: 3, max: 4, axis: 'x', mode: 'center' } ]
});
```

返回 `{ bands, boxes, actors, rails, plots, list(prefix), one(id), center(id), audit() }`。
`list('stop')` 按编号取一组（同位轮换的成员**也在里面**，同一时刻只显示一个）；
`center(id)` 取盒子的真实中心（连接线、人物走位都用它，别自己再算一遍）。

**对账**：清单里说多大，实际就画多大。基元若因为某种原因画得更大（文字比量出来的还宽），
`window.__K12_LAYOUT__` 里会多一条 `{kind:'overflow', id, planned, actual}` ——
**不会悄悄压住邻居**（截图流水线与守卫都会读它）。

### 3bis.5 `Sandbox.safe`

舞台安全区 `{x, y, width, height, bottom}`（`720×420` 去掉四周 34 / 底部 30 的边距）。
**内容一律落在这里面**：步骤条与字幕行是外壳里的 HTML（在 SVG 下方），
舞台又是等比缩放的，画到 420 的最下面几像素就会被裁掉。

### 3bis.6 人物的走位（`actor` 的两点补充）

- `actor()` 返回的组上带 **`k12Anchor`**（脚底那一点）——「站在哪条线上」用它，不要用 `k12Box`；
- 沿路走动要动 **`actor.k12Pivot`**（运行时给每个人物套的一层平移轴），
  **不要**直接 `translateX` 人物自己：anime 写的是 `style.transform`，
  会把人物自己的 `translate(...) scale(...)` 属性整个盖掉（人物会弹回原点并丢掉缩放）。

---

## 4. `Sandbox.timeline(steps, builder)` —— 分相位时间线

```js
Sandbox.play(function () {
  return Sandbox.timeline(3, function (tl, index, h) {
    if (index === 0) {
      h.caption('先把输入送进来')
      h.step(1, 3)
      return { targets: input.body, opacity: [0, 1], translateY: [14, 0] }
    }
    if (index === 1) {
      h.caption('经过处理单元')
      h.step(2, 3)
      // 一个相位可以返回多条动画（数组 → 逐条加入，**同时开始**）
      return [
        { targets: box.body, opacity: [0, 1], duration: h.duration },
        { targets: meter, duration: 1, begin: function () { meter.set(42) } }
      ]
    }
    h.caption('结果出来了')
    h.step(3, 3)
    return { targets: output.body, opacity: [0, 1], scale: [0.92, 1] }
  })
})
```

**语义**

| 项 | 说明 |
| --- | --- |
| `steps` | 相位数（整数；`< 1` 会被抬到 1） |
| `builder(tl, index, helpers)` | 第 `index` 个相位（`0 … steps-1`）做什么 |
| 返回值 | 一个 anime 参数对象，或**一个数组**（数组 = 同一相位内的多条，同时开始），或 `null`（该相位空着） |
| 相位之间 | 自动插入 `Sandbox.motion.holdMs` 停顿（学生需要时间看结果） |
| 进度 | 自动按「已过毫秒 / 总时长」调 `Sandbox.progress()`（暂停时不报，运行时统一拦） |
| 播放起始 | 自动开始播放（`autoplay: false` + 手动 `play()`，所以 `restart()` 的语义可预测） |
| 返回值 | `{ pause, play, restart, finished }`，**可直接从 `Sandbox.play(impl)` 的回调返回** |

**`helpers`**：`{ motion, total, easing, duration, holdMs, stagger, at(i), add(params), stage, grid, axis, node, actor, bubble, link, readout, caption, step }`

★ **不要**写 `tl.add([a, b])` —— anime 的 `timeline.add(数组)` 是**关键帧**语义
（实测：`add([a, b])` 得到一条默认 1000ms 的关键帧动画，而不是两条动画）。
要在一个相位里放多条，**从 builder 返回数组**，`Sandbox.timeline` 会逐条 `add`。

---

## 5. 三条硬纪律（守卫会查）

### ① 颜色只走类名与变量，**不许**写死色值

基元的每个部件都挂了 `.k12-*` 类；`skins.css` 按 `data-grade` / `data-skin` 换值。
你在模板里写 `fill="#f97316"` = 那个模板永远只属于小学低年级。

```js
// ✗ 错：写死颜色 = 学段隔离当场失效
rect.setAttribute('fill', '#4F46E5')
// ✓ 对：用基元，或自己挂类名 / 用 var()
node.setAttribute('fill', 'var(--accent)')
```

**例外**：状态类（`.k12-node--accent`、`.k12-bubble--narrator` …）就是给你表态度的，用 `tone` / `who` 参数。

### ② 文字**永不截断**

产品口径：学生看到的必须是**整句话**。「字小一点」比「少半句」好得多。

- 运行时自动折行（中文逐字、西文按词），超宽就缩字号（下限 11px，气泡 10.5px）；
- `node` 的 `h` 不够时**自动长高**；`bubble` 按内容长高 / 长宽；
- 全文另挂在 `<title>` 上（悬停可见）；
- **`…` / `...` 一个都不许出现在你的文案里**（守卫盯着运行时的截断路径，你自己也别截）。

给基元的 `label` ≤ 10 字、`sub` ≤ 16 字、气泡 ≤ 40 字时观感最好 —— 但**超了也不会被截**，只会变小。

### ③ 沙箱纪律（既有，没变）

- 必须 `Sandbox.play(function () { ... })` 注册播放实现（漏了 → 产物永远静止，校验器会 422）；
- 必须 `Sandbox.ready({...})` 上报就绪（漏了 → 宿主 5 秒超时降级）；
- 禁：外链 / `fetch` / `XMLHttpRequest` / 顶层 `throw` / `parent.document` / 宿主存储；
- 文案里禁 markdown（`**`、反引号）与破折号 `——`（内容卫生守卫会拦）；
- 参数占位 `{{name}}` 只能用在 `params` 里声明过的名字。

---

## 6. 最小可运行样例（复制即可）

```json
{
  "body": "<h1 class=\"anim-title\">循环：同一段代码重复跑</h1>\n<p class=\"anim-caption\" id=\"caption\">准备开始</p>\n<div class=\"anim-canvas\"></div>\n<p class=\"anim-caption\"><span class=\"chip\">第 0 步</span></p>",
  "script": "var m = Sandbox.motion;\nvar code = Sandbox.node({ x: 60, y: 150, w: 220, h: 96, label: '循环体', sub: '会被重复执行', tone: 'accent' });\nvar meter = Sandbox.readout({ x: 480, y: 150, label: '执行次数', value: 0, unit: '次' });\nvar times = {{times}};\n\nSandbox.play(function () {\n  return Sandbox.timeline(times + 1, function (tl, index, h) {\n    if (index === 0) {\n      h.caption('先看循环体长什么样');\n      h.step(1, times + 1);\n      return { targets: code.body, opacity: [0, 1], duration: m.duration, easing: m.easing };\n    }\n    var round = index;\n    h.caption('第 ' + round + ' 圈：同一段代码又跑了一次');\n    h.step(round + 1, times + 1);\n    return [\n      { targets: code.body, scale: [1, 1.06, 1], duration: m.duration * 0.6, easing: m.easing },\n      { targets: meter, duration: 1, begin: function () { meter.set(round) } }\n    ];\n  });\n});\n\nSandbox.ready({ template: 'demo' });"
}
```

`params.times` 需要按模板契约声明（`"times": {"type": "int", "min": 2, "max": 6, "default": 4, "description": "循环几圈"}`）。

---

## 7. 自检清单（发出去之前逐条打勾）

- [ ] `Sandbox.ready(` 与 `Sandbox.play(` 都在脚本里（`Sandbox.play` 必须在**脚本段**，不能只在 body 里出现这几个字）
- [ ] 时长 / 缓动取自 `Sandbox.motion`，没有写死 `duration: 800`
- [ ] 没有任何色值字面量（`#rrggbb` / `rgb(...)`）
- [ ] 文案里没有 `…` / `...` / `**` / 反引号 / `——`
- [ ] `{{占位符}}` 集合 == `params` 键集合
- [ ] `body` 里有 `<h1 class="anim-title">`、`<p class="anim-caption" id="caption">`、`<div class="anim-canvas">`、`<span class="chip">`
- [ ] 每个相位都调了 `caption(...)`，学生跟得上
- [ ] **手算坐标一个都没有**：位置一律走 `Sandbox.zone/row/stack` 或（生成本）`Sandbox.layout(plan)`；
      内容全部落在 `Sandbox.safe` 之内（步骤条与字幕行在 SVG 外面，别去抢它们的地盘）
- [ ] 同一块地方换文案时用的是**同位轮换**（`band.row` 的 `alts` / 清单里的同 `alt` 槽位），
      尺寸按最长的那一段预留 —— 别让后一段把盒子撑高
- [ ] 人物的脚底落在一条讲得通的线上（路面 / 基线），且不压任何盒子
- [ ] 跑 `cd server && uv run python -m unittest tests.test_animation_templates tests.test_sandbox_palette -v`

## 8. 想换学段看效果（本地验证）

```bash
cd server
uv run python -c "from app.routes.resources import load_templates, render_animation; ts=load_templates('resources/templates'); t=[x for x in ts if x.id=='python-loop'][0]; open('/tmp/a.html','w',encoding='utf-8').write(render_animation(t, params={}, payload_id='demo', grade_level='primary_low').html)"
```

改 `grade_level`（`primary_low` / `primary_high` / `junior` / `senior`）就能看到同一份模板在四个
学段下的配色与皮肤差异：小学是暖橙 / 晴空蓝的插画皮肤，初中高中是靛蓝 / 青绿的工程皮肤。

> 配色真源：`desktop/scripts/design/tokens.source.json`（`soft` 饱和度轴）。
> 改令牌 → `cd server && uv run python scripts/build_animation_skins.py` 重新生成 `skins.css`
> （**不要手改生成物**；`tests/test_sandbox_palette.py` 会与令牌逐字节比对）。
