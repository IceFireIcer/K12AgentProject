/**
 * 动画卡片的**副标题去重**（P3-2）。
 *
 * ★ 现场形态（真机 a11y 文本）：
 *   `…：从底往上，一层层层价值：从底往上，一层…搭` —— 屏幕阅读器把同一段话读了**两遍**。
 *
 * ★ 根因：卡片同时渲染 `title` 与 `concept` 两个字段，而生成期的标题模板是
 *   `"{concept}：<这一版的钩子>"` —— 也就是说 **title 一律以 concept 开头**
 *   （实测：全库 228/228 都是这个形态）。于是「名称 + 概念」这一对在屏幕上与
 *   屏幕阅读器里都是同一句话的两次。
 *
 * ★ 修法（显示层，不动资产）：**title 已经以 concept 开头时，副标题不再重复渲染**。
 *   为什么不改生成器：`title` 是学生读到的主行（要能独立读懂），而 `concept` 是
 *   选片卡上的分类维度（跨模板比对时才需要）—— 两者都还有用，只是不该叠着显示。
 *   228 份资产重跑一轮的代价，不该花在一个纯显示问题上。
 *
 * ★ 判据只做**前缀**比较（不做包含、不做模糊匹配）：`concept` 出现在标题中间时
 *   该保留（那时的重复不成立），误删会让学生丢掉真正的信息。
 */

/**
 * 这张卡的副标题该显示什么（`''` = 不必再显示）。
 *
 * @param title   卡片主行（生成期模板：`{concept}：<钩子>`）
 * @param concept 概念名（选片卡上的分类维度）
 */
export function templateCardSubtitle(title: string, concept: string): string {
  const name = (title ?? '').trim()
  const label = (concept ?? '').trim()
  if (label.length === 0) return ''
  // 主行已经把它说出来了 → 不再重复（这就是 P3-2 那个「读两遍」）
  if (name.startsWith(label)) return ''
  return label
}
