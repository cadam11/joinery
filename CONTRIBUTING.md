# Contributing to Joinery

Thank you for your interest in contributing to Joinery! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Making Changes](#making-changes)
- [AI Integration Guidelines](#ai-integration-guidelines)
- [Commit Guidelines](#commit-guidelines)
- [Pull Request Process](#pull-request-process)
- [Code Style](#code-style)

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/joinery.git`
3. Add the upstream remote: `git remote add upstream https://github.com/cadam11/joinery.git`

## Development Setup

### Prerequisites

- **Node.js** 20 or later
- **pnpm** 11 or later (`corepack enable pnpm`)
- **Xcode Command Line Tools** (macOS, for native modules)
- **Docker** (optional, for local SQL Server/PostgreSQL/MySQL testing)

### Installation

```bash
pnpm install
pnpm run build       # Build all packages
pnpm run dev         # Development mode with hot reload
```

### Where the development build keeps its state

`pnpm run dev` runs `electron .` inside `packages/main`, so Electron takes the app name from that
package's manifest — `"productName": "Joinery (dev)"`. State therefore lands in a directory of its
own, separate from the installed app's:

| Build          | macOS                                         | Windows                   |
| -------------- | --------------------------------------------- | ------------------------- |
| `pnpm run dev` | `~/Library/Application Support/Joinery (dev)` | `%APPDATA%\Joinery (dev)` |
| Installed app  | `~/Library/Application Support/Joinery`       | `%APPDATA%\Joinery`       |

That separation is deliberate: a bug in a development build cannot reach the connection profiles,
query history or chat conversations of the app you actually use. Deleting the `Joinery (dev)`
directory is a safe way to start from a clean profile.

**Do not remove `productName` from `packages/main/package.json`.** Electron falls back to `name`,
which is `@joinery/main`, and it joins that onto the application-data path without complaint — the
`/` nests your state inside a directory called `@joinery` where nothing looks for it. A spec in
`packages/main/src/services/config/user-data-dir.spec.ts` fails if any Electron entry point in the
workspace resolves a name that is not a single, plain directory.

### Running SQL Server Locally

```bash
docker run -e "ACCEPT_EULA=Y" -e "MSSQL_SA_PASSWORD=YourStrong@Passw0rd" \
  -p 1433:1433 --name sql1 -d mcr.microsoft.com/mssql/server:2022-latest
```

### Building Installers

```bash
pnpm run package:mac   # macOS DMG (arm64 + x64)
pnpm run package       # Current platform
```

## Project Structure

```
joinery/
├── packages/
│   ├── shared/        # Types, IPC channels, ai-vendors.json
│   ├── preload/       # Electron context bridge
│   ├── main/          # Electron main process
│   │   └── src/
│   │       ├── ipc/       # IPC handler registration
│   │       └── services/
│   │           ├── ai/    # LLM providers, chat service, tool registry
│   │           ├── sql/   # Multi-engine SQL: dialect/, provider/ (mssql, postgresql, mysql)
│   │           ├── docker/# Container detection (dockerode)
│   │           ├── keychain/ # Credential storage (keytar)
│   │           └── config/   # App state persistence (electron-store)
│   └── renderer/      # React 19 + Tailwind v4 application (Vite)
│       └── src/
│           ├── state/     # Zustand stores
│           ├── ipc/       # Typed window.joinery wrappers, TanStack Query cache
│           ├── persistence/ # AppState bridge, legacy migration, theme mirror
│           ├── features/  # Chat, ERD, query, explorer, backup, welcome
│           ├── ui/        # Radix + Tailwind primitives
│           ├── commands/  # Command bus, palette catalogue, menu registry
│           └── shell/     # App shell, sidebar, Dockview workspace
├── .github/workflows/ # CI/CD
├── scripts/           # Build helpers
├── resources/         # App icons
└── plans/             # Design documents
```

### Package Overview

| Package             | Purpose                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `@joinery/shared`   | Type definitions, IPC channel constants, AI vendor config          |
| `@joinery/preload`  | Electron preload script with typed contextBridge API               |
| `@joinery/main`     | Main process: SQL, AI, Docker, Keychain services + IPC handlers    |
| `@joinery/renderer` | React 19 + Tailwind v4 UI (Vite), Zustand stores, Radix primitives |

## Making Changes

1. Create a branch from `main`:

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make changes following our [code style guidelines](#code-style)

3. Build to check for type errors:

   ```bash
   pnpm run build
   ```

4. Test your changes manually or with tests:
   ```bash
   pnpm test
   ```

## AI Integration Guidelines

If you're working on AI features, follow these rules:

1. **Never make direct LLM API calls.** All AI interactions go through `packages/main/src/services/ai/llm-providers.ts`. This multi-provider abstraction supports Google, Anthropic, OpenAI, Groq, and Cerebras.

2. **Streaming is required** for chat/conversational features. Use the `StreamCallbacks` interface from `llm-providers.ts`.

3. **Tool definitions** go in `packages/main/src/services/ai/tool-registry.ts`. Tools that modify data must set `requiresConfirmation: true`.

4. **Model/vendor config** lives in `packages/shared/src/config/ai-vendors.json`. User preferences are stored in app state.

5. **Use `src/markdown/`** (`renderMarkdown`, `<Markdown>`) for rendering AI-generated content in the renderer. It parses with `marked` and sanitizes with DOMPurify; `dangerouslySetInnerHTML` is banned by ESLint everywhere else in the package.

## Commit Guidelines

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description
```

### Types

| Type       | Description            |
| ---------- | ---------------------- |
| `feat`     | New feature            |
| `fix`      | Bug fix                |
| `docs`     | Documentation          |
| `refactor` | Code restructuring     |
| `test`     | Test additions/changes |
| `chore`    | Build/tooling          |

### Examples

```
feat(chat): add image attachment support
fix(query): handle timeout on large result sets
docs(readme): update AI provider setup instructions
refactor(explorer): move the tree state into its own Zustand store
```

## Pull Request Process

1. Ensure the build succeeds: `pnpm run build`
2. Update documentation if your change affects user-facing behavior
3. Create a PR with a clear description of what and why
4. Link related issues

### PR Title Format

Same as commit format: `type(scope): description`

## Code Style

### TypeScript

- Strict mode (`strict: true`) — no `any` without justification
- Use interfaces for object shapes, type guards for narrowing
- Static imports only — no dynamic `require()` or `import()`

### React (Renderer)

- **Function components and hooks** — no class components
- **Zustand stores** for shared state, `useState` for local
- **TanStack Query** for anything fetched over IPC
- **Smart/dumb pattern** — containers handle logic, presentational components take props

### Electron (Main Process)

- All Node operations in main process — never expose Node APIs to renderer
- IPC channels typed in `@joinery/shared`
- Use `invoke/handle` for request-response, `send/on` for streaming
- Credentials via Keychain only — never in files or logs

### File Naming

| Type                        | Pattern               |
| --------------------------- | --------------------- |
| Components (renderer)       | `kebab-case.tsx`      |
| Services / utilities (main) | `kebab-case.ts`       |
| Types                       | `kebab-case.types.ts` |
| Tests                       | `*.spec.ts`           |

### Forbidden Patterns

- `eval()` or `new Function()`
- Dynamic `require()` or `import()`
- Storing credentials outside Keychain
- Direct DOM manipulation outside a ref/effect
- `console.log` in production (use the logger service)
- Direct HTTP calls to LLM APIs (use the provider abstraction)
- Synchronous IPC (`ipcRenderer.sendSync`)

## Questions?

- **Bugs** — [Open an issue](https://github.com/cadam11/joinery/issues)
- **Ideas** — [Start a discussion](https://github.com/cadam11/joinery/discussions)

Thank you for contributing!
