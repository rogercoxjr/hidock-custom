# HiDock Next - Agent Guidelines

## Essential Commands

**Desktop App (Python):** `cd apps/desktop && python3 main.py` | `pytest` (581 tests) | `pytest -k test_name` (single test) | `black . && isort . && flake8 . && mypy .`
**Web App (React/TS):** `cd apps/web && npm run dev` | `npm test` | `npm run build` | `npx tsc --noEmit && npx eslint src --ext .ts,.tsx`
**Electron App (Universal Knowledge Hub):** `cd apps/electron && npm run dev` | `npm run test:run` | `npm run build` | `npm run typecheck && npm run lint`
**Audio Insights (archived, React):** `cd legacy/audio-insights && npm run dev` | `npm test` | `npm run build` | `npx tsc --noEmit`

## Architecture

Monorepo (no root npm workspace — each JS project is `npm install`'d in its own directory; `packages/*` are `file:`-linked, so install/build a package before any app that depends on it): **apps/desktop/** (Python/CustomTkinter/PyUSB — original device-management entry point), **apps/web/** (React 18/Zustand/WebUSB transcription app), **apps/electron/** (Electron "universal knowledge hub" — current primary focus), **apps/meeting-recorder/** (standalone Electron real-time AI meeting recorder), **apps/meeting-assistant/** (phased Electron build reusing `packages/*`). Shared `@hidock/*` libraries live in **packages/{ai-providers,audio-capture,calendar-sync,storage-controller,transcription}**. **legacy/audio-insights/** (React/Vite/Gemini) is an archived prototype — its transcription + insight-extraction capabilities are absorbed into apps/electron. Jensen USB protocol for HiDock device communication. 11 AI providers supported across components. Component-specific rules in each `AGENT.md` file.

## Code Standards

**Line Length:** 120 chars max | **Python:** Black, isort, flake8, mypy, TDD required | **TypeScript:** Strict mode, no `any` types | **React:** CustomTkinter for desktop GUI, Zustand for web state, functional components with hooks | **USB:** Background threads mandatory, never block GUI | **AI:** Multi-provider support, secure API key storage | **Testing:** 80% coverage minimum, comprehensive mocking

## Key Patterns

**Python Classes:** Private methods `_method()`, proper cleanup, exception handling | **React Components:** Props interfaces, useCallback for handlers, useEffect with cleanup | **Error Handling:** Custom exception classes, try/catch with logging | **Device Communication:** Thread-safe USB operations, reconnection support | **Performance:** Desktop <3s startup, Web <2s load, Audio <500ms processing

**Important:** Always check component-specific `AGENT.md` files for detailed rules. Use `python3` not `python`. Run validation commands before commits.
