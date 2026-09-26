/**
 * Monaco 编辑器的**本地装配**（票 18）。
 *
 * ---------------------------------------------------------------------------
 * ★ 为什么必须单独一个文件：Monaco 需要 worker 配置，不配会在**生产构建**报错
 * ---------------------------------------------------------------------------
 *
 * Monaco 自己也要 Web Worker（编辑器内核、词法分析都在 worker 里跑）。
 * 用 vite 打包时，如果不告诉 Monaco「worker 从哪来」，它在开发态可能侥幸能跑
 * （vite 的 dev server 会兜住），但**生产构建会报 worker 相关错误/运行期 404** ——
 * 这是业务陷阱清单 §7 第 4 条点名要防的事。
 *
 * 做法是给 `self.MonacoEnvironment.getWorker` 一个 vite 认得的 `?worker` 入口：
 *
 *     const { default: EditorWorker } = await import(
 *       'monaco-editor/editor/editor.worker?worker'
 *     )
 *     self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
 *
 * ⚠️ **说明符必须写成 `monaco-editor/editor/editor.worker?worker`**（不是 `.../esm/vs/...`）。
 *    实测（`vite build`，monaco 0.56）：`monaco-editor/esm/vs/editor/editor.worker?worker`
 *    会直接**构建失败**：
 *
 *        [vite]: Rollup failed to resolve import
 *        "monaco-editor/esm/vs/editor/editor.worker?worker"
 *
 *    原因是 monaco 0.56 的 `exports` 映射是 `"./*": "./esm/vs/*.js"` —— 写全 `esm/vs/…`
 *    会被映射成 `esm/vs/esm/vs/…` 而对不上。写**短形式** `monaco-editor/editor/...`
 *    由 exports 映射成 `esm/vs/editor/editor.worker.js`，vite 才能把 worker 单独打成一个
 *    chunk（实测产物 `assets/editor.worker-*.js`，约 585 kB）。
 *    **这一条正是业务陷阱清单 §7 第 4 条说的「不配会在生产构建报错」。**
 *
 * ★ **只需要 `editor.worker` 一个**：本项目只用 Python（`basic-languages` 里的词法高亮，
 * 不需要独立的语言服务 worker）。TS/JSON/CSS/HTML 那四个 worker 我们一个都不碰，
 * 所以不必为它们各写一条映射 —— 少配一条就少一处打包风险。
 *
 * ---------------------------------------------------------------------------
 * ★ 离线自托管（任何 CDN 引用都是断网演示的必然翻车点）
 * ---------------------------------------------------------------------------
 *
 * Monaco 的资源**全部由 vite 从 `node_modules/monaco-editor/` 打包进产物**：
 * 没有 `vs/loader.js` 的 CDN 引导、没有 `require.config({paths})`、
 * 没有 `cdn.jsdelivr.net` / `unpkg`。本文件里**一个网络地址都没有**。
 * （业务陷阱清单 §7 第 6 条：任何 CDN 引用都会在断网演示时翻车。）
 *
 * ---------------------------------------------------------------------------
 * ★ 懒加载：进编程卡片才加载
 * ---------------------------------------------------------------------------
 *
 * 本文件**不在模块顶层 import monaco** —— Monaco 是几百 KB 的大家伙，
 * 对话页上九成时间用不到它。{@link createCodeEditor} 内部用**动态 import**，
 * vite 因此会把它切成独立 chunk：只有编程卡片真的打开时才拉取。
 * 这和 Pyodide 的懒加载口径一致（`sandbox/pyodide-runner.ts` 也只在进卡片时创建 Worker）。
 *
 * ---------------------------------------------------------------------------
 * 语言与主题（报告 §5.1 的「只加载 Python / 主题精简」）
 * ---------------------------------------------------------------------------
 *
 * 语言固定 `python`：只注册**这一种**语言的词法高亮
 * （`languages/definitions/python/register`），不再拉 `basic-languages` 的全量清单 ——
 * 后者会注册 ~90 种语言的 register 入口（每一种又各自懒加载自己的定义），
 * 对只写 Python 的学生是纯噪声。
 *
 * 主题按报告 §5.1 **只保留 `vs-dark`**（编辑器固定深色皮肤，卡片与编程页的编辑器外框
 * 随之走 `--k12-editor-bg`）。`vs` 仍然留在 {@link CodeEditorTheme} 里，只作为「未来若
 * 要做浅色皮肤」的代码路径 —— **不暴露入口**（没有任何调用点传它）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- monaco 的类型面很大，只声明用到的部分 */

/** 编辑器实例的最小结构面（避免在组件里散落 `any`）。 */
export interface CodeEditorHandle {
  /** 取当前源码（学生改动后的最新版本）。 */
  getValue(): string
  /** 整段替换（切换知识点 / 重置为脚手架时用）。 */
  setValue(text: string): void
  /** 是否只读（运行期间可锁住，避免"边跑边改"）。 */
  setReadOnly(readOnly: boolean): void
  /**
   * 切换主题（`vs` / `vs-dark`）。
   *
   * ★ 目前**没有调用点**（卡片固定用浅色 `vs`）——刻意保留：Monaco 的主题是**全局**设置
   *   （`monaco.editor.setTheme()`），将来做深色模式时所有编辑器实例要一起切，
   *   而这个句柄正是唯一该碰 Monaco 的地方（组件不 import monaco）。
   *   接口本身**不暴露 `any`**：主题只有两个字面量，加新主题改 {@link CodeEditorTheme} 即可。
   */
  setTheme(theme: CodeEditorTheme): void
  /** 重算布局（卡片展开/全屏/窗口尺寸变化后必须调用，否则编辑器会留白或裁切）。 */
  layout(): void
  /** 聚焦（打开卡片后把光标放进去）。 */
  focus(): void
  /** 释放（组件卸载时必须调用，否则会留下监听器与 DOM 引用）。 */
  dispose(): void
}

export type CodeEditorTheme = 'vs' | 'vs-dark'

/**
 * 默认（也是当前唯一的）主题：`vs-dark`。
 *
 * ★ 报告 §5.1 要求主题精简为只保留 `vs-dark`（计划 §3 D9 的收口口径：需求层照报告做，
 *   编辑器固定深色皮肤）。`vs` 这个字面量保留在类型里，注释里说明它是**未来路径**，
 *   不给任何入口 —— 改回去之前先读这一段。
 */
export const DEFAULT_EDITOR_THEME: CodeEditorTheme = 'vs-dark'

/** 加载 Monaco 的最大尝试次数（报告 §5.1「失败重试 ≤3 次」）。 */
export const MONACO_MAX_LOAD_ATTEMPTS = 3

/** Monaco 用的语言 id（契约里 `CodeTemplate.language` 固定 `"python"`）。 */
export const EDITOR_LANGUAGE = 'python'

/**
 * 学生代码的编辑器选项（教学取向：行号、自动换行、缩进参考线、**关掉代码提示的噪声**）。
 *
 * ── ★ 字号 / 行高（走查结论：代码字太小、行距太挤）────────────────────────
 *
 * `15 / 24`（1.6 倍行距），三条依据：
 *   ① **代码不许比正文小**：设计系统的正文是 16px（`--k12-fs-md`，D-043 的字号阶梯），
 *      而 K12 的学生里有一大批是刚接触键盘的 —— 13px 的等宽字对他们是"看不清"而不是"紧凑"；
 *   ② 不直接取 16px：等宽字在**同样字号下视觉上比 UI 字更大**（字面更宽更满），
 *      15px 已经与正文观感齐平、再大就比正文重（那会违反「内容里最重的是正文」这条层级纪律）；
 *   ③ 行距按 1.6 倍：Python 是**缩进即语法**的语言，行距太挤时"缩进了几层"会看不出来
 *      （那正是 `IndentationError` 最让人想不通的地方）。
 *
 * ⚠️ 改这两个数要同时看编辑器容器的**高度**（两处，都写死了）：
 *     `views/Coding.vue` 的 `.code__editor` = 420px ≈ (420−16)÷24 ≈ 16 行；
 *     `cards/CodingCard.vue` 的 `.coding__editor` = 300px ≈ 12 行（内联卡片，可展开/全屏）。
 *     高度与行高一起决定"一屏能看到几行"，只改一边就会出现"字大了但一行都看不全"。
 *
 * ── ★ 缩进参考线 / 括号连线（`guides`）──────────────────────────────────
 *
 * 目标版本：**monaco-editor 0.56.0**（`^0.56.0`）。0.56 支持 `guides.indentation` /
 * `guides.bracketPairs`（`IGuidesOptions`，见 `esm/vs/editor/editor.api.d.ts`）。
 * ⚠️ 事实核对：**`indentation` 在 0.56 的默认值本来就是 `true`**（`editorOptions.js` 的
 * `GuideOptions` 默认块），所以这一条是"写明意图"而不是"打开一个新开关"；
 * 真正的变化是 `bracketPairs`（默认 `false`）—— 括号配对连线对
 * `(height_m ** 2)` 这类嵌套表达式是实打实的帮助。
 */
export function editorOptions() {
  return {
    language: EDITOR_LANGUAGE,
    theme: DEFAULT_EDITOR_THEME,
    // 自动换行：K12 学生写不出超长行，但粘贴进来的示例常有 —— 横向滚动会让人找不到北
    wordWrap: 'on' as const,
    lineNumbers: 'on' as const,
    // 缩进用 4 空格（与教材里的 Python 示例一致；Tab 会让缩进错误更难发现）
    tabSize: 4,
    insertSpaces: true,
    detectIndentation: false,
    // 关掉自动补全/参数提示：教学场景里"猜出答案"会削弱思考（陷阱：直接给答案的软性版本）
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    parameterHints: { enabled: false },
    // 关掉 minimap 与滚动条装饰：小卡片里它们只占地方
    minimap: { enabled: false },
    // ★ 多光标（报告 §5.1 点名要移除的一项）：monaco 0.56 的 standalone 入口
    //   把编辑器内核整体打进来，没有「编译期删掉多光标」的开关 —— 等价做法是把
    //   上限压到 1（再想加第二个光标就撞上限），并关掉列选择（鼠标拖出来的第二个光标）。
    multiCursorLimit: 1,
    columnSelection: false,
    scrollBeyondLastLine: false,
    // 字体：等宽，与设计系统的 --font-mono 同族（回退链保证本机一定有字体可用）
    fontFamily:
      "ui-monospace, 'Cascadia Mono', Consolas, 'Courier New', 'Microsoft YaHei Mono', monospace",
    fontSize: 15,
    lineHeight: 24,
    // 缩进参考线 + 括号配对连线（见文件头的版本核对）。
    // `bracketPairsHorizontal` 保持默认 `'active'`：只给当前括号对画横线，不糊满屏。
    guides: { indentation: true, bracketPairs: true, highlightActiveBracketPair: true },
    // 上下各 8px：首行/末行贴着外框时，行号与缩进会看起来像被裁掉了
    padding: { top: 8, bottom: 8 },
    // 编辑器自己滚动，不把整页撑开（卡片高度固定）
    scrollbar: { alwaysConsumeMouseWheel: false },
    automaticLayout: false, // 由我们用 ResizeObserver 显式 layout（更可控）
    renderLineHighlight: 'line' as const,
    contextmenu: true,
    // ★ 只读的"灰色遮罩"关掉：我们只在运行时临时只读，不需要视觉降级
    readOnly: false,
    domReadOnly: false
  }
}

/** 模块级缓存：Monaco 只装配一次（多次 `import` 是幂等的，但 MonacoEnvironment 只需设一次）。 */
let monacoReady: Promise<any> | null = null

/**
 * 装配一次 Monaco（三个动态 import + worker 映射）。
 *
 * ★ 三个 import 的顺序有实义：语言注册与 worker 都必须在**任何** `editor.create` 之前
 *   落地（语言不注册 = 没有高亮；worker 不映射 = 生产构建下 404）。
 */
async function importMonacoOnce(): Promise<any> {
  // ★ 动态 import：这一行是懒加载的关键（vite 据此切 chunk）。
  //
  // ⚠️ **不要 import 'monaco-editor'（包根）**。实测（vite build，monaco 0.56）：
  //    包根 `esm/vs/index.js` 会 register **每一种**语言，还会拉进
  //    `external/monaco-lsp-client` —— 于是生产产物里出现五个语言服务 worker：
  //
  //        ts.worker   13,307 kB
  //        css.worker   1,909 kB
  //        html.worker  1,285 kB
  //        json.worker    883 kB
  //        ─────────────────────── 约 17.4 MB，本项目**一个都用不到**
  //
  //    改用 `editor/editor.api`（编辑器内核 + 语言注册表，不含任何内置语言）
  //    + 只注册 Python 一个语言定义，这 17.4 MB 全部消失。
  const monaco = await import('monaco-editor/editor/editor.api')
  // ★ 只注册 Python（报告 §5.1「配置只加载 Python 语言」）。
  //   ⚠️ 不要换回 `basic-languages/monaco.contribution` —— 那个文件会把 ~90 种语言的
  //   register 入口全部拉进来（每种语言再各自懒加载定义），对只写 Python 的场景是纯噪声。
  await import('monaco-editor/languages/definitions/python/register')
  // ★ 说明符必须是这个**短形式**（见文件头：`esm/vs/...` 会让生产构建直接失败）
  const { default: EditorWorker } = await import('monaco-editor/editor/editor.worker?worker')

  // ★ 告诉 Monaco：worker 用这个 vite 打出来的入口。
  //   只映射 `editorWorkerService` —— 我们只注册了 Python 的词法高亮，
  //   没有语言服务（LSP），所以不存在 ts/json/css/html 那四个 worker 的需求。
  ;(self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
    getWorker: (): Worker => new EditorWorker()
  }

  return monaco
}

/**
 * 懒加载并装配 Monaco（**幂等**）。
 *
 * ★ 这里是"进卡片才加载"的落点：动态 `import()` 让 vite 把 Monaco 切成独立 chunk，
 * 页面初始化时不会拉它（对话为主的应用不该为编程卡片付启动成本）。
 *
 * 同时完成 worker 装配 —— **必须在任何 `monaco.editor.create` 之前**，
 * 否则 Monaco 会去猜 worker 地址（生产构建下就是那个 404）。
 *
 * ★★ 失败重试（报告 §5.1「失败重试 ≤3 次」，2026-09-27）：
 *   第一次打开编程环境时，chunk 是从本地磁盘读的 —— 读失败只可能发生在磁盘抖动 /
 *   安装包被占用这类瞬时故障上，**再试一次的代价远小于让学生看到一句"起不来"**。
 *   三次都失败才向上抛；抛之前把缓存的 Promise 清掉，这样学生再点一次能重新试
 *   （而不是被一个已经失败的 Promise 永久钉住）。
 */
export async function loadMonaco(): Promise<any> {
  if (monacoReady) return await monacoReady

  const pending = (async () => {
    let lastError: unknown = null
    for (let attempt = 1; attempt <= MONACO_MAX_LOAD_ATTEMPTS; attempt += 1) {
      try {
        return await importMonacoOnce()
      } catch (error) {
        lastError = error
        // 前两次失败后短暂等待再试（磁盘抖动 / 句柄占用往往几十毫秒内就释放）
        if (attempt < MONACO_MAX_LOAD_ATTEMPTS) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 150))
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  })()

  monacoReady = pending
  try {
    return await pending
  } catch (error) {
    // ★ 只有「还是这次失败的那一个 Promise」才清缓存：并发调用各自拿到的都是 pending，
    //   后到的调用不该把别人已经成功的装配再抹掉。
    if (monacoReady === pending) monacoReady = null
    throw error
  }
}

export interface CreateEditorOptions {
  /** 宿主 DOM 节点（必须已经在文档里且有尺寸）。 */
  container: HTMLElement
  /** 初始源码（通常是模板的 `scaffold`）。 */
  value: string
  /** 只读（运行期间可临时锁住）。 */
  readOnly?: boolean
  theme?: CodeEditorTheme
  /** 内容变化回调（用于"学生改过没有"的判断与提示）。 */
  onChange?: (value: string) => void
}

/**
 * 建一个代码编辑器（**异步**：内部会先 `loadMonaco()`）。
 *
 * 返回的句柄是**最小面**：组件不需要认识 Monaco 的类型，
 * 也就不会因为升级 monaco 版本而在业务代码里到处报类型错。
 */
export async function createCodeEditor(options: CreateEditorOptions): Promise<CodeEditorHandle> {
  const monaco = await loadMonaco()
  const editor = monaco.editor.create(options.container, {
    ...editorOptions(),
    value: options.value,
    readOnly: options.readOnly ?? false,
    theme: options.theme ?? DEFAULT_EDITOR_THEME
  })

  // 内容变化：交给宿主组件（例如"改过之后再点运行"的引导）
  const subscription =
    typeof options.onChange === 'function'
      ? editor.onDidChangeModelContent(() => {
          options.onChange?.(editor.getValue())
        })
      : null

  return {
    getValue: () => editor.getValue(),
    setValue: (text: string) => editor.setValue(text),
    setReadOnly: (readOnly: boolean) => editor.updateOptions({ readOnly }),
    setTheme: (theme: CodeEditorTheme) => {
      // `monaco` 本身是 `any`（monaco 的类型面很大，只在 `loadMonaco()` 边界收一次）；
      // 这里**立刻**收窄成我们要的那一个方法，别让 `any` 顺着句柄跑到业务代码里。
      const editorApi: { setTheme(theme: CodeEditorTheme): void } = monaco.editor
      editorApi.setTheme(theme)
    },
    layout: () => editor.layout(),
    focus: () => editor.focus(),
    dispose: () => {
      subscription?.dispose()
      // 先 dispose model 再 dispose editor：只 dispose editor 会留下 model 引用（内存泄漏）
      const model = editor.getModel()
      editor.dispose()
      model?.dispose()
    }
  }
}

/**
 * 用 `ResizeObserver` 把容器尺寸变化接到 `editor.layout()`。
 *
 * 为什么需要：卡片有"内联 / 展开 / 全屏"三种形态（执行文档 §11.1 的布局口径），
 * 每次形态变化容器尺寸都变；Monaco **不会**自己感知（它把 `automaticLayout: false` 交给我们），
 * 不调用 `layout()` 就会出现"编辑器还停留在旧高度"的空白或裁切。
 *
 * 返回取消函数（组件卸载时调用）。
 */
export function observeEditorResize(container: HTMLElement, handle: CodeEditorHandle): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {}
  const observer = new ResizeObserver(() => {
    // Monaco 的 layout 很便宜，但连续拖动窗口时会很密集 —— 用 rAF 合并到每帧一次
    requestAnimationFrame(() => handle.layout())
  })
  observer.observe(container)
  return () => observer.disconnect()
}
