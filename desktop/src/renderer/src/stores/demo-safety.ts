/**
 * 演示沙箱的**拦截判定**：学生真打的那句话有没有命中词表。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（2026-10-02 用户口径）
 * ══════════════════════════════════════════════════════════════════════════
 * 拦截演示原先挂在**脚本第 5 轮**上（`studentTextFromInput: true` + 固定回执）——
 * 那等于「打到第 5 下必然出拦截回执」：演示者打「机器学习到底是什么」也会被拦，
 * 环回被吃掉。用户的原话是「**得确确实实发了，然后得变红**；不发的话还是走回环」。
 * 所以拦截必须由**原话**决定，与第几轮无关。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 判定规则与 Python 侧同源（不是另写一套安全策略）
 * ══════════════════════════════════════════════════════════════════════════
 * 三步与 `server/app/safety/guard.py` 的 `normalize_for_matching` **逐条对齐**：
 *   ① NFKC 归一（全角字母/标点向内折叠）；
 *   ② 删掉零宽 / 不可见 / 双向控制字符（`自\u200b杀` 屏幕上看就是「自杀」）；
 *   ③ 吃掉两个 CJK 字符之间的空白与标点（`自 杀` / `自-杀`）。
 * 匹配就是**归一化后的子串包含**（与 `_match_all` 的 `token in normalized or token in text` 同口径）。
 *
 * ⚠️ 本模块**只服务演示**：沙箱态下学生的话根本不进主进程（由本机脚本接手），
 *   所以它不会成为任何真实输入的判定依据 —— 真实输入的判定始终在 Python。
 * ⚠️ 词表**不从渲染进程写死**：它随 `demo:script` 下发（`DemoScriptPayload.blockedWords`），
 *   内容由 `tests/demo-seed.test.ts` 对着随包词表逐条核对。
 */

import type { DemoBlockedWord } from '../../../shared/demo-seed'

/** 零宽 / 不可见 / 双向控制字符（与 `guard.py` 的 `_INVISIBLE_CHARS_RE` 同一组）。 */
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g

/**
 * 两个 CJK 字符之间的空白与标点 —— 只吃掉**夹在中间**的那些。
 *
 * ★ 判据与 Python 侧一致：`自 杀`（半角空格）、`自　杀`（全角空格，NFKC 后是半角）、
 *   `自-杀` 都要能被同一个词命中；而词首/词尾的空白不吃（那是正常断句）。
 */
const CJK_GAP_RE =
  /([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])[\s\u3000.·。，、,;；:：!！?？'"“”‘’()（）\[\]【】<>《》\-—_~～|/\\]+(?=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g

/**
 * 把文本归一化成**用于匹配**的形态（与 `guard.normalize_for_matching` 同口径）。
 *
 * ⚠️ 归一化只影响匹配用的副本，**不改学生看到的那句话**：气泡里显示的永远是原话。
 */
export function normalizeForMatching(text: string): string {
  if (text.length === 0) return text
  const folded = text.normalize('NFKC')
  const stripped = folded.replace(INVISIBLE_RE, '')
  // ★ 反复替换到不再变化：`自 杀` 里夹了两个字符时，一次替换只吃得掉一个
  //   （Python 侧用的是同样的循环式正则，`re.sub` 会一直替换到没有匹配为止）。
  let out = stripped
  for (let round = 0; round < 8; round += 1) {
    const next = out.replace(CJK_GAP_RE, '$1')
    if (next === out) break
    out = next
  }
  return out
}

/**
 * 命中词表的那一条（没命中回 `null`）。
 *
 * ★ 返回**词表里的那一条**而不是一个布尔：回执文案要取它自己的 `safeText`
 *   （不同类目的回执完全不同），界面上的"命中"标记也要能说出命中了哪一类。
 */
export function matchBlockedWord(
  text: string,
  words: readonly DemoBlockedWord[]
): DemoBlockedWord | null {
  if (text.trim().length === 0) return null
  const normalized = normalizeForMatching(text)
  for (const entry of words) {
    if (entry.word.length === 0) continue
    // 与 Python 的 `token in normalized or token in text` 同一判据：
    // 归一化那份管变体（零宽/空格/全角），原文那份管「本来就是原样打的」。
    if (normalized.includes(entry.word) || text.includes(entry.word)) return entry
  }
  return null
}
