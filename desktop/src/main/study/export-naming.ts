/**
 * 导出为文件的**纯逻辑**（文件名清理 + 内容规范化），与 Electron 的 `dialog` 分开。
 *
 * 分开的理由：清理规则是**安全边界**（文件名会落到学生的磁盘上），必须能单测；
 * 而 `dialog.showSaveDialog` 是 Electron API，测试里跑不了。
 * 于是 `handlers.ts` 只做「清理 → 弹框 → 写盘」的编排，规则全在这里。
 *
 * ★★ 唯一的安全目标：渲染进程递进来的 `fileName` **只能变成一个文件名**，
 *    不能变成一条路径。做法是**白名单式重建**（只保留安全字符），而不是黑名单式过滤
 *    （`replace(/\.\./g, '')` 这类可以被 `....//` 绕过）。
 */

/** 文件名允许保留的字符：中日韩、字母数字、空格、`-`、`_`、`.`。其余一律换成 `-`。 */
const SAFE_NAME_RE = /[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Letter}\p{Number} ._-]/gu

/** 文件名长度上限（**按字符**：Windows 的 255 是字节，中文一个占三字节，取 60 很安全）。 */
export const MAX_FILE_NAME_CHARS = 60

/**
 * ★★ Windows **保留设备名**（DOS 时代的遗留：这些名字至今仍被 Win32 当成设备而不是文件）。
 *
 * 判据（`MS-DOS` 设备名 + Win10 补的 `CONIN$` / `CONOUT$` 不在内 —— 它们带 `$`，
 * 白名单重建那一步已经把 `$` 换成 `-` 了，构造不出来）：
 *   - 裸设备名（`CON` / `NUL` / `COM1` …）；
 *   - **带扩展名的也算**（`nul.txt`、`COM1.log` 全都是设备）；
 *   - **大小写不敏感**（`con` / `CoN` 同样命中）—— 这是 Win32 的实际行为。
 *
 * ⚠️ 为什么只对**开头**做锚定：设备名的判定是「**基本名**（第一个点之前的部分）等于设备名」，
 *    所以 `我的CON.txt` 是普通文件（基本名是「我的CON」）。用 `^` 锚定正好表达这一点；
 *    不加锚定会把 `第1章-COM1练习` 这类正常标题也一起改名。
 *
 * ★ 触发距离（为什么现在就补）：当前唯一调用点的入参受 `[A-Za-z0-9_-]{1,64}` 约束，
 *   **打不出来**；但本函数自称是「渲染进程字符串 → 文件名」的安全边界，
 *   将来接上别的输入（比如用学生输入的标题当文件名）就直接命中 ——
 *   而症状是「保存成功但文件不见了/写到了设备上」，堪称最难排查的一类。
 */
const WINDOWS_RESERVED_DEVICE_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i

/** 命中保留设备名时加的前缀（**加前缀而不是改名**：保留可读性，且 `_CON.md` 是合法文件）。 */
export const RESERVED_NAME_PREFIX = '_'

/** 导出文件名的默认值（清理后为空时用它）。 */
export const DEFAULT_EXPORT_NAME = '学习档案'

/**
 * 把任意输入清理成一个**安全文件名**（不含目录、以 `.md` 结尾）。
 *
 * 规则（每条都对应一种真实攻击/事故形态）：
 *   1. **只取最后一段**：`a/b/c.md`、`..\\..\\config.json` 这类输入，
 *      先按两种分隔符切开取最后一段 —— 路径分隔符在这里就没了；
 *   2. **白名单重建**：剩下的字符里，非「汉字/字母/数字/空格/`-`/`_`/`.`」一律换成 `-`；
 *   3. **去掉开头的点**：`.env`、`..` 这类以点开头的名字在 Unix 下是隐藏文件，
 *      而 `.` 与 `..` 是目录项本身 —— 直接清掉开头的连续点；
 *   4. **压掉连续空白并限长**；
 *   5. **强制 `.md` 后缀**：认不出后缀就补，`.md` 已存在则不重复补。
 *      这一步同时挡掉「把 `.exe` 当文件名递进来」的可能（后缀被替换）。
 *   6. ★ **Windows 保留设备名加前缀**（`CON` / `nul.txt` / `COM1` / `LPT9` …，见
 *      {@link WINDOWS_RESERVED_DEVICE_RE}）。
 *
 * ⚠️ 第 6 条的**位置**很重要：它必须排在**洗完名字之后、补后缀之前** —— 拿 `CON` 举例，
 *    第 5 步认不出它的「后缀」（`CON` 没有点），于是它会原样成为基本名 `CON`，
 *    补上 `.md` 就得到 `CON.md`，而那**仍然是个设备**（Win32 只看第一个点之前的部分）。
 *    所以在生成最终字符串之前先看基本名。
 *
 * 返回的一定是**单段、相对、以 `.md` 结尾**的名字，或 {@link DEFAULT_EXPORT_NAME} + `.md`。
 */
export function sanitizeFileName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : ''
  // ① 取最后一段（两种分隔符都切）。注意先切再过滤：反过来会被 `a\/b` 这类混合绕过。
  const lastSegment = text.split(/[/\\]/).filter((part) => part.length > 0).pop() ?? ''
  // ② 白名单重建
  let name = lastSegment.replace(SAFE_NAME_RE, '-')
  // ③ 去掉开头的点（隐藏文件 / 目录项）
  name = name.replace(/^\.+/, '')
  // ④ 压空白 + 限长
  name = name.replace(/\s+/g, ' ').trim()
  // ⑤ 后缀：先判是否已是 .md（大小写不敏感），不是就把已有的伪后缀也去掉再补
  const withoutExt = name.replace(/\.(md|markdown|txt|exe|bat|cmd|js|py|json)$/i, '')
  const base = Array.from(withoutExt).slice(0, MAX_FILE_NAME_CHARS).join('')
  // ⑥ 收尾：去掉两端的 `-`/`.`/空白。★ 这一步不只是「好看」——
  //    全是非法字符的输入（`***`）走到这里会剩下一串 `-`，那是个**毫无意义的文件名**。
  //    去掉分隔符后若什么都不剩，就退回默认名（而不是给学生一个叫 `---.md` 的文件）。
  let safeBase = base.replace(/^[-.\s]+|[-.\s]+$/g, '')
  // ⑦ ★ Windows 保留设备名：加前缀（判据与理由见 `WINDOWS_RESERVED_DEVICE_RE` 的注释）。
  //    ⚠️ 用 `safeBase`（已洗过的那份）判断，不是用户原始输入 —— 否则 `NUL*` 这种
  //    会被第 ② 步变成 `NUL-` 而漏掉，而它补上 `.md` 之后基本名仍是 `NUL-`（无害，
  //    但「用哪一份做判断」必须固定成一处，不能两处各判一次）。
  if (WINDOWS_RESERVED_DEVICE_RE.test(safeBase)) {
    safeBase = `${RESERVED_NAME_PREFIX}${safeBase}`
  }
  return `${safeBase || DEFAULT_EXPORT_NAME}.md`
}

/**
 * 内容规范化：**统一 LF + 去掉结尾多余空行**，不追加 BOM。
 *
 * ★ 为什么不用 `\r\n`：`.gitattributes` 与本项目所有文档都是 LF；
 *   导出物是要给学生/家长看、可能要进仓库或粘进报告的，**统一 LF** 才不会再制造
 *   「CRLF/LF 混排导致整文件 diff」那类问题（本项目已踩过）。
 * ★ 不加 BOM：Windows 记事本从 2019 起已经能识别无 BOM 的 UTF-8；
 *   而加了 BOM 会让 `git diff` 与 `head` 这类工具多一个不可见字符，弊大于利。
 */
export function normalizeExportContent(content: unknown): string {
  const text = typeof content === 'string' ? content : ''
  return `${text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')}\n`
}
