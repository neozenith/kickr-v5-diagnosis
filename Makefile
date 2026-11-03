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
serve:
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
