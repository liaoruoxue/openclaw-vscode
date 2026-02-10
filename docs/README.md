# OpenClaw VS Code 扩展 — 用户使用指南

## 目录

1. [前置条件](#1-前置条件)
2. [安装方式](#2-安装方式)
3. [配置说明](#3-配置说明)
4. [快速开始](#4-快速开始)
5. [功能介绍](#5-功能介绍)
6. [会话管理](#6-会话管理)
7. [故障排查](#7-故障排查)

---

## 1. 前置条件

使用本扩展前，请确保以下环境已就绪：

- **VS Code** >= 1.100.0
- **Node.js** >= 22（仅从源码构建时需要）
- **OpenClaw Gateway** 已安装并运行

### 启动 Gateway

```bash
# 默认监听 ws://127.0.0.1:18789
openclaw gateway start
```

确认 Gateway 正在运行后，再在 VS Code 中连接。

---

## 2. 安装方式

### 方式一：安装 .vsix 文件（推荐）

1. 获取 `openclaw-0.1.0.vsix` 文件
2. 在 VS Code 中按 `Ctrl+Shift+P`（macOS: `Cmd+Shift+P`）
3. 输入 `Extensions: Install from VSIX...`
4. 选择下载的 `.vsix` 文件

### 方式二：从源码构建

```bash
git clone <repo-url>
cd openclaw-acp
npm install
npm run build
```

然后按 `F5` 启动扩展开发宿主窗口进行调试，或执行以下命令打包：

```bash
npm run package
# 生成 openclaw-0.1.0.vsix，按方式一安装即可
```

---

## 3. 配置说明

打开 VS Code 设置（`Ctrl+,`），搜索 `openclaw`，可配置以下选项：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `openclaw.gateway.url` | string | `ws://127.0.0.1:18789` | Gateway WebSocket 地址 |
| `openclaw.gateway.token` | string | （空） | Gateway 认证令牌 |
| `openclaw.session.defaultAgent` | string | `main` | 新会话默认使用的 Agent 名称 |
| `openclaw.autoConnect` | boolean | `false` | 启动时自动连接 Gateway |

也可直接编辑 `settings.json`：

```json
{
  "openclaw.gateway.url": "ws://127.0.0.1:18789",
  "openclaw.gateway.token": "your-token-here",
  "openclaw.session.defaultAgent": "main",
  "openclaw.autoConnect": true
}
```

---

## 4. 快速开始

### 步骤一：连接 Gateway

按 `Ctrl+Shift+P`，输入 `OpenClaw: Connect to Gateway` 并执行。连接成功后会看到通知提示，Chat 面板顶部状态指示灯变为绿色。

> 如果设置了 `openclaw.autoConnect: true`，扩展启动时会自动连接。

### 步骤二：打开 Chat 面板

点击活动栏（左侧边栏）中的 **OpenClaw** 图标，即可打开 Chat Sidebar。

### 步骤三：发送第一条消息

在 Chat 输入框中输入你的问题或指令，按 `Enter` 发送（`Shift+Enter` 换行）。Agent 的响应会以流式方式实时显示。

> 未连接 Gateway 时，输入框和发送按钮处于禁用状态。

### 步骤四：查看响应

- **文本回复**：直接显示在聊天区域，自动滚动到底部
- **工具调用**：显示为可折叠卡片，点击展开可查看工具输入参数和输出结果
- **代码变更**：如果 Agent 生成了 diff，会自动打开 VS Code 的 Diff 视图
- **Canvas 内容**：A2UI 可视化组件会在 Canvas 面板中渲染

---

## 5. 功能介绍

### 5.1 Chat Sidebar（聊天侧边栏）

Chat Sidebar 是与 Agent 交互的主要界面，位于左侧活动栏的 OpenClaw 视图中。

**状态栏：**

面板顶部显示连接状态指示灯和会话选择器：
- 绿色圆点 = `connected`（已连接）
- 橙色圆点 = `connecting`（连接中）
- 灰色圆点 = `disconnected`（未连接）
- 红色圆点 = `error`（连接错误）

**发送消息：**
- 在输入框中输入消息，按 `Enter` 发送
- `Shift+Enter` 可插入换行（支持多行输入）
- 流式传输期间显示 "Thinking..." 提示，发送按钮变为 **Stop** 按钮

**中止回复：**
Agent 回复过程中，点击 **Stop** 按钮或通过 Webview 发送 `abort` 消息可中止当前回复。

**工具调用查看：**
Agent 调用工具时，聊天区域会显示工具调用卡片：
- 标题栏显示工具名称或描述，运行中显示 "running..."，出错显示红色 "error"
- 点击标题栏可展开/折叠，查看输入参数（JSON）和输出结果
- 每个工具调用通过唯一 `id` 追踪，`tool_start` 和 `tool_result` 自动关联

**错误处理：**
发送失败时，错误信息会以 Agent 消息形式显示在聊天区域。

### 5.2 Canvas Panel（画布面板）

Canvas 是 A2UI（Agent-to-UI）的可视化渲染面板，用于展示 Agent 生成的交互式 UI 组件。

**打开方式：**
- 按 `Ctrl+Shift+P` 输入 `OpenClaw: Open Canvas`，面板会在编辑器右侧打开
- 当 Agent 发送 A2UI 事件时，Canvas 面板会自动打开

**内置组件类型：**

| 组件 | 说明 | 属性 |
|------|------|------|
| `Text` | 文本段落 | `text` |
| `Button` | 可点击按钮 | `label` |
| `CodeBlock` | 代码块显示 | `code` |
| `FileTree` | 文件列表（可点击） | `items` (string[]) |

**A2UI 事件类型：**
- `createSurface` — 创建新的画布区域（Surface），包含标题和初始组件
- `updateComponents` — 更新已有 Surface 中的组件列表
- `updateDataModel` — 通过 JSON Pointer 更新 Surface 数据模型

**消息缓冲：**
Canvas 面板关闭时收到的 A2UI 消息会被缓冲，面板打开后自动回放。

> Canvas 面板设置了 `retainContextWhenHidden`，即使切换到其他标签页，状态也会保留。

### 5.3 IDE 集成

扩展深度集成了 VS Code 的原生功能：

**发送选中代码：**
1. 在编辑器中选中代码
2. 右键菜单中选择 `OpenClaw: Send Selection to Agent`
3. 选中内容会作为带文件路径和语言标注的代码块发送给 Agent

也可通过命令面板执行 `OpenClaw: Send Selection to Agent`。

**Diff 视图：**
当 Agent 返回 `diff` 事件时，扩展自动打开 VS Code 内置的 Diff 编辑器，展示原始内容与修改后内容的对比。

**终端集成：**
Agent 可以通过 VS Code Bridge 在专用终端（名为 "OpenClaw"）中执行命令。如果终端已存在则复用。

**文件打开：**
Agent 可以直接在编辑器中打开指定路径的文件。

---

## 6. 会话管理

每次对话在一个 **会话（Session）** 中进行。会话信息包括：

| 字段 | 说明 |
|------|------|
| `key` | 会话唯一标识符 |
| `agent` | 使用的 Agent 名称 |
| `label` | 会话显示名称 |
| `createdAt` | 创建时间 |

**新建会话：**
发送第一条消息时会自动创建会话，会话 key 格式为 `acp:<uuid>`。

**切换会话：**
Chat 面板顶部状态栏中有会话下拉选择器，显示所有已有会话（打开 Chat 时自动加载会话列表）。选择不同会话后，聊天记录会清空并切换到新会话的上下文。

**默认 Agent：**
新会话默认使用 `openclaw.session.defaultAgent` 配置的 Agent（默认为 `main`）。

---

## 7. 故障排查

### 连接失败

**现象：** 执行 Connect 后提示 `Connection failed`，状态指示灯为红色

**排查步骤：**
1. 确认 Gateway 已启动并在监听
2. 检查 `openclaw.gateway.url` 配置是否正确
3. 如果使用了认证，确认 `openclaw.gateway.token` 有效
4. 检查防火墙或代理设置是否阻止了 WebSocket 连接

> 连接断开后，扩展会自动尝试重连（指数退避，最多 10 次，间隔从 1 秒到最长 30 秒）。手动执行 Disconnect 后不会自动重连。

### Chat 无响应

**现象：** 发送消息后一直显示 "Thinking..."

**排查步骤：**
1. 检查 Chat 面板顶部状态指示灯确认连接状态（应为绿色 `connected`）
2. 确认 Gateway 后端的 Agent 服务正常运行
3. 点击 **Stop** 按钮中止当前请求，重新发送
4. 打开 VS Code 开发者工具（`Help > Toggle Developer Tools`）查看控制台日志

### Canvas 不显示

**现象：** Agent 发送了 A2UI 事件但 Canvas 面板为空

**排查步骤：**
1. 确认已执行 `OpenClaw: Open Canvas` 打开 Canvas 面板
2. Canvas 面板接收到 A2UI 事件时会自动打开；检查是否有 `createSurface` 事件
3. 检查开发者工具中 Webview 是否有 JavaScript 错误

### 命令超时

**现象：** 发送消息后报错 `Command 'chat.send' timed out`

**排查步骤：**
1. 命令默认超时时间为 30 秒
2. 检查 Gateway 和 Agent 后端是否负载过高
3. 确认网络连接稳定

### 常见错误信息

| 错误 | 原因 | 解决方案 |
|------|------|----------|
| `Connection failed` | Gateway 未运行或地址错误 | 启动 Gateway，检查 URL 配置 |
| `Not connected to Gateway` | 未连接时尝试发送命令 | 先执行 Connect 命令 |
| `Command '...' timed out` | Gateway 响应超时（30秒） | 检查 Gateway 状态和网络 |
| `No text selected` | 使用 Send Selection 时未选中文本 | 先在编辑器中选中代码 |
| `Failed to send: ...` | 发送消息失败 | 查看具体错误信息，检查连接状态 |

---

## 命令速查

| 命令 | 说明 |
|------|------|
| `OpenClaw: Connect to Gateway` | 连接到 Gateway |
| `OpenClaw: Disconnect` | 断开连接 |
| `OpenClaw: Open Canvas` | 打开 Canvas 面板 |
| `OpenClaw: Send Selection to Agent` | 将选中代码发送给 Agent |

## 快捷键

| 操作 | 快捷键 |
|------|--------|
| 发送消息 | `Enter` |
| 换行 | `Shift+Enter` |
| 中止回复 | 点击 Stop 按钮 |
