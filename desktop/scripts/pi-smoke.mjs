/**
 * 票 03 —— 最小流式冒烟脚本（**不接 UI、不接 sidecar**）。
 *
 * 用法：
 *   node scripts/pi-smoke.mjs                                   # 自动找 Key；没有就停在 Key 这一步
 *   node scripts/pi-smoke.mjs --api-key sk-xxx                  # Key 解析链第 1 档
 *   node scripts/pi-smoke.mjs --model deepseek-chat --base-url https://api.deepseek.com/v1
 *   node scripts/pi-smoke.mjs --user-data D:/tmp/k12-smoke      # 指定 userData（三处目录隔离的根）
 *
 * 退出码：0 = 到 Key 为止全部通过（含真有 Key 且拿到增量）
 *         1 = Pi 装配失败    2 = 参数错误   12 = 有 Key 但请求失败
 *
 * ★ 本脚本直接 import TS 源码（Node 22.18+ 默认开启类型擦除），
 *   所以「开发态脚本」与「打包产物 K12_PI_SMOKE=1」跑的是**同一份实现**，不存在两套代码互相甩锅。
 */

import { runPiSmoke, fallbackUserDataDir } from '../src/main/agent/pi-bootstrap.ts'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = 'true'
    } else {
      out[key] = next
      i += 1
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

const result = await runPiSmoke({
  userDataDir: args['user-data'] ?? fallbackUserDataDir(),
  apiKey: args['api-key'],
  modelId: args.model,
  baseUrl: args['base-url'],
  phrase: args.phrase,
  log: (line) => console.log(line)
})

process.exit(result.exitCode)
