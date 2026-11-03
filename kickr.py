"""Wahoo KICKR BLE diagnostics.

Subcommands:
  scan     find BLE devices advertising cycling services
  inspect  connect and dump services, characteristics, device info
  monitor  subscribe to CPS / CSC / FTMS, print live values, log raw packets to JSONL
  analyze  summarise a JSONL log: notification gaps, stalled counters, value drops
"""

import argparse
import asyncio
import json
import struct
import sys
import time
from datetime import datetime
from pathlib import Path

from bleak import BleakClient, BleakScanner

DEFAULT_NAME = "KICKR 9B08"
LOG_DIR = Path("tmp") / "logs"

SVC_CPS = "00001818-0000-1000-8000-00805f9b34fb"
SVC_CSC = "00001816-0000-1000-8000-00805f9b34fb"
SVC_FTMS = "00001826-0000-1000-8000-00805f9b34fb"
CHR_CPS_MEAS = "00002a63-0000-1000-8000-00805f9b34fb"
CHR_CSC_MEAS = "00002a5b-0000-1000-8000-00805f9b34fb"
CHR_FTMS_BIKE = "00002ad2-0000-1000-8000-00805f9b34fb"
CHR_FTMS_STATUS = "00002ada-0000-1000-8000-00805f9b34fb"
DEVICE_INFO = {
    "manufacturer": "00002a29-0000-1000-8000-00805f9b34fb",
    "model": "00002a24-0000-1000-8000-00805f9b34fb",
    "serial": "00002a25-0000-1000-8000-00805f9b34fb",
    "hardware_rev": "00002a27-0000-1000-8000-00805f9b34fb",
    "firmware_rev": "00002a26-0000-1000-8000-00805f9b34fb",
    "software_rev": "00002a28-0000-1000-8000-00805f9b34fb",
}
CHR_BATTERY = "00002a19-0000-1000-8000-00805f9b34fb"
CYCLING_SVCS = {SVC_CPS, SVC_CSC, SVC_FTMS}


# ---------------------------------------------------------------- decoders


def decode_cps(data: bytes) -> dict:
    flags, power = struct.unpack_from("<Hh", data, 0)
    off = 4
    out = {"flags": flags, "power_w": power}
    if flags & 0x01:
        out["pedal_balance"] = data[off] / 2
        off += 1
    if flags & 0x04:
        out["accum_torque"] = struct.unpack_from("<H", data, off)[0] / 32
        off += 2
    if flags & 0x10:
        revs, t = struct.unpack_from("<IH", data, off)
        out["wheel_revs"], out["wheel_time"] = revs, t  # time unit 1/2048 s
        off += 6
    if flags & 0x20:
        revs, t = struct.unpack_from("<HH", data, off)
        out["crank_revs"], out["crank_time"] = revs, t  # time unit 1/1024 s
        off += 4
    return out


def decode_csc(data: bytes) -> dict:
    flags = data[0]
    off = 1
    out = {"flags": flags}
    if flags & 0x01:
        revs, t = struct.unpack_from("<IH", data, off)
        out["wheel_revs"], out["wheel_time"] = revs, t  # 1/1024 s
        off += 6
    if flags & 0x02:
        revs, t = struct.unpack_from("<HH", data, off)
        out["crank_revs"], out["crank_time"] = revs, t  # 1/1024 s
    return out


def decode_ftms_bike(data: bytes) -> dict:
    flags = struct.unpack_from("<H", data, 0)[0]
    off = 2
    out = {"flags": flags}
    if not flags & 0x0001:  # bit0 "More Data" is inverted: 0 => speed present
        out["speed_kmh"] = struct.unpack_from("<H", data, off)[0] / 100
        off += 2
    if flags & 0x0002:
        out["avg_speed_kmh"] = struct.unpack_from("<H", data, off)[0] / 100
        off += 2
    if flags & 0x0004:
        out["cadence_rpm"] = struct.unpack_from("<H", data, off)[0] / 2
        off += 2
    if flags & 0x0008:
        out["avg_cadence_rpm"] = struct.unpack_from("<H", data, off)[0] / 2
        off += 2
    if flags & 0x0010:
        out["distance_m"] = int.from_bytes(data[off : off + 3], "little")
        off += 3
    if flags & 0x0020:
        out["resistance"] = struct.unpack_from("<h", data, off)[0]
        off += 2
    if flags & 0x0040:
        out["power_w"] = struct.unpack_from("<h", data, off)[0]
        off += 2
    return out


DECODERS = {
    CHR_CPS_MEAS: ("cps", decode_cps),
    CHR_CSC_MEAS: ("csc", decode_csc),
    CHR_FTMS_BIKE: ("ftms", decode_ftms_bike),
}


class RateTracker:
    """Derives rpm from cumulative revs + event time, as Zwift does."""

    def __init__(self, rev_mod: int, time_unit: float):
        self.rev_mod, self.time_unit, self.prev = rev_mod, time_unit, None

    def update(self, revs: int, t: int):
        prev, self.prev = self.prev, (revs, t)
        if prev is None:
            return None
        drev = (revs - prev[0]) % self.rev_mod
        dt = ((t - prev[1]) % 65536) / self.time_unit
        if dt == 0:
            return "stale" if drev == 0 else None
        return 60 * drev / dt


# ---------------------------------------------------------------- commands


async def find_device(name: str, timeout: float):
    print(f"Scanning {timeout:.0f}s for '{name}' ...", flush=True)
    dev = await BleakScanner.find_device_by_filter(
        lambda d, ad: (d.name or ad.local_name or "").find(name) >= 0, timeout=timeout
    )
    if dev is None:
        sys.exit(
            f"'{name}' not found. Close Zwift/Wahoo app (they hold the connection), "
            "pedal to wake the trainer, retry."
        )
    return dev


async def cmd_scan(args):
    found = await BleakScanner.discover(timeout=args.timeout, return_adv=True)
    for dev, ad in sorted(found.values(), key=lambda x: -x[1].rssi):
        uuids = set(ad.service_uuids)
        tag = ",".join(
            n for n, u in (("CPS", SVC_CPS), ("CSC", SVC_CSC), ("FTMS", SVC_FTMS)) if u in uuids
        )
        if tag or args.all:
            print(f"{ad.rssi:>4} dBm  {dev.address}  {ad.local_name or dev.name!s:<24} {tag}")


async def cmd_inspect(args):
    dev = await find_device(args.name, args.timeout)
    async with BleakClient(dev) as c:
        print(f"Connected {dev.name} {dev.address}\n")
        for key, uuid in DEVICE_INFO.items():
            try:
                print(f"  {key:<14} {(await c.read_gatt_char(uuid)).decode(errors='replace')}")
            except Exception as e:  # characteristic absent is informative, not fatal
                print(f"  {key:<14} <{type(e).__name__}>")
        try:
            print(f"  {'battery':<14} {(await c.read_gatt_char(CHR_BATTERY))[0]}%")
        except Exception:
            pass
        print()
        for s in c.services:
            print(f"[service] {s.uuid}  {s.description}")
            for ch in s.characteristics:
                print(f"    {ch.uuid}  {','.join(ch.properties):<40} {ch.description}")


async def cmd_monitor(args):
    dev = await find_device(args.name, args.timeout)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    path = LOG_DIR / f"kickr_{datetime.now():%Y%m%d_%H%M%S}.jsonl"
    log = path.open("w")
    trackers = {
        ("cps", "wheel"): RateTracker(2**32, 2048),
        ("cps", "crank"): RateTracker(2**16, 1024),
        ("csc", "wheel"): RateTracker(2**32, 1024),
        ("csc", "crank"): RateTracker(2**16, 1024),
    }
    t0 = time.monotonic()
    disconnected = asyncio.Event()

    def on_disconnect(_):
        print(f"\n!!! DISCONNECTED at t={time.monotonic() - t0:.1f}s", flush=True)
        log.write(json.dumps({"t": time.monotonic() - t0, "event": "disconnect"}) + "\n")
        disconnected.set()

    def handler(uuid):
        src, decode = DECODERS[uuid]

        def cb(_ch, data: bytearray):
            t = time.monotonic() - t0
            d = decode(bytes(data))
            for kind in ("wheel", "crank"):
                if f"{kind}_revs" in d:
                    d[f"{kind}_rpm"] = trackers[(src, kind)].update(
                        d[f"{kind}_revs"], d[f"{kind}_time"]
                    )
            log.write(json.dumps({"t": round(t, 4), "src": src, "raw": data.hex(), **d}) + "\n")
            log.flush()
            fields = " ".join(
                f"{k}={v:.1f}" if isinstance(v, float) else f"{k}={v}"
                for k, v in d.items()
                if k != "flags"
            )
            print(f"{t:8.2f}s {src:<4} {fields}", flush=True)

        return cb

    async with BleakClient(dev, disconnected_callback=on_disconnect) as c:
        available = {ch.uuid for s in c.services for ch in s.characteristics}
        subs = [u for u in DECODERS if u in available]
        print(f"Connected. Subscribing: {[DECODERS[u][0] for u in subs]}  -> {path}")
        if not subs:
            sys.exit("No CPS/CSC/FTMS measurement characteristic found.")
        for u in subs:
            await c.start_notify(u, handler(u))
        try:
            await asyncio.wait_for(disconnected.wait(), timeout=args.duration)
        except asyncio.TimeoutError:
            pass
    log.close()
    print(f"\nLog: {path}\nRun: uv run kickr.py analyze {path}")


def cmd_analyze(args):
    rows = [json.loads(l) for l in Path(args.log).read_text().splitlines()]
    events = [r for r in rows if "event" in r]
    by_src: dict[str, list] = {}
    for r in rows:
        if "src" in r:
            by_src.setdefault(r["src"], []).append(r)
    print(f"{len(rows)} records, events: {events or 'none'}\n")
    for src, rs in by_src.items():
        ts = [r["t"] for r in rs]
        gaps = [(b - a, a) for a, b in zip(ts, ts[1:])]
        dur = ts[-1] - ts[0]
        print(f"== {src}: {len(rs)} packets over {dur:.1f}s ({len(rs) / max(dur, 1e-9):.1f} Hz)")
        big = sorted((g for g in gaps if g[0] > 1.5), reverse=True)
        print(f"   notification gaps >1.5s: {len(big)}" + (
            "  worst: " + ", ".join(f"{g:.1f}s@{a:.0f}s" for g, a in big[:5]) if big else ""))
        for kind in ("wheel", "crank"):
            key = f"{kind}_revs"
            if key not in rs[0]:
                continue
            stale = run = longest = 0
            for a, b in zip(rs, rs[1:]):
                if b[key] == a[key] and b[f"{kind}_time"] == a[f"{kind}_time"]:
                    stale += 1
                    run += 1
                    longest = max(longest, run)
                else:
                    run = 0
            rpms = [r[f"{kind}_rpm"] for r in rs if isinstance(r.get(f"{kind}_rpm"), float)]
            print(f"   {kind}: stale packets {stale} (longest run {longest}), "
                  f"rpm min/median/max = {_stats(rpms)}")
        for k in ("power_w", "cadence_rpm", "speed_kmh"):
            vals = [r[k] for r in rs if k in r]
            if vals:
                zeros = sum(1 for v in vals if v == 0)
                print(f"   {k}: min/median/max = {_stats(vals)}, zeros {zeros}/{len(vals)}")
        print()


def _stats(v):
    if not v:
        return "n/a"
    s = sorted(v)
    return f"{s[0]:.1f}/{s[len(s) // 2]:.1f}/{s[-1]:.1f}"


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("scan", "inspect", "monitor"):
        sp = sub.add_parser(name)
        sp.add_argument("--timeout", type=float, default=10.0, help="scan seconds")
        if name != "scan":
            sp.add_argument("--name", default=DEFAULT_NAME)
    sub.choices["scan"].add_argument("--all", action="store_true", help="show non-cycling devices")
    sub.choices["monitor"].add_argument("--duration", type=float, default=120.0)
    sub.add_parser("analyze").add_argument("log")
    args = p.parse_args()
    if args.cmd == "analyze":
        cmd_analyze(args)
    else:
        asyncio.run({"scan": cmd_scan, "inspect": cmd_inspect, "monitor": cmd_monitor}[args.cmd](args))


if __name__ == "__main__":
    main()
