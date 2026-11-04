.PHONY: scan inspect monitor analyze

scan:
	uv run kickr.py scan

inspect:
	uv run kickr.py inspect

# Pedal ~110rpm during the run. DURATION in seconds.
monitor:
	uv run kickr.py monitor --duration $(or $(DURATION),120)

.PHONY: serve status tail
# Always-on BLE monitor + web UI at http://127.0.0.1:8765. Restarts itself if the process dies.
serve: web
	@mkdir -p tmp/logs
	@until uv run service.py; do echo "service exited ($$?), restarting in 3s" | tee -a tmp/logs/service.log; sleep 3; done

# Kill only the python child; the `serve` supervisor loop relaunches it
restart:
	-pkill -f "[p]ython[0-9.]* service.py"

status:
	@cat tmp/logs/status.json

tail:
	tail -f tmp/logs/service.log

# Analyze the newest log
analyze:
	uv run kickr.py analyze $$(ls -t tmp/logs/*.jsonl | head -1)

.PHONY: web theme web-dev serve-sim test-e2e
# Sync the OsakaNights design profile into the app (index.css vars + Plotly theme)
theme:
	node frontend/scripts/sync-theme.mjs

# Build the shadcn web app into frontend/dist (served by service.py)
web: theme
	npm --prefix frontend run build

# Vite dev server with /api and /events proxied to the service on :8765
web-dev:
	npm --prefix frontend run dev

# Service with the simulated driver instead of hardware. SCENARIO=healthy|faulty
serve-sim: web
	uv run service.py --sim $(or $(SCENARIO),faulty) --port $(or $(PORT),8765)

# Playwright UI tests against simulated healthy and faulty services
test-e2e: web
	PLAYWRIGHT_BROWSERS_PATH=$(CURDIR)/node_modules/.cache/ms-playwright npm --prefix frontend exec playwright install chromium
	PLAYWRIGHT_BROWSERS_PATH=$(CURDIR)/node_modules/.cache/ms-playwright npm --prefix frontend exec -- playwright test --config frontend/playwright.config.ts

.PHONY: record
# Record the switchbacks and village to tmp/recordings (needs a service on PORT, e.g. make serve-sim)
record:
	PLAYWRIGHT_BROWSERS_PATH=$(CURDIR)/node_modules/.cache/ms-playwright node frontend/e2e/record-route.mjs http://127.0.0.1:$(or $(PORT),8765) tmp/recordings
