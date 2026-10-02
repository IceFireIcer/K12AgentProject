# 动画卡片 PRD · gradient-descent-v2

> 这份 PRD 给设计/动画方案的 AI 看。
> 拿到方案后，我再据此生成最终代码（落 `server/resources/templates/gradient-descent-v2.json` + 沙箱预置）。

## 1. 背景

演示沙箱第二轮对话：学生问「训练的时候，它怎么知道该往哪儿调？」，老师讲损失函数与梯度下降直觉，挂一张动画卡。

动画必须让学生**一眼看懂三件事**：
1. 训练数据长什么样（散点云）
2. 拟合直线是怎么随参数变化的（直线平移）
3. 损失是怎么降下去的（小球沿曲线滚向谷底）

## 2. 技术约束（硬性，不能破）

| 项 | 值 |
| --- | --- |
| 画布尺寸 | 720 × 420（Stage API 视口） |
| 动画库 | anime.js v3（内联，锁 v3） |
| 运行时 | 项目自带的 `Sandbox` 全局对象（见下） |
| 配色 | **只能用 CSS 变量**：`var(--accent)` / `var(--warn)` / `var(--surface)` / `var(--surface-2)` / `var(--ink)` / `var(--muted)` / `var(--line)` / `var(--chip-bg)` / `var(--chip-fg)` |
| 字体 | 系统字体（`"Microsoft YaHei", "PingFang SC", system-ui, sans-serif`），不允许外链字体 |
| 外链 | **零外链**（无 CDN、无远程图片、无远程字体）—— 演示现场断网 |
| 文案卫生 | 禁 `**`、禁反引号、禁破折号 `——`、禁 `…` 省略号 |
| SVG 命名空间 | 用 `Sandbox.SVG_NS`，不写字面量 |

## 3. Sandbox API（可用的接口）

```js
Sandbox.stage()          // 建 720×420 SVG 舞台，返回 { svg, width, height }
Sandbox.grid(opts)       // 背景网格 { x, y, w, h, cols, rows }
Sandbox.readout(opts)    // 数值读数 { x, y, w, h, label, value, unit }，返回的组上带 .set(value)
Sandbox.timeline(steps, builder)  // 分相位时间线，返回值交给 Sandbox.play
Sandbox.caption(text)    // 更新字幕行
Sandbox.step(n, total)   // 更新步骤条「第 n 步 / 共 total 步」
Sandbox.play(impl)       // 注册播放实现
Sandbox.ready(detail)    // 上报就绪
Sandbox.motion           // { duration, easing, stagger, holdMs }（technical 皮肤：460ms / easeInOutQuad / 90ms / 380ms）
Sandbox.SVG_NS           // SVG 命名空间（用 createElementNS）
anime.stagger(ms)        // anime.js 的 stagger 延迟
```

## 4. 画面结构

```
┌──────────────────────────────────────────────────────────────┐
│ 梯度下降：让损失降下去                                    │  ← 标题
│ 准备开始                                                    │  ← 字幕行
│                                                              │
│  ┌─ 左面板 ──────────┐  ┌─ 右面板 ──────────┐               │
│  │ 训练数据          │  │ 损失曲面          │               │
│  │                   │  │                   │               │
│  │  · · · · · · ·    │  │  ╲               │               │
│  │   · · · · ·       │  │   ╲___           │               │
│  │  ─────── (拟合直线)│  │      ● (小球)    │               │
│  │                   │  │                   │               │
│  └───────────────────┘  └───────────────────┘               │
│  [拟合度 0.42]              [当前损失 7.60]                  │  ← 读数行
│  第 0 步                                                     │  ← 步骤条
└──────────────────────────────────────────────────────────────┘
```

### 4.1 坐标分区（建议，可调）

| 区域 | x | y | w | h |
| --- | --- | --- | --- | --- |
| 左面板（散点云） | 40 | 80 | 310 | 260 |
| 右面板（损失曲面） | 380 | 80 | 300 | 260 |
| 左读数（拟合度） | 40 | 358 | 310 | 24 |
| 右读数（当前损失） | 380 | 358 | 300 | 24 |

两个面板之间留 30px 间隙，面板内有 20px 内边距。

## 5. 数据

### 5.1 训练数据散点（18 个，固定）

真实关系 `y = 0.6x + 130 + noise`，noise 是固定的 ±10 序列：

```
[70,178] [95,192] [120,205] [145,215] [170,225] [195,238]
[220,248] [245,255] [270,268] [295,278] [320,290] [100,188]
[150,218] [200,240] [250,260] [300,285] [115,200] [265,270]
```

散点用 `var(--accent)` 填充，半径 5，opacity 0.85。

### 5.2 损失函数

`L(w) = 0.8(w-3)² + 0.4`，最低点在 w=3，L(3)=0.4。

w 的可视范围 [0, 6]，对应屏幕 x 坐标 `CURVE_AREA.x + (w/6) * CURVE_AREA.w`。
loss 的可视范围 [0.4, 7.6]，对应屏幕 y 坐标 `CURVE_AREA.y + CURVE_AREA.h - ((loss-0.4)/7.2) * CURVE_AREA.h`。

### 5.3 拟合直线

斜率固定 0.6，截距 `130 + (3-w)*8`。w=3 时直线穿过散点云中心；w 偏离 3 时直线平移偏离散点。

直线用 `var(--warn)`，stroke-width 2.5，stroke-linecap round。

## 6. 相位设计（4 个引导相位 + 6 步走步）

### 相位 1 · 散点云 stagger 入场

- **caption**：先看这一批训练数据
- **step**：1/4
- **动画**：18 个散点用 `anime.stagger(35ms)` 依次入场，每个点 `r` 从 0 长到 5、`opacity` 从 0 到 0.85
- **时长**：~460ms（Sandbox.motion.duration）+ stagger 总延迟 ~630ms ≈ 1.1s

### 相位 2 · 拟合直线画出

- **caption**：随便给一个初始参数 w
- **step**：2/4
- **动画**：拟合直线从左端 `(60, y1)` 延伸到右端 `(330, y2)`，`x2` 从 60 动到 330、`opacity` 从 0 到 1
- **读数**：拟合度设为 0.42
- **时长**：~460ms

### 相位 3 · 偏差虚线 + 损失读数

- **caption**：算每个点的偏差，加起来就是损失
- **step**：3/4
- **动画**：18 根偏差虚线（每个散点垂直投到拟合直线）整体淡入（opacity 0 → 1），`stroke-dasharray: 2 3`、`var(--muted)`、opacity 0.5
- **读数**：当前损失设为 7.60
- **时长**：~460ms

### 相位 4-9 · 梯度下降 6 步

每步：
- **caption**：第 1 步用「沿损失下降最快方向走第一步」，后续用「继续往下走，损失越来越小」
- **step**：4/4
- **动画**：
  - 小球光晕 + 小球同步移动到新位置（`cx` / `cy` 动画）
  - 拟合直线平移（`y1` / `y2` 动画）
  - 前一步位置留一个淡色小圆点（轨迹尾巴，r=4，opacity 0.25）
  - 拟合度读数更新（0.42 → 0.95 渐增）
  - 当前损失读数更新（7.60 → 0.40 渐降）
- **梯度下降公式**：`w_next = w - 0.35 * 1.6 * (w - 3)`，限制在 [0.05, 5.95]
- **每步时长**：~460ms + holdMs 380ms ≈ 840ms

### 收敛轨迹（学习率 0.35，6 步）

| 步 | w | loss |
| --- | --- | --- |
| 初始 | 0.00 | 7.60 |
| 1 | 1.68 | 2.13 |
| 2 | 2.62 | 0.62 |
| 3 | 2.91 | 0.42 |
| 4 | 2.98 | 0.40 |
| 5 | 3.00 | 0.40 |
| 6 | 3.00 | 0.40 |

## 7. 美学要求

### 7.1 色彩克制

- 主色 `var(--accent)`（蓝）：散点、损失曲线
- 强调色 `var(--warn)`（橙）：拟合直线、小球、小球光晕、轨迹尾巴
- 中性色 `var(--muted)`（灰）：偏差虚线、坐标标注
- 背景 `var(--surface-2)`（浅灰）：面板填充
- 边框 `var(--line)`：面板边框

**不要**用超过 3 个色相。不要用渐变色（损失曲线下方的填充用单色 + 低 opacity）。

### 7.2 字体层级

| 元素 | 字号 | 字重 |
| --- | --- | --- |
| 标题（anim-title） | 20px | 700 |
| 面板标题 | 13px | 500 |
| 字幕行（anim-caption） | 15px | 400 |
| 步骤条（chip） | 13.5px | 600 |
| 坐标标注 | 10px | 400 |
| 读数标签 | 11.5px | 400 |
| 读数数值 | 24px | 400（tabular-nums） |

### 7.3 动效曲线

- 入场动画（散点、直线）：`Sandbox.motion.easing`（easeInOutQuad）
- 小球移动：`Sandbox.motion.easing`
- 读数更新：瞬时（`duration: 1, begin: function() { ... }`）
- 相位间停顿：`Sandbox.motion.holdMs`（380ms）

### 7.4 视觉细节

- 面板圆角 12px、1px 边框、淡背景
- 小球带光晕（半透明大圆 r=16，opacity 0.15，衬在球后面）
- 损失曲线下方渐变填充（单色 `var(--accent)` + opacity 0.08）
- 最低点虚线标记 + 「最优 w=3」文字标注
- 背景细网格（`Sandbox.grid`，8 列 4 行）

## 8. 期望方案里给出什么

请给我一份完整的、可直接落地的方案，包含：

1. **完整配色清单**：每个元素用什么 CSS 变量、opacity 多少、stroke-width 多少
2. **完整坐标清单**：每个元素的 x / y / w / h（精确到像素）
3. **完整动效清单**：每个相位的 `anime({...})` 参数对象（targets / 属性 / duration / easing / delay）
4. **完整时间线**：相位顺序、每相位时长、holdMs、总时长
5. **完整文案清单**：每个相位的 caption 文字、step 数字
6. **完整读数清单**：每个相位的拟合度 / 当前损失数值
7. **美学加分项**：如果你觉得哪里还能更好看（比如散点加阴影、小球加弹跳、曲线加描边动画），列出来给我参考

## 9. 不需要你做的事

- 不需要写完整的 `gradient-descent-v2.json` 模板（我来落）
- 不需要写 HTML 外壳（我来拼）
- 不需要管 `Sandbox.ready` / `Sandbox.play` 的调用（我来接）
- 不需要管沙箱态载入逻辑（我来接）

你只出**设计方案**，我拿到后据此生成最终代码。

## 10. 参考文件（如果你需要）

| 文件 | 内容 |
| --- | --- |
| `docs/preset-redesign/animation-preview.html` | v2 预览页（当前版本，可看现有效果） |
| `server/resources/templates/_shared/runtime.js` | Sandbox 运行时完整实现 |
| `server/resources/templates/_shared/base.css` | 动画卡片公共样式 |
| `server/resources/templates/_shared/skins.css` | 学段皮肤（senior 工程皮肤） |
| `preset-content/_meta/STAGE-API.md` | Stage API 冻结接口文档 |
| `server/resources/templates/gradient-descent.json` | 旧版梯度下降模板（参考结构，不复用画面） |