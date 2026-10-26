# dpi-backend on this machine. Remote devices run it as a service (see `just net`).

set shell := ["zsh", "-cu"]
set positional-arguments
set working-directory := "../../apps/dpi-backend"

free-port := source_directory() / ".." / "free-port.sh"
# The port the backend will bind: $DPI_PORT, else DPI_PORT in ~/.dpi/backend.env, else 4780.
port := 'p=${DPI_PORT:-$(sed -n "s/^DPI_PORT=//p" "${DPI_HOME:-$HOME/.dpi}/backend.env" 2>/dev/null | head -1)}; echo ${p:-4780}'

# List backend commands
[default]
default:
    @just --list backend

# Run this machine's backend (frees the port first)
run *ARGS:
    @{{ free-port }} "$({{ port }})"
    npm start -- "$@"

# Run with restart on file changes (frees the port)
dev *ARGS:
    @{{ free-port }} "$({{ port }})"
    npm run dev -- "$@"

# Create ~/.dpi/backend.env with a token
token:
    npm run token

# Sign this device in to a subscription provider (anthropic, openai or openrouter)
login PROVIDER:
    npm run login -- login "$1"

# Remove a provider's stored credential
logout PROVIDER:
    npm run login -- logout "$1"

# List stored provider credentials (types only, never secrets)
auth:
    npm run login -- status

# Type check and run backend tests
check:
    npm run check
    npm test
