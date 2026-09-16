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
         * @description ⚠️ **票 04 不实现探测**：真实连通性探测（``GET /models`` / 1-token 请求 +
         *     可读失败原因）属票 07。
         *
         *     这里**返回 501 而不是造一个 ``{ok:false}``** —— 假结果会被设置页当成
         *     「用户填错了」显示，比没实现更糟（执行文档 §6.2 明确要求真实探测）。
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
         * GradeLevel
         * @enum {string}
         */
        GradeLevel: "primary_low" | "primary_high" | "junior" | "senior";
        /**
         * GradeSignal
         * @description 一条学段判定信号（§8.3 `grade_signals`）。
         */
        GradeSignal: {
            /**
             * Raw
             * @default null
             */
            raw: string | null;
            /**
             * Signaltype
             * @enum {string}
             */
            signalType: "vocab" | "depth" | "quiz_perf" | "meta_cognition";
            /**
             * Ts
             * @default null
             */
            ts: number | null;
            /** Value */
            value: number;
        };
        /**
         * GradeSignals
         * @description ``GET /api/grade/signals/{student_id}``：学段信号与推断建议。
         *
         *     ⚠️ **自动推断只写「建议」，不直接改**（AGENTS §5.1）：``suggested_level`` 供前端弹
         *     建议条，学生确认后才写 `grade_history(source=confirmed)`。
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
             * @default explicit
             * @enum {string}
             */
            source: "explicit" | "inferred" | "confirmed";
            /** Studentid */
            studentId: string;
            /**
             * Suggestedlevel
             * @default null
             */
            suggestedLevel: ("primary_low" | "primary_high" | "junior" | "senior") | null;
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
            /**
             * Lastseenat
             * @default null
             */
            lastSeenAt: number | null;
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
            /**
             * Sessionid
             * @default null
             */
            sessionId: string | null;
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
            /**
             * Options
             * @default null
             */
            options: string[] | null;
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
