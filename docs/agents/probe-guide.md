# 探针维护指南（优化报告 §5.3 / WP-15）

> 适用对象：改**渲染层结构**（模板 / 类名 / `data-testid` / `data-probe-*`）或
> 改 `desktop/scripts/ux-*.mjs` / `verify-ui.mjs` 的同学。
> 一句话纪律：**探针报红时，先问"它找的东西还在不在"，再问"产品坏没坏"** ——
> 2026-09-27 那轮体检的 5 条红，没有一条是产品缺陷，全是锚点腐烂（P-147）。

## 1. 锚点有两类，各自怎么用

| 类型 | 长什么样 | 用途 | 谁在守 |
| --- | --- | --- | --- |
| **`data-testid`** | `data-testid="quiz-card"` | 定位**元素**（看得见 / 点得到 / 几何） | `tests/probe-anchors.test.ts`：探针脚本里的静态 `data-testid` 必须真的存在于渲染层 |
| **`data-probe-*`** | `data-probe-id="quiz-card"` + `data-probe-count="1"` | 量**行为**（题数 / 开合态 / 卡片数） | `tests/probe-structure.test.ts` + `scripts/probe-lib.mjs` 的锚点表 |

> 为什么不都塞进 `data-testid`：`data-testid` 是"这是哪个元素"，`data-probe-*` 是
> "这个行为现在是什么值"。混在一起，改一个计数属性就会连带改掉所有选择器。

## 2. 结构化锚点表（`desktop/scripts/probe-lib.mjs`）

```js
{
  id: 'quiz-default-single',
  selector: '[data-probe-id="quiz-card"]',
  attribute: 'data-probe-count',
  expected: '1',
  description: '对话内练习卡默认只渲染 1 道题（报告 §2.3）'
}
```

- `attribute` / `expected` 为 `null` = **只检查存在**（例如"有进度卡"）；
- 探针开跑前跑一次 `VERIFY_ANCHORS_SCRIPT`：
  - **缺锚点** → 打印「部分失败」提示（多半是"这一页 / 这个状态还没出现"）；
  - **行为不符** → 判红（找到了，但值不对 —— 那才是产品问题）。

## 3. 改组件时的 checklist（**必做**）

1. 删 / 改任何一个 `data-testid` 或 `data-probe-*` 之前，先
   `rg -n "<锚点名>" desktop/scripts desktop/tests` 看清谁在用；
2. 改了锚点 → 同步改探针脚本与 `probe-lib.mjs` 的锚点表（两处都改，别只改一边）；
3. 跑 `npm test`（`probe-anchors.test.ts` + `probe-structure.test.ts` 会立刻抓出漏改）；
4. 真机验证：`K12_DEBUG_PORT=9222 npm run dev` 起应用，另开一个终端跑相关的
   `npm run ux:*`（先 `npm run ux:reload` —— HMR 不会重跑 `onMounted`）；
5. 如果确实是**故意**删掉的锚点，把它的旧名写进 `tests/probe-anchors.test.ts` 的
   `NEGATIVE_ANCHORS`（并说明为什么它必须不存在）。

## 4. 探针隔离（避免状态污染）

- 探针**只许改自己列的键**，收尾时要还回去：
  - `CLEANUP_SCRIPT([...keys])`：清掉探针自己写的 localStorage 键 + 移除注入元素
    （`data-probe-injected`）；
  - 需要临时改偏好（如减动效三档）的探针：**先读旧值、收尾写回**，
    不要顺手 `localStorage.clear()`（那会删掉学生的偏好）。
- 典型示范：`scripts/ux-probe-reduced-motion.mjs`（保存 / 还原 `k12.reducedMotion`）。

## 5. 失败截图

- `captureFailureScreenshot(cdp, name, dir)`：只在**红了**的时候调用；
- 产物落在 `desktop/.probe-artifacts/`（已在 `.gitignore`）；
- 现状：`ux-pages-audit.mjs` 与 `ux-probe-reduced-motion.mjs` 已接。

## 6. axe 类规则（自研，三类）

`A11Y_SCRIPT`（`probe-lib.mjs`）覆盖报告 §6.4 点名的三个面：

| 规则 | 判据 |
| --- | --- |
| `no-focusable-hidden` | `aria-hidden` 子树里不许有可聚焦元素（读屏死区） |
| `interactive-name` | 可点元素必须有可读名字（文字 / `aria-label` / `title`） |
| `text-contrast` | 带 `data-testid` 且直接含文字的元素，前景/背景对比度 ≥4.5:1 |

现状：`ux-pages-audit.mjs` 收尾会跑一遍并判红。

## 7. CI

`npm test` 里已经包含两条锚点守卫（`probe-anchors` / `probe-structure`），
而 `npm test` 是 `ci.yml` 的门禁步骤之一 —— 因此"CI 增加探针验证步骤"
由既有步骤满足，不需要改 `ci.yml`（见 `docs/optimise-acceptance.md` 的门禁表）。
