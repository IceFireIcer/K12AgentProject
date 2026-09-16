/**
 * ⚠️ 生成物，**不要手改**（generated, do not edit）。
 *
 * 来源：`server/app/contracts.py`（唯一手写契约处）
 *   → `server/scripts/export_openapi.py` → `src/shared/openapi.json`
 *   → `desktop/scripts/gen-api-types.mjs` → 本文件。
 *
 * 重新生成：`cd desktop && npm run gen:api`；校验是否漂移：`npm run check:api`。
 * 手改本文件会在下一次 `--check` 时被判定为漂移（并让 typecheck 失去意义）。
 *
 * ★ 6 事件词表（冻结，见 `contracts.py` 的 `IPC_EVENT_NAMES` 与 `shared/ipc-events.ts`）：
 *   delta | citation | payload | blocked | done | error
 *
 * ⚠️ 本文件**不含**带标准答案的内部模型 `QuizQuestion`（§6.3 答案泄漏防护）：对外的题目
 * 一律是 `QuizQuestionOut`。本文件里唯一带 `answer` 的是 `QuizGradeRequest` —— 那是
 * **学生提交的作答**（请求方向），不是标准答案；导出脚本会断言它不被任何 response 引用。
 */

export interface paths {
    "/api/grade/history/{student_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 学段变化轨迹
         * @description ``grade_history`` 全量轨迹（含冷启动基线那行：``from_level`` 为空）。
         */
        get: operations["grade_history_api_grade_history__student_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/grade/signals/{student_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 学段信号与待生效的推断建议
         * @description 当前学段 + 最近信号 + （够格但被挡住时的）待生效建议。
         *
         *     ★ 与旧设计不同：这里**不再有「学生确认」这一步** —— 学段由系统自动生效，
         *     ``source`` 恒为 ``inferred``。``suggested_level`` 的含义因此收窄为
         *     「证据已够、但被冷却期或置信度挡住的下一个学段」，供前端显示「将在下一轮生效」。
         */
        get: operations["grade_signals_api_grade_signals__student_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/grade/state/{student_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 当前学段状态（轻量）
         * @description 桌面端每轮取「当前学段」的入口（不含信号列表，载荷最小）。
         *
         *     学生还没建库时**冷启动**：建默认学段（小学高年级）并写一条基线轨迹，
         *     而不是 404 —— 学段推断从第一轮就要开始工作。
         */
        get: operations["grade_state_api_grade_state__student_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/grade/turns/{student_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 上交一批轮次证据，由服务端提取信号并判定学段
         * @description ★ **学段推断的主入口**：一批轮次证据 → 信号 → 判定 → （必要时）改学段。
         *
         *     依次处理 ``turns``（按给定顺序 = 轮次升序），**逐轮判定**，
         *     返回最后一轮的结论 + 每一轮的轨迹。信号逐轮落库：即使中途失败，
         *     已写入的信号也不会丢，下一次调用照样能算出正确的连续轮次。
         */
        post: operations["submit_grade_turns_api_grade_turns__student_id__post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/graph/deps/{kp_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Graph Deps
         * @description 查一个知识点的前置/后继。
         *
         *     - 知识点不存在 → **404**（不返回空数组：空数组看起来像「这个点没有邻居」，
         *       而实际上可能是 kp_id 拼错了，两者必须区分开）；
         *     - 深度上限由 :data:`app.knowledge.deps.MAX_DEPTH_LIMIT` 卡死（元数据笔误成环也不会挂）。
         *
         *     ★ 返回结构里带 ``depth`` 与 ``direction``：前端画邻域图与排序都要用，
         *     调用方也就不必自己再走一遍图。
         */
        get: operations["graph_deps_api_graph_deps__kp_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/profile/{student_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 画像与掌握度
         * @description 读某学生的画像：基本身份 + 掌握度 + 偏好（+ 依赖图推荐，票 20 填充）。
         *
         *     - 学生不存在 → **404**（空画像会让学生以为「我没学过任何东西」，两者必须区分）；
         *     - ``studentId`` 非法 → **422**（它会被拼进文件系统路径）；
         *     - 库读写失败 → **503**（可读中文；上层 Tool 会把它转成 `error` 事件而不是崩）。
         */
        get: operations["student_profile_api_profile__student_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/profile/{student_id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 学习记录写入（答题/代码/动画观看/答疑）
         * @description 把一条结构化学习记录写进该学生的 ``learning.db``。
         *
         *     冷启动兜底：学生行不存在时按请求里的学段（缺省 ``primary_high``）建一条 ——
         *     「学生还没登录就先产生了学习记录」不该丢数据，也不该 500。
         */
        post: operations["record_learning_event_api_profile__student_id__events_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/quiz/bank/{kp_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 按知识点 + 学段取题（剔除 answer）
         * @description 取题（供练习 Extension 的 ``generate_quiz`` Tool 调用）。
         *
         *     - 本题库**按学段分文件**，因此学段是必填参数；只允许取**不高于**学生学段的题；
         *     - 返回体是 :class:`QuizPayload`，``questions`` 全是 :class:`QuizQuestionOut`
         *       （**结构上没有 ``answer``**，不是靠 ``exclude`` 临时裁的）；
         *     - 取不到题 → **404** + 可读中文（``questions: []`` 看起来像「这个知识点没题」，
         *       与「kpId 拼错了」分不开，所以不用空数组表达失败）；
         *     - 题库目录不存在/坏题多 → 不算错误：返回 404，由编排层决定改用 LLM 生成（票 15）。
         */
        get: operations["get_quiz_bank_api_quiz_bank__kp_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/quiz/grade": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 提交答案并批改（客观题规则判分）
         * @description 按 ``qid`` 查库判分，并把结果写进该学生的 ``learning.db``。
         *
         *     写入两处（都是结构化数据，**不写对话正文**）：
         *       - ``mastery``：``score`` / ``attempts`` / ``correct`` / ``last_seen_at``；
         *       - ``learning_history``：一条 ``activity="quiz"`` 记录（票 20 的个性化闭环要吃它）。
         *
         *     ``mastery_delta`` 回传的是**实际生效**的变化量（``新值 - 旧值``）：已经满分时再答对就是 0，
         *     而不是回一个没发生的 ``+0.15``（否则前端进度条会虚涨）。
         */
        post: operations["grade_quiz_api_quiz_grade_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/rag/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rag Search
         * @description 按学段检索教材片段。
         *
         *     :param body: ``{query, gradeLevel, topK?, allowCompat?, includeExpansion?}``
         *         - ``gradeLevel``：学生当前学段（**显式选择优先**），学段隔离在 SQL 层按它执行；
         *         - ``allowCompat``：是否允许取用更低学段的内容（命中标 ``compat=true``）；
         *         - ``includeExpansion``：是否把依赖图里的前置知识点补进上下文（有数量上限）。
         *
         *     响应里的 ``hits`` 带父块正文（注入 LLM 的上下文），``context`` 是拼好的可直接投喂文本，
         *     ``degraded`` 说明本次落在降级链的哪一级（vector → cloud → fts → outline）。
         */
        post: operations["rag_search_api_rag_search_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 读设置（Key 只回掩码） */
        get: operations["read_settings_api_settings_get"];
        /**
         * 存设置
         * @description 保存设置。
         *
         *     ``apiKey`` 提交空串或掩码（``…abcd``）**不会**抹掉已存 Key —— 用户没动这一栏时
         *     前端会把读回来的掩码原样提交；只有 ``clearApiKey=true`` 才删除。
         *     两栏都可省略（= 不动那一栏），但至少要提交一栏。
         */
        put: operations["update_settings_api_settings_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/probe": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 探测 LLM 连通性（票 07 实现）
         * @description 真实连通性探测（票 07 落地）：``GET {baseUrl}/models``，必要时补一条 1-token 对话请求。
         *
         *     ★ **BaseURL 的 `/v1` 陷阱**：默认值历史上是 ``https://api.deepseek.com/v1``（OpenAI 兼容习惯），
         *     而 Pi 内置 DeepSeek provider 用的是 ``https://api.deepseek.com``（**无 `/v1`**）。
         *     两者都可能连通、也都可能只有一种能连通，所以这里**不自动改写**用户填的值：
         *     先原样探测（探测的就是「保存后会用的那个地址」），只有在**路径不存在**（404/405）时才拿
         *     另一种写法做一次诊断，并在失败原因里明确告诉用户该改成哪一个。
         *
         *     探测的是**提交的候选配置**（先探测、满意再保存）；Key 提交掩码/空串时用已存 Key。
         *     **探测失败不阻塞保存**（断网/离线演示仍要能存配置），失败原因一律是可读中文。
         */
        post: operations["probe_settings_api_settings_probe_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/students": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 学生列表 */
        get: operations["list_students_api_students_get"];
        put?: never;
        /**
         * 新建学生（含学段）
         * @description 新建学生。请求体校验（含四学段字面量）由契约模型完成，非法学段直接 422。
         *
         *     落盘位置：``<userData>/students/<id>/learning.db``（一人一库，§8.2）。
         */
        post: operations["create_student_api_students_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Health
         * @description 存活探针。
         *
         *     ``embedder_ready`` 为假**不代表 sidecar 不健康** —— 模型缺失时应用仍应能起来，
         *     只是检索会走降级链（FTS5 → 大纲）。所以这里不因缺模型而报错。
         */
        get: operations["health_health_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /**
         * AnimationPayload
         * @description 动画讲解载荷（§11.2：**模板优先**，自由生成只是补充路径）。
         */
        AnimationPayload: {
            /** Concept */
            concept: string;
            /** Durationms */
            durationMs: number;
            /**
             * Fallbackimage
             * @default null
             */
            fallbackImage: string | null;
            /** Fallbacktext */
            fallbackText: string;
            /** Html */
            html: string;
            /**
             * Source
             * @enum {string}
             */
            source: "template" | "generated";
        };
        /**
         * ChatRequest
         * @description 一轮对话请求（**渲染进程 → 主进程 IPC**，不是 HTTP 端点）。
         *
         *     §6.3 v2 变更：``POST /api/chat/stream`` 已从 Python 侧移除，对话改由主进程的
         *     Pi Agent 处理；这里冻结的是 IPC 入参形状，供票 05/06 的主进程处理器与前端共用。
         *     ``requestId`` 由**主进程**生成并贯穿一轮（§9.4），所以不在请求体里。
         */
        ChatRequest: {
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /**
             * Sessionid
             * @default null
             */
            sessionId: string | null;
            /** Studentid */
            studentId: string;
            /** Text */
            text: string;
        };
        /**
         * Citation
         * @description 检索命中的引用条目（§6.4 的 `citation` 事件载荷，**字段与顺序冻结**）。
         *
         *     ``compat``：是否为「向上兼容」取用的更高学段内容 —— 跨学段时必须显式标注，
         *     前端要据此显示标记（执行文档 §6.3 / 业务陷阱清单 §2）。
         *
         *     ⚠️ **只有这 5 个字段**：事件载荷「一字不改」是票 13 的验收口径。
         *     检索内部还需要父块正文、相关性、知识点 id 等 —— 那些在 :class:`RagHit` 里，
         *     发射 `citation` 事件时**从 hit 投影出这 5 个字段**，不要把 hit 直接塞进事件。
         */
        Citation: {
            /** Chaptertitle */
            chapterTitle: string;
            /** Chunkid */
            chunkId: string;
            /** Compat */
            compat: boolean;
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /** Sectiontitle */
            sectionTitle: string;
        };
        /**
         * CodeError
         * @description 归一化后的代码错误（面向学生）。原始 traceback 保留供家长/教师导出与排查。
         */
        CodeError: {
            /**
             * Line
             * @default null
             */
            line: number | null;
            /** Message */
            message: string;
            /**
             * Rawtraceback
             * @default
             */
            rawTraceback: string;
            /** Type */
            type: string;
        };
        /**
         * CodeEvaluation
         * @description ``POST /api/code/run-hint`` 的响应：运行结果 + 评估 + 下一级提示（§6.3）。
         */
        CodeEvaluation: {
            /** @default null */
            error: components["schemas"]["CodeError"] | null;
            /** Feedback */
            feedback: string;
            /** @default null */
            nextHint: components["schemas"]["CodingHint"] | null;
            /** Ok */
            ok: boolean;
            /** Stdout */
            stdout: string;
        };
        /**
         * CodeRunRequest
         * @description ``POST /api/code/run-hint`` 的请求体：把「提交的代码 + 报错」交给后端评估。
         *
         *     ⚠️ 学生代码**绝不在主进程（Pi Extension）执行**：它在渲染进程的 Pyodide Worker 里跑，
         *     这里收到的只是运行结果与 traceback（AGENTS §5.7）。
         */
        CodeRunRequest: {
            /**
             * Attempt
             * @default 1
             */
            attempt: number;
            /** Code */
            code: string;
            /** Kpid */
            kpId: string;
            /**
             * Language
             * @default python
             * @constant
             */
            language: "python";
            /**
             * Stderr
             * @default
             */
            stderr: string;
            /**
             * Stdout
             * @default
             */
            stdout: string;
            /** Studentid */
            studentId: string;
        };
        /**
         * CodeTemplate
         * @description 编程模板载荷（§11.3 / 票 19）。``scaffold`` 必须含明确的 TODO 标记。
         */
        CodeTemplate: {
            /** Expectedbehavior */
            expectedBehavior: string;
            /** Kpid */
            kpId: string;
            /**
             * Language
             * @default python
             * @constant
             */
            language: "python";
            /** Scaffold */
            scaffold: string;
        };
        /**
         * CodingHint
         * @description 分级提示（票 19：**不许直接给答案**，level 1 指方向 → level 3 才贴近骨架）。
         */
        CodingHint: {
            /** Hint */
            hint: string;
            /**
             * Level
             * @enum {integer}
             */
            level: 1 | 2 | 3;
        };
        /**
         * Degraded
         * @enum {string}
         */
        Degraded: "vector" | "cloud" | "fts" | "outline";
        /**
         * DepNode
         * @description 依赖图查询结果条目（``GET /api/graph/deps/{kp_id}``）。
         *
         *     **`from → to` 语义全项目一致：`from` 是前置、`to` 是后继。**
         *     ``direction`` 显式标明这条边相对被查询知识点是哪一侧，双用途据此分流：
         *     ``successor`` 用于推荐路径，``prereq`` 用于检索上下文扩展。
         */
        DepNode: {
            /**
             * Depth
             * @default 1
             */
            depth: number;
            /**
             * Direction
             * @enum {string}
             */
            direction: "successor" | "prerequisite";
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /** Kpid */
            kpId: string;
            /** Name */
            name: string;
            /**
             * Relation
             * @default prerequisite
             * @enum {string}
             */
            relation: "prerequisite" | "related";
            /**
             * Weight
             * @default 1
             */
            weight: number;
        };
        /**
         * EmbeddingConfig
         * @description 嵌入配置的**出参形态**（§6.2）。``mode="none"`` 表示不用嵌入（检索走 FTS5 兜底）。
         */
        EmbeddingConfig: {
            /**
             * Apikey
             * @default
             */
            apiKey: string;
            /** Baseurl */
            baseUrl?: string | null;
            /**
             * Haskey
             * @default false
             */
            hasKey: boolean;
            /**
             * Mode
             * @default local_fastembed
             * @enum {string}
             */
            mode: "local_fastembed" | "cloud_api" | "none";
            /** Modelid */
            modelId?: string | null;
        };
        /**
         * EmbeddingConfigIn
         * @description 嵌入配置的**入参形态**（``mode="cloud_api"`` 时才有 base_url/api_key/model_id）。
         */
        EmbeddingConfigIn: {
            /**
             * Apikey
             * @default
             */
            apiKey: string;
            /** Baseurl */
            baseUrl?: string | null;
            /**
             * Clearapikey
             * @default false
             */
            clearApiKey: boolean;
            /** Haskey */
            hasKey?: boolean | null;
            /**
             * Mode
             * @default local_fastembed
             * @enum {string}
             */
            mode: "local_fastembed" | "cloud_api" | "none";
            /** Modelid */
            modelId?: string | null;
        };
        /**
         * EmbeddingMode
         * @enum {string}
         */
        EmbeddingMode: "local_fastembed" | "cloud_api" | "none";
        /**
         * GradeEvaluationOut
         * @description 一轮的判定结论（演示脚本与报告直接用它叙述「第 N 轮为什么没改」）。
         */
        GradeEvaluationOut: {
            /** Changed */
            changed: boolean;
            /** Confidence */
            confidence: number;
            /** Direction */
            direction: number;
            /**
             * Grade
             * @enum {string}
             */
            grade: "primary_low" | "primary_high" | "junior" | "senior";
            /** Reason */
            reason: string;
            /** Streak */
            streak: number;
            /** Turn */
            turn: number;
        };
        /**
         * GradeHistoryEntry
         * @description ``grade_history`` 的一行（学段变化轨迹）。
         */
        GradeHistoryEntry: {
            /**
             * Confidence
             * @default 0
             */
            confidence: number;
            /** Fromlevel */
            fromLevel?: ("primary_low" | "primary_high" | "junior" | "senior") | null;
            /** Source */
            source: string;
            /**
             * Tolevel
             * @enum {string}
             */
            toLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /** Ts */
            ts: number;
            /** Turn */
            turn: number;
        };
        /**
         * GradeHistoryResponse
         * @description ``grade_history`` 轨迹（报告叙事：「第 3 轮调为小学低年级（0.75）」）。
         */
        GradeHistoryResponse: {
            /**
             * Currentlevel
             * @enum {string}
             */
            currentLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /** Entries */
            entries?: components["schemas"]["GradeHistoryEntry"][];
            /** Studentid */
            studentId: string;
        };
        /**
         * GradeLevel
         * @enum {string}
         */
        GradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
        /**
         * GradeProposalInput
         * @description 第二层 LLM 的**提议**（``{suggestedGrade, confidence}``）。
         *
         *     ★ 它只是提议：规则引擎可以采纳（同向时抬高置信度）、可以无视，也可以否决（反向）。
         */
        GradeProposalInput: {
            /** Confidence */
            confidence: number;
            /**
             * Note
             * @default
             */
            note: string;
            /**
             * Suggestedgrade
             * @enum {string}
             */
            suggestedGrade: "primary_low" | "primary_high" | "junior" | "senior";
        };
        /**
         * GradeSignal
         * @description 一条学段判定信号（§8.3 `grade_signals`）。
         */
        GradeSignal: {
            /** Raw */
            raw?: string | null;
            /**
             * Signaltype
             * @enum {string}
             */
            signalType: "vocab" | "depth" | "quiz_perf" | "meta_cognition";
            /** Ts */
            ts?: number | null;
            /** Value */
            value: number;
        };
        /**
         * GradeSignals
         * @description ``GET /api/grade/signals/{student_id}``：学段信号与推断建议。
         *
         *     ⚠️ **自动推断只写「建议」，不直接改**（AGENTS §5.1）：``suggested_level`` 供前端弹
         *     达到阈值时**自动生效**并写 `grade_history(source="inferred")`；
         *     学生端只读展示当前学段，**没有选择器、没有确认动作**（§10.3）。
         */
        GradeSignals: {
            /**
             * Confidence
             * @default 0
             */
            confidence: number;
            /**
             * Currentlevel
             * @enum {string}
             */
            currentLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /** Signals */
            signals?: components["schemas"]["GradeSignal"][];
            /**
             * Source
             * @default inferred
             * @constant
             */
            source: "inferred";
            /** Studentid */
            studentId: string;
            /** Suggestedlevel */
            suggestedLevel?: ("primary_low" | "primary_high" | "junior" | "senior") | null;
        };
        /**
         * GradeStateOut
         * @description 轻量状态（桌面端每轮取「当前学段」；不含信号列表）。
         */
        GradeStateOut: {
            /**
             * Confidence
             * @default 0
             */
            confidence: number;
            /**
             * Cooldownremainingturns
             * @default 0
             */
            cooldownRemainingTurns: number;
            /**
             * Direction
             * @default 0
             */
            direction: number;
            /**
             * Grade
             * @enum {string}
             */
            grade: "primary_low" | "primary_high" | "junior" | "senior";
            /** Lastchangeturn */
            lastChangeTurn?: number | null;
            /** Lastturn */
            lastTurn: number;
            /** Source */
            source: string;
            /**
             * Streak
             * @default 0
             */
            streak: number;
            /** Studentid */
            studentId: string;
            /** Suggestedlevel */
            suggestedLevel?: ("primary_low" | "primary_high" | "junior" | "senior") | null;
        };
        /**
         * GradeTurnInput
         * @description **一轮**证据：轮次号 + 学生原话 + （可选）答题表现与第二层提议。
         */
        GradeTurnInput: {
            proposal?: components["schemas"]["GradeProposalInput"] | null;
            quiz?: components["schemas"]["QuizPerformanceInput"] | null;
            /** Sessionid */
            sessionId?: string | null;
            /**
             * Text
             * @default
             */
            text: string;
            /** Turn */
            turn: number;
        };
        /**
         * GradeTurnResponse
         * @description 上交证据后的判定结果（**服务端决策**，桌面端只负责按它换下一轮的 prompt）。
         */
        GradeTurnResponse: {
            /** Changed */
            changed: boolean;
            /** Confidence */
            confidence: number;
            /** Cooldownremainingturns */
            cooldownRemainingTurns: number;
            /** Degraded */
            degraded?: string | null;
            /** Direction */
            direction: number;
            /** Evaluations */
            evaluations?: components["schemas"]["GradeEvaluationOut"][];
            /**
             * Grade
             * @enum {string}
             */
            grade: "primary_low" | "primary_high" | "junior" | "senior";
            /** Llmconfidence */
            llmConfidence?: number | null;
            /**
             * Previousgrade
             * @enum {string}
             */
            previousGrade: "primary_low" | "primary_high" | "junior" | "senior";
            /** Reason */
            reason: string;
            /** Ruleconfidence */
            ruleConfidence: number;
            /** Signals */
            signals?: components["schemas"]["GradeSignal"][];
            /** Source */
            source: string;
            /** Streak */
            streak: number;
            /** Studentid */
            studentId: string;
            /** Turn */
            turn: number;
        };
        /**
         * GradeTurnsRequest
         * @description ``POST /api/grade/turns/{student_id}`` 的请求体（**一批轮次证据**，按轮次升序）。
         */
        GradeTurnsRequest: {
            /** Turns */
            turns: components["schemas"]["GradeTurnInput"][];
        };
        /** HTTPValidationError */
        HTTPValidationError: {
            /** Detail */
            detail?: components["schemas"]["ValidationError"][];
        };
        /**
         * HealthResponse
         * @description ``GET /health`` 响应（执行文档 §6.3）。
         *
         *     免鉴权，Electron 启动期轮询它判断 sidecar 是否可用。
         *     ``embedder_ready`` 为假**不代表 sidecar 不健康** —— 模型缺失时应用仍应能起来，
         *     只是检索会走降级链。
         */
        HealthResponse: {
            /** Embedderready */
            embedderReady: boolean;
            /** Status */
            status: string;
            /** Version */
            version: string;
        };
        /**
         * IpcEventName
         * @enum {string}
         */
        IpcEventName: "delta" | "citation" | "payload" | "blocked" | "done" | "error";
        /**
         * LearningActivity
         * @enum {string}
         */
        LearningActivity: "qa" | "animation" | "coding" | "quiz";
        /**
         * LearningEventAck
         * @description 学习记录写入的回执（§6.3：``{ok}``）。
         */
        LearningEventAck: {
            /**
             * Ok
             * @default true
             */
            ok: boolean;
        };
        /**
         * LearningEventRequest
         * @description ``POST /api/profile/{student_id}/events`` 的请求体（学习记录写入）。
         *
         *     由 ``learning-log`` Extension 构造，字段全部是**从对话里提取出来的结构化信息**：
         *     没有任何一个字段用于承载对话正文（这是有意的，见模块头）。
         */
        LearningEventRequest: {
            /**
             * Activity
             * @enum {string}
             */
            activity: "qa" | "animation" | "coding" | "quiz";
            /**
             * Detail
             * @default
             */
            detail: string;
            /** Gradelevel */
            gradeLevel?: ("primary_low" | "primary_high" | "junior" | "senior") | null;
            /** Iscorrect */
            isCorrect?: boolean | null;
            /**
             * Kpid
             * @default
             */
            kpId: string;
            /** Sessionid */
            sessionId?: string | null;
        };
        /**
         * LlmConfig
         * @description LLM 配置的**出参形态**（发给渲染进程 / 与磁盘一致的只读视图）。
         *
         *     ⚠️ ``api_key`` 在这里**恒为掩码**（``…abcd``）或空串，绝不会是明文；
         *     需要明文的地方只有存储层，用 {@link LlmConfigIn} 提交。
         *     **请一律经 :meth:`from_plain` 构造**，别手拼 ``api_key=`` 把明文漏出去。
         */
        LlmConfig: {
            /**
             * Apikey
             * @default
             */
            apiKey: string;
            /**
             * Baseurl
             * @default https://api.deepseek.com/v1
             */
            baseUrl: string;
            /**
             * Haskey
             * @default false
             */
            hasKey: boolean;
            /**
             * Modelid
             * @default deepseek-chat
             */
            modelId: string;
            /**
             * Providername
             * @default DeepSeek
             */
            providerName: string;
        };
        /**
         * LlmConfigIn
         * @description LLM 配置的**入参形态**（``PUT /api/settings``）。
         *
         *     ``api_key`` 语义见模块头的「API Key 掩码语义」：
         *     空串/掩码/纯符号 = 保留已存值；明文 = 覆盖；``clear_api_key=true`` = 显式删除。
         */
        LlmConfigIn: {
            /**
             * Apikey
             * @default
             */
            apiKey: string;
            /**
             * Baseurl
             * @default https://api.deepseek.com/v1
             */
            baseUrl: string;
            /**
             * Clearapikey
             * @default false
             */
            clearApiKey: boolean;
            /** Haskey */
            hasKey?: boolean | null;
            /**
             * Modelid
             * @default deepseek-chat
             */
            modelId: string;
            /**
             * Providername
             * @default DeepSeek
             */
            providerName: string;
        };
        /**
         * Mastery
         * @description 单知识点掌握度（§8.3 `mastery`）。``score`` 0..1。
         */
        Mastery: {
            /**
             * Attempts
             * @default 0
             */
            attempts: number;
            /**
             * Correct
             * @default 0
             */
            correct: number;
            /** Kpid */
            kpId: string;
            /** Lastseenat */
            lastSeenAt?: number | null;
            /**
             * Score
             * @default 0
             */
            score: number;
        };
        /**
         * PayloadKind
         * @enum {string}
         */
        PayloadKind: "animation" | "coding" | "quiz";
        /**
         * ProbeRequest
         * @description ``POST /api/settings/probe`` 的请求体（**票 07 实现探测**）。
         *
         *     探测的是**提交的候选配置**而非已存配置，这样「先探测、满意再保存」才成立。
         *     ``api_key`` 允许是占位（== 用已存 Key）——实现方用 :func:`resolve_api_key` 解析。
         */
        ProbeRequest: {
            llm: components["schemas"]["LlmConfigIn"];
        };
        /**
         * ProbeResult
         * @description ``POST /api/settings/probe`` 的响应（§6.3）。
         *
         *     ``message`` 必须**可读**：401 / 超时 / DNS / 404 要说清是哪一种（票 07）。
         */
        ProbeResult: {
            /** Message */
            message: string;
            /** Ok */
            ok: boolean;
        };
        /**
         * ProgressStage
         * @enum {string}
         */
        ProgressStage: "locked" | "learning" | "quizzed" | "mastered";
        /**
         * QuizGradeRequest
         * @description ``POST /api/quiz/grade`` 的请求体：提交答案并批改（判分只走后端）。
         */
        QuizGradeRequest: {
            /** Answer */
            answer: string | string[];
            /** Qid */
            qid: string;
            /** Sessionid */
            sessionId?: string | null;
            /** Studentid */
            studentId: string;
        };
        /**
         * QuizPayload
         * @description 出题载荷。``questions`` **一律是对外形态**，内部模型塞不进来（会被类型校验挡住）。
         */
        QuizPayload: {
            /** Kpid */
            kpId: string;
            /** Questions */
            questions?: components["schemas"]["QuizQuestionOut"][];
            /**
             * Source
             * @enum {string}
             */
            source: "bank" | "generated";
        };
        /**
         * QuizPerformanceInput
         * @description 答题表现（从 ``learning.db`` 读出来的结构化摘要，由桌面端带上来）。
         *
         *     **不带题干与作答正文**，只有数字 —— 与 ``learning_history`` 的口径一致。
         */
        QuizPerformanceInput: {
            /**
             * Attempts
             * @default 0
             */
            attempts: number;
            /**
             * Correct
             * @default 0
             */
            correct: number;
            /**
             * Currentstreak
             * @default 0
             */
            currentStreak: number;
            /**
             * Hintsrequested
             * @default 0
             */
            hintsRequested: number;
            /**
             * Toohard
             * @default false
             */
            tooHard: boolean;
        };
        /**
         * QuizQuestionOut
         * @description ★ **对外模型**：没有 ``answer``，发给 TS 与前端（§6.3 答案泄漏防护）。
         *
         *     判分所需的标准答案只留在 Python 侧：``POST /api/quiz/grade`` 按 ``qid`` 查库判分，
         *     前端与 TS 都不需要答案。
         */
        QuizQuestionOut: {
            /** Explanation */
            explanation: string;
            /** Kpid */
            kpId: string;
            /** Options */
            options?: string[] | null;
            /** Qid */
            qid: string;
            /** Stem */
            stem: string;
            /**
             * Type
             * @enum {string}
             */
            type: "choice" | "blank" | "code_blank";
        };
        /**
         * QuizQuestionType
         * @enum {string}
         */
        QuizQuestionType: "choice" | "blank" | "code_blank";
        /**
         * QuizResult
         * @description 批改结果（§6.5）。``scored_by`` 区分客观题规则判分与主观题 LLM 判分。
         */
        QuizResult: {
            /** Correct */
            correct: boolean;
            /** Feedback */
            feedback: string;
            /** Masterydelta */
            masteryDelta: number;
            /** Qid */
            qid: string;
            /**
             * Scoredby
             * @enum {string}
             */
            scoredBy: "rule" | "llm";
        };
        /**
         * RagHit
         * @description 检索命中的**完整记录**（HTTP 层，供 `rag_search` Tool 注入上下文与轨迹图）。
         *
         *     在 :class:`Citation` 的 5 个冻结字段之上补齐内部字段。父块正文在这里
         *     （父子 chunk：小子块检索、命中回父块作上下文，§8.3），不要塞进 `Citation`。
         */
        RagHit: {
            /** Chaptertitle */
            chapterTitle: string;
            /** Chunkid */
            chunkId: string;
            /** Compat */
            compat: boolean;
            /**
             * Degraded
             * @default vector
             * @enum {string}
             */
            degraded: "vector" | "cloud" | "fts" | "outline";
            /**
             * Expanded
             * @default false
             */
            expanded: boolean;
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /**
             * Knowledgepoint
             * @default
             */
            knowledgePoint: string;
            /**
             * Kpid
             * @default
             */
            kpId: string;
            /** Parentchunkid */
            parentChunkId?: string | null;
            /**
             * Score
             * @default 0
             */
            score: number;
            /** Sectiontitle */
            sectionTitle: string;
            /**
             * Text
             * @default
             */
            text: string;
        };
        /**
         * RagSearchRequest
         * @description ``POST /api/rag/search`` 的请求体（供 Pi 的 `rag_search` Tool 调用）。
         *
         *     ``grade_level`` 是**必填**：学段过滤写在 SQL 层，模型改不了 WHERE（AGENTS §5.2）。
         */
        RagSearchRequest: {
            /**
             * Allowcompat
             * @default true
             */
            allowCompat: boolean;
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /**
             * Includeexpansion
             * @default true
             */
            includeExpansion: boolean;
            /** Query */
            query: string;
            /**
             * Topk
             * @default 5
             */
            topK: number;
        };
        /**
         * RagSearchResult
         * @description ``POST /api/rag/search`` 的响应。
         *
         *     降级链整条在 Python 侧一次调用内完成（§8.5）：调用方只读 ``degraded``，
         *     **不要**在编排层再实现一遍降级逻辑。
         */
        RagSearchResult: {
            /**
             * Context
             * @default
             */
            context: string;
            /**
             * Degraded
             * @default vector
             * @enum {string}
             */
            degraded: "vector" | "cloud" | "fts" | "outline";
            /** Hits */
            hits?: components["schemas"]["RagHit"][];
        };
        /**
         * SettingsResponse
         * @description ``GET`` / ``PUT /api/settings`` 的响应（§6.3）。**任何情况下都不含明文 Key。**
         */
        SettingsResponse: {
            embedding: components["schemas"]["EmbeddingConfig"];
            llm: components["schemas"]["LlmConfig"];
        };
        /**
         * SettingsUpdateRequest
         * @description ``PUT /api/settings`` 的请求体。
         *
         *     两栏都可省略（``null`` = 不动那一栏）—— 设置页可以分栏保存；
         *     但**不能两栏都不给**（那样这次请求没有任何意义）。
         */
        SettingsUpdateRequest: {
            embedding?: components["schemas"]["EmbeddingConfigIn"] | null;
            llm?: components["schemas"]["LlmConfigIn"] | null;
        };
        /**
         * Student
         * @description 一名学生。**一人一库**（``students/<student_id>/learning.db``），不跨学生复用连接。
         */
        Student: {
            /** Createdat */
            createdAt: number;
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /** Lastactiveat */
            lastActiveAt: number;
            /** Nickname */
            nickname: string;
            /** Studentid */
            studentId: string;
        };
        /**
         * StudentCreateRequest
         * @description ``POST /api/students``：新建学生（含学段，学段也可后改）。``student_id`` 由服务端生成。
         */
        StudentCreateRequest: {
            /**
             * Gradelevel
             * @enum {string}
             */
            gradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
            /** Nickname */
            nickname: string;
        };
        /**
         * StudentProfile
         * @description ``GET /api/profile/{student_id}``：画像与掌握度（§6.3）。
         *
         *     ``recommended_kp_ids`` 由依赖图 + 掌握度算出（§8.6 用途一，票 12/20 填充）——
         *     **推荐必须来自依赖图**，不是随机取或按顺序取下一个。
         */
        StudentProfile: {
            /** Mastery */
            mastery?: components["schemas"]["Mastery"][];
            /** Preferences */
            preferences?: {
                [key: string]: string;
            };
            /** Recommendedkpids */
            recommendedKpIds?: string[];
            student: components["schemas"]["Student"];
        };
        /** ValidationError */
        ValidationError: {
            /** Context */
            ctx?: Record<string, never>;
            /** Input */
            input?: unknown;
            /** Location */
            loc: (string | number)[];
            /** Message */
            msg: string;
            /** Error Type */
            type: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    grade_history_api_grade_history__student_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                student_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GradeHistoryResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    grade_signals_api_grade_signals__student_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                student_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GradeSignals"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    grade_state_api_grade_state__student_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                student_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GradeStateOut"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    submit_grade_turns_api_grade_turns__student_id__post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                student_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GradeTurnsRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GradeTurnResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    graph_deps_api_graph_deps__kp_id__get: {
        parameters: {
            query?: {
                /** @description successor=后继（推荐路径）/ prerequisite=前置（检索扩展）/ both */
                direction?: "successor" | "prerequisite" | "both";
                /** @description 递归深度上限（防环死循环） */
                max_depth?: number;
            };
            header?: never;
            path: {
                kp_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DepNode"][];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    student_profile_api_profile__student_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                student_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StudentProfile"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    record_learning_event_api_profile__student_id__events_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                student_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LearningEventRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LearningEventAck"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_quiz_bank_api_quiz_bank__kp_id__get: {
        parameters: {
            query?: {
                /** @description 学生学段（四学段之一，必填） */
                grade_level?: string | null;
                /** @description 取几道题 */
                count?: number;
                /** @description 题目不足时是否允许取用更低学段的题 */
                allow_compat?: boolean;
            };
            header?: never;
            path: {
                kp_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["QuizPayload"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    grade_quiz_api_quiz_grade_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["QuizGradeRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["QuizResult"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    rag_search_api_rag_search_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RagSearchRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RagSearchResult"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    read_settings_api_settings_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SettingsResponse"];
                };
            };
        };
    };
    update_settings_api_settings_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SettingsUpdateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SettingsResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    probe_settings_api_settings_probe_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ProbeRequest"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProbeResult"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_students_api_students_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Student"][];
                };
            };
        };
    };
    create_student_api_students_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StudentCreateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Student"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    health_health_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HealthResponse"];
                };
            };
        };
    };
}
