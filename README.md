# kickr-v5-diagnosis

Bluetooth and ANT+ tools for diagnosing a Wahoo KICKR v5 that connects but reports wrong or zero speed, cadence and power.

Findings for one faulty unit are in [docs/support-evidence.md](docs/support-evidence.md).

## Requirements

- macOS or Linux with Bluetooth LE
- [uv](https://docs.astral.sh/uv/)
- Optional: an ANT+ USB stick (Dynastream/Garmin) and `libusb`
- Close Zwift and the Wahoo app first, so they don't hold the trainer's connections

## Usage

| Command | What it does |
| --- | --- |
| `make scan` | List nearby BLE devices that advertise cycling services |
| `make inspect` | Dump the trainer's GATT table and device information |
| `make monitor DURATION=90` | Log raw and decoded packets to `tmp/logs/*.jsonl` |
| `make analyze` | Summarise the newest log: packet gaps, frozen counters, value drops |
| `make serve` | Run the always-on service and live dashboard at http://127.0.0.1:8765 |
| `make restart` | Restart the service process (the `serve` loop relaunches it) |
| `make status` | Print the service's current status JSON |

The defaults target trainer `KICKR 9B08`, ANT+ ID `39688` and crank meter `4iiii105`. Override them with `uv run service.py --name ... --ant-id ... --crank-pm ...`.

## What the service records

- **Bluetooth:** Cycling Power (0x2A63), FTMS Indoor Bike Data (0x2AD2), FTMS status and training status, plus Wahoo's proprietary notify characteristics as raw hex.
- **ANT+:** FE-C (device type 17) and Power (type 11) pages, decoded from raw bytes, including trainer status flags and calibration pages.
- **Reference meter:** an optional independent crank power meter over Bluetooth, to compare against the trainer.
- **Watchdog:** flags stalled notification streams and wheel or crank counters that stop changing while packets keep arriving.
- **Calibration:** the dashboard can send an ANT+ FE-C spindown or zero-offset request and show the trainer's progress and result.

## Files

| Path | Contents |
| --- | --- |
| `kickr.py` | CLI: scan, inspect, monitor, analyze; BLE decoders |
| `service.py` | Always-on monitor, watchdog and web server |
| `ant.py` | ANT+ FE-C and Power listener and calibration requests |
| `web/index.html` | Live dashboard |
| `docs/` | Support evidence write-up and charts |
