/**
 * 徽章档位的**纯逻辑**（`components/Badge.vue` 的落点）。
 *
 * 为什么单独一个文件：`<script setup>` 里**不允许 ES 模块导出**（Vue 的编译期约束），
 * 而「把后端下发的 `熟练-3` 解析成严格枚举」这件事必须可单测（见
 * `tests/component-api.test.ts`）—— 于是它住在这里，组件只负责画。
 *
 * 档位名与后端 `server/app/routes/quiz.py` 的 `BADGE_LEVELS` 一一对应，**顺序也是契约**。
 *
 * ⚠️ 本文件**不 import 任何东西**（连类型都不 import）：这样 `node --test` 能直接
 *    导入它跑纯函数断言（node 的 ESM 加载器要求显式 `.ts` 扩展名，Vite 那边不需要 ——
 *    零 import 就没有这个两面为难）。类型的再导出在 `types/component-props.ts`。
 */

/** 徽章五档（英文枚举；报告 §4.2 点名的那五个字面量）。 */
export type BadgeLevel = 'starter' | 'beginner' | 'skilled' | 'expert' | 'master'

/** 五档的**顺序**（也是契约：后端按这个顺序发档位名）。 */
export const BADGE_LEVELS: readonly BadgeLevel[] = [
  'starter',
  'beginner',
  'skilled',
  'expert',
  'master'
]

/** 五档的中文档位名（与后端 `BADGE_LEVELS` 同序）。 */
export const BADGE_TIERS = ['起步', '初通', '熟练', '精通', '大师'] as const

/**
 * 把一条徽章原值（`熟练-3` / `起步-0` / 认不出的串）解析成**严格枚举**的档位。
 *
 * ★ 认不出退回第一档（`starter`）——不抛异常、不猜高档（与后端 `badge_for` 的兜底同向）。
 */
export function badgeLevelOf(raw: string | null | undefined): BadgeLevel {
  const text = (raw ?? '').trim()
  if (!text) return BADGE_LEVELS[0] ?? 'starter'
  const at = text.indexOf('-')
  const tier = at >= 0 ? text.slice(0, at) : text
  const index = BADGE_TIERS.indexOf(tier as (typeof BADGE_TIERS)[number])
  return (index >= 0 ? BADGE_LEVELS[index] : BADGE_LEVELS[0]) ?? 'starter'
}

/** 档位序号（0 = 起步）——配色按它递进。 */
export function badgeLevelIndex(level: BadgeLevel): number {
  const index = BADGE_LEVELS.indexOf(level)
  return index >= 0 ? index : 0
}
