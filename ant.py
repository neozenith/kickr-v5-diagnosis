"""ANT+ listener for the KICKR: FE-C (type 17) and Power Meter (type 11) channels.

Runs openant's blocking Node in a thread; every page is passed raw + decoded to `sink`.
Pages are decoded here from raw bytes (not openant's dataclasses) so the trainer-status
bits (calibration required etc.) and event counters are visible.
"""

import logging
import threading
import time
from typing import Callable

from openant.devices import ANTPLUS_NETWORK_KEY
from openant.devices.fitness_equipment import FitnessEquipment
from openant.devices.power_meter import PowerMeter
from openant.easy.node import Node

log = logging.getLogger("kickr.ant")

FE_TYPES = {16: "general", 19: "treadmill", 20: "elliptical", 22: "rower", 23: "climber",
            24: "nordic_skier", 25: "trainer"}
FE_STATES = {1: "asleep", 2: "ready", 3: "in_use", 4: "finished"}


def decode_fe(p: list[int]) -> dict:
    page = p[0]
    out: dict = {"page": page}
    if page == 0x10:  # general FE data
        out.update(fe_type=FE_TYPES.get(p[1] & 0x1F, p[1] & 0x1F), elapsed_raw=p[2],
                   distance_raw=p[3], speed_kmh=round((p[4] | p[5] << 8) * 0.0036, 2),
                   fe_state=FE_STATES.get(p[7] >> 4 & 0x7, p[7] >> 4 & 0x7))
    elif page == 0x19:  # specific trainer data
        status = p[6] >> 4
        out.update(event=p[1], cadence_rpm=p[2], accum_power=p[3] | p[4] << 8,
                   power_w=p[5] | (p[6] & 0x0F) << 8,
                   power_cal_required=bool(status & 1), resistance_cal_required=bool(status & 2),
                   user_config_required=bool(status & 4),
                   target_power_limit={0: "ok", 1: "too_low", 2: "too_high", 3: "undetermined"}
                   [p[7] & 0x03], fe_state=FE_STATES.get(p[7] >> 4 & 0x7, p[7] >> 4 & 0x7))
    elif page == 0x1A:  # trainer torque data
        out.update(event=p[1], wheel_ticks=p[2], wheel_period=p[3] | p[4] << 8,
                   accum_torque=p[5] | p[6] << 8)
    elif page == 0x01:  # calibration response
        out.update(cal_zero_offset_ok=bool(p[1] & 0x40), cal_spindown_ok=bool(p[1] & 0x80),
                   cal_temp_c=None if p[3] == 0xFF else p[3] * 0.5 - 25,
                   cal_zero_offset=p[4] | p[5] << 8, cal_spindown_ms=p[6] | p[7] << 8)
    elif page == 0x02:  # calibration in progress
        out.update(zero_offset_pending=bool(p[1] & 0x40), spindown_pending=bool(p[1] & 0x80),
                   temp_condition=["n/a", "too_low", "ok", "too_high"][p[2] >> 4 & 3],
                   speed_condition=["n/a", "too_low", "ok", "reserved"][p[2] >> 6 & 3],
                   cal_temp_c=None if p[3] == 0xFF else p[3] * 0.5 - 25,
                   target_speed_kmh=round((p[4] | p[5] << 8) * 0.0036, 1),
                   target_spindown_ms=p[6] | p[7] << 8)
    elif page == 0x50:
        out.update(hw_rev=p[3], manufacturer=p[4] | p[5] << 8, model=p[6] | p[7] << 8)
    elif page == 0x51:
        out.update(sw_rev=(p[2], p[3]), serial=p[4] | p[5] << 8 | p[6] << 16 | p[7] << 24)
    return out


def decode_pm(p: list[int]) -> dict:
    page = p[0]
    out: dict = {"page": page}
    if page == 0x10:  # standard power-only
        out.update(event=p[1], pedal_power=p[2], cadence_rpm=p[3],
                   accum_power=p[4] | p[5] << 8, power_w=p[6] | p[7] << 8)
    elif page == 0x11:  # wheel torque
        out.update(event=p[1], wheel_ticks=p[2], cadence_rpm=p[3],
                   wheel_period=p[4] | p[5] << 8, accum_torque=p[6] | p[7] << 8)
    elif page == 0x12:  # crank torque
        out.update(event=p[1], crank_ticks=p[2], cadence_rpm=p[3],
                   crank_period=p[4] | p[5] << 8, accum_torque=p[6] | p[7] << 8)
    return out


class AntBridge:
    def __init__(self, device_id: int, sink: Callable[[str, dict], None],
                 note: Callable[[str, int], None]):
        self.device_id, self.sink, self.note = device_id, sink, note
        self.state = "stopped"
        self.fe: FitnessEquipment | None = None

    def request_calibration(self, kind: str):
        """FE-C page 0x01 calibration request: 0x80 = spin-down, 0x40 = zero offset."""
        if self.fe is None or self.state != "streaming":
            raise RuntimeError(f"ANT+ FE-C channel not streaming (state={self.state})")
        cal_id = {"spindown": 0x80, "zero_offset": 0x40}[kind]
        payload = [0x01, cal_id, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]
        self.fe.send_acknowledged_data(payload)
        return bytes(payload).hex()

    def start(self):
        threading.Thread(target=self._supervise, name="ant", daemon=True).start()

    def _supervise(self):
        backoff = 1.0
        while True:
            node = None
            try:
                self.state = "opening"
                node = Node()
                node.set_network_key(0x00, ANTPLUS_NETWORK_KEY)
                fe = FitnessEquipment(node, device_id=self.device_id)
                pm = PowerMeter(node, device_id=self.device_id)
                self.fe = fe
                for dev, src, dec in ((fe, "ant_fe", decode_fe), (pm, "ant_pm", decode_pm)):
                    dev.on_update = self._handler(src, dec)
                    dev.on_found = (lambda s=src: self.note(f"{s} found #{self.device_id}",
                                                            logging.INFO))
                self.state = "searching"
                self.note(f"ANT+ stick open, searching for #{self.device_id} (FE-C + PM)",
                          logging.INFO)
                backoff = 1.0
                node.start()  # blocks until node.stop() or error
                raise RuntimeError("ANT node loop exited")
            except Exception as e:  # USB unplug / libusb errors: log and reopen
                self.state = "error"
                self.note(f"ANT+ error: {type(e).__name__}: {e}", logging.WARNING)
            finally:
                if node is not None:
                    try:
                        node.stop()
                    except Exception as e:
                        log.debug(f"node.stop: {e}")
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)

    def _handler(self, src: str, dec):
        def cb(data):
            raw = list(data[:8])
            self.state = "streaming"
            self.sink(src, {"raw": bytes(raw).hex(), **dec(raw)})
        return cb
