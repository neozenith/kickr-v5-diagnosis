# kickr-v5-diagnosis

Bluetooth and ANT+ tools for diagnosing a Wahoo KICKR v5 that connects but reports wrong or zero speed, cadence and power.

Findings for one faulty unit are in [docs/support-evidence.md](docs/support-evidence.md).

## Requirements

- macOS or Linux with Bluetooth LE
- [uv](https://docs.astral.sh/uv/)
- Optional: an ANT+ USB stick (Dynastream/Garmin) and `libusb`
- Node.js 20+ for the web app and tests
- Close Zwift and the Wahoo app first, so they don't hold the trainer's connections

## Usage

| Command | What it does |
| --- | --- |
| `make scan` | List nearby BLE devices that advertise cycling services |
| `make inspect` | Dump the trainer's GATT table and device information |
| `make monitor DURATION=90` | Log raw and decoded packets to `tmp/logs/*.jsonl` |
| `make analyze` | Summarise the newest log: packet gaps, frozen counters, value drops |
| `make serve` | Build the web app, then run the always-on service and dashboard at http://127.0.0.1:8765 |
| `make restart` | Restart the service process (the `serve` loop relaunches it) |
| `make status` | Print the service's current status JSON |
| `make serve-sim SCENARIO=faulty` | Run the service on the simulated driver, no hardware (`healthy` or `faulty`) |
| `make web` | Sync the design profile and build the web app into `frontend/dist` |
| `make web-dev` | Vite dev server, proxying `/api` and `/events` to the service on :8765 |
| `make test-e2e` | Playwright UI tests against simulated healthy and faulty services |
| `make record PORT=8766` | Record a video of the switchbacks and village to `tmp/recordings` |

The defaults target trainer `KICKR 9B08`, ANT+ ID `39688` and crank meter `4iiii105`. Override them with `uv run service.py --name ... --ant-id ... --crank-pm ...`.

## What the service records

- **Bluetooth:** Cycling Power (0x2A63), FTMS Indoor Bike Data (0x2AD2), FTMS status and training status, plus Wahoo's proprietary notify characteristics as raw hex.
- **ANT+:** FE-C (device type 17) and Power (type 11) pages, decoded from raw bytes, including trainer status flags and calibration pages.
- **Reference meter:** an optional independent crank power meter over Bluetooth, to compare against the trainer.
- **Watchdog:** flags stalled notification streams and wheel or crank counters that stop changing while packets keep arriving.
- **Calibration:** the dashboard can send an ANT+ FE-C spindown or zero-offset request and show the trainer's progress and result.

## Web app

- **Stack:** React, Vite and [shadcn/ui](https://ui.shadcn.com) (Base UI). All charts use Plotly.js.
- **Diagnostics page:** live verdict against the reference meter, metrics, charts, counters, ANT+ status, calibration, events, raw packets and device config.
- **Virtual route page:** a three.js loop of about 6.9 km with climbs and descents up to about 6%, a switchback descent and a cobbled festival village. Rides start at 4 km (override with `?at=<km>`). Rider speed comes from road physics, driven by reference power, trainer power or a manual slider.
- **HUDs:** a 5-minute trend of every input (top left), elevation profile (top right) and a top-down route map (bottom right).
- **Theme:** OsakaNights from the design-profiles skill, stored in `.design-profiles/`. `make theme` writes its CSS variables into `frontend/src/index.css` and its Plotly colours into `frontend/src/theme/plotly.json`.

## Simulated driver

`sim.py` encodes a scripted ride (steady, ramp, hold, coast) into the same raw BLE and ANT+ bytes the devices send, then pushes them through the service's real decoders. No hardware is needed.

- **healthy:** the trainer reports what the rider does, and spindown completes.
- **faulty:** reproduces this unit's fault. Above 12 km/h the wheel counter freezes and every trainer channel reads 0, while the crank meter keeps reporting. Spindown stays at `too_low`.

## Files

| Path | Contents |
| --- | --- |
| `kickr.py` | CLI: scan, inspect, monitor, analyze; BLE decoders |
| `service.py` | Always-on monitor, watchdog and web server |
| `ant.py` | ANT+ FE-C and Power listener and calibration requests |
| `sim.py` | Simulated KICKR, ANT+ FE-C and crank meter driver |
| `frontend/` | shadcn web app: `src/pages`, Plotly wrapper, stream store, route physics |
| `frontend/e2e/` | Playwright tests |
| `.design-profiles/` | OsakaNights design profile (seed, tokens, theme) |
| `.claude/skills/shadcn/` | Official shadcn/ui agent skill, from `shadcn-ui/ui` |
| `docs/` | Support evidence write-up and charts |
