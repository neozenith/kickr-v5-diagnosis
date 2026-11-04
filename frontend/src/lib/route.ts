// Virtual circuit: a closed loop with rolling climbs and descents, plus ride physics.

export type Zone = "switchbacks" | "village"
export type RoutePoint = { x: number; z: number; y: number; d: number; grade: number; zone?: Zone }
export type Route = {
  points: RoutePoint[]
  length: number
  climb: number
  maxGrade: number
  minGrade: number
  switchbacks: number
  villageTurns: number
  /** Start and end of each zone, in route distance (m). */
  zones: Record<Zone, { from: number; to: number }>
}

const N = 1600 // base loop samples
const M = 3000 // final route samples, evenly spaced by distance (~2.4 m)

/** The descent that zig-zags down the hillside: distance range in metres, legs and leg angle. */
export const SWITCHBACKS = { from: 4200, to: 5200, legs: 6, angle: (75 * Math.PI) / 180, sharpness: 5 }

/**
 * The village at the bottom of the switchbacks: street blocks joined by right-angle turns.
 * Heading offsets per block, in degrees: a square wave left and right, ending straight on.
 */
export const VILLAGE = { from: 5260, to: 5860, blocks: [0, 90, 0, -90, 0, 90, 0, -90, 0], corner: 10 }

/**
 * Base loop. Plan shape is a lobed oval; elevation is a sum of whole-number harmonics
 * of the loop angle, so the climb always returns to the start height.
 */
function baseLoop() {
  const raw: { x: number; z: number; y: number; d: number }[] = []
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2
    const r = 900 + 160 * Math.sin(3 * a) + 90 * Math.cos(5 * a + 0.6)
    raw.push({
      x: r * Math.cos(a) * 1.25,
      z: r * Math.sin(a),
      y: 24 * Math.sin(a) + 14 * Math.sin(2 * a + 1.1) + 5 * Math.sin(5 * a + 0.4),
      d: 0,
    })
  }
  let d = 0
  for (let i = 0; i < N; i++) {
    raw[i].d = d
    const q = raw[(i + 1) % N]
    d += Math.hypot(q.x - raw[i].x, q.z - raw[i].z)
  }
  return { raw, length: d }
}

/** Linear interpolation of the base loop at distance s. */
function baseAt(raw: ReturnType<typeof baseLoop>["raw"], length: number, s: number) {
  const ss = ((s % length) + length) % length
  let lo = 0
  let hi = raw.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (raw[mid].d <= ss) lo = mid
    else hi = mid - 1
  }
  const p = raw[lo]
  const q = raw[(lo + 1) % raw.length]
  const seg = (q.d || length) - p.d
  const f = seg > 0 ? (ss - p.d) / seg : 0
  return { x: p.x + (q.x - p.x) * f, z: p.z + (q.z - p.z) * f, y: p.y + (q.y - p.y) * f }
}

/**
 * Heading offset that turns the descent into switchbacks: legs alternate +-angle across the
 * slope, joined by hairpins. Zero at both ends of the section, so it joins the loop smoothly.
 */
function switchbackOffset(s: number) {
  const { from, to, legs, angle, sharpness } = SWITCHBACKS
  if (s <= from || s >= to) return 0
  const u = ((s - from) / (to - from)) * legs
  return (angle * Math.tanh(sharpness * Math.sin(Math.PI * u))) / Math.tanh(sharpness)
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Heading offset for the village: each block boundary is a right-angle turn over VILLAGE.corner metres. */
function villageOffset(s: number) {
  const { from, to, blocks, corner } = VILLAGE
  if (s <= from - corner || s >= to + corner) return 0
  const block = (to - from) / blocks.length
  let off = (blocks[0] * Math.PI) / 180
  for (let k = 1; k < blocks.length; k++) {
    const b = from + k * block
    off += (((blocks[k] - blocks[k - 1]) * Math.PI) / 180) * smoothstep(b - corner / 2, b + corner / 2, s)
  }
  return off
}

function zoneAt(s: number): Zone | undefined {
  if (s >= SWITCHBACKS.from && s < SWITCHBACKS.to) return "switchbacks"
  if (s >= VILLAGE.from && s < VILLAGE.to) return "village"
  return undefined
}

/**
 * Closed loop with switchbacks and a village. The plan is rebuilt by integrating heading
 * along distance, adding each section's heading offset. Those sections cover less ground
 * than the original path, so the leftover closure gap is spread smoothly over the rest of
 * the loop. Height stays a function of distance, so the elevation profile is unchanged.
 */
export function buildRoute(): Route {
  const { raw, length } = baseLoop()
  const ds = length / M
  const base = Array.from({ length: M + 1 }, (_, j) => baseAt(raw, length, j * ds))
  // Unwrapped base heading at each step.
  const heading: number[] = []
  let prev = 0
  for (let j = 0; j < M; j++) {
    let h = Math.atan2(base[j + 1].z - base[j].z, base[j + 1].x - base[j].x)
    if (j > 0) h = prev + Math.atan2(Math.sin(h - prev), Math.cos(h - prev))
    heading.push(h)
    prev = h
  }
  const xs = [base[0].x]
  const zs = [base[0].z]
  for (let j = 0; j < M; j++) {
    const s = (j + 0.5) * ds
    const h = heading[j] + switchbackOffset(s) + villageOffset(s)
    xs.push(xs[j] + Math.cos(h) * ds)
    zs.push(zs[j] + Math.sin(h) * ds)
  }
  // Spread the closure gap over the loop, away from the switchbacks and village.
  const ex = xs[M] - xs[0]
  const ez = zs[M] - zs[0]
  const from = SWITCHBACKS.from
  const to = VILLAGE.to
  const w = Array.from({ length: M }, (_, j) => {
    const s = (j + 0.5) * ds
    const outside = s < from ? from - s : s > to ? s - to : 0
    return smoothstep(100, 400, outside)
  })
  const total = w.reduce((a, b) => a + b, 0)
  let acc = 0
  for (let j = 0; j <= M; j++) {
    xs[j] -= (ex * acc) / total
    zs[j] -= (ez * acc) / total
    if (j < M) acc += w[j]
  }

  const points: RoutePoint[] = []
  const zones: Partial<Record<Zone, { from: number; to: number }>> = {}
  let d = 0
  let climb = 0
  for (let j = 0; j < M; j++) {
    const run = Math.hypot(xs[j + 1] - xs[j], zs[j + 1] - zs[j])
    const y = base[j].y
    const rise = base[(j + 1) % M].y - y
    const zone = zoneAt(j * ds)
    points.push({ x: xs[j], z: zs[j], y, d, grade: (rise / run) * 100, zone })
    if (zone) {
      const z = (zones[zone] ??= { from: d, to: d })
      z.to = d + run
    }
    if (rise > 0) climb += rise
    d += run
  }
  const grades = points.map((p) => p.grade)
  return {
    points,
    length: d,
    climb,
    maxGrade: Math.max(...grades),
    minGrade: Math.min(...grades),
    switchbacks: SWITCHBACKS.legs - 1,
    villageTurns: VILLAGE.blocks.length - 1,
    zones: zones as Route["zones"],
  }
}

/** Bucketed spatial index over route points, for fast "which road points are near (x, z)" queries. */
export function routeIndex(points: RoutePoint[], cell = 40) {
  const buckets = new Map<string, RoutePoint[]>()
  const key = (i: number, k: number) => `${i},${k}`
  for (const p of points) {
    const k = key(Math.floor(p.x / cell), Math.floor(p.z / cell))
    const b = buckets.get(k)
    if (b) b.push(p)
    else buckets.set(k, [p])
  }
  return {
    /** Visit every point within radius r of (x, z). */
    near(x: number, z: number, r: number, visit: (p: RoutePoint, d2: number) => void) {
      const r2 = r * r
      const i0 = Math.floor((x - r) / cell)
      const i1 = Math.floor((x + r) / cell)
      const k0 = Math.floor((z - r) / cell)
      const k1 = Math.floor((z + r) / cell)
      for (let i = i0; i <= i1; i++)
        for (let k = k0; k <= k1; k++) {
          const b = buckets.get(key(i, k))
          if (!b) continue
          for (const p of b) {
            const d2 = (p.x - x) ** 2 + (p.z - z) ** 2
            if (d2 <= r2) visit(p, d2)
          }
        }
    },
  }
}

/** Interpolated position and grade at distance d (metres, wraps around the loop). */
export function sample(route: Route, d: number) {
  const len = route.length
  const dd = ((d % len) + len) % len
  const pts = route.points
  let lo = 0
  let hi = pts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (pts[mid].d <= dd) lo = mid
    else hi = mid - 1
  }
  const p = pts[lo]
  const q = pts[(lo + 1) % pts.length]
  const r = pts[(lo + 2) % pts.length]
  const segLen = (q.d || len) - p.d
  const f = segLen > 0 ? (dd - p.d) / segLen : 0
  // Blend heading and grade towards the next segment's, so neither snaps at a segment boundary.
  const h1 = Math.atan2(q.z - p.z, q.x - p.x)
  const h2 = Math.atan2(r.z - q.z, r.x - q.x)
  const turn = Math.atan2(Math.sin(h2 - h1), Math.cos(h2 - h1))
  return {
    x: p.x + (q.x - p.x) * f,
    y: p.y + (q.y - p.y) * f,
    z: p.z + (q.z - p.z) * f,
    grade: p.grade + (q.grade - p.grade) * f,
    heading: h1 + turn * f,
    d: dd,
  }
}

export const RIDER = { mass: 85, cda: 0.32, crr: 0.004, rho: 1.2, g: 9.81 }

/** One physics step: returns the new road speed (m/s) for power (W) on grade (%). */
export function rideStep(v: number, power: number, grade: number, dt: number) {
  const { mass, cda, crr, rho, g } = RIDER
  const theta = Math.atan(grade / 100)
  const drive = power / Math.max(v, 1)
  const resist = 0.5 * rho * cda * v * v + crr * mass * g * Math.cos(theta) + mass * g * Math.sin(theta)
  return Math.max(0, v + ((drive - resist) / mass) * dt)
}

/**
 * The same loop with heights (and so grades) scaled by k, for display only.
 * Real 5-6% grades look flat from a chase camera; physics and the HUD keep true values.
 */
export function exaggerate(route: Route, k: number): Route {
  return {
    ...route,
    points: route.points.map((p) => ({ ...p, y: p.y * k, grade: p.grade * k })),
    climb: route.climb * k,
    maxGrade: route.maxGrade * k,
    minGrade: route.minGrade * k,
  }
}
