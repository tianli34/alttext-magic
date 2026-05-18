# AI 模型调用耗时记录 — 需求与设计方案

---

## 一、需求定义

### 1.1 目标

记录每个模型每次调用的耗时，用于性能统计与分析。

### 1.2 耗时定义

| 项目 | 定义 |
|---|---|
| **计时起点** | HTTP/SDK 请求即将发出前（请求体组装完毕之后） |
| **成功计时终点** | 收到模型响应并完成最小必要解析（如 `response.json()`、取出 `content` 字段） |
| **失败计时终点** | 收到失败响应 / 超时 / 异常抛出时 |

#### 计时边界的排除项

以下开销**不计入**耗时：

- 请求发出**前**：prompt 拼装、参数转换、schema 构建、图片预处理、本地校验
- 响应收到**后**：业务字段映射、二次清洗、正则修复、重组等后处理
- **外层链路**开销：fallback 切换、gateway 路由、processor 调度

#### 计时边界的包含项

以下开销**计入**耗时：

- 网络传输（DNS / TCP / TLS / 排队）
- 模型推理处理
- 响应体读取与最小必要解析（`await response.json()`、成功/失败判断）

### 1.3 失败分类

失败记录必须区分故障来源，因为非模型服务端原因的失败不具有统计价值：

| 分类 | 标识 | 含义 | 统计价值 | 典型场景 |
|---|---|---|---|---|
| 模型服务端失败 | `SERVER` | 模型提供商一侧的原因 | ✅ 有 | 5xx 响应、模型过载、速率限制、内容过滤拒绝、模型返回格式异常 |
| 非模型服务端失败 | `NON_SERVER` | 己方或中间环节的原因 | ❌ 无 | 己方网络中断、DNS 解析失败、连接被中间环节重置、己方主动 abort |

> 超时（timeout）的归类需按具体情况判断：若请求已送达模型服务端但未在限定时间内回复，归为 `SERVER`；若请求未能送达（如连接超时），归为 `NON_SERVER`。

### 1.4 调用粒度

**每次实际 HTTP 请求记录一条**。若 provider 内部存在重试机制，每次重试独立记录，例如：

```
第 1 次请求 → timeout → 记录: FAILED, 3000ms
第 2 次请求 → success → 记录: SUCCESS, 800ms
```

> 若当前实现中不存在 provider 内部重试，此条款暂不适用，但数据结构应预留支持。

---

## 二、设计方案

### 2.1 数据模型

```prisma
model AiModelCall {
  id            String   @id @default(cuid())
  shopId        String   @map("shop_id")
  candidateId   String?  @map("candidate_id")
  batchId       String?  @map("batch_id")
  modelName     String   @map("model_name")      // e.g. "openai/gpt-4o", "anthropic/claude-3"
  durationMs    Int      @map("duration_ms")      // 计时边界内的耗时
  status        String   @map("status")           // "SUCCESS" | "FAILED"
  failureOrigin String?  @map("failure_origin")   // "SERVER" | "NON_SERVER" (仅 FAILED 时有值)
  errorMessage  String?  @map("error_message")
  createdAt     DateTime @default(now()) @map("created_at")

  @@index([modelName])
  @@index([shopId])
  @@map("ai_model_call")
}
```

### 2.2 类型定义

```typescript
export interface ModelCallRecord {
  modelName: string;
  durationMs: number;
  status: "SUCCESS" | "FAILED";
  failureOrigin?: "SERVER" | "NON_SERVER"; // 仅 FAILED 时填写
  errorMessage?: string;
}
```

在现有类型上扩展：

```typescript
export interface GenerateAltResult {
  altText: string;
  modelUsed: string;
  modelCalls: ModelCallRecord[];  // 新增
}

export class AIGenerationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly modelCalls?: ModelCallRecord[],  // 新增
  ) {
    super(message);
  }
}
```

### 2.3 各层职责

```
┌─────────────────────────────────────────────────────────────┐
│  Processor                                                  │
│  ● 从 result / error 中取出 modelCalls                      │
│  ● 调用 persistModelCalls() 写入 ai_model_call 表            │
│  ● 不做计时                                                  │
├─────────────────────────────────────────────────────────────┤
│  AIGatewayService                                           │
│  ● 纯透传，不做计时                                           │
├─────────────────────────────────────────────────────────────┤
│  FallbackProvider                                           │
│  ● 不自行计时                                                │
│  ● 收集 primary / secondary 返回的 modelCalls，聚合后上传      │
├─────────────────────────────────────────────────────────────┤
│  具体 Provider (OpenAICompatible / Fake / ...)              │
│  ● 唯一计时层                                                │
│  ● 计时边界：请求体组装完毕后 → 响应接收及最小必要解析完毕        │
│  ● 成功时通过 GenerateAltResult.modelCalls 返回               │
│  ● 失败时通过 AIGenerationError.modelCalls 抛出               │
│  ● 负责判定 failureOrigin                                    │
└─────────────────────────────────────────────────────────────┘
```

### 2.4 Provider 内部计时实现

```typescript
// 具体 Provider 伪代码
async generateAlt(request: GenerateAltRequest): Promise<GenerateAltResult> {
  // ① 请求体组装（不计时）
  const payload = this.buildPayload(request);

  // ② 计时区间开始
  const start = Date.now();
  let response: Response;
  try {
    response = await fetch(this.endpoint, {
      method: "POST",
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  } catch (err) {
    const durationMs = Date.now() - start;
    // 网络错误、连接失败、客户端超时等 → NON_SERVER
    // 但需根据错误类型进一步判断
    const failureOrigin = this.classifyNetworkError(err);
    throw new AIGenerationError("Request failed", err, [
      { modelName: this.modelName, durationMs, status: "FAILED", failureOrigin, errorMessage: String(err) },
    ]);
  }

  if (!response.ok) {
    const durationMs = Date.now() - start;
    // HTTP 错误响应 → 通常为 SERVER
    const failureOrigin = this.classifyHttpError(response.status);
    throw new AIGenerationError(`HTTP ${response.status}`, undefined, [
      { modelName: this.modelName, durationMs, status: "FAILED", failureOrigin, errorMessage: `HTTP ${response.status}` },
    ]);
  }

  // ③ 最小必要解析（计入耗时）
  const body = await response.json();
  const altText = body.choices?.[0]?.message?.content;
  const durationMs = Date.now() - start;
  // ④ 计时区间结束

  // ⑤ 业务后处理（不计时）
  const cleaned = this.postProcess(altText);

  return {
    altText: cleaned,
    modelUsed: this.modelName,
    modelCalls: [
      { modelName: this.modelName, durationMs, status: "SUCCESS" },
    ],
  };
}
```

### 2.5 失败来源判定逻辑

```typescript
// 网络层异常分类
private classifyNetworkError(err: unknown): "SERVER" | "NON_SERVER" {
  if (err instanceof TypeError) return "NON_SERVER";       // fetch 网络错误（DNS、连接拒绝等）
  if (err instanceof DOMException                          // AbortSignal.timeout 触发
      && err.name === "TimeoutError") return "SERVER";     // 请求已发出但超时未回复 → 归为 SERVER
  // 根据实际情况补充
  return "NON_SERVER";
}

// HTTP 响应状态码分类
private classifyHttpError(status: number): "SERVER" | "NON_SERVER" {
  // 5xx、429 → 模型服务端原因
  if (status >= 500 || status === 429) return "SERVER";
  // 4xx（除 429）→ 通常是请求方构造问题，但由模型服务端返回 → 仍归 SERVER
  if (status >= 400) return "SERVER";
  return "NON_SERVER";
}
```

> 以上分类规则为初始版本，可根据实际运行中的异常类型逐步细化。

### 2.6 FallbackProvider 聚合逻辑

```typescript
async generateAlt(request: GenerateAltRequest): Promise<GenerateAltResult> {
  const allCalls: ModelCallRecord[] = [];

  try {
    const result = await this.primary.generateAlt(request);
    allCalls.push(...result.modelCalls);
    return { ...result, modelCalls: allCalls };
  } catch (primaryErr) {
    if (primaryErr instanceof AIGenerationError && primaryErr.modelCalls) {
      allCalls.push(...primaryErr.modelCalls);
    }
  }

  try {
    const result = await this.secondary.generateAlt(request);
    allCalls.push(...result.modelCalls);
    return { ...result, modelCalls: allCalls };
  } catch (secondaryErr) {
    if (secondaryErr instanceof AIGenerationError && secondaryErr.modelCalls) {
      allCalls.push(...secondaryErr.modelCalls);
    }
    throw new AIGenerationError("All providers failed", secondaryErr, allCalls);
  }
}
```

### 2.7 Processor 持久化

```typescript
async function persistModelCalls(
  data: { shopId: string; candidateId?: string; batchId?: string },
  calls: ModelCallRecord[],
): Promise<void> {
  if (calls.length === 0) return;

  await prisma.aiModelCall.createMany({
    data: calls.map((c) => ({
      shopId: data.shopId,
      candidateId: data.candidateId,
      batchId: data.batchId,
      modelName: c.modelName,
      durationMs: c.durationMs,
      status: c.status,
      failureOrigin: c.failureOrigin ?? null,
      errorMessage: c.errorMessage ?? null,
    })),
  });
}
```

在 processor 的成功 / 失败路径中均调用：

```typescript
// 成功路径
const result = await aiGatewayService.generateAlt(req);
await persistModelCalls(data, result.modelCalls);

// 失败路径
catch (err) {
  if (err instanceof AIGenerationError && err.modelCalls) {
    await persistModelCalls(data, err.modelCalls);
  }
}
```

### 2.8 调用链示例

**场景 A：Primary 成功**
```
Processor
 └→ AIGatewayService.generateAlt()
     └→ FallbackProvider.generateAlt()
         └→ Primary (openai/gpt-4o)
             ├─ [请求体组装]          ← 不计时
             ├─ start = Date.now()
             ├─ fetch(...)           ← 计时中
             ├─ response.json()      ← 计时中
             ├─ durationMs = 1200ms
             └─ return modelCalls: [{ openai/gpt-4o, 1200ms, SUCCESS }]

 → persistModelCalls: 写入 1 条 (SUCCESS, 1200ms)
```

**场景 B：Primary 失败 → Secondary 成功**
```
Processor
 └→ AIGatewayService.generateAlt()
     └→ FallbackProvider.generateAlt()
         ├→ Primary (openai/gpt-4o)
         │   ├─ start = Date.now()
         │   ├─ fetch(...) → timeout 5000ms
         │   └─ throw AIGenerationError(modelCalls: [{ openai/gpt-4o, 5000ms, FAILED, SERVER }])
         │
         └→ Secondary (anthropic/claude-3)
             ├─ start = Date.now()
             ├─ fetch(...) → 800ms SUCCESS
             └─ return modelCalls: [{ anthropic/claude-3, 800ms, SUCCESS }]

 → FallbackProvider 聚合: [primary FAILED, secondary SUCCESS]
 → persistModelCalls: 写入 2 条
     ├─ openai/gpt-4o,     5000ms, FAILED,  failureOrigin=SERVER
     └─ anthropic/claude-3,  800ms, SUCCESS
```

**场景 C：失败且为非服务端原因**
```
Processor
 └→ Primary (openai/gpt-4o)
     ├─ start = Date.now()
     ├─ fetch(...) → DNS resolution failed, 50ms
     └─ throw AIGenerationError(modelCalls: [{ openai/gpt-4o, 50ms, FAILED, NON_SERVER }])

 → persistModelCalls: 写入 1 条 (FAILED, NON_SERVER)
 → 统计分析时可过滤 failureOrigin = "NON_SERVER" 的记录
```

---

## 三、要点总结

| 关注点 | 结论 |
|---|---|
| 谁负责计时 | 仅具体 Provider（OpenAICompatible 等） |
| 计时起点 | 请求体组装完毕后、`fetch` 调用前 |
| 计时终点 | 响应接收 + 最小必要解析完毕，或异常捕获时 |
| 失败分类 | 区分 `SERVER` / `NON_SERVER`，后者无统计价值 |
| 调用粒度 | 每次实际 HTTP 请求一条记录（含重试场景） |
| 聚合方式 | FallbackProvider 收集所有子 provider 的 `modelCalls`，不自行计时 |
| 传递方式 | 成功通过 `GenerateAltResult.modelCalls`，失败通过 `AIGenerationError.modelCalls` |
| 持久化时机 | Processor 在成功/失败路径统一调用 `persistModelCalls()` |