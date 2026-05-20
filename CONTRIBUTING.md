# Contributing to tb

## Setup

```bash
git clone https://github.com/user/tiny-browser && cd tiny-browser
bun install
bun run dev help        # test CLI
tb install              # install lightpanda
```

## Architecture

```
src/
├── cli.ts              # CLI entry, arg parsing, command dispatch
├── daemon.ts           # Persistent daemon (Bun.serve on unix socket)
├── cdp.ts              # Chrome DevTools Protocol client (WebSocket)
├── session.ts          # Browser session (navigate, click, screenshot, etc.)
├── renderer.ts         # satori + resvg DOM→PNG renderer (for lightpanda screenshots)
├── render-worker.ts    # Subprocess worker for crash-safe rendering
├── config.ts           # ~/.tb/config.json management
├── server.ts           # HTTP API server (tb serve)
├── index.ts            # Library API (import { tb } from 'tiny-browser')
├── utils.ts            # Shared utilities
├── commands/
│   └── install.ts      # Engine installation logic
└── engines/
    ├── types.ts        # Engine interface
    ├── index.ts        # Engine registry + auto-selection
    ├── lightpanda.ts   # Lightpanda engine (detect, install, launch)
    └── chromium.ts     # Chromium engine (detect, install, launch)
```

**Flow:** CLI → daemon (unix socket) → engine (CDP) → session → response

## Adding a new engine

1. Create `src/engines/myengine.ts` implementing the `Engine` interface from `types.ts`
2. Register it in `src/engines/index.ts`
3. Add detection + install logic
4. Test: `tb --engine myengine open http://example.com`

## Testing

```bash
tb open http://example.com && tb title && tb screenshot /tmp/test.png && tb stop
```
