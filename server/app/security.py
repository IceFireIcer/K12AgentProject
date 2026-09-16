"""鉴权与跨源策略常量。

**票 01 只落常量**；token 鉴权中间件在**票 02**（与 sidecar 握手一起）落地，规则见下：

- 所有 ``/api/*`` 必须带 ``X-Auth-Token``，与启动参数 ``--token`` 不符 → 401；
- ``/health`` 免鉴权（启动期探活要用）；
- ``OPTIONS`` 预检免鉴权（预检不带自定义头，拦了就等于拦掉一切跨源请求）。

**为什么 token 是「每次启动随机生成」而不是固定值**：sidecar 监听在回环地址上，
本机任何进程都能访问 —— 没有 token 就等于把学生数据暴露给本机任意程序。
见执行文档 §6.3 安全第 ② 条。
"""

from __future__ import annotations

# 自定义鉴权头（契约的一部分，不要改名）
AUTH_HEADER = "X-Auth-Token"

# ------------------------------------------------------------------ 跨源策略 --
# 渲染进程**不直连 sidecar**（所有请求都来自主进程），所以跨源不是主链路问题；
# 这里保留一段最小显式来源的 CORS 只作纵深防御。**禁止使用 `*`**。
ALLOWED_ORIGINS = (
    "null",  # file:// 页面的 Origin 就是字符串 "null"
    "file://",
)

# 开发态：electron-vite dev server 的本地来源
ALLOWED_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"
