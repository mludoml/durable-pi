# Test suites. Device suites use a real model and cost money; `unit` and `ui` do not.

set shell := ["zsh", "-cu"]
set positional-arguments

# List test commands
[default]
[no-cd]
default:
    @just --list test

# Type checks and unit tests, every app
[no-cd]
unit:
    cd apps/dpi-sdk && npm run check && npm test
    cd apps/dpi-backend && npm run check && npm test
    cd apps/dpi-playground && npm run build && npm run lint && npm test
    cd apps/dpi-tui && npm run check && npm test

# Web UI suite against two faux devices (builds the UI first)
[no-cd]
ui:
    cd apps/dpi-playground && npm run build && node tests/network-ui.mjs

hub-url := env("DPI_URL", "http://localhost:4781")
# Device suites drive the running hub; fail with the fix instead of a bare fetch error.
hub-up := 'curl -sf -o /dev/null "' + hub-url + '/api/network" || { echo "No hub at ' + hub-url + '. Start it in another terminal: just hub start (and the device: just backend run)" >&2; exit 1; }'

# UI and agent suites on one device
[no-cd]
device DEVICE:
    @{{ hub-up }}
    cd apps/dpi-playground && for t in device-ui agent-features browser-close; do DPI_DEVICE="$1" node tests/$t.mjs || exit 1; done

# Device suites on every YAML device
[no-cd]
devices:
    for d in $(just net ids); do just test device "$d" || exit 1; done

# TUI smoke: faux, or a device id
[no-cd]
smoke TARGET="faux":
    apps/dpi-tui/tests/smoke.sh "$1"

# TUI + web + restart + fork scenario
[no-cd]
e2e DEVICE:
    @{{ hub-up }}
    cd apps/dpi-playground && DPI_DEVICE="$1" node tests/e2e-network.mjs
