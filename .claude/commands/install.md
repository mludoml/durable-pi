---
description: Install Durable Pi: prerequisites, .env, app dependencies, the web UI build, this machine's device config and the optional proactive demo
---

# Install Durable Pi (Durable Agent Network)

## Purpose

Set up this checkout so this machine can run a `dpi-backend` device, the web hub and the terminal client. Check prerequisites, confirm model access (an OpenRouter key, a subscription login or an Ollama Cloud key), install the four network apps, build the web UI, write this machine's device config, and verify with the test suite. This is an interactive, agentic process: ask the user when a choice is needed.

## Variables

SOURCE_REPO: the directory this command runs from (the repo root, where `justfile` lives)
NETWORK_FILE: `dpi-network.yaml` (gitignored device declarations; template `dpi-network.example.yaml`; every `just net` recipe takes an id from it)
ENV_FILE: `.env` at the repo root (template: `.env.example`)
DEVICE_HOME: `~/.dpi` (`backend.env` with the device token, `backend/` data, `network.sqlite` hub registry)
APPS: `apps/dpi-sdk`, `apps/dpi-backend`, `apps/dpi-playground`, `apps/dpi-tui`

## Codebase Structure

```text
justfile                 # groups: net, backend, hub, tui, test, proactive (just/<group>/mod.just)
dpi-network.example.yaml # template: defaults + the local device, commented ssh and exe-dev examples
.env.example             # OPENROUTER_API_KEY (copied into each device's backend.env), optional Anthropic/OpenAI/Ollama keys, TypeSafe and ElevenLabs settings
apps/dpi-sdk/            # contract, client, models, registry, ops drivers (scripts/net.ts)
apps/dpi-backend/        # the device server (port 4780)
apps/dpi-playground/     # hub + Vue web UI (port 4781)
apps/dpi-tui/            # terminal client
apps/proactive-dpi-demo/ # the hook: proactive incident agent (just proactive install, reset, build)
```

## Instructions

- Run every check via Bash. Do not assume anything is installed.
- Show a status line right after each check (pass or fail).
- Install auto-installable items without asking. Ask the user before anything that needs their input.
- Never read, print or echo an API key value. Only confirm that it is set.
- Never start servers or long-running processes (`just backend run`, `just hub start`, `just tui attach`). Only verify readiness.
- Do not run `just net up` for any device except `local`. Remote devices need the user's own ssh hosts or exe.dev account, so leave them for the user to add.
- Do not run the device suites (`just test device`, `just test e2e`): they call a real model and cost money.

## Workflow

### Step 1 — Check Prerequisites

Critical, so stop and guide the user if any is missing:

1. `command -v node && node -v`: Node.js **24 or newer** (the backend uses `node:sqlite`). Install with nvm (https://github.com/nvm-sh/nvm): `nvm install 24 && nvm use 24`, or from https://nodejs.org.
2. `command -v npm && npm -v`.
3. `command -v just && just --version`: install with `brew install just` or see https://github.com/casey/just.
4. `command -v zsh`: every `just` recipe runs in zsh. macOS ships it; on Linux install it with `sudo apt install zsh` (or your package manager).
5. `command -v git`.

Optional, so report them and continue:

6. `command -v ssh && command -v rsync`: needed only to deploy to remote `ssh` or `exe-dev` devices.
7. `command -v tmux`: the TUI smoke test and the e2e scenario (`just test smoke`, `just test e2e`). `brew install tmux`.
8. A browser for the Playwright UI suites: Google Chrome (`test -d "/Applications/Google Chrome.app"` on macOS, `command -v google-chrome` on Linux) is the default. Without it, run `npx playwright install firefox` in `apps/dpi-playground` and set `DPI_TEST_BROWSER=firefox` for the suites (Playwright's own Firefox, separate from an installed one).
9. `command -v curl && command -v sqlite3 && command -v openssl`: the one-request curl recipe and the smoke script.

### Step 2 — Check Environment

1. If `.env` is missing, copy the template: `cp .env.example .env`.
2. Ask the user how this device reaches models. Any of these works, and several can be combined:
   - **OpenRouter key:** the user pastes it into `.env` (https://openrouter.ai/keys). Do not ask for the key in chat.
   - **Subscription login:** `just backend login anthropic` (Claude Pro/Max) or `just backend login openai` (Sign in with ChatGPT, the Codex subscription). The user runs it, not you: it opens a browser. It needs `just install` first, so ask for it after Step 3, and confirm with `just backend auth` (shows provider and credential type, never secrets). Credentials go to `~/.dpi/auth.json`. Warn that Anthropic allows Claude subscription OAuth only in Claude Code and claude.ai, so the account may get restricted; an `ANTHROPIC_API_KEY` avoids that.
   - **Ollama Cloud key:** the user sets `OLLAMA_API_KEY` in `.env`.

   Any provider other than `openrouter` must be named in `dpi-network.yaml` under `defaults.env` (for example `DPI_PROVIDER: openrouter,anthropic,openai,ollama-cloud`), and any key other than `OPENROUTER_API_KEY` must be added to `env_keys`. Edit the file after Step 4 creates it and before `just net up local`.
3. Confirm keys without printing them: `for k in OPENROUTER_API_KEY OLLAMA_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY; do grep -Eq "^$k=.*[^.]$" .env && echo "$k set" || echo "$k missing"; done`. The pattern skips empty values and placeholders like `sk-or-...`.
4. If there is no model access and the user wants to continue anyway, tell them the backend can run with the free deterministic model: `DPI_PROVIDER=faux just backend run`.
5. Optional, for the proactive demo's voice line: `grep -Eq '^ELEVENLABS_API_KEY=.+' .env && echo set || echo "not set (the demo runs, the voice line is skipped)"`. The line plays through `afplay` on macOS and in the browser elsewhere; `ELEVENLABS_VOICE_ID` picks another voice from the user's ElevenLabs account.

### Step 3 — Install Dependencies

1. `just install`: `npm install` in the four network apps.
2. Ask whether to also set up the proactive demo, the video's hook: a watcher sends every log row to Jev, and a durable agent fixes the incident and waits for deploy approval. If yes, run `just proactive install`, `just proactive reset` (builds the mock checkout-api git repo with the bug) and `just proactive build`. It uses `OPENROUTER_API_KEY` for Sonnet 5.5 and Jev, and serves `http://localhost:4790` on loopback only (`--host 0.0.0.0` opts in to the LAN; the UI has no login).

### Step 4 — Verify Configuration

1. If `dpi-network.yaml` is missing, create it: `cp dpi-network.example.yaml dpi-network.yaml`. Never overwrite an existing one.
2. `just net ids`: the file parses and lists device ids. Confirm `local` is among them.
3. `just net up local`: writes `~/.dpi/backend.env` with a fresh `DPI_TOKEN` (or keeps an existing one), copies the `env_keys` from `.env` and the `env` settings, and registers the device in `~/.dpi/network.sqlite`. Then confirm `test -f ~/.dpi/backend.env && stat -f '%Lp' ~/.dpi/backend.env` (Linux: `stat -c '%a'`) shows `600`. Never print the file.
4. `just hub build`: type-checks and builds the web UI that `just hub start` serves.
5. Tell the user that new sessions start in `~/dpi-work` (created by `just net up local`) unless they set `start_dirs`, that any existing folder on the device works as a session cwd, and that remote machines are added by uncommenting the `ssh` or `exe-dev` example in `dpi-network.yaml` and running `just net up <id>`.

### Step 5 — Verify Readiness

1. `just --list`: shows the groups net, backend, hub, tui, test and proactive.
2. `just check`: type checks and unit tests for every app. They use the faux model, so they need no network and cost nothing (under a minute).
3. Optional, if a browser from item 8 is set up: `just test ui` (prefix `DPI_TEST_BROWSER=firefox` when using Playwright's Firefox), the 28-check web UI suite against two faux devices (under a minute).

### Step 6 — Report

Print a table with one row per check: each required prerequisite (node, npm, just, zsh, git), model access (which of OpenRouter key, subscription login, Ollama Cloud key), `just install`, `just net ids`, `just net up local`, `just hub build`, `just check` and the optional items (including the proactive demo setup and the ElevenLabs key). Mark each `pass`, `fail` or `skipped`, then give a ready count (for example `11 of 11 required checks pass`).

Next steps, in order (each in its own terminal):

```bash
just backend run              # this machine's device server on :4780
just hub start                # web UI: http://localhost:4781
just tui attach local         # terminal client on the same device
just net status               # probe every device in dpi-network.yaml
just net up <id>              # after uncommenting an ssh or exe-dev example in dpi-network.yaml
just proactive take           # the proactive demo: prints the URL; the agent asks to deploy within about 30s
```
