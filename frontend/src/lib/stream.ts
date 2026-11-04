// Live store fed by the service's SSE stream at /events.
// One module-level store; components subscribe with useStream(selector).
import { useSyncExternalStore } from "react"

export const WINDOW_S = 90 // dashboard chart window
export const RETAIN_S = 300 // series history kept in memory (route trend overlay)
const RAW_MAX = 300
const EVENTS_MAX = 200

export type Packet = { kind?: "packet"; t: number; src: string; raw: string; [k: string]: unknown }
export type Status = {
  state: string
  uptime_s: number
  session: string
  stream_log: string
  connects: number
  disconnects: number
  stalls: number
  rssi: number | null
  last_error: string | null
  counts: Record<string, number>
  last_rx_age_s: Record<string, number>
  counter_age_s: Record<string, number>
  stalled: string[]
  ant_state: string
}
export type LogEvent = { t: number; wall: string; msg: string }
export type Config = Record<string, unknown>

/** One series key per (metric, source). Sources: cps, ftms, ant_fe, pm_crank. */
export type Metric = "power" | "cadence" | "speed" | "gap"
export const SOURCES = ["cps", "ftms", "ant_fe", "pm_crank"] as const
export type Source = (typeof SOURCES)[number]
export const SOURCE_LABEL: Record<Source, string> = {
  cps: "BLE Cycling Power",
  ftms: "BLE FTMS",
  ant_fe: "ANT+ FE-C",
  pm_crank: "4iiii crank (reference)",
}

type Series = { t: number[]; v: number[] }
type Latest = Partial<Record<Metric, Partial<Record<Source, number>>>>

export type StreamState = {
  sse: "connecting" | "live" | "reconnecting"
  status: Status | null
  config: Config
  events: LogEvent[]
  raw: Packet[]
  sources: string[]
  series: Record<string, Series>
  latest: Latest
  counters: { crank?: [number, number]; wheel?: [number, number] }
  antTrainer: Packet | null
  antGeneral: Packet | null
  calibration: Packet | null
  calibrationRequest: { ok: boolean; text: string } | null
  latestT: number
  version: number
}

const state: StreamState = {
  sse: "connecting",
  status: null,
  config: {},
  events: [],
  raw: [],
  sources: [],
  series: {},
  latest: {},
  counters: {},
  antTrainer: null,
  antGeneral: null,
  calibration: null,
  calibrationRequest: null,
  latestT: 0,
  version: 0,
}
let snapshot: StreamState = { ...state }
const listeners = new Set<() => void>()
const lastT: Record<string, number> = {}
let dirty = false

function emit() {
  if (dirty) return
  dirty = true
  // Coalesce bursts of packets into one render per animation frame.
  requestAnimationFrame(() => {
    dirty = false
    state.version++
    snapshot = { ...state }
    listeners.forEach((l) => l())
  })
}

function push(metric: Metric, src: Source, t: number, v: unknown) {
  if (typeof v !== "number") return
  const key = `${metric}.${src}`
  const s = (state.series[key] ??= { t: [], v: [] })
  s.t.push(t)
  s.v.push(v)
  while (s.t.length && s.t[0] < t - RETAIN_S) {
    s.t.shift()
    s.v.shift()
  }
  if (Number.isFinite(v)) {
    state.latest = { ...state.latest, [metric]: { ...state.latest[metric], [src]: v } }
  }
}

function onPacket(p: Packet) {
  state.latestT = Math.max(state.latestT, p.t)
  const src = p.src as Source
  if (src === "cps" || src === "ftms" || src === "ant_fe") {
    if (lastT[src] !== undefined) push("gap", src, p.t, (p.t - lastT[src]) * 1000)
    lastT[src] = p.t
  }
  if (src === "cps") {
    push("power", src, p.t, p.power_w)
    push("cadence", src, p.t, p.crank_rpm === "stale" ? NaN : p.crank_rpm)
    push("speed", src, p.t, p.wheel_speed_kmh)
    state.counters = {
      crank: [p.crank_revs as number, p.crank_time as number],
      wheel: [p.wheel_revs as number, p.wheel_time as number],
    }
  } else if (src === "ftms") {
    push("power", src, p.t, p.power_w)
    push("cadence", src, p.t, p.cadence_rpm)
    push("speed", src, p.t, p.speed_kmh)
  } else if (src === "pm_crank") {
    push("power", src, p.t, p.power_w)
    push("cadence", src, p.t, p.crank_rpm)
  } else if (src === "ant_fe") {
    if (p.page === 0x19) {
      push("power", src, p.t, p.power_w)
      push("cadence", src, p.t, p.cadence_rpm)
      state.antTrainer = p
    } else if (p.page === 0x10) {
      push("speed", src, p.t, p.speed_kmh)
      state.antGeneral = p
    } else if (p.page === 0x01 || p.page === 0x02) {
      state.calibration = p
    }
  }
  if (!state.sources.includes(p.src)) state.sources = [...state.sources, p.src]
  state.raw = [p, ...state.raw].slice(0, RAW_MAX)
}

function onEvent(e: LogEvent) {
  state.events = [e, ...state.events].slice(0, EVENTS_MAX)
}

type Message =
  | ({ kind: "packet" } & Packet)
  | ({ kind: "status" } & Status)
  | ({ kind: "event" } & LogEvent)
  | ({ kind: "config" } & Config)
  | { kind: "init"; status: Status; config: Config; events: LogEvent[]; recent: Packet[] }

function handle(m: Message) {
  if (m.kind === "init") {
    state.events = [...m.events].reverse().slice(0, EVENTS_MAX)
    state.config = m.config
    m.recent.forEach(onPacket)
    state.status = m.status
  } else if (m.kind === "packet") onPacket(m)
  else if (m.kind === "status") {
    const { kind: _k, ...s } = m
    state.status = s as Status
  } else if (m.kind === "event") onEvent(m)
  else if (m.kind === "config") {
    const { kind: _k, ...c } = m
    state.config = c
  }
  emit()
}

let started = false
function start() {
  if (started) return
  started = true
  const es = new EventSource("/events")
  es.onopen = () => {
    state.sse = "live"
    emit()
  }
  es.onerror = () => {
    state.sse = "reconnecting"
    emit()
  }
  es.onmessage = (ev) => handle(JSON.parse(ev.data) as Message)
}

function subscribe(l: () => void) {
  start()
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useStream<T>(select: (s: StreamState) => T): T {
  return useSyncExternalStore(subscribe, () => select(snapshot))
}

export async function requestCalibration(kind: "spindown" | "zero_offset") {
  const r = await fetch(`/api/ant/calibrate/${kind}`, { method: "POST" })
  const j = (await r.json()) as { sent?: string; error?: string }
  state.calibration = null
  state.calibrationRequest = r.ok
    ? { ok: true, text: `${kind} requested (page ${j.sent}), waiting for trainer` }
    : { ok: false, text: j.error ?? `HTTP ${r.status}` }
  emit()
}

/** Current snapshot, for animation loops that read outside React renders. */
export function getStream(): StreamState {
  return snapshot
}

/** Start the SSE connection without a React subscriber. */
export function ensureStream() {
  start()
}
