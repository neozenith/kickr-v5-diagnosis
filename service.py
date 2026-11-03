"""KICKR diagnostic service: always-on BLE monitor + live web dashboard.

- Scans, connects, reads device config, subscribes to every notify characteristic.
- Auto-reconnects with backoff; watchdog flags stalled streams.
- Logs every packet to tmp/logs/stream_<session>.jsonl, status lines to tmp/logs/service.log,
  current state to tmp/logs/status.json.
- Serves http://127.0.0.1:8765 with an SSE stream at /events.
"""

import argparse
import asyncio
import json
import logging
import struct
import time
from collections import deque
from datetime import datetime
from pathlib import Path

from aiohttp import web
from bleak import BleakClient, BleakScanner

from ant import AntBridge
from kickr import (
    CHR_CPS_MEAS,
    CHR_FTMS_BIKE,
    DEVICE_INFO,
    RateTracker,
    decode_cps,
    decode_ftms_bike,
)

LOG_DIR = Path("tmp") / "logs"
STATIC = Path(__file__).parent / "web"
WHEEL_CIRC_M = 2.105  # 700x25c default, as Zwift uses
STALL_S = 3.0

U = "0000{}-0000-1000-8000-00805f9b34fb".format
CHR_CPS_FEATURE, CHR_SENSOR_LOC = U("2a65"), U("2a5d")
CHR_FTMS_FEATURE, CHR_FTMS_RES_RANGE, CHR_FTMS_PWR_RANGE = U("2acc"), U("2ad6"), U("2ad8")
CHR_TRAINING_STATUS, CHR_FTMS_STATUS, CHR_WEIGHT = U("2ad3"), U("2ada"), U("2a98")

CPS_FEATURE_BITS = [
    "pedal_power_balance", "accumulated_torque", "wheel_revolution_data", "crank_revolution_data",
    "extreme_magnitudes", "extreme_angles", "top_bottom_dead_spot", "accumulated_energy",
    "offset_compensation_indicator", "offset_compensation", "cpm_content_masking",
    "multiple_sensor_locations", "crank_length_adjustment", "chain_length_adjustment",
    "chain_weight_adjustment", "span_length_adjustment", "sensor_measurement_context_torque",
    "instantaneous_measurement_direction", "factory_calibration_date",
    "enhanced_offset_compensation",
]
SENSOR_LOCATIONS = [
    "Other", "Top of shoe", "In shoe", "Hip", "Front wheel", "Left crank", "Right crank",
    "Left pedal", "Right pedal", "Front hub", "Rear dropout", "Chainstay", "Rear wheel",
    "Rear hub", "Chest", "Spider", "Chain ring",
]
FTMS_MACHINE_BITS = [
    "avg_speed", "cadence", "total_distance", "inclination", "elevation_gain", "pace",
    "step_count", "resistance_level", "stride_count", "expended_energy", "heart_rate",
    "metabolic_equivalent", "elapsed_time", "remaining_time", "power_measurement",
    "force_on_belt_and_power_output", "user_data_retention",
]
FTMS_TARGET_BITS = [
    "speed_target", "inclination_target", "resistance_target", "power_target",
    "heart_rate_target", "expended_energy_target", "step_number_target", "stride_number_target",
    "distance_target", "training_time_target", "time_in_two_hr_zones", "time_in_three_hr_zones",
    "time_in_five_hr_zones", "indoor_bike_simulation", "wheel_circumference",
    "spin_down_control", "targeted_cadence",
]
FTMS_STATUS_OPS = {
    0x01: "reset", 0x02: "stopped_or_paused", 0x03: "stopped_by_safety_key", 0x04: "started",
    0x05: "target_speed_changed", 0x06: "target_incline_changed",
    0x07: "target_resistance_changed", 0x08: "target_power_changed",
    0x12: "indoor_bike_simulation_changed", 0x13: "wheel_circumference_changed",
    0x14: "spin_down_status", 0x15: "targeted_cadence_changed", 0xFF: "control_lost",
}
TRAINING_STATUS = {
    0: "other", 1: "idle", 2: "warming_up", 3: "low_intensity_interval",
    4: "high_intensity_interval", 5: "recovery_interval", 6: "isometric", 7: "heart_rate_control",
    8: "fitness_test", 9: "speed_outside_control_low", 10: "speed_outside_control_high",
    11: "cool_down", 12: "watt_control", 13: "manual_mode", 14: "pre_workout", 15: "post_workout",
}
NAMES = {
    CHR_CPS_MEAS: "cps", CHR_FTMS_BIKE: "ftms", CHR_FTMS_STATUS: "ftms_status",
    CHR_TRAINING_STATUS: "training_status",
    "a026e002-0a7d-4ab3-97fa-f1500f9feb8b": "wahoo_e002",
    "a026e004-0a7d-4ab3-97fa-f1500f9feb8b": "wahoo_e004",
    "a026e037-0a7d-4ab3-97fa-f1500f9feb8b": "wahoo_e037",
    "a026e023-0a7d-4ab3-97fa-f1500f9feb8b": "wahoo_e023",
}

log = logging.getLogger("kickr")


def bits(value: int, names: list[str]) -> list[str]:
    return [n for i, n in enumerate(names) if value >> i & 1]


def decode_ftms_status(d: bytes) -> dict:
    return {"op": FTMS_STATUS_OPS.get(d[0], f"0x{d[0]:02x}"), "param": d[1:].hex()}


def decode_training_status(d: bytes) -> dict:
    return {"status": TRAINING_STATUS.get(d[1], d[1]) if len(d) > 1 else None}


class Hub:
    """Fan-out of events to SSE clients plus a replay buffer."""

    def __init__(self):
        self.clients: set[asyncio.Queue] = set()
        self.recent: deque = deque(maxlen=3000)

    def publish(self, kind: str, payload: dict):
        msg = {"kind": kind, **payload}
        if kind == "packet":
            self.recent.append(msg)
        for q in list(self.clients):
            if q.qsize() > 5000:  # slow client: drop it rather than grow unbounded
                self.clients.discard(q)
            else:
                q.put_nowait(msg)


class Monitor:
    def __init__(self, name: str, hub: Hub):
        self.name, self.hub = name, hub
        self.session = datetime.now().strftime("%Y%m%d_%H%M%S")
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        self.stream_path = LOG_DIR / f"stream_{self.session}.jsonl"
        self.stream = self.stream_path.open("a")
        self.t0 = time.monotonic()
        self.state = "starting"
        self.config: dict = {}
        self.connects = self.disconnects = self.stalls = 0
        self.counts: dict[str, int] = {}
        self.last_rx: dict[str, float] = {}
        self.counter_changed: dict[str, float] = {}  # src.kind -> last time revs/time moved
        self.prev_counter: dict[str, tuple] = {}
        self.stalled: set[str] = set()
        self.events: deque = deque(maxlen=200)
        self.last_error = None
        self.rssi = None
        self.ant: AntBridge | None = None
        self.last_cal: dict[int, dict] = {}

    def ingest(self, src: str, d: dict):
        """Record one decoded packet from a non-BLE source (ANT+)."""
        t = self.now()
        self.counts[src] = self.counts.get(src, 0) + 1
        self.last_rx[src] = t
        rec = {"t": t, "src": src, **d}
        if src == "ant_fe" and d.get("page") in (0x01, 0x02):
            summary = {k: v for k, v in d.items() if k not in ("raw", "page")}
            if summary != self.last_cal.get(d["page"]):
                self.last_cal[d["page"]] = summary
                label = "calibration result" if d["page"] == 1 else "calibration progress"
                self.event(f"{label}: {summary}")
        self.stream.write(json.dumps(rec) + "\n")
        self.stream.flush()
        self.hub.publish("packet", rec)

    def now(self) -> float:
        return round(time.monotonic() - self.t0, 4)

    def event(self, msg: str, level=logging.INFO):
        log.log(level, msg)
        e = {"t": self.now(), "wall": datetime.now().isoformat(timespec="seconds"), "msg": msg}
        self.events.append(e)
        self.stream.write(json.dumps({"event": msg, "t": e["t"], "wall": e["wall"]}) + "\n")
        self.stream.flush()
        self.hub.publish("event", e)

    def set_state(self, s: str):
        if s != self.state:
            self.state = s
            self.event(f"state -> {s}")

    def status(self) -> dict:
        t = self.now()
        return {
            "state": self.state, "uptime_s": t, "session": self.session,
            "stream_log": str(self.stream_path), "connects": self.connects,
            "disconnects": self.disconnects, "stalls": self.stalls, "rssi": self.rssi,
            "last_error": self.last_error, "counts": self.counts,
            "last_rx_age_s": {k: round(t - v, 2) for k, v in self.last_rx.items()},
            "counter_age_s": {k: round(t - v, 2) for k, v in self.counter_changed.items()},
            "stalled": sorted(self.stalled),
            "ant_state": self.ant.state if self.ant else "disabled",
        }

    # ------------------------------------------------------------ BLE

    async def run_forever(self):
        backoff = 1.0
        while True:
            try:
                await self.session_once()
                backoff = 1.0
            except asyncio.CancelledError:
                raise
            except Exception as e:  # reconnect loop: every failure is logged, then retried
                self.last_error = f"{type(e).__name__}: {e}"
                self.event(f"error: {self.last_error}", logging.WARNING)
            self.set_state("backoff")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

    async def session_once(self):
        self.set_state("scanning")
        found = {}

        def match(d, ad):
            if self.name in (d.name or ad.local_name or ""):
                found["rssi"] = ad.rssi
                return True
            return False

        dev = await BleakScanner.find_device_by_filter(match, timeout=15)
        if dev is None:
            self.event("device not found (another app connected, or trainer asleep: pedal to wake)")
            return
        self.rssi = found.get("rssi")
        self.set_state("connecting")
        gone = asyncio.Event()

        def on_disc(_):
            self.disconnects += 1
            self.event("BLE disconnected", logging.WARNING)
            gone.set()

        async with BleakClient(dev, disconnected_callback=on_disc, timeout=20) as c:
            self.connects += 1
            self.event(f"connected {dev.name} {dev.address} rssi={self.rssi}")
            self.set_state("reading_config")
            self.config = await self.read_config(c)
            self.config["address"], self.config["rssi_at_connect"] = dev.address, self.rssi
            self.hub.publish("config", self.config)
            self.stream.write(json.dumps({"t": self.now(), "config": self.config}) + "\n")
            self.trackers = {
                "cps.wheel": RateTracker(2**32, 2048),
                "cps.crank": RateTracker(2**16, 1024),
            }
            self.prev_counter.clear()
            for s in c.services:
                for ch in s.characteristics:
                    if "notify" in ch.properties:
                        await c.start_notify(ch, self.make_handler(ch.uuid))
                        self.event(f"subscribed {NAMES.get(ch.uuid, ch.uuid)}")
            self.set_state("streaming")
            await gone.wait()

    async def read_config(self, c: BleakClient) -> dict:
        avail = {ch.uuid for s in c.services for ch in s.characteristics}
        cfg: dict = {"device_info": {}, "raw_reads": {}, "malformed": {}}

        async def rd(u, need=0):
            log.info(f"reading {u[4:8]} (connected={c.is_connected})")
            b = bytes(await c.read_gatt_char(u))
            log.info(f"read {u[4:8]} -> {b.hex() or '<empty>'}")
            cfg["raw_reads"][NAMES.get(u, u[4:8])] = b.hex()
            if not c.is_connected:
                raise ConnectionError(f"link dropped during read of {u[4:8]}")
            if len(b) < need:  # device returned short payload: record it as a finding
                cfg["malformed"][u[4:8]] = f"expected {need} bytes, got {len(b)}: {b.hex()}"
                self.event(f"short GATT read {u[4:8]}: {len(b)}/{need} bytes", logging.WARNING)
                b = b.ljust(need, b"\0")
            return b
        for k, u in DEVICE_INFO.items():
            if u in avail:
                cfg["device_info"][k] = (await rd(u)).decode(errors="replace")
        if CHR_CPS_FEATURE in avail:
            v = struct.unpack("<I", await rd(CHR_CPS_FEATURE, 4))[0]
            cfg["cps_feature"] = {"raw": f"0x{v:08x}", "flags": bits(v, CPS_FEATURE_BITS)}
        if CHR_SENSOR_LOC in avail:
            i = (await rd(CHR_SENSOR_LOC, 1))[0]
            cfg["sensor_location"] = SENSOR_LOCATIONS[i] if i < len(SENSOR_LOCATIONS) else i
        if CHR_FTMS_FEATURE in avail:
            m, t = struct.unpack("<II", await rd(CHR_FTMS_FEATURE, 8))
            cfg["ftms_feature"] = {
                "machine_raw": f"0x{m:08x}", "machine": bits(m, FTMS_MACHINE_BITS),
                "target_raw": f"0x{t:08x}", "target": bits(t, FTMS_TARGET_BITS),
            }
        if CHR_FTMS_RES_RANGE in avail:
            lo, hi, inc = struct.unpack("<hhH", await rd(CHR_FTMS_RES_RANGE, 6))
            cfg["resistance_range"] = {"min": lo / 10, "max": hi / 10, "inc": inc / 10}
        if CHR_FTMS_PWR_RANGE in avail:
            lo, hi, inc = struct.unpack("<hhH", await rd(CHR_FTMS_PWR_RANGE, 6))
            cfg["power_range_w"] = {"min": lo, "max": hi, "inc": inc}
        if CHR_TRAINING_STATUS in avail:
            cfg["training_status"] = decode_training_status(await rd(CHR_TRAINING_STATUS, 2))
        if CHR_WEIGHT in avail:
            cfg["rider_weight_kg"] = struct.unpack("<H", await rd(CHR_WEIGHT, 2))[0] * 0.005
        cfg["gatt"] = [
            {"service": s.uuid, "desc": s.description,
             "chars": [{"uuid": ch.uuid, "props": ch.properties, "desc": ch.description}
                       for ch in s.characteristics]}
            for s in c.services
        ]
        self.event(f"config read: fw={cfg['device_info'].get('firmware_rev')} "
                   f"hw={cfg['device_info'].get('hardware_rev')}")
        return cfg

    def make_handler(self, uuid: str):
        src = NAMES.get(uuid, uuid[:8])

        def cb(_ch, data: bytearray):
            t = self.now()
            raw = bytes(data)
            if uuid == CHR_CPS_MEAS:
                d = decode_cps(raw)
                for kind in ("wheel", "crank"):
                    if f"{kind}_revs" in d:
                        key = f"cps.{kind}"
                        cur = (d[f"{kind}_revs"], d[f"{kind}_time"])
                        if self.prev_counter.get(key) != cur:
                            self.counter_changed[key] = t
                        self.prev_counter[key] = cur
                        d[f"{kind}_rpm"] = self.trackers[key].update(*cur)
                if isinstance(d.get("wheel_rpm"), float):
                    d["wheel_speed_kmh"] = round(d["wheel_rpm"] * WHEEL_CIRC_M * 60 / 1000, 2)
            elif uuid == CHR_FTMS_BIKE:
                d = decode_ftms_bike(raw)
            elif uuid == CHR_FTMS_STATUS:
                d = decode_ftms_status(raw)
                self.event(f"ftms status: {d['op']} {d['param']}")
            elif uuid == CHR_TRAINING_STATUS:
                d = decode_training_status(raw)
                self.event(f"training status: {d['status']}")
            else:
                d = {}
            self.counts[src] = self.counts.get(src, 0) + 1
            self.last_rx[src] = t
            rec = {"t": t, "src": src, "raw": raw.hex(), **d}
            self.stream.write(json.dumps(rec) + "\n")
            self.stream.flush()
            self.hub.publish("packet", rec)

        return cb

    # ------------------------------------------------------------ watchdog / heartbeat

    async def heartbeat(self):
        status_path = LOG_DIR / "status.json"
        n = 0
        while True:
            await asyncio.sleep(1)
            n += 1
            t = self.now()
            ble = self.state == "streaming"
            if True:
                for src in ("cps", "ftms", "ant_fe", "ant_pm", "pm_crank"):
                    if src in self.last_rx and (ble or src.startswith(("ant", "pm_"))):
                        silent = t - self.last_rx[src]
                        tag = f"{src}.notify"
                        if silent > STALL_S and tag not in self.stalled:
                            self.stalled.add(tag)
                            self.stalls += 1
                            self.event(f"STALL: no {src} packets for {silent:.1f}s",
                                       logging.WARNING)
                        elif silent <= STALL_S and tag in self.stalled:
                            self.stalled.discard(tag)
                            self.event(f"recovered: {src} packets resumed")
                for key, changed in (self.counter_changed.items() if ble else ()):
                    tag = f"{key}.counter"
                    frozen = t - changed
                    if frozen > STALL_S and tag not in self.stalled:
                        self.stalled.add(tag)
                        alive = t - self.last_rx.get("cps", -1e9) < STALL_S
                        self.event(f"FROZEN: {key} counter unchanged {frozen:.1f}s "
                                   f"({'packets still arriving' if alive else 'no packets'})",
                                   logging.WARNING)
                    elif frozen <= STALL_S and tag in self.stalled:
                        self.stalled.discard(tag)
                        self.event(f"recovered: {key} counter moving")
            st = self.status()
            status_path.write_text(json.dumps(st, indent=1))
            self.hub.publish("status", st)
            if n % 10 == 0:
                rates = " ".join(f"{k}={v}" for k, v in self.counts.items())
                log.info(f"heartbeat state={st['state']} packets[{rates}] stalled={st['stalled']}")


# ---------------------------------------------------------------- web


def make_app(mon: Monitor, hub: Hub) -> web.Application:
    async def index(_):
        return web.FileResponse(STATIC / "index.html")

    async def status(_):
        return web.json_response(mon.status())

    async def config(_):
        return web.json_response(mon.config)

    async def events(req):
        resp = web.StreamResponse(headers={
            "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
            "Connection": "keep-alive"})
        await resp.prepare(req)
        q: asyncio.Queue = asyncio.Queue()
        hub.clients.add(q)
        init = {"kind": "init", "status": mon.status(), "config": mon.config,
                "events": list(mon.events), "recent": list(hub.recent)}
        await resp.write(f"data: {json.dumps(init)}\n\n".encode())
        try:
            while q in hub.clients:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15)
                    await resp.write(f"data: {json.dumps(msg)}\n\n".encode())
                except asyncio.TimeoutError:
                    await resp.write(b": ping\n\n")
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        finally:
            hub.clients.discard(q)
        return resp

    async def calibrate(req):
        kind = req.match_info["kind"]
        if kind not in ("spindown", "zero_offset"):
            return web.json_response({"error": f"unknown calibration {kind}"}, status=400)
        try:
            sent = mon.ant.request_calibration(kind)
        except Exception as e:
            mon.event(f"calibration {kind} NOT sent: {e}", logging.WARNING)
            return web.json_response({"error": str(e)}, status=409)
        mon.last_cal.clear()
        mon.event(f"calibration {kind} requested over ANT+ FE-C (page {sent})")
        return web.json_response({"sent": sent})

    app = web.Application()
    app.add_routes([web.post("/api/ant/calibrate/{kind}", calibrate),
                    web.get("/", index), web.get("/api/status", status),
                    web.get("/api/config", config), web.get("/events", events)])
    return app


async def crank_pm_forever(mon: Monitor, name: str, src: str = "pm_crank"):
    """Independent crank power meter over BLE CPS: ground truth for power/cadence."""
    backoff = 1.0
    while True:
        try:
            dev = await BleakScanner.find_device_by_filter(
                lambda d, ad: name in (d.name or ad.local_name or ""), timeout=15)
            if dev is None:
                mon.event(f"{name} not found (spin the cranks to wake it)")
            else:
                gone = asyncio.Event()
                async with BleakClient(dev, disconnected_callback=lambda _: gone.set(),
                                       timeout=20) as c:
                    mon.event(f"connected crank power meter {dev.name}")
                    crank = RateTracker(2**16, 1024)

                    def cb(_ch, data: bytearray):
                        d = decode_cps(bytes(data))
                        if "crank_revs" in d:
                            d["crank_rpm"] = crank.update(d["crank_revs"], d["crank_time"])
                        mon.ingest(src, {"raw": bytes(data).hex(), **d})

                    await c.start_notify(CHR_CPS_MEAS, cb)
                    backoff = 1.0
                    await gone.wait()
                    mon.event(f"{name} disconnected", logging.WARNING)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # reconnect loop: log and retry
            mon.event(f"{name} error: {type(e).__name__}: {e}", logging.WARNING)
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 30)


async def main_async(args):
    hub = Hub()
    mon = Monitor(args.name, hub)
    runner = web.AppRunner(make_app(mon, hub))
    await runner.setup()
    await web.TCPSite(runner, args.host, args.port).start()
    mon.event(f"web UI http://{args.host}:{args.port}  stream log {mon.stream_path}")
    loop = asyncio.get_running_loop()
    mon.ant = AntBridge(
        args.ant_id,
        sink=lambda src, d: loop.call_soon_threadsafe(mon.ingest, src, d),
        note=lambda msg, lvl: loop.call_soon_threadsafe(mon.event, msg, lvl),
    )
    mon.ant.start()
    await asyncio.gather(mon.run_forever(), mon.heartbeat(),
                         crank_pm_forever(mon, args.crank_pm))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--name", default="KICKR 9B08")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--ant-id", type=int, default=39688, help="ANT+ device number")
    p.add_argument("--crank-pm", default="4iiii105", help="BLE name of crank power meter")
    args = p.parse_args()
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.FileHandler(LOG_DIR / "service.log"), logging.StreamHandler()])
    logging.getLogger("openant").setLevel(logging.WARNING)  # its per-page INFO lines flood the log
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
