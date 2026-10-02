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
 * ⚠️ 规则**不从渲染进程写死**：它住在 `shared/demo-safety-rules.ts`（随包词表的逐字镜像，
 *   27 词 / 7 类 / 7 条越狱正则 / 全量回执），随 `demo:script` 一并下发；
 *   内容由 `tests/demo-seed.test.ts` 的 ⑩ 对着 `sensitive-words.json` 逐条核对。
 */


// ⚠️ 相对路径**带 `.ts` 后缀**：本模块被 `tests/demo-seed.test.ts` 在纯 node 下直接加载
//   （那份测试的解析钩子只兜"不带后缀的相对导入"，而静态 import 的解析发生在钩子注册之前）。
// ⚠️ 用 `@shared/*` 别名，不写相对路径：
//   · 渲染侧的 tsconfig **不允许** import 路径带 `.ts` 后缀（TS5097）；
//   · 而纯 node 下被 `tests/demo-seed.test.ts` 直接加载时，无后缀的相对路径
//     由那份测试的解析钩子补 —— 但**静态 import 的解析发生在钩子注册之前**，补不上。
//   两个配置都映射了 `@shared/*`（`stores/demoSeed.ts` 用的同一套写法）。
// ⚠️ **只有类型 import**（编译期擦除，不产生运行时依赖）：
//   本模块要能被 `tests/demo-seed.test.ts` 在**纯 node**下直接加载，而那条路上
//   `@shared/*` 别名解析不了、带 .ts 后缀的相对路径又被渲染侧 tsconfig 拒（TS5097）。
//   所以规则**由调用方传进来**（运行时来自 `demo:script` 的载荷），本模块只负责"怎么用"。
import type {
  DemoSafetyCategory,
  DemoSafetyRules,
  DemoSafetyWord
} from '@shared/demo-safety-rules'
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
  //   （Python 侧用的也是会一直替换到没有匹配为止的正则）。
  let out = stripped
  for (let round = 0; round < 8; round += 1) {
    const next = out.replace(CJK_GAP_RE, '$1')
    if (next === out) break
    out = next
  }
  return out
}

/**
 * 越狱正则命中时在 {@link DemoSafetyVerdict.matched} 里留下的前缀。
 *
 * ⚠️ 刻意**不写成一个英文技术词**：本文件在渲染进程，而学生面纪律守卫禁止这一侧出现
 *   技术词。用 `re:` 这种不带词义的短前缀即可 —— 它只是给驾驶舱/日志看的标记，
 *   规则 id 才是可读的那一半（如 `re:ignore_instructions`）。
 */
const PATTERN_LABEL_PREFIX = 're:'

/**
 * 一次判定的结论（渲染侧据此决定"要不要演拦截那一段"）。
 *
 * ★ 给的是**类目 + 回执 + 命中项**，不是布尔：界面上的红回执要取该类目的 `safeText`，
 *   而"命中了哪一类"本身也是演示里要讲的东西。
 */
export interface DemoSafetyVerdict {
  /** 该不该拦（`severity: "block"` 至少命中一条）。 */
  blocked: boolean
  /** 归一化后的类目 id（按 `CATEGORY_PRIORITY` 挑出来的那一个）。 */
  category: string
  /** 该类目的回执文案（逐字取自随包词表）。 */
  safeText: string
  /** 命中的原文片段（词表词 / `regex:<id>`），供驾驶舱与日志用。 */
  matched: string[]
  /** 命中项里最高的那个档位（`block` > `flag`）。 */
  severity: string
}

/**
 * 一条命中的中间形态。
 *
 * ⚠️ 字段叫 `label` 而不是 `token`：本文件在渲染进程的可执行代码里，
 *   而架构守卫 G6b 禁止这一侧出现 token 相关标识（凭据面纪律，与安全词表无关）——
 *   这里的词义本来就是"命中的那一段文字"，`label` 反而更准。
 */
interface RawHit {
  label: string
  category: string
  severity: string
}

/**
 * 编译越狱正则（**只编译一次**，并容错）。
 *
 * ★ 为什么要 try：正则原文来自随包词表的 Python 语法。这一小撮（7 条）在两种语法下
 *   是兼容的，但"词表将来加了一条 JS 编不出来的"不该让**整个安全判定**瘫掉 ——
 *   编不出来的那一条跳过，其余照常（真实 guard 也是"坏条目跳过、不整条挂掉"的口径）。
 */

/**
 * 词表 + 越狱正则的**全部命中**（与 `guard._match_all` 同口径：先归一化再匹配）。
 *
 * ★★ **本文件只有这一处匹配实现**：`checkDemoInput` 也走它。
 *   两处各写一份的话，改了一处另一处照旧命中 —— 变异验证会当场发现
 *   「把判定改成永不命中，守卫却是绿的」（实测踩到过）。
 *
 * @param text 学生真打的那句话（原话）。
 * @param rules 规则集（缺省用内置那份；测试与单测可注入一份小的）。
 */
export function matchAllSafetyRules(
  text: string,
  rules: DemoSafetyRules
): RawHit[] {
  const normalized = normalizeForMatching(text)
  const hits: RawHit[] = []
  for (const entry of rules.words as readonly DemoSafetyWord[]) {
    // 与 Python 的 `<词> in normalized or <词> in text` 同一判据：
    // 归一化那份管变体（零宽/空格/全角），原文那份管「本来就是原样打的」。
    if (entry.word.length > 0 && (normalized.includes(entry.word) || text.includes(entry.word))) {
      hits.push({ label: entry.word, category: entry.category, severity: entry.severity })
    }
  }
  for (const entry of rules.patterns) {
    try {
      // 逐条编译并容错：正则原文来自随包词表的 **Python 语法**。这一小撮（7 条）
      // 在两种语法下兼容，但"将来加了一条 JS 编不出来的"不该让整个判定瘫掉 ——
      // 编不出来的那一条跳过，其余照常（真实 guard 也是"坏条目跳过"的口径）。
      const re = new RegExp(entry.pattern, 'i')
      if (re.test(normalized) || re.test(text)) {
        hits.push({
          label: `${PATTERN_LABEL_PREFIX}${entry.id}`,
          category: entry.category,
          severity: entry.severity
        })
      }
    } catch {
      // 坏正则跳过这一条（其余照常）。
    }
  }
  return hits
}

/**
 * 判定一句话要不要拦（**演示口径**，与真实 `guard.check_input` 同源）。
 *
 * 三步，与 Python 侧逐条对齐：
 *   ① `_match_all`：词表 + 越狱正则，先归一化再匹配（→ {@link matchAllSafetyRules}）；
 *   ② `_pick_category`：按规则里的 `categoryPriority` 挑类目；
 *   ③ **只有 `block` 档才算拦**：`flag` 档（`血腥` / `笨蛋`）只记日志不打断对话 ——
 *      与真实 guard 一致，演示里也不会因为"flag 词也弹红气泡"而露馅。
 *
 * @param text 学生**真打的那句话**（原话，不预置）。
 * @param rules 规则集（缺省用内置那份；测试可注入一份小的）。
 */
export function checkDemoInput(
  text: string,
  rules: DemoSafetyRules
): DemoSafetyVerdict {
  const empty: DemoSafetyVerdict = {
    blocked: false,
    category: 'ok',
    safeText: '',
    matched: [],
    severity: 'none'
  }
  if (text.trim().length === 0) return empty

  // ★ 走**唯一那处**匹配实现（见 matchAllSafetyRules 的说明）。
  const hits = matchAllSafetyRules(text, rules)
  if (hits.length === 0) return empty

  // ② 按 priority 挑类目（都没在表里时退回第一条命中的类目）
  const category =
    rules.categoryPriority.find((id) => hits.some((hit) => hit.category === id)) ??
    hits[0]?.category ??
    'ok'
  // ③ 只有 block 档才拦；命中里只要有一条 block 就拦（与 guard 的 severity 判定一致）
  const blocking = hits.filter((hit) => hit.severity === 'block')
  const meta: DemoSafetyCategory | undefined = rules.categories[category]
  return {
    blocked: blocking.length > 0,
    category,
    safeText: meta?.safeText ?? '',
    matched: [...new Set(hits.map((hit) => hit.label))],
    severity: blocking.length > 0 ? 'block' : 'flag'
  }
}

/**
 * 命中词表的那一条（**只认词表、不看越狱正则**；没命中回 `null`）。
 *
 * ★ 保留这个更窄的入口给需要"是哪一条词"的场景；要判"该不该拦"请用
 *   {@link checkDemoInput} —— 它才是与 guard 同口径的那一个。
 */
export function matchBlockedWord(
  text: string,
  words: readonly DemoSafetyWord[]
): DemoSafetyWord | null {
  if (text.trim().length === 0) return null
  const normalized = normalizeForMatching(text)
  for (const entry of words) {
    if (entry.word.length === 0) continue
    if (normalized.includes(entry.word) || text.includes(entry.word)) return entry
  }
  return null
}
