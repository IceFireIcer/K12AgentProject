/**
 * Pyodide 运行器**主线程那一半**的断言（`sandbox/pyodide-runner.ts`）。
 *
 * ★ 为什么需要这一组（审计结论）：`createPyodideRunner` 的第一个参数 `workerFactory`
 *   从写下来那天起就是「可注入（测试用假 Worker）」，但 `grep -rn workerFactory desktop/tests`
 *   是 **0** —— 于是**这一半**最关键的三条性质全程没有任何机器判据：
 *
 *     ① ready 握手（懒加载入口：发 init、收 ready、把状态推成 ready）；
 *     ② **超时真的写了 SIGINT**（票 18 的头号演示：`while True: pass` 能被中断）——
 *        只断言「reject 了」是不够的：一个从不写共享内存、只把 await 晾死的实现
 *        同样能「超时」，而现场表现是**界面卡死**；
 *     ③ `isCurrent()` 代际判断（旧 Worker 迟到的消息不得冒充当前 Worker）与
 *        `terminateWorker` 的调用顺序（重试前先终结）。
 *
 * `coding-extension.test.ts` 的 G18-1c2/c3 只钉住了「渲染进程入口装上了桥」这条接线，
 * 桥另一头的执行语义一直没测 —— 本文件补的就是那一段。
 *
 * ---------------------------------------------------------------------------
 * 怎么在 node 里测：注入假 Worker，不用真 Pyodide
 * ---------------------------------------------------------------------------
 * 本模块在渲染进程跑，但**没有**在模块顶层碰 `window` / `document`
 * （`document.baseURI` 那处有 `typeof document !== 'undefined'` 兜底，
 * 所以这里解析出的是相对路径 `./pyodide/`）。因此可以直接 import 真实实现。
 *
 * 假 Worker 用**同一块 `SharedArrayBuffer`** 与运行器对话，于是「主线程写 SIGINT」
 * 这条链路是真的走了一遍：定时器 → `Atomics.store` → 假 Worker 轮询看到 2 → 回
 * `interrupted: true`。**这正是要钉住的契约**（真 Worker 那边由 Pyodide 轮询同一块内存）。
 *
 * ⚠️ 需要真 SharedArrayBuffer / Atomics（Node ≥ 12 自带），不需要浏览器。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SIGINT, createPyodideRunner } from '../src/renderer/src/sandbox/pyodide-runner.ts'

/* ------------------------------------------------------------------ *
 * 假 Worker
 * ------------------------------------------------------------------ */

/** 主线程发给 Worker 的消息（本文件只关心这几个字段）。 */
interface SentMessage {
  type: string
  runId?: string
  code?: string
  timeoutMs?: number
  indexURL?: string
  packages?: string[]
}

type MessageHandler = (event: { data: unknown }) => void

interface FakeOptions {
  /** ready 交出来的中断缓冲区（`null` = 模拟本环境拿不到 SharedArrayBuffer）。 */
  interruptBuffer?: SharedArrayBuffer | null
  /** init 直接回失败（用来走「加载失败 → 允许重试」那条路径）。 */
  initFailure?: string
  /**
   * 收到 run 后的行为：
   *   - `echo`：立刻回一条 result（正常路径）
   *   - `interrupt-on-sigint`：轮询共享内存，看到 SIGINT 才回 `interrupted: true`
   *   - `silent`：永不回（模拟死循环期间 Worker 事件循环被占满）
   */
  run?: 'echo' | 'interrupt-on-sigint' | 'silent'
  /** echo 的延迟（毫秒）—— 用来让「主线程超时」先发生。 */
  runDelayMs?: number
  stdout?: string
}

interface FakeWorker {
  /** 交给 `createPyodideRunner` 的工厂（已按 Worker 形状强制转换）。 */
  worker: Worker
  sent: SentMessage[]
  /** 当前装着的处理器（`terminateWorker` 会把它清成 null）。 */
  handler(): MessageHandler | null
  errorHandler(): (() => void) | null
  /** 按「当前处理器」投递一条消息（正常路径）。 */
  emit(data: unknown): void
  /**
   * 按「**最后一个**装过的处理器」投递 —— 即使它已被 `terminateWorker()` 摘掉。
   *
   * 这模拟的是真实的竞态：消息在 terminate 之前就已投递、正在事件队列里。
   * 真 Worker 的这种情况我们无法构造，但「摘掉回调」不等于「消息没在路上」，
   * 而 `isCurrent()` 这道身份判断就是要兜住它。
   */
  emitStale(data: unknown): void
  terminated(): number
  sigintSeen(): boolean
  lastRun(): SentMessage | null
  stopTimers(): void
}

function makeFakeWorker(options: FakeOptions = {}): FakeWorker {
  const sent: SentMessage[] = []
  const timers: Array<ReturnType<typeof setInterval>> = []
  const buffer = options.interruptBuffer ?? null

  let handler: MessageHandler | null = null
  let lastHandler: MessageHandler | null = null
  let errorHandler: (() => void) | null = null
  let terminatedCount = 0
  let sawSigint = false

  const emit = (data: unknown): void => {
    handler?.({ data })
  }

  const replyResult = (runId: string, interrupted: boolean): void => {
    emit({
      type: 'result',
      runId,
      stdout: interrupted ? '' : (options.stdout ?? ''),
      stderr: interrupted ? 'KeyboardInterrupt: 已被中断\n' : '',
      interrupted,
      elapsedMs: 1
    })
  }

  const beginInterruptWatch = (runId: string): void => {
    if (buffer === null) return
    const view = new Int32Array(buffer)
    const timer = setInterval(() => {
      if (Atomics.load(view, 0) !== SIGINT) return
      // ★ 真的看到了主线程写进来的 2 —— 这一条就是「超时能中断死循环」的全部机制
      sawSigint = true
      clearInterval(timer)
      replyResult(runId, true)
    }, 5)
    timers.push(timer)
  }

  const worker = {
    get onmessage(): MessageHandler | null {
      return handler
    },
    set onmessage(next: MessageHandler | null) {
      handler = next
      // ★ 记下「最后一个装过的」：terminateWorker 之后还要能模拟迟到消息
      if (next) lastHandler = next
    },
    get onerror(): (() => void) | null {
      return errorHandler
    },
    set onerror(next: (() => void) | null) {
      errorHandler = next
    },
    postMessage(message: SentMessage): void {
      sent.push(message)

      if (message.type === 'init') {
        setTimeout(() => {
          if (options.initFailure) {
            emit({ type: 'error', runId: 'init', failure: options.initFailure })
            return
          }
          emit({
            type: 'ready',
            version: '0.28.0',
            loadMs: 1_100,
            packages: message.packages ?? [],
            capability: {
              interruptible: buffer !== null,
              detail: buffer !== null ? '自检通过' : '拿不到 SharedArrayBuffer'
            },
            interruptBuffer: buffer
          })
        }, 0)
        return
      }

      if (message.type === 'run') {
        const runId = message.runId ?? ''
        const behavior = options.run ?? 'echo'
        if (behavior === 'silent') return
        if (behavior === 'interrupt-on-sigint') {
          beginInterruptWatch(runId)
          return
        }
        setTimeout(() => replyResult(runId, false), options.runDelayMs ?? 0)
      }
    },
    terminate(): void {
      terminatedCount += 1
    }
  }

  return {
    worker: worker as unknown as Worker,
    sent,
    handler: () => handler,
    errorHandler: () => errorHandler,
    emit,
    emitStale: (data: unknown) => lastHandler?.({ data }),
    terminated: () => terminatedCount,
    sigintSeen: () => sawSigint,
    lastRun: () => sent.filter((m) => m.type === 'run').pop() ?? null,
    stopTimers: () => {
      for (const timer of timers) clearInterval(timer)
      timers.length = 0
    }
  }
}

/**
 * 按顺序发 Worker 的工厂。
 *
 * ★ 调用次数**必须**正好用完：多要一个 Worker 会当场炸 ——
 *   「重试只建一个新 Worker」本身就是一条要钉的性质（建两个 = 内存翻倍 +
 *   中断标志分家的老毛病）。
 */
function workerFactoryOf(...fakes: FakeWorker[]): () => Worker {
  let index = 0
  return () => {
    const fake = fakes[index]
    index += 1
    assert.ok(fake, `工厂被多调了一次（只准备了 ${fakes.length} 个假 Worker）`)
    return fake.worker
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * ★ 给「等一条回执」加上界：**守卫宁可响亮失败，也不能把整套测试挂住**。
 *
 * 这不是洁癖 —— 变异验证时实测过：把 `Atomics.store(..., SIGINT)` 改成写 0，
 * 假 Worker 的轮询永远看不到中断、那条 `await` 就永不兑现，
 * `node --test` 会一直停在那里（不是红，是**不动**）。
 * 一个「挂了」的守卫在现场与「没写」几乎一样难查，所以这里统一兜一层。
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`超时未兑现（${label}，${ms}ms）`)), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 收集日志（默认实现会往 console 里灌，测试里换成收集器）。 */
function collector(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = []
  return { lines, log: (line: string) => lines.push(line) }
}

/* ------------------------------------------------------------------ *
 * ① 正常路径
 * ------------------------------------------------------------------ */

test('① 正常路径：懒加载（run 之前一个资源都不拉）→ init → ready → run → result', async (t) => {
  const fake = makeFakeWorker({ interruptBuffer: new SharedArrayBuffer(4), stdout: '2\n' })
  const { lines, log } = collector()
  const runner = createPyodideRunner(workerFactoryOf(fake), { log })
  t.after(() => fake.stopTimers())

  // ★ 懒加载：还没 run / ensureReady，就不该有任何消息（CodingCard 的「进卡片才加载」证据）
  //   ⚠️ 用 `length` 而不是 `deepEqual(sent, [])`：node:assert 的 `asserts` 签名会把
  //      `sent` 收窄成 `never[]`，后面所有 `sent[i].type` 全部变成类型错误。
  assert.equal(fake.sent.length, 0, '构造运行器本身不得拉任何资源')

  const outcome = await withTimeout(runner.run('print(1 + 1)', { timeoutMs: 1_000 }), 3_000, '正常路径回执')

  assert.deepEqual(
    fake.sent.map((m) => m.type),
    ['init', 'run'],
    '顺序必须是 init → run（run 之前必须先握手）'
  )
  assert.equal(fake.sent[0].packages?.join(','), 'numpy', '预置包随 init 下发（票 18：numpy）')
  assert.equal(fake.sent[0].indexURL, './pyodide/', 'Node 里没有 document，取兜底相对路径')
  assert.equal(fake.sent[1].code, 'print(1 + 1)')
  assert.match(fake.sent[1].runId ?? '', /^run-\d+$/, 'runId 用来配对回执')

  assert.equal(outcome.failure, undefined)
  assert.equal(outcome.stdout, '2\n')
  assert.equal(outcome.interrupted, false)
  assert.ok(Number.isFinite(outcome.elapsedMs))

  assert.equal(runner.status().phase, 'ready')
  assert.equal(runner.status().loadMs, 1_100, 'ready 里的加载耗时要进状态（界面据此显示）')
  assert.ok(
    lines.some((l) => l.includes('懒加载完成')),
    'ready 要留一条带时间戳的日志（「进卡片才开始加载」的证据链）'
  )

  runner.dispose()
})

test('① 并发执行被挡住：上一次没跑完时给出可读失败，不乱发第二条 run', async (t) => {
  const fake = makeFakeWorker({ interruptBuffer: new SharedArrayBuffer(4), run: 'silent' })
  const { log } = collector()
  const runner = createPyodideRunner(workerFactoryOf(fake), { log })
  t.after(() => {
    runner.dispose()
    fake.stopTimers()
  })

  const first = runner.run('while True: pass', { timeoutMs: 10_000 })
  await sleep(10)
  const second = await withTimeout(runner.run('print(2)', { timeoutMs: 10_000 }), 3_000, '并发拦截')

  assert.match(second.failure ?? '', /上一次运行还没结束/)
  assert.equal(fake.sent.filter((m) => m.type === 'run').length, 1, '第二条代码根本不该发给 Worker')
  runner.dispose()
  await first // dispose 会把在跑的那条以可读失败兑现（不留悬空 await）
})

/* ------------------------------------------------------------------ *
 * ② 超时中断：真的写了 SIGINT
 * ------------------------------------------------------------------ */

test('★★ 超时真的写了 SIGINT（不是只把 await 晾着），且兑现回执后清回 0', async (t) => {
  const sab = new SharedArrayBuffer(4)
  const view = new Int32Array(sab)
  const fake = makeFakeWorker({ interruptBuffer: sab, run: 'interrupt-on-sigint' })
  const { lines, log } = collector()
  const runner = createPyodideRunner(workerFactoryOf(fake), { log })
  t.after(() => fake.stopTimers())

  const outcome = await withTimeout(runner.run('while True: pass', { timeoutMs: 60 }), 3_000, '超时中断回执')

  assert.equal(fake.sigintSeen(), true, '★ 主线程必须把 2 写进共享内存（Pyodide 靠它抛 KeyboardInterrupt）')
  assert.equal(outcome.interrupted, true, '回执要如实带 interrupted（界面/轨迹图都看它）')
  assert.match(outcome.stderr, /KeyboardInterrupt/)
  assert.match(lines.join('\n'), /已写入 SIGINT/)
  assert.equal(
    Atomics.load(view, 0),
    0,
    '★ 兑现回执后必须清回 0：残留的 2 会让**下一次**执行一上来就被中断（「第二次运行总是失败」）'
  )

  runner.dispose()
})

test('★ 能力自检说「不可中断」时不假装有保护：如实记一条，且不写中断标志', async (t) => {
  // interruptBuffer = null 模拟拿不到 SharedArrayBuffer 的环境
  const fake = makeFakeWorker({ interruptBuffer: null, runDelayMs: 60, stdout: 'ok\n' })
  const { lines, log } = collector()
  const runner = createPyodideRunner(workerFactoryOf(fake), { log })
  t.after(() => fake.stopTimers())

  const outcome = await withTimeout(runner.run('print("ok")', { timeoutMs: 20 }), 3_000, '不可中断环境的回执')

  assert.equal(outcome.interrupted, false, '没有中断保护时不得谎报中断')
  assert.match(
    lines.join('\n'),
    /无法中断/,
    '拿不到 SAB 必须留一条明确日志（否则现场只能靠猜「超时到底有没有用」）'
  )
  assert.equal(fake.sigintSeen(), false)

  runner.dispose()
})

/* ------------------------------------------------------------------ *
 * ③ 代际身份：旧 Worker 迟到的消息一律不认
 * ------------------------------------------------------------------ */

test('★★ 旧 Worker 迟到的 ready 不得覆盖 interruptBuffer（「重试后中断标志分家」的防线）', async (t) => {
  const oldSab = new SharedArrayBuffer(4)
  const newSab = new SharedArrayBuffer(4)
  const oldView = new Int32Array(oldSab)
  const newView = new Int32Array(newSab)

  // 第一个 Worker：加载直接失败（把运行器打到「可重试」状态）
  const broken = makeFakeWorker({ interruptBuffer: oldSab, initFailure: 'wasm 加载失败' })
  const fresh = makeFakeWorker({ interruptBuffer: newSab, run: 'interrupt-on-sigint' })
  const { log } = collector()
  const runner = createPyodideRunner(workerFactoryOf(broken, fresh), { log })
  t.after(() => {
    broken.stopTimers()
    fresh.stopTimers()
  })

  const first = await withTimeout(runner.run('1 + 1'), 3_000, '加载失败回执')
  assert.match(first.failure ?? '', /wasm 加载失败/, '加载失败必须收敛成 failure（不抛给界面）')

  // 第二次：建新 Worker；等它的 ready 落定后，旧 Worker 那条迟到的 ready 才到
  const pending = withTimeout(runner.run('while True: pass', { timeoutMs: 60 }), 3_000, '代际 ready')
  await sleep(10)
  broken.emitStale({
    type: 'ready',
    version: '0.28.0',
    loadMs: 5,
    packages: ['numpy'],
    capability: { interruptible: true, detail: '旧 Worker' },
    interruptBuffer: oldSab
  })

  const outcome = await pending

  assert.equal(outcome.interrupted, true, '中断必须仍然落在**当前** Worker 那块内存上')
  assert.equal(fresh.sigintSeen(), true)
  assert.equal(
    Atomics.load(oldView, 0),
    0,
    '★ 旧 Worker 的缓冲区一个字都不该被写 —— 写了就说明 interruptBuffer 被迟到的 ready 覆盖过'
  )
  assert.equal(Atomics.load(newView, 0), 0, '回执兑现后仍要清回 0')
  assert.equal(broken.terminated(), 1, '开放的旧 Worker 必须先被终结（否则它继续占内存 + 发迟到消息）')

  runner.dispose()
})

test('★★ 旧 Worker 迟到的 result 不得冒充当前回执', async (t) => {
  const stale = makeFakeWorker({ interruptBuffer: new SharedArrayBuffer(4), run: 'silent' })
  const fresh = makeFakeWorker({
    interruptBuffer: new SharedArrayBuffer(4),
    run: 'interrupt-on-sigint'
  })
  const { log } = collector()
  const runner = createPyodideRunner(workerFactoryOf(stale, fresh), { log })
  t.after(() => {
    stale.stopTimers()
    fresh.stopTimers()
  })

  // 第一轮：第一条 Worker 挂住不回（模拟死循环把 Worker 的事件循环占满）
  const hanging = withTimeout(runner.run('while True: pass', { timeoutMs: 10_000 }), 3_000, 'dispose 兑现')
  await sleep(10)
  runner.dispose()
  const closed = await hanging
  assert.match(closed.failure ?? '', /运行器已关闭/, 'dispose 要把在跑的请求兑现成可读失败')

  // 第二轮：新 Worker 上跑新代码，此时旧 Worker 才把第一轮的结果递过来
  const pending = withTimeout(runner.run('while True: pass', { timeoutMs: 60 }), 3_000, '代际 result')
  await sleep(10)
  const runId = fresh.lastRun()?.runId ?? ''
  assert.ok(runId, '新 Worker 应当收到过 run')
  stale.emitStale({
    type: 'result',
    runId,
    stdout: '旧 Worker 的假结果\n',
    stderr: '',
    interrupted: false,
    elapsedMs: 1
  })

  const outcome = await pending
  assert.equal(outcome.stdout, '', '★ 旧 Worker 的 stdout 不得被当成当前结果')
  assert.equal(outcome.interrupted, true, '当前这条仍要等它自己的回执（被中断）')

  runner.dispose()
})

/* ------------------------------------------------------------------ *
 * ④ terminateWorker 的调用顺序
 * ------------------------------------------------------------------ */

test('★ 重试前先终结旧 Worker（terminate 发生在新建之前），dispose 只终结一次', async (t) => {
  const events: string[] = []
  const broken = makeFakeWorker({ interruptBuffer: null, initFailure: '第一次初始化失败' })
  const fresh = makeFakeWorker({ interruptBuffer: new SharedArrayBuffer(4), stdout: '' })
  const { log } = collector()

  let created = 0
  const factory = (): Worker => {
    created += 1
    events.push(`create-${created}`)
    return created === 1 ? broken.worker : fresh.worker
  }
  const runner = createPyodideRunner(factory, { log })
  t.after(() => {
    broken.stopTimers()
    fresh.stopTimers()
  })

  await withTimeout(runner.run('1 + 1'), 3_000, '终结顺序-第一次')
  assert.equal(broken.terminated(), 1, '加载失败后必须立刻终结旧 Worker（否则它还在拉那 9MB wasm）')
  assert.equal(
    broken.handler(),
    null,
    '终结前要先摘掉 onmessage（已 terminate 的 Worker 不该再驱动我们的逻辑）'
  )
  assert.equal(broken.errorHandler(), null)

  await withTimeout(runner.run('2 + 2'), 3_000, '终结顺序-第二次')
  assert.equal(
    events.join(' '),
    'create-1 create-2',
    `重试只新建一个 Worker（实际：${events.join(' ')}）`
  )
  assert.ok(fresh.terminated() === 0, '新 Worker 此刻不该被终结')

  runner.dispose()
  runner.dispose()
  assert.equal(fresh.terminated(), 1, 'dispose 幂等：第二次调用不该去终结一个已经为 null 的 Worker')
  assert.equal(runner.status().phase, 'idle', 'dispose 之后状态回到 idle')
})

test('★ 执行期故障（error 回执）转成 outcome.failure 而不是抛出（界面不许白屏）', async (t) => {
  const sab = new SharedArrayBuffer(4)
  const view = new Int32Array(sab)
  const fake = makeFakeWorker({ interruptBuffer: sab, run: 'silent' })
  const { log } = collector()
  const runner = createPyodideRunner(workerFactoryOf(fake), { log })
  t.after(() => fake.stopTimers())

  const pending = withTimeout(runner.run('print(1)'), 3_000, '执行期故障回执')
  await sleep(10)
  const runId = fake.lastRun()?.runId ?? ''
  // 人为置位中断标志，验证「执行期故障兑现时也会清 buffer」
  Atomics.store(view, 0, SIGINT)
  fake.emit({ type: 'error', runId, failure: 'Python 运行环境（Worker）异常退出' })

  const outcome = await pending
  assert.equal(outcome.failure, 'Python 运行环境（Worker）异常退出')
  assert.equal(outcome.interrupted, false)
  assert.equal(Atomics.load(view, 0), 0, '故障路径同样要清中断标志（否则下一次执行一上来就被中断）')

  runner.dispose()
})
