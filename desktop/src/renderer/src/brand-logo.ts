/**
 * 品牌素材（吉祥物「智团团」的 logo）的**唯一 URL 来源**。
 *
 * ── 为什么要单独一个模块 ──────────────────────────────────────────────
 * 同一张图要在三处出现：侧栏品牌标（随学段换图）、对话空态的大标记、
 * 每条回答旁边的小头像。三处各写一遍 `'./brand/main.png'` 就是三处真相 ——
 * 换素材时漏掉一处，表现成「有的地方是新 logo、有的地方还是旧的」，
 * 而那种不一致**不会报错**（路径写错只会在界面上留一个裂图）。
 *
 * ── URL 必须相对页面，不能以 `/` 开头 ─────────────────────────────────
 * `desktop/resources` 是 vite 的 `publicDir`，素材落在**页面根**下的 `brand/`。
 * 打包态页面是 `file://`，以 `/` 开头会解析到**文件系统根**，图直接裂掉；
 * 这条约定与 `sandbox/pyodide-runner.ts` 的 `./pyodide/` 是同一个。
 *
 * ★ **学段与文件名的写法不同**：配色轴键是连字符（`primary-low`），
 *   而素材文件名与契约的学段枚举同名（`primary_low.png`，下划线）。
 *   下面这张表直接用**配色轴键**作索引，换算就只此一处。
 */

/** 配色轴上的学段键（与 `stores/theme.ts` 的 `GradeKey` 同一套取值）。 */
export type LogoGradeKey = 'primary-low' | 'primary-high' | 'junior' | 'senior'

/**
 * 四学段各自的吉祥物图（`logos/logo1-4.png` 的运行时版本，由
 * `server/scripts/make_brand_icons.py` 生成）。
 *
 * ⚠️ 默认档（`default`）与设计系统预览档（`brand`）**不在表里** ——
 * 它们不是真实学段，落到 {@link DEFAULT_LOGO_URL}。
 */
const LOGO_BY_GRADE: Readonly<Record<LogoGradeKey, string>> = {
  'primary-low': './brand/primary_low.png',
  'primary-high': './brand/primary_high.png',
  junior: './brand/junior.png',
  senior: './brand/senior.png'
}

/**
 * 默认 logo（`logos/mainlogo.png` 的运行时版本，抱蜂蜜的小熊）。
 *
 * ★ 它同时是两件事：**没判出学段时的兜底**，以及**所有非学段的品牌位**
 *   （对话空态大标记 / 每条回答的小头像）用的那一张 ——
 *   那些位置不属于任何学段，跟着学段换图没有意义。
 */
export const DEFAULT_LOGO_URL = './brand/main.png'

/** 按配色轴键取图；不是四个真实学段之一时回默认 logo。 */
export function logoUrlFor(grade: string | null | undefined): string {
  if (!grade) return DEFAULT_LOGO_URL
  return LOGO_BY_GRADE[grade as LogoGradeKey] ?? DEFAULT_LOGO_URL
}
