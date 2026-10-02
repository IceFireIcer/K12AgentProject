/**
 * 沙箱拦截演示的**内置安全规则**（词表 + 越狱正则 + 各类目回执文案）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它是什么、不是什么
 * ══════════════════════════════════════════════════════════════════════════
 * **是**：随包词表 `server/resources/sensitive-words.json` 的**逐字镜像**（27 词 / 7 类 /
 *   7 条越狱正则 / 全量 `safeText`）。演示沙箱在**不依赖 sidecar**的前提下，
 *   就能按**真实 guard 的同一套口径**判定"这句话该不该拦"。
 *
 * **不是**：安全判定的真源。真源永远是 Python 的
 *   `server/app/safety/guard.py` + `sensitive-words.json`；真实链路一个字都没改
 *   （沙箱态下学生的话根本不进主进程，判定在渲染侧跑，只影响"演示里演不演那一段"）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么整份内置（而不是挑几个演示词）
 * ══════════════════════════════════════════════════════════════════════════
 * ① **演示要稳**：现场断网 / sidecar 没起来是明确要支持的场景，而"打了敏感词必须变红"
 *    是硬要求 —— 把成功率押在现场网络上是不合格的兜底；
 * ② **覆盖要够**：只放几个词时，演示者临场换一个说法（"怎么做炸弹"而不是"制作炸药"）
 *    就不会命中，届时看起来像"这个安全功能没做"；
 * ③ **口径要真**：真实 guard 是「词表命中 **或** 越狱正则命中 → 按 `CATEGORY_PRIORITY`
 *    挑类目 → 取该类目的 `safeText`」；内置版逐条对齐（见 `stores/demo-safety.ts`），
 *    连 `severity: "flag"` 这种"只记日志、不打断对话"的档位也保留 ——
 *    否则拿 `血腥`/`笨蛋` 这种 flag 词去演示，会在真机上露出与后端不一致的破绽。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 与随包词表的一致性由守卫钉住
 * ══════════════════════════════════════════════════════════════════════════
 * `tests/demo-seed.test.ts` 的 ⑩ 会拿这里的三样（词/类目/severity）与
 * `sensitive-words.json` **逐条**核对，并断言每个类目的 `safeText` 一字不差 ——
 * 改了随包词表却忘了同步这里，守卫当场变红。
 */

/** 一条词表命中项（字段与随包词表的 `words[]` 逐字对齐）。 */
export interface DemoSafetyWord {
  /** 触发词（逐字取自随包词表）。 */
  word: string
  /** 类目 id（与词表的 `categories` 键同源）。 */
  category: string
  /**
   * `block` = 直接拦截并撤回；`flag` = **只记日志、不打断对话**。
   *
   * ★★ 这个档位必须保留并如实遵守：真实 guard 里 `血腥` / `笨蛋` 就是 flag ——
   *   拿它们演示"拦截"会在真机上露出与后端不一致的破绽。
   */
  severity: string
  note?: string
}

/** 一条越狱意图正则（字段与随包词表的 `patterns[]` 逐字对齐）。 */
export interface DemoSafetyPattern {
  id: string
  /** **Python 正则语法**的原文（JS 侧直接用 `new RegExp` 编译；两侧语法在此表内兼容）。 */
  pattern: string
  category: string
  severity: string
  note?: string
}

/** 一个类目的元信息（标签 + 面向学生的回执文案）。 */
export interface DemoSafetyCategory {
  label: string
  safeText: string
}

/**
 * **内置安全规则**（随包词表的逐字镜像）。
 *
 * ★ `categoryPriority` 与 `guard.py` 的 `CATEGORY_PRIORITY` 同序：
 *   命中多个类目时**按这个顺序**挑第一个命中的 —— 顺序影响学生看到哪一句回执。
 */
/** 规则集的形状（`DemoScriptPayload.safetyRules` 转发它，两处必须是同一个类型）。 */
export interface DemoSafetyRules {
  version: number
  categoryPriority: readonly string[]
  categories: Readonly<Record<string, DemoSafetyCategory>>
  words: readonly DemoSafetyWord[]
  patterns: readonly DemoSafetyPattern[]
}

export const DEMO_SAFETY_RULES: DemoSafetyRules = {
  version: 1,
  // 与 `server/app/safety/guard.py` 的 `CATEGORY_PRIORITY` 同序（先关怀、后合规口径）。
  categoryPriority: ['self_harm', 'violence', 'illegal', 'adult', 'personal_info', 'jailbreak', 'abuse'],
  categories: {
  self_harm: {
    label: '自伤/轻生',
    safeText:
      '我很在意你刚刚说的这句话。这件事比今天的课更重要，请你现在就告诉身边信任的大人：爸爸妈妈、老师，或者拨打 12356 心理援助热线。你愿意说给我听的，我都在。'
  },
  violence: {
    label: '暴力伤害',
    safeText:
      '这个话题我不能接着讲。如果你是因为看到或遇到了让人害怕的事，请一定告诉老师或爸爸妈妈，他们能真正帮上忙。我们可以换个问题，比如「AI 能不能帮忙发现危险」。'
  },
  adult: {
    label: '色情/成人内容',
    safeText:
      '这个问题超出我们今天要聊的范围了。不如换一个我一定能帮上忙的问题？'
  },
  illegal: {
    label: '违法与危险品',
    safeText:
      '这类内容我不能提供，也不能帮你查找。如果你是对相关新闻有疑问，我们可以聊聊「AI 在安全领域能做什么」。'
  },
  personal_info: {
    label: '索要个人信息',
    safeText:
      '我不会向你索要姓名、住址、电话、密码这些东西，你也不要发给任何人或别的 AI 助手。只留一个昵称就够我们上课了，这也是在保护你自己。'
  },
  jailbreak: {
    label: '越狱/绕过规则',
    safeText:
      '我是你的 AI 老师，只能陪你聊学习上的事。我们换个问题继续吧，你想从哪个知识点开始？'
  },
  abuse: {
    label: '辱骂与人身攻击',
    safeText:
      '被这样说是会难受的。我们可以不喜欢某个答案，但尽量不用这些话。你想问什么，我认真答。'
  },
  },
  words: [
  { word: '自杀', category: 'self_harm', severity: 'block', note: 'K12 场景一律优先关怀式回应，不做说教' },
  { word: '自残', category: 'self_harm', severity: 'block' },
  { word: '轻生', category: 'self_harm', severity: 'block' },
  { word: '割腕', category: 'self_harm', severity: 'block' },
  { word: '不想活了', category: 'self_harm', severity: 'block' },
  { word: '结束生命', category: 'self_harm', severity: 'block' },
  { word: '砍死', category: 'violence', severity: 'block' },
  { word: '弄死他', category: 'violence', severity: 'block' },
  { word: '打死你', category: 'violence', severity: 'block' },
  { word: '捅死', category: 'violence', severity: 'block' },
  { word: '血腥', category: 'violence', severity: 'flag', note: '只记日志：教材讨论「暴力内容识别」时会合法出现' },
  { word: '色情', category: 'adult', severity: 'block' },
  { word: '裸照', category: 'adult', severity: 'block' },
  { word: '约炮', category: 'adult', severity: 'block' },
  { word: '成人网站', category: 'adult', severity: 'block' },
  { word: '制毒', category: 'illegal', severity: 'block' },
  { word: '毒品交易', category: 'illegal', severity: 'block' },
  { word: '买枪', category: 'illegal', severity: 'block' },
  { word: '怎么做炸弹', category: 'illegal', severity: 'block' },
  { word: '制作炸药', category: 'illegal', severity: 'block' },
  { word: '身份证号是多少', category: 'personal_info', severity: 'block' },
  { word: '你家住哪', category: 'personal_info', severity: 'block' },
  { word: '你的手机号', category: 'personal_info', severity: 'block' },
  { word: '银行卡号', category: 'personal_info', severity: 'block' },
  { word: '发张照片给我', category: 'personal_info', severity: 'block' },
  { word: '笨蛋', category: 'abuse', severity: 'flag', note: '同学之间口播常见，先只记日志' },
  { word: '去死', category: 'abuse', severity: 'block' },
  ],
  patterns: [
  {
    id: 'ignore_instructions',
    pattern:
      '(忽略|无视|忘掉|不要理)(上面|之前|前面|以上|所有)?(的)?(所有)?(指令|规则|要求|设定|提示|限制|约束)',
    category: 'jailbreak',
    severity: 'block'
  },
  {
    id: 'dan_mode',
    pattern:
      '(现在|从现在起)?(你)?(不再是|不是)(一个)?(AI|人工智能|助手|机器人)',
    category: 'jailbreak',
    severity: 'block'
  },
  {
    id: 'roleplay_unrestricted',
    pattern:
      '(开发者|上帝|root|超级)(模式|权限)|越狱模式|jailbreak',
    category: 'jailbreak',
    severity: 'block'
  },
  {
    id: 'reveal_system_prompt',
    pattern:
      '(输出|告诉我|背出|复述|打印|泄露|给我看)[^。！？\\n]{0,12}(系统提示|系统提示词|system\\s*prompt|你的设定|你的规则|提示词)',
    category: 'jailbreak',
    severity: 'block'
  },
  {
    id: 'repeat_everything_above',
    pattern:
      '(把|将)?(上面|之前|前面)[^。！？\\n]{0,8}(全部|所有|一字不差)[^。！？\\n]{0,8}(重复|发|说|输出|念)',
    category: 'jailbreak',
    severity: 'block'
  },
  {
    id: 'pretend_no_rules',
    pattern:
      '(假装|假设|就当)(你)?(没有|不受)[^。！？\\n]{0,8}(限制|规则|约束|审查)',
    category: 'jailbreak',
    severity: 'block'
  },
  {
    id: 'give_me_answer',
    pattern:
      '(直接|马上|快)?(把)?(标准)?答案(给我|发我|告诉我)|别(?:要)?提示(了|，)(直接|就)(给|说)(答案|我)',
    category: 'jailbreak',
    severity: 'flag',
    note: '索要答案不算安全事故，但教学上要挡：只记日志，由提示分级策略处理（票 19）'
  },
  ]
}
