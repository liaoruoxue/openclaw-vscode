# OpenClaw ACP — VS Code Extension

OpenClaw AI Agent integration for VS Code, Cursor, and Windsurf. Chat with AI agents, render interactive Canvas UIs, and get code diffs — all through the [OpenClaw Gateway](https://openclaw.ai) protocol.

## Features

- **Chat Sidebar** — Stream-based conversation with AI agents, Markdown rendering, tool call inspection
- **Canvas Panel** — A2UI (Agent-to-UI) interactive components rendered in an editor tab
- **IDE Integration** — Diff views, terminal execution, file navigation, "Send Selection to Agent"
- **Session Management** — Multiple sessions with history loading on switch
- **Auto-Reconnect** — Exponential backoff reconnection with device identity authentication

## Prerequisites

- **VS Code** >= 1.100.0 (or Cursor / Windsurf)
- **OpenClaw Gateway** running and accessible

```bash
# Start the Gateway (default: ws://127.0.0.1:18789)
openclaw gateway start
```

## Installation

### From .vsix (Recommended)

1. Download `openclaw-0.1.0.vsix`
2. In VS Code: `Ctrl+Shift+P` → `Extensions: Install from VSIX...`
3. Select the `.vsix` file

### From Source

```bash
git clone <repo-url>
cd openclaw-acp
npm install
npm run build
```

Press `F5` to launch the Extension Development Host for testing, or package for production:

```bash
npm run package
# Produces openclaw-0.1.0.vsix
```

## Configuration

Open VS Code Settings (`Ctrl+,`) and search `openclaw`:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `openclaw.gateway.url` | string | `ws://127.0.0.1:18789` | Gateway WebSocket URL |
| `openclaw.gateway.token` | string | *(empty)* | Authentication token |
| `openclaw.session.defaultAgent` | string | `main` | Default agent for new sessions |
| `openclaw.autoConnect` | boolean | `false` | Auto-connect on startup |

## Quick Start

1. **Connect**: `Ctrl+Shift+P` → `OpenClaw: Connect to Gateway`
2. **Chat**: Click the OpenClaw icon in the Activity Bar, type a message, press Enter
3. **Canvas**: `Ctrl+Shift+P` → `OpenClaw: Open Canvas` (opens automatically when agents send A2UI events)
4. **Send Code**: Select code in the editor → right-click → `OpenClaw: Send Selection to Agent`

## Chat

- Messages stream in real-time with Markdown rendering (headings, code blocks, tables, etc.)
- Tool calls appear as collapsible cards showing input/output
- Code diffs automatically open VS Code's built-in Diff editor
- Session switcher in the status bar; switching loads chat history
- Press **Stop** to abort a running response

## Canvas / A2UI

The Canvas panel renders interactive UI components sent by agents:

| Component | Props | Interaction |
|-----------|-------|-------------|
| Text | `text` | — |
| Button | `label` | onClick |
| CodeBlock | `code` | — |
| FileTree | `items` | onSelect |
| TextField | `value` | onChange |
| CheckBox | `checked` | onChange |
| Card, Row, Column | children | Layout containers |
| Image | `src` | — |
| DiffView | `original`, `modified` | — |
| Terminal | `content` | — |
| List | `items` | onSelect |

## Commands

| Command | Description |
|---------|-------------|
| `OpenClaw: Connect to Gateway` | Connect to the Gateway |
| `OpenClaw: Disconnect` | Disconnect |
| `OpenClaw: Open Canvas` | Open the Canvas panel |
| `OpenClaw: Send Selection to Agent` | Send selected code to the agent |

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for architecture, build instructions, protocol reference, and how to add custom A2UI components.

Chinese user guide: [docs/README.md](docs/README.md)

```bash
npm install       # Install dependencies
npm run build     # Build (3 bundles: extension CJS, chat ESM, canvas ESM)
npm run watch     # Watch mode
npm test          # Run tests (vitest)
npm run test:watch
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Connection failed | Ensure Gateway is running; check `openclaw.gateway.url` |
| Chat shows "Thinking..." indefinitely | Check connection status (green dot); try Stop + resend |
| Canvas blank | Run `OpenClaw: Open Canvas`; check for `createSurface` events |
| Command timed out | Gateway may be overloaded (30s timeout) |

For detailed diagnostics, open `Help > Toggle Developer Tools` to see Extension Host logs.

## License

[MIT](LICENSE)
