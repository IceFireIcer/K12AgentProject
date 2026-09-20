/**
 * 「一个知识点在界面上叫什么」——**学习档案页组的唯一口径**（纯函数，可单测）。
 *
 * ── 为什么要有这个文件（一条走查结论，别在本页组里各写一份）
 * ─────────────────────────────────────────────────────────────────────
 * 知识点在数据里是 `kp_id`（`ai-definition-jr` / `prog-loop-jr` 这种 slug）：
 *   · `learning.db` 里存的是 id；
 *   · 契约里 `MistakeItem.kp_name` 在**查不到名字时退化成 id 本身**
 *     （`routes/study.py` 的 `meta.get(...)[0] or record.kp_id`）；
 *   · 生成类型里 `Mastery.kpId` 也只有 id。
 * 于是任何「拿不到名字就退回 id」的兜底，最后都会把一个 slug 摆到一个 10 岁学生面前
 * —— 那不是「信息更全」，那是**看起来像报错**（本项目实测过：闯关页 55 关标题、
 * 顶栏「建议接着练」、档案页「继续学习」都出现过 `ph-data-train-predict`）。
 *
 * 最典型的成因是**教材换代**：`learning.db` 按学生长期保留，换代后老库里留着一批
 * 指向已删除 kp 的残留行 —— 那些行没有对应的中文名（服务端在报告里已按当前教材
 * 白名单滤掉 `mastery`，但错题本/闯关路径这类行仍可能落进来）。
 *
 * ★ 规则（三页共用，不要各写一份）：
 *   1. 有中文名 → 显示中文名；
 *   2. 没有中文名 → 显示 {@link UNKNOWN_KP_LABEL}（**不显示 slug**）；
 *      原始 id 只进 `title`（悬停可见，排障/答辩要它，学生不会被它吓到）。
 * ★ 为什么不是「干脆不显示这一行」：那一行背后是**真实的学习记录**
 *   （错了几次 / 掌握度多少），因为名字一时取不到就整行不显示，等于把学生的数据藏起来。
 *   显示一个中性的「未命名知识点」比显示 `jr-py-data-features` 或什么都不显示都好。
 */

/** 名字取不到时的中性标签（与 `api/events.ts` 的「未命名章节」同一口径）。 */
export const UNKNOWN_KP_LABEL = '未命名知识点'

/**
 * 取一个知识点的**显示名**。
 *
 * @param kpId 契约里的知识点 id
 * @param name 契约里可能已经带上的名字（`MistakeItem.kpName` / `GraphNode.name`）。
 *             ⚠️ 服务端在查不到时会把 id 原样填进来，所以与 id 相同**等于没有名字**。
 * @param lookup 名字的第二来源：`knowledge.kpNameOf`（教材知识点清单，唯一来源）。
 */
export function kpLabel(
  kpId: string,
  name?: string | null,
  lookup?: ((kpId: string) => string | null) | null
): string {
  const fromContract = (name ?? '').trim()
  if (fromContract && fromContract !== kpId) return fromContract
  const fromTextbook = lookup?.(kpId) ?? null
  if (fromTextbook && fromTextbook !== kpId) return fromTextbook
  return UNKNOWN_KP_LABEL
}

/** 名字是否真的取到了（取不到时界面不再显示 slug，只把它放进 `title`）。 */
export function kpLabelResolved(
  kpId: string,
  name?: string | null,
  lookup?: ((kpId: string) => string | null) | null
): boolean {
  return kpLabel(kpId, name, lookup) !== UNKNOWN_KP_LABEL
}
