# OpenClaw VS Code 扩展 — 开发者指南

## 目录

1. [项目结构](#1-项目结构)
2. [构建说明](#2-构建说明)
3. [架构图](#3-架构图)
4. [如何添加自定义 A2UI 组件](#4-如何添加自定义-a2ui-组件)
5. [Gateway Protocol v3 消息参考](#5-gateway-protocol-v3-消息参考)

---

## 1. 项目结构

```
openclaw-acp/
├── src/
│   ├── extension.ts              # 扩展入口：注册命令、初始化各模块
│   ├── gateway/
│   │   ├── types.ts              # Gateway Protocol v3 类型定义
│   │   ├── client.ts             # GatewayClient：WebSocket 连接、重连、命令收发
│   │   └── router.ts             # MessageRouter：事件分发（含序号去重）
│   ├── vscode/
│   │   ├── chatProvider.ts       # ChatProvider：Chat Sidebar Webview（含会话管理）
│   │   ├── canvasPanel.ts        # CanvasPanel：Canvas/A2UI Webview Panel
│   │   └── bridge.ts             # VSCodeBridge：IDE 原生功能桥接
│   └── webview/
│       ├── chat/
│       │   └── index.tsx          # Chat 前端：StatusBar + MessageList + InputBar
│       └── canvas/
│           └── index.tsx          # Canvas 前端：A2UI Surface/组件渲染
├── dist/                          # 构建输出
│   ├── extension.js               # 扩展主代码（CJS, Node）
│   └── webview/
│       ├── chat.js                # Chat Webview（ESM, Browser）
│       └── canvas.js              # Canvas Webview（ESM, Browser）
├── test/                          # 测试文件（vitest）
├── docs/                          # 文档
├── package.json                   # 扩展清单与依赖
├── tsconfig.json                  # TypeScript 配置
├── esbuild.config.mjs             # 构建脚本（esbuild）
└── vitest.config.ts               # 测试配置（vitest）
```

### 关键模块说明

| 模块 | 文件 | 职责 |
|------|------|------|
| `GatewayClient` | `src/gateway/client.ts` | WebSocket 连接管理，自动重连（指数退避），命令发送与响应匹配，事件分发，连接状态订阅 |
| `MessageRouter` | `src/gateway/router.ts` | 根据事件 `kind` 路由到 Chat/Canvas/Bridge，序号去重防止乱序和重复事件 |
| `ChatProvider` | `src/vscode/chatProvider.ts` | Chat Sidebar Webview 生命周期管理，连接状态转发，消息发送/中止，会话切换与列表查询 |
| `CanvasPanel` | `src/vscode/canvasPanel.ts` | Canvas Webview Panel 管理，A2UI 消息缓冲与转发 |
| `VSCodeBridge` | `src/vscode/bridge.ts` | 封装 VS Code API：文件打开、Diff 视图、终端执行、通知 |

### 依赖

| 包 | 用途 |
|-----|------|
| `ws` | WebSocket 客户端（Node 端） |
| `marked` | Markdown 渲染 |
| `react` / `react-dom` | Webview UI 框架 |
| `esbuild` | 构建打包 |
| `vitest` | 测试框架 |

---

## 2. 构建说明

### 环境要求

- Node.js >= 22
- npm >= 10

### 安装依赖

```bash
npm install
```

### 构建

```bash
npm run build
```

构建使用 esbuild，产生三个 bundle：

| 输出 | 入口 | 格式 | 平台 |
|------|------|------|------|
| `dist/extension.js` | `src/extension.ts` | CJS | Node 22 |
| `dist/webview/chat.js` | `src/webview/chat/index.tsx` | ESM | Chrome 120 |
| `dist/webview/canvas.js` | `src/webview/canvas/index.tsx` | ESM | Chrome 120 |

`vscode` 模块声明为 external，由 VS Code 运行时提供。

### 监听模式

```bash
npm run watch
```

文件变更时自动重新构建。

### 调试

1. 在 VS Code 中打开项目
2. 按 `F5` 启动 Extension Development Host
3. 在新窗口中测试扩展功能
4. 修改 Webview 代码后，在开发窗口按 `Ctrl+Shift+P` → `Developer: Reload Webviews` 刷新

### 运行测试

```bash
npm test          # 运行一次
npm run test:watch # 监听模式
```

测试框架为 vitest，配置在 `vitest.config.ts`，测试文件位于 `test/` 目录。

### 打包发布

```bash
npm run package   # 使用 vsce 生成 .vsix 文件
```

---

## 3. 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                      VS Code Extension Host                  │
│                                                              │
│  ┌──────────┐    ┌───────────────┐    ┌──────────────────┐  │
│  │ extension│───>│ GatewayClient │    │   VSCodeBridge   │  │
│  │   .ts    │    │  (WebSocket)  │    │ (open, diff,     │  │
│  └──────────┘    │  + 自动重连    │    │  terminal, ...)  │  │
│       │          └───────┬───────┘    └────────▲─────────┘  │
│       │                  │                     │             │
│       │    events(seq) + │                     │             │
│       │    responses(id) │                     │             │
│       │                  ▼                     │             │
│       │          ┌───────────────┐             │             │
│       │          │ MessageRouter │─────────────┘             │
│       │          │  (序号去重)    │                           │
│       │          └──┬─────────┬──┘                           │
│       │             │         │                              │
│       │    text/tool/│         │ a2ui                        │
│       │    diff/done │         │                             │
│       │             ▼         ▼                              │
│  ┌────▼──────┐  ┌──────────────────┐                        │
│  │   Chat    │  │   CanvasPanel    │                        │
│  │ Provider  │  │  (消息缓冲)      │                        │
│  └─────┬─────┘  └────────┬─────────┘                        │
│        │ postMessage      │ postMessage                      │
├────────┼──────────────────┼──────────────────────────────────┤
│        ▼                  ▼            Webview Sandbox       │
│  ┌───────────┐    ┌───────────────┐                         │
│  │ Chat UI   │    │  Canvas UI    │                         │
│  │ StatusBar │    │   Surface     │                         │
│  │ Messages  │    │  Components   │                         │
│  │ ToolCalls │    │  (A2UI)       │                         │
│  │ InputBar  │    │               │                         │
│  └───────────┘    └───────────────┘                         │
└─────────────────────────────────────────────────────────────┘
         ▲                                    │
         │            WebSocket               │
         ▼                                    ▼
┌─────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                          │
│               (ws://127.0.0.1:18789)                        │
└─────────────────────────────────────────────────────────────┘
```

### 数据流

1. **用户发送消息：**
   Chat UI `postMessage({type:"send"})` → ChatProvider `handleWebviewMessage` → `GatewayClient.chatSend()` → WebSocket → Gateway

2. **Gateway 返回事件：**
   Gateway → WebSocket → `GatewayClient` 解析 → `emit(event)` → `MessageRouter.route()` 按 `payload.kind` 分发：
   - `text_delta` / `tool_start` / `tool_result` / `done` → `ChatProvider.postEvent()` → Chat UI
   - `a2ui` → `CanvasPanel.postA2UIMessage()` → Canvas UI
   - `diff` → `ChatProvider.postEvent()` + `VSCodeBridge.showDiff()`

3. **命令响应匹配：**
   `GatewayClient.sendCommand()` 为每个命令生成唯一 `id`，Gateway 返回 `{type:"res", id, ok, payload/error}` 后通过 `pendingRequests` Map 匹配并 resolve/reject Promise。超时 30 秒。

4. **自动重连：**
   连接意外断开后，`GatewayClient` 以指数退避重连（基准 1s，上限 30s，最多 10 次）。手动调用 `disconnect()` 不触发重连。

### Extension Host ↔ Webview 消息协议

Extension Host 和 Webview 运行在不同进程中，通过 `postMessage` / `onDidReceiveMessage` 双向通信。

**Extension → Chat Webview：**

| 消息 | 说明 |
|------|------|
| `{kind:"text_delta", content}` | Agent 文本增量 |
| `{kind:"tool_start", id, tool, title, input}` | 工具调用开始 |
| `{kind:"tool_result", id, output, error}` | 工具调用结果 |
| `{kind:"done", stopReason}` | Agent 回复完成 |
| `{kind:"diff", path, original, modified}` | 代码 diff |
| `{type:"connection_state", state}` | 连接状态变更 |
| `{type:"inject_prompt", text}` | 注入提示文本（Send Selection） |
| `{type:"sessions", sessions}` | 会话列表响应 |
| `{type:"error", message}` | 错误信息 |
| `{type:"history", messages}` | 会话历史消息（切换会话时） |
| `{type:"history_loading"}` | 历史加载中（清空当前消息） |

**Chat Webview → Extension：**

| 消息 | 说明 |
|------|------|
| `{type:"send", text}` | 发送消息 |
| `{type:"abort"}` | 中止当前回复 |
| `{type:"switch_session", key}` | 切换会话 |
| `{type:"request_sessions"}` | 请求会话列表 |

**Extension → Canvas Webview：**

| 消息 | 说明 |
|------|------|
| `{type:"a2ui", payload}` | A2UI 事件（createSurface / updateComponents / updateDataModel） |

**Canvas Webview → Extension：**

| 消息 | 说明 |
|------|------|
| `{type:"userAction", action, context}` | 用户交互回调 |

---

## 4. 如何添加自定义 A2UI 组件

A2UI（Agent-to-UI）组件在 Canvas Webview 中渲染。添加新组件的步骤如下：

### 步骤一：定义组件

在 `src/webview/canvas/index.tsx` 的 `RenderComponent` 函数中添加新的 case：

```tsx
case "Chart":
  return (
    <div>
      <h3>{String(component.props.title ?? "")}</h3>
      {/* 你的图表渲染逻辑 */}
    </div>
  );
```

### 步骤二：处理用户交互

如果组件需要响应用户操作，通过 `onAction` 回调通知 Extension Host：

```tsx
case "Confirm":
  return (
    <div>
      <p>{String(component.props.message ?? "")}</p>
      <button onClick={() => onAction("onConfirm", { componentId: component.id, confirmed: true })}>
        确认
      </button>
      <button onClick={() => onAction("onConfirm", { componentId: component.id, confirmed: false })}>
        取消
      </button>
    </div>
  );
```

用户交互会以 `{type: "userAction", action, context}` 的格式发送到 Extension Host。

### 步骤三：组件属性规范

每个 A2UI 组件遵循以下接口：

```typescript
{
  id: string;        // 组件唯一标识
  type: string;      // 组件类型名（如 "Text", "Button", "Chart"）
  props: Record<string, unknown>;  // 组件属性
}
```

### 现有内置组件

| 类型 | 属性 | 用户交互 |
|------|------|----------|
| `Text` | `text: string` | 无 |
| `Button` | `label: string` | `onClick` → `{componentId}` |
| `CodeBlock` | `code: string` | 无 |
| `FileTree` | `items: string[]` | `onSelect` → `{path}` |

未识别的组件类型会显示 `[ComponentType: not yet implemented]` 占位符。

### 步骤四：Surface 生命周期

组件存在于 Surface 中。Gateway 通过以下事件管理 Surface：

1. `createSurface` — 创建 Surface，包含 `surface.id`、`surface.title` 和初始 `components` 数组
2. `updateComponents` — 替换指定 `surfaceId` 的整个组件列表
3. `updateDataModel` — 通过 JSON Pointer 更新 Surface 数据模型（需自行实现数据绑定逻辑）

---

## 5. Gateway Protocol v3 消息参考

扩展通过 WebSocket 与 OpenClaw Gateway 通信，使用 JSON 消息格式。

### 连接握手

连接建立后，Gateway 发送 `connect.challenge` 事件，客户端响应 `connect` 请求：

```json
// 1. Gateway → Client: challenge event
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "...", "ts": 1234567890 }
}

// 2. Client → Gateway: connect request
{
  "type": "req",
  "id": "connect",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": { "id": "cli", "version": "0.1.0", "platform": "darwin", "mode": "cli" },
    "role": "operator",
    "scopes": ["operator.admin", "operator.approvals", "operator.pairing"],
    "caps": [],
    "commands": [],
    "permissions": {},
    "auth": { "token": "your-token" }
  }
}

// 3. Gateway → Client: connect response
{
  "type": "res",
  "id": "connect",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3 }
}
```

`auth` 字段在无认证时省略。

### 请求（Extension → Gateway）

请求是扩展主动发送给 Gateway 的消息。每个请求带有唯一 `id`，用于匹配 Gateway 的响应。

```typescript
interface GatewayRequest {
  type: "req";
  id: string;                   // 请求 ID（如 "cmd_1", "cmd_2"）
  method: string;               // 方法名
  params: Record<string, unknown>;  // 参数
}
```

#### chat.send（发送聊天消息）

```json
{
  "type": "req",
  "id": "cmd_1",
  "method": "chat.send",
  "params": {
    "sessionKey": "acp:uuid-here",
    "message": "用户输入的消息",
    "idempotencyKey": "随机UUID防重"
  }
}
```

响应：`{ "type": "res", "id": "cmd_1", "ok": true, "payload": { "runId": "..." } }`

#### chat.abort（中止当前回复）

```json
{
  "type": "req",
  "id": "cmd_2",
  "method": "chat.abort",
  "params": {
    "sessionKey": "acp:uuid-here",
    "runId": "run-id-here"
  }
}
```

#### chat.history（查询聊天历史）

```json
{
  "type": "req",
  "id": "cmd_3",
  "method": "chat.history",
  "params": {
    "sessionKey": "acp:uuid-here"
  }
}
```

响应：`{ "type": "res", "id": "cmd_3", "ok": true, "payload": { "messages": [...] } }`

#### session.list（查询会话列表）

```json
{
  "type": "req",
  "id": "cmd_4",
  "method": "session.list",
  "params": {}
}
```

响应：`{ "type": "res", "id": "cmd_4", "ok": true, "payload": { "sessions": [...] } }`

#### session.create（创建新会话）

```json
{
  "type": "req",
  "id": "cmd_5",
  "method": "session.create",
  "params": {
    "key": "acp:new-uuid",
    "agent": "main"
  }
}
```

### 响应（Gateway → Extension）

每个请求对应一个响应，通过 `id` 匹配：

```typescript
// 成功
{ "type": "res", "id": "cmd_1", "ok": true, "payload": { ... } }

// 失败
{ "type": "res", "id": "cmd_1", "ok": false, "error": "error message" }
```

命令超时时间为 30 秒，超时后 Promise 被 reject。

### 事件（Gateway → Extension）

事件是 Gateway 主动推送给扩展的消息，通过 `GatewayClient.onEvent` 接收。`seq` 字段用于序号去重，`MessageRouter` 会丢弃 seq <= lastSeq 的事件。

```typescript
interface GatewayEvent {
  type: "event";
  event: string;
  payload: AgentEventPayload;   // 见下方各事件类型
  seq?: number;                 // 递增序号，用于去重
}
```

**重要：Gateway 双流机制**

Gateway 对同一次 Agent 回复会同时发送两种事件流：

| 流 | 事件名 | 频率 | 用途 |
|----|--------|------|------|
| Raw agent stream | `event:"agent"`, `payload.stream:"assistant"` | 每 token | 文本增量（`data.delta`） |
| Chat 状态 | `event:"chat"`, `payload.state:"delta\|final\|error\|aborted"` | 批量 | 回复结束状态 |

`GatewayClient` 在内部完成翻译：
- Raw agent `data.delta` → `{kind:"text_delta", content}` 事件
- Chat `state:"final"` → `{kind:"done", stopReason:"end_turn"}` 事件
- Chat `state:"error"` → `{kind:"done", stopReason:"<errorMessage>"}` 事件
- Chat `state:"aborted"` → `{kind:"done", stopReason:"aborted"}` 事件
- Agent 事件中带 `kind` 字段的（tool_start/tool_result/diff/done）直接透传
- `health`、`tick`、agent 生命周期事件被过滤

#### text_delta — 文本增量

Agent 生成的文本回复，以流式增量方式推送。

```json
{
  "type": "event",
  "event": "agent",
  "payload": { "kind": "text_delta", "content": "这是一段" },
  "seq": 1
}
```

#### tool_start — 工具调用开始

```json
{
  "type": "event",
  "event": "agent",
  "payload": {
    "kind": "tool_start",
    "tool": "readFile",
    "id": "tool-call-1",
    "title": "Reading src/main.ts",
    "input": { "path": "src/main.ts" }
  },
  "seq": 2
}
```

#### tool_result — 工具调用结果

```json
{
  "type": "event",
  "event": "agent",
  "payload": {
    "kind": "tool_result",
    "id": "tool-call-1",
    "output": "文件内容...",
    "error": null
  },
  "seq": 3
}
```

#### a2ui — A2UI 界面事件

**创建 Surface：**
```json
{
  "type": "event",
  "event": "agent",
  "payload": {
    "kind": "a2ui",
    "payload": {
      "type": "createSurface",
      "surface": { "id": "s1", "title": "代码分析结果" },
      "components": [
        { "id": "c1", "type": "Text", "props": { "text": "分析完成" } },
        { "id": "c2", "type": "CodeBlock", "props": { "code": "console.log('hello')" } }
      ]
    }
  }
}
```

**更新组件：**
```json
{
  "type": "event",
  "event": "agent",
  "payload": {
    "kind": "a2ui",
    "payload": {
      "type": "updateComponents",
      "surfaceId": "s1",
      "components": [
        { "id": "c1", "type": "Text", "props": { "text": "更新后的内容" } }
      ]
    }
  }
}
```

**更新数据模型：**
```json
{
  "type": "event",
  "event": "agent",
  "payload": {
    "kind": "a2ui",
    "payload": {
      "type": "updateDataModel",
      "surfaceId": "s1",
      "pointer": "/results/0",
      "value": { "status": "done" }
    }
  }
}
```

#### diff — 代码变更

```json
{
  "type": "event",
  "event": "agent",
  "payload": {
    "kind": "diff",
    "path": "src/main.ts",
    "original": "原始内容",
    "modified": "修改后内容"
  }
}
```

`original` 为 `null` 时表示新建文件。

#### done — 回复完成

```json
{
  "type": "event",
  "event": "agent",
  "payload": {
    "kind": "done",
    "stopReason": "end_turn"
  }
}
```

### 连接状态

`GatewayClient` 维护以下连接状态，可通过 `onStateChange` 订阅变更：

| 状态 | 说明 |
|------|------|
| `disconnected` | 未连接 |
| `connecting` | 正在连接 |
| `connected` | 已连接，握手完成 |
| `error` | 连接错误（超过最大重试次数后进入此状态） |

### 重连策略

| 参数 | 值 |
|------|-----|
| 基准延迟 | 1 秒 |
| 最大延迟 | 30 秒 |
| 最大重试次数 | 10 |
| 退避算法 | `min(base * 2^attempt, max)` |

手动调用 `disconnect()` 会阻止自动重连。重连成功后重试计数器归零。
