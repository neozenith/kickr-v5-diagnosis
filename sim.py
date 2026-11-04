"""Simulated KICKR, ANT+ FE-C and crank power meter driver.

Encodes a scripted ride into the same raw byte packets the real devices send, then
feeds them through the service's real decode paths (Monitor.make_handler for BLE
notifications, ant.decode_fe for ANT+, decode_cps + RateTracker for the crank meter).

Scenarios:
- healthy: the trainer reports what the rider does.
- faulty:  reproduces the KICKR 9B08 fault. Above FAULT_KMH the trainer's wheel
           counter freezes, so speed, cadence and power read 0 on every channel,
           while the crank meter keeps reporting the truth. Spindown never reaches
           its target speed.
"""

import asyncio
import math
import random
import struct
from dataclasses import dataclass, field

from ant import decode_fe
from kickr import CHR_CPS_MEAS, CHR_FTMS_BIKE, RateTracker, decode_cps

HZ = 4  # notification rate of the real KICKR
WHEEL_CIRC_M = 2.105
FAULT_KMH = 12.0  # above this the faulty trainer's speed sensor drops out
SPINDOWN_TARGET_KMH = 32.1
SCENARIOS = ("healthy", "faulty")

# Ride script, looped: (duration s, start power W, end power W, start rpm, end rpm)
SCRIPT = [
    (12, 180, 180, 88, 88),  # steady
    (12, 180, 450, 88, 112),  # ramp to peak
    (4, 450, 450, 112, 112),  # hold peak
    (18, 0, 0, 0, 0),  # coast
]
CYCLE_S = sum(s[0] for s in SCRIPT)

SIM_CONFIG = {
    "simulated": True,
    "device_info": {
        "manufacturer": "Wahoo Fitness (simulated)", "model_number": "KICKR",
        "firmware_rev": "4.5.74", "hardware_rev": "5", "serial_number": "SIM-0000",
    },
    "cps_feature": {"raw": "0x0000000c",
                    "flags": ["wheel_revolution_data", "crank_revolution_data"]},
    "sensor_location": "Rear hub",
    "ftms_feature": {"machine_raw": "0x00004082", "machine": ["cadence", "power_measurement"],
                     "target_raw": "0x0000e00c", "target": ["resistance_target", "power_target",
                                                            "indoor_bike_simulation"]},
    "resistance_range": {"min": 0.0, "max": 100.0, "inc": 1.0},
    "power_range_w": {"min": 0, "max": 2200, "inc": 1},
    "address": "SIM:00:00:00:9B:08",
    "rssi_at_connect": -55,
    "gatt": [],
}


def rider_at(t: float) -> tuple[float, float]:
    """Scripted rider (power W, cadence rpm) at time t, looping every CYCLE_S."""
    t %= CYCLE_S
    for dur, p0, p1, c0, c1 in SCRIPT:
        if t < dur:
            f = t / dur
            return p0 + (p1 - p0) * f, c0 + (c1 - c0) * f
        t -= dur
    raise AssertionError("unreachable: t within CYCLE_S")


def flywheel_step(v: float, power: float, dt: float) -> float:
    """Advance flywheel speed (m/s) one step: air drag, rolling and eddy brake on 20 kg."""
    mass, cda, crr, rho, eddy = 20.0, 0.32, 0.004, 1.2, 2.0
    drive = power / max(v, 1.0)
    resist = 0.5 * rho * cda * v * v + crr * mass * 9.81 + eddy * v
    return max(0.0, v + (drive - resist) / mass * dt)


def cps_packet(power: int, wheel_revs: int, wheel_t: int, crank_revs: int, crank_t: int) -> bytes:
    flags = 0x10 | 0x20
    return struct.pack("<HhIHHH", flags, power, wheel_revs % 2**32, wheel_t % 65536,
                       crank_revs % 65536, crank_t % 65536)


def crank_cps_packet(power: int, crank_revs: int, crank_t: int) -> bytes:
    return struct.pack("<HhHH", 0x20, power, crank_revs % 65536, crank_t % 65536)


def ftms_packet(speed_kmh: float, cadence: float, power: int) -> bytes:
    flags = 0x0004 | 0x0040  # speed (bit0 clear), cadence, power
    return struct.pack("<HHHh", flags, round(speed_kmh * 100), round(cadence * 2), power)


def fe_page_0x10(speed_kmh: float) -> list[int]:
    s = round(speed_kmh / 0.0036)
    return [0x10, 25, 0, 0, s & 0xFF, s >> 8 & 0xFF, 0xFF, 0x30]  # bike trainer, in_use


def fe_page_0x19(event: int, cadence: int, accum: int, power: int, cal_required: bool) -> list[int]:
    status = 0x1 if cal_required else 0
    return [0x19, event & 0xFF, cadence & 0xFF, accum & 0xFF, accum >> 8 & 0xFF,
            power & 0xFF, (power >> 8 & 0x0F) | status << 4, 0x30]


def fe_page_0x02(speed_ok: bool) -> list[int]:
    target = round(SPINDOWN_TARGET_KMH / 0.0036)
    cond = (2 if speed_ok else 1) << 6 | 2 << 4  # speed ok/too_low, temperature ok
    return [0x02, 0x80, cond, 0x5A, target & 0xFF, target >> 8, 0xFF, 0xFF]


def fe_page_0x01(spindown_ms: int) -> list[int]:
    return [0x01, 0x80, 0, 0x5A, 0xFF, 0xFF, spindown_ms & 0xFF, spindown_ms >> 8]


@dataclass
class Counter:
    """Cumulative revolution counter with event timestamp, as BLE CPS reports it."""

    unit: float  # ticks per second
    revs: float = 0.0
    revs_int: int = 0
    event_t: int = 0

    def advance(self, rpm: float, now: float):
        self.revs += rpm / 60 / HZ
        if int(self.revs) != self.revs_int:
            self.revs_int = int(self.revs)
            # Event time is when the last whole revolution completed, not the packet tick.
            since = (self.revs - self.revs_int) / (rpm / 60)
            self.event_t = round((now - since) * self.unit)


@dataclass
class SimAnt:
    """Stands in for AntBridge: same .state and .request_calibration surface."""

    state: str = "simulated"
    pending: str | None = None
    since: float = 0.0
    clock: float = field(default=0.0, repr=False)

    def request_calibration(self, kind: str) -> str:
        self.pending, self.since = kind, self.clock
        return "0x01"


class SimDriver:
    def __init__(self, mon, scenario: str, seed: int = 1):
        if scenario not in SCENARIOS:
            raise ValueError(f"unknown scenario {scenario!r}, expected one of {SCENARIOS}")
        self.mon, self.scenario = mon, scenario
        self.rng = random.Random(seed)
        self.ant = SimAnt()
        mon.ant = self.ant
        self.cps_cb = mon.make_handler(CHR_CPS_MEAS)
        self.ftms_cb = mon.make_handler(CHR_FTMS_BIKE)
        self.pm_tracker = RateTracker(2**16, 1024)

    def trainer_sees(self, true_kmh: float) -> bool:
        return self.scenario == "healthy" or true_kmh < FAULT_KMH

    async def run(self):
        mon = self.mon
        mon.set_state("connecting")
        mon.connects += 1
        mon.rssi = SIM_CONFIG["rssi_at_connect"]
        mon.event(f"connected simulated KICKR ({self.scenario}) rssi={mon.rssi}")
        mon.config = dict(SIM_CONFIG, scenario=self.scenario)
        mon.hub.publish("config", mon.config)
        mon.trackers = {"cps.wheel": RateTracker(2**32, 2048), "cps.crank": RateTracker(2**16, 1024)}
        mon.prev_counter.clear()
        mon.set_state("streaming")
        mon.event("connected crank power meter 4iiii105 (simulated)")

        wheel, crank, pm_crank = Counter(2048), Counter(1024), Counter(1024)
        v = 0.0
        event = accum = 0
        loop = asyncio.get_running_loop()
        start = loop.time()
        tick = 0
        while True:
            tick += 1
            await asyncio.sleep(max(0.0, start + tick / HZ - loop.time()))
            now = tick / HZ
            self.ant.clock = now
            power, cadence = rider_at(now)
            power = max(0.0, power + self.rng.gauss(0, 6) * (power > 0))
            cadence = max(0.0, cadence + self.rng.gauss(0, 1.2) * (cadence > 0))
            v = flywheel_step(v, power, 1 / HZ)
            true_kmh = v * 3.6
            sees = self.trainer_sees(true_kmh)

            # Trainer: frozen counters and zero output while its sensor is blind.
            if sees:
                wheel.advance(v / WHEEL_CIRC_M * 60, now)
                crank.advance(cadence, now)
            t_power = round(power) if sees else 0
            t_cad = cadence if sees else 0.0
            t_kmh = true_kmh if sees else 0.0
            self.cps_cb(None, bytearray(cps_packet(t_power, wheel.revs_int, wheel.event_t,
                                                   crank.revs_int, crank.event_t)))
            self.ftms_cb(None, bytearray(ftms_packet(t_kmh, t_cad, t_power)))

            # ANT+ FE-C: alternate pages 0x19 and 0x10, as the trainer does.
            event += 1
            accum = (accum + t_power) % 65536
            if self.ant.pending == "spindown":
                self.spindown_pages(now, true_kmh)
            elif tick % 2:
                p = fe_page_0x19(event, round(t_cad), accum, t_power, cal_required=not sees)
                mon.ingest("ant_fe", {"raw": bytes(p).hex(), **decode_fe(p)})
            else:
                p = fe_page_0x10(t_kmh)
                mon.ingest("ant_fe", {"raw": bytes(p).hex(), **decode_fe(p)})

            # Crank power meter: always truthful, like the 4iiii.
            pm_crank.advance(cadence, now)
            raw = crank_cps_packet(round(power), pm_crank.revs_int, pm_crank.event_t)
            d = decode_cps(raw)
            d["crank_rpm"] = self.pm_tracker.update(d["crank_revs"], d["crank_time"])
            mon.ingest("pm_crank", {"raw": raw.hex(), **d})

    def spindown_pages(self, now: float, true_kmh: float):
        """Spindown: progress until the trainer sees target speed, then a result page."""
        seen_kmh = true_kmh if self.trainer_sees(true_kmh) else 0.0
        reached = seen_kmh >= SPINDOWN_TARGET_KMH
        if reached or now - self.ant.since > 60:
            p = fe_page_0x01(round(1500 + 50 * math.sin(now)) if reached else 0)
            self.ant.pending = None
        else:
            p = fe_page_0x02(speed_ok=False)
        self.mon.ingest("ant_fe", {"raw": bytes(p).hex(), **decode_fe(p)})
