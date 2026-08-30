# Joinery Implementation Status

Last Updated: 2026-03-22

## Summary

**Current Version: v0.2.0**
**Platforms: macOS (arm64, x64) + Windows (x64, arm64)**

All core features implemented. AI chat with agentic tool calling fully operational across 5 LLM providers.

## Build & Distribution

| Target              | Format               | CI                |
| ------------------- | -------------------- | ----------------- |
| macOS Apple Silicon | DMG + ZIP            | ✅ GitHub Actions |
| macOS Intel         | DMG + ZIP            | ✅ GitHub Actions |
| Windows x64         | NSIS Installer + ZIP | ✅ GitHub Actions |
| Windows ARM64       | NSIS Installer + ZIP | ✅ GitHub Actions |

Builds trigger automatically on tagged releases via `.github/workflows/release.yml`.

---

## Phase 0: Project Foundation ✅

- [x] Monorepo with Turborepo (shared, preload, main, renderer, cli)
- [x] Electron shell with context isolation
- [x] Angular 18 standalone components with signals
- [x] Typed IPC channels between main and renderer
- [x] Development scripts (dev, build, package)
- [x] electron-builder config for macOS + Windows

## Phase 1: Connection Management ✅

- [x] macOS Keychain credential storage (keytar)
- [x] Connection pool manager (mssql/tedious)
- [x] Connection profiles with validation
- [x] Docker SQL Server auto-detection (dockerode)
- [x] Connection color coding by environment
- [x] Welcome screen with Docker detection

## Phase 2: Object Explorer ✅

- [x] Full tree navigation: databases, tables, views, procedures, functions, schemas
- [x] Lazy-loaded tree nodes with metadata caching
- [x] Column details (types, nullability, keys, defaults)
- [x] Keyboard navigation and accessibility

## Phase 3: Query Editor ✅

- [x] Multi-tab query editor (CodeMirror 6)
- [x] Virtualized results grid (AG Grid)
- [x] GoldenLayout dockable tab system
- [x] Tab context menu (rename, pin, duplicate, close others, close to right)
- [x] Find & Replace
- [x] Query history (persistent, searchable)
- [x] Export: CSV, JSON, clipboard
- [x] Auto-execute tabs (opened by AI)
- [x] Unsaved changes warning on close

## Phase 4: Database Operations ✅

- [x] Create / Rename / Delete database
- [x] Safety confirmations for destructive operations
- [x] T-SQL transparency (show exact SQL executed)

## Phase 5: Backup & Restore ✅

- [x] Full backup with streaming progress
- [x] Compression options
- [x] Restore with file relocation wizard
- [x] Docker volume path translation

## Phase 6: ERD Visualization ✅

- [x] Interactive entity-relationship diagrams (D3.js)
- [x] Theme-aware colors (dark/light)
- [x] Double-click table to open query
- [x] Focus depth control

## Phase 7: AI Chat Assistant ✅

- [x] Multi-provider LLM abstraction layer (`llm-providers.ts`)
  - Google Gemini (with thought signatures for 2.5+/3.x)
  - Anthropic Claude
  - OpenAI
  - Groq
  - Cerebras
- [x] Agentic tool-calling loop (max 10 iterations)
  - execute_query, list_databases, list_tables, list_columns, get_table_schema
  - create_database (with confirmation)
  - open_query_tab (with auto-execute)
  - navigate_to_database, open_settings
- [x] Streaming responses with real-time rendering
- [x] Tool call cards with expandable results
- [x] Confirmation flow for destructive operations
- [x] Independent chat tab instances (ChatInstanceState)
- [x] Conversation dropdown selector with inline rename
- [x] Resizable chat panel with width persistence
- [x] Smart auto-scroll (stays at bottom during streaming, preserves user scroll position)
- [x] Dark mode markdown readability (tables, code blocks, inline code)
- [x] Default model selection prefers stable (non-preview) models

## Phase 8: UX & Polish ✅

- [x] Refined dark theme (purple-tinted)
- [x] Connection color coding
- [x] Keyboard shortcuts (Cmd+Enter, Cmd+N, etc.)
- [x] Toast notifications
- [x] Accessibility (ARIA labels, focus management)
- [x] Production logger with structured output
- [x] Security hardening (parameterized queries, no credential leaks)

## Phase 9: CI/CD ✅

- [x] GitHub Actions workflow: build on tag push
- [x] macOS + Windows matrix build
- [x] Automatic artifact upload to GitHub Releases
- [x] beforeBuild hook to handle incompatible native modules (cpu-features)

---

## What's Next (v0.3+)

- [ ] Schema-aware SQL autocomplete
- [ ] AI "Fix this error" — one-click error resolution
- [ ] Cmd+K command palette
- [ ] Query snippets and templates
- [ ] Global schema search
- [ ] Light theme
- [ ] Azure AD / Entra ID authentication
