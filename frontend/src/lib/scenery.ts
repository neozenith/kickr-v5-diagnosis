// Scenery for the virtual route: sky dome, clouds, mountain ridges (parallax layers) and trees.
// Deterministic (seeded) so screenshots and tests see the same world every time.
import * as THREE from "three"

import { type Route, routeIndex } from "@/lib/route"

/** Small seeded PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type SkyColors = { top: string; horizon: string }

/** Vertical-gradient sky dome. Follows the camera, so it reads as infinitely far away. */
export function makeSky({ top, horizon }: SkyColors) {
  const geometry = new THREE.SphereGeometry(8000, 32, 16)
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uTop: { value: new THREE.Color(top) }, uHorizon: { value: new THREE.Color(horizon) } },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w; // always at the far plane
      }`,
    fragmentShader: `
      uniform vec3 uTop;
      uniform vec3 uHorizon;
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y, 0.0, 1.0);
        gl_FragColor = vec4(mix(uHorizon, uTop, pow(h, 0.55)), 1.0);
        #include <colorspace_fragment>
      }`,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.renderOrder = -10
  mesh.frustumCulled = false
  return mesh
}

/**
 * One ring of mountain silhouettes around (cx, cz). Peaks come from a few sine harmonics plus
 * seeded noise, closed around the ring. Several rings at different radii give parallax as the
 * rider turns: near ridges sweep past faster than far ones.
 */
export function makeRidge(opts: {
  cx: number
  cz: number
  radius: number
  base: number
  height: number
  color: string
  seed: number
}) {
  const { cx, cz, radius, base, height, color, seed } = opts
  const r = rng(seed)
  const n = 240
  const phase = [r() * 6.28, r() * 6.28, r() * 6.28]
  const jitter = Array.from({ length: n }, () => r())
  const pos: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2
    const k = i % n
    const smooth = (jitter[k] + jitter[(k + 1) % n] + jitter[(k + n - 1) % n]) / 3
    const h =
      height *
      (0.45 +
        0.25 * Math.sin(3 * a + phase[0]) +
        0.18 * Math.sin(7 * a + phase[1]) +
        0.1 * Math.sin(17 * a + phase[2]) +
        0.25 * smooth)
    const x = cx + Math.cos(a) * radius
    const z = cz + Math.sin(a) * radius
    pos.push(x, base, z, x, base + Math.max(h, height * 0.1), z)
    if (i < n) {
      const v = i * 2
      idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  const m = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, fog: false })
  const mesh = new THREE.Mesh(g, m)
  mesh.renderOrder = -5
  return mesh
}

/** Clusters of flattened spheres high above the loop, drifting slowly. */
export function makeClouds(opts: { cx: number; cz: number; color: string; count: number; seed: number }) {
  const { cx, cz, color, count, seed } = opts
  const r = rng(seed)
  const group = new THREE.Group()
  const mat = new THREE.MeshLambertMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.35,
    transparent: true,
    opacity: 0.85,
    fog: false,
  })
  const puff = new THREE.IcosahedronGeometry(1, 2)
  for (let c = 0; c < count; c++) {
    const cloud = new THREE.Group()
    const a = r() * Math.PI * 2
    const dist = 900 + r() * 2600
    cloud.position.set(cx + Math.cos(a) * dist, 380 + r() * 420, cz + Math.sin(a) * dist)
    const size = 60 + r() * 90
    const puffs = 5 + Math.floor(r() * 6)
    for (let p = 0; p < puffs; p++) {
      const m = new THREE.Mesh(puff, mat)
      m.position.set((r() - 0.5) * size * 2.2, (r() - 0.3) * size * 0.35, (r() - 0.5) * size * 0.9)
      const s = size * (0.45 + r() * 0.5)
      m.scale.set(s, s * 0.45, s * 0.8)
      cloud.add(m)
    }
    group.add(cloud)
  }
  return group
}

/** Seconds -> drift: call each frame to move clouds slowly downwind. */
export function driftClouds(clouds: THREE.Group, dt: number) {
  for (const c of clouds.children) c.position.x += 4 * dt
}

/**
 * Trees scattered beside the road, never on it. Two instanced meshes (trunks and crowns)
 * keep this to two draw calls for well over a thousand trees.
 */
export function makeTrees(opts: {
  route: Route
  heightAt: (x: number, z: number) => number
  roadClear: number
  /** Extra no-tree test, e.g. village houses. */
  avoid?: (x: number, z: number) => boolean
  count: number
  colors: { trunk: string; crowns: string[] }
  seed: number
}) {
  const { route, heightAt, roadClear, count, colors, seed, avoid } = opts
  const r = rng(seed)
  const index = routeIndex(route.points)
  const clearOfRoad = (x: number, z: number) => {
    let clear = true
    index.near(x, z, roadClear, () => (clear = false))
    return clear
  }
  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.18, 0.28, 1, 6).translate(0, 0.5, 0),
    new THREE.MeshLambertMaterial({ color: colors.trunk }),
    count
  )
  const crowns = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1, 1, 8).translate(0, 0.5, 0),
    new THREE.MeshLambertMaterial({ color: "#ffffff" }),
    count
  )
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3()
  const p = new THREE.Vector3()
  const crown = new THREE.Color()
  let placed = 0
  let tries = 0
  while (placed < count && tries < count * 20) {
    tries++
    const i = Math.floor(r() * route.points.length)
    const pt = route.points[i]
    const q2 = route.points[(i + 1) % route.points.length]
    const h = Math.atan2(q2.z - pt.z, q2.x - pt.x)
    // Dense near the road, thinning out to ~250 m.
    const side = r() < 0.5 ? -1 : 1
    const off = roadClear + Math.pow(r(), 1.8) * 250
    const along = (r() - 0.5) * 8
    const x = pt.x + Math.cos(h) * along - Math.sin(h) * off * side
    const z = pt.z + Math.sin(h) * along + Math.cos(h) * off * side
    if (!clearOfRoad(x, z) || avoid?.(x, z)) continue
    const y = heightAt(x, z)
    const height = 6 + r() * 10
    const trunkH = height * 0.3
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * Math.PI)
    m.compose(p.set(x, y, z), q, s.set(1, trunkH, 1))
    trunks.setMatrixAt(placed, m)
    const width = height * (0.28 + r() * 0.1)
    m.compose(p.set(x, y + trunkH * 0.8, z), q, s.set(width, height - trunkH * 0.8, width))
    crowns.setMatrixAt(placed, m)
    crowns.setColorAt(placed, crown.set(colors.crowns[Math.floor(r() * colors.crowns.length)]))
    placed++
  }
  trunks.count = placed
  crowns.count = placed
  const group = new THREE.Group()
  group.add(trunks, crowns)
  return { group, count: placed }
}

/** Cobblestone texture: staggered rows of rounded stones with seeded colour variation. */
export function makeCobbleTexture(colors: { mortar: string; stones: string[] }, seed = 3) {
  const r = rng(seed)
  const size = 256
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = size
  const g = canvas.getContext("2d")!
  g.fillStyle = colors.mortar
  g.fillRect(0, 0, size, size)
  const rows = 8
  const rowH = size / rows
  for (let row = 0; row < rows; row++) {
    const cols = 6
    const w = size / cols
    const shift = row % 2 ? w / 2 : 0
    for (let c = -1; c < cols; c++) {
      const x = c * w + shift + 2 + r() * 3
      const y = row * rowH + 2 + r() * 2
      const sw = w - 5 - r() * 4
      const sh = rowH - 5 - r() * 3
      g.fillStyle = colors.stones[Math.floor(r() * colors.stones.length)]
      g.beginPath()
      g.roundRect(x, y, sw, sh, 6)
      g.fill()
      // A soft highlight so stones read as domed.
      g.fillStyle = "rgba(255,255,255,0.08)"
      g.beginPath()
      g.roundRect(x + 2, y + 2, sw * 0.6, sh * 0.45, 5)
      g.fill()
    }
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

/** Triangular prism, 1 x 1 x 1: ridge along x at y = 1, eaves at y = 0. */
function roofGeometry() {
  const A = [-0.5, 0, -0.5], B = [-0.5, 0, 0.5], C = [-0.5, 1, 0]
  const D = [0.5, 0, -0.5], E = [0.5, 0, 0.5], F = [0.5, 1, 0]
  const tris = [A, C, B, D, E, F, A, D, F, A, F, C, B, C, F, B, F, E]
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(tris.flat(), 3))
  g.computeVertexNormals()
  return g
}

/**
 * Village houses lining the cobbled streets, plus a church with a spire. Houses face the
 * street, are never on the road, and never overlap each other. Two instanced draws for houses.
 */
export function makeVillage(opts: {
  route: Route
  heightAt: (x: number, z: number) => number
  roadW: number
  /** Sidewalk width in metres; houses stand behind it. */
  sidewalk: number
  colors: { walls: string[]; roofs: string[]; church: string; spire: string }
  seed: number
}) {
  const { route, heightAt, roadW, sidewalk, colors, seed } = opts
  const r = rng(seed)
  const index = routeIndex(route.points)
  const street = route.points.filter((p) => p.zone === "village")
  const clearOfRoad = (x: number, z: number, margin: number) => {
    let clear = true
    index.near(x, z, roadW / 2 + margin, () => (clear = false))
    return clear
  }
  type Lot = { x: number; z: number; h: number; w: number; dpt: number; height: number }
  const lots: Lot[] = []
  const free = (x: number, z: number, radius: number) => lots.every((l) => Math.hypot(l.x - x, l.z - z) > radius + Math.max(l.w, l.dpt) / 2)
  for (let i = 0; i < street.length; i += 3) {
    const p = street[i]
    const q = street[Math.min(i + 1, street.length - 1)]
    const h = Math.atan2(q.z - p.z, q.x - p.x)
    for (const side of [-1, 1]) {
      const w = 6 + r() * 4
      const dpt = 6 + r() * 3
      const off = roadW / 2 + sidewalk + 0.4 + dpt / 2
      const x = p.x - Math.sin(h) * off * side
      const z = p.z + Math.cos(h) * off * side
      // All four corners must clear the road, and the house must not overlap another.
      const corners = [
        [w / 2, dpt / 2], [-w / 2, dpt / 2], [w / 2, -dpt / 2], [-w / 2, -dpt / 2],
      ].map(([a, b]) => [x + Math.cos(h) * a - Math.sin(h) * b, z + Math.sin(h) * a + Math.cos(h) * b])
      if (!corners.every(([cx, cz]) => clearOfRoad(cx, cz, sidewalk + 0.2))) continue
      if (!free(x, z, Math.max(w, dpt) / 2 + 0.8)) continue
      lots.push({ x, z, h, w, dpt, height: 4.5 + r() * 3.5 })
    }
  }
  const walls = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    new THREE.MeshLambertMaterial({ color: "#ffffff" }),
    lots.length
  )
  const roofs = new THREE.InstancedMesh(
    roofGeometry(),
    new THREE.MeshLambertMaterial({ color: "#ffffff", side: THREE.DoubleSide }),
    lots.length
  )
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  const c = new THREE.Color()
  lots.forEach((l, i) => {
    // Sit on the lowest ground under the footprint so no corner floats.
    const y = Math.min(heightAt(l.x, l.z), heightAt(l.x + 3, l.z), heightAt(l.x - 3, l.z), heightAt(l.x, l.z + 3), heightAt(l.x, l.z - 3)) - 0.3
    q.setFromAxisAngle(up, -l.h)
    m.compose(new THREE.Vector3(l.x, y, l.z), q, new THREE.Vector3(l.w, l.height + 0.3, l.dpt))
    walls.setMatrixAt(i, m)
    walls.setColorAt(i, c.set(colors.walls[Math.floor(r() * colors.walls.length)]))
    m.compose(new THREE.Vector3(l.x, y + l.height + 0.3, l.z), q, new THREE.Vector3(l.w + 0.6, 2 + r() * 1.5, l.dpt + 0.6))
    roofs.setMatrixAt(i, m)
    roofs.setColorAt(i, c.set(colors.roofs[Math.floor(r() * colors.roofs.length)]))
  })
  const group = new THREE.Group()
  group.add(walls, roofs)

  // Church: a tower and spire on open ground near the middle of the village.
  const mid = street[Math.floor(street.length / 2)]
  let church = false
  for (const dist of [22, 30, 38]) {
    for (const side of [-1, 1]) {
      const n = street[Math.min(Math.floor(street.length / 2) + 1, street.length - 1)]
      const h = Math.atan2(n.z - mid.z, n.x - mid.x)
      const x = mid.x - Math.sin(h) * dist * side
      const z = mid.z + Math.cos(h) * dist * side
      if (church || !clearOfRoad(x, z, 6) || !free(x, z, 6)) continue
      const y = heightAt(x, z) - 0.3
      const tower = new THREE.Mesh(new THREE.BoxGeometry(5, 18, 5).translate(0, 9, 0), new THREE.MeshLambertMaterial({ color: colors.church }))
      tower.position.set(x, y, z)
      tower.rotation.y = -h
      const spire = new THREE.Mesh(new THREE.ConeGeometry(3.8, 9, 4).translate(0, 4.5, 0), new THREE.MeshLambertMaterial({ color: colors.spire }))
      spire.position.set(x, y + 18, z)
      spire.rotation.y = -h + Math.PI / 4
      group.add(tower, spire)
      lots.push({ x, z, h, w: 5, dpt: 5, height: 18 })
      church = true
    }
  }

  /** True when (x, z) is clear of houses: trees use it to stay out of gardens and streets. */
  const avoid = (x: number, z: number) => lots.some((l) => Math.hypot(l.x - x, l.z - z) < Math.max(l.w, l.dpt) / 2 + 3)
  return { group, houses: lots.length - (church ? 1 : 0), church, avoid }
}

const smooth01 = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Festival in the village: spectators on the sidewalks who jump and wave as the rider passes,
 * and bunting strung across the street on poles. Everything is instanced; call update() each frame.
 */
export function makeFestival(opts: {
  route: Route
  heightAt: (x: number, z: number) => number
  roadW: number
  sidewalk: number
  lift: number
  colors: { shirts: string[]; skins: string[]; flags: string[]; pole: string; string: string }
  seed: number
}) {
  const { route, heightAt, roadW, sidewalk, lift, colors, seed } = opts
  const r = rng(seed)
  const index = routeIndex(route.points)
  const street = route.points.filter((p) => p.zone === "village")
  const onRoad = (x: number, z: number, margin: number) => {
    let hit = false
    index.near(x, z, roadW / 2 + margin, () => (hit = true))
    return hit
  }
  const group = new THREE.Group()

  // ---- spectators
  type Person = { x: number; y: number; z: number; yaw: number; phase: number; scale: number }
  const people: Person[] = []
  for (let i = 0; i < street.length; i += 2) {
    const p = street[i]
    const q = street[Math.min(i + 1, street.length - 1)]
    const h = Math.atan2(q.z - p.z, q.x - p.x)
    for (const side of [-1, 1]) {
      if (r() < 0.45) continue
      const off = roadW / 2 + 0.4 + r() * (sidewalk - 0.7)
      const x = p.x - Math.sin(h) * off * side + Math.cos(h) * (r() - 0.5) * 2
      const z = p.z + Math.cos(h) * off * side + Math.sin(h) * (r() - 0.5) * 2
      if (onRoad(x, z, 0.25)) continue // inside corners: keep people off the road
      if (people.some((o) => Math.hypot(o.x - x, o.z - z) < 0.7)) continue
      // Face the street: local +x points at the road centreline.
      const yaw = Math.atan2(p.z - z, p.x - x)
      people.push({ x, y: p.y + lift + 0.12, z, yaw, phase: r() * Math.PI * 2, scale: 0.9 + r() * 0.2 })
    }
  }
  const n = people.length
  const mat = () => new THREE.MeshLambertMaterial({ color: "#ffffff" })
  const bodies = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.17, 0.2, 1.3, 8).translate(0, 0.65, 0), mat(), n)
  const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.13, 10, 8), mat(), n)
  // Arm: pivot at the shoulder (origin), hanging down -y.
  const armGeo = new THREE.BoxGeometry(0.08, 0.62, 0.08).translate(0, -0.31, 0)
  const armsL = new THREE.InstancedMesh(armGeo, mat(), n)
  const armsR = new THREE.InstancedMesh(armGeo, mat(), n)
  const c = new THREE.Color()
  people.forEach((_, i) => {
    const shirt = colors.shirts[Math.floor(r() * colors.shirts.length)]
    const skin = colors.skins[Math.floor(r() * colors.skins.length)]
    bodies.setColorAt(i, c.set(shirt))
    armsL.setColorAt(i, c.set(shirt))
    armsR.setColorAt(i, c.set(shirt))
    heads.setColorAt(i, c.set(skin))
  })
  for (const m of [bodies, heads, armsL, armsR]) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    m.frustumCulled = false
    group.add(m)
  }

  // ---- bunting: a pole each side, a sagging string across, triangular flags along it
  const flagGeo = new THREE.BufferGeometry()
  flagGeo.setAttribute("position", new THREE.Float32BufferAttribute([-0.17, 0, 0, 0.17, 0, 0, 0, -0.42, 0], 3))
  flagGeo.computeVertexNormals()
  type Flag = { x: number; y: number; z: number; yaw: number; phase: number }
  const flags: Flag[] = []
  const strings: number[] = []
  const poles: [number, number, number][] = []
  const span = roadW / 2 + sidewalk + 0.2
  for (let i = 4; i < street.length - 4; i += 6) {
    const p = street[i]
    const q = street[i + 1]
    const h = Math.atan2(q.z - p.z, q.x - p.x)
    const A = new THREE.Vector3(p.x + Math.sin(h) * span, 0, p.z - Math.cos(h) * span)
    const B = new THREE.Vector3(p.x - Math.sin(h) * span, 0, p.z + Math.cos(h) * span)
    if (onRoad(A.x, A.z, 0.6) || onRoad(B.x, B.z, 0.6)) continue // skip across corners
    A.y = heightAt(A.x, A.z)
    B.y = heightAt(B.x, B.z)
    const top = Math.max(A.y, B.y, p.y + lift) + 6.2
    poles.push([A.x, A.y, A.z], [B.x, B.y, B.z])
    const sag = 0.9
    const segs = 24
    const across = Math.atan2(B.z - A.z, B.x - A.x)
    for (let k = 0; k < segs; k++) {
      for (const t of [k / segs, (k + 1) / segs]) {
        strings.push(A.x + (B.x - A.x) * t, top - sag * 4 * t * (1 - t), A.z + (B.z - A.z) * t)
      }
    }
    const count = Math.floor((2 * span) / 0.48)
    for (let k = 1; k < count; k++) {
      const t = k / count
      flags.push({
        x: A.x + (B.x - A.x) * t,
        y: top - sag * 4 * t * (1 - t),
        z: A.z + (B.z - A.z) * t,
        yaw: -across,
        phase: r() * Math.PI * 2,
      })
    }
  }
  const flagMesh = new THREE.InstancedMesh(
    flagGeo,
    new THREE.MeshLambertMaterial({ color: "#ffffff", side: THREE.DoubleSide }),
    Math.max(flags.length, 1)
  )
  flagMesh.count = flags.length
  flags.forEach((_, i) => flagMesh.setColorAt(i, c.set(colors.flags[i % colors.flags.length])))
  flagMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  flagMesh.frustumCulled = false
  group.add(flagMesh)
  const stringGeo = new THREE.BufferGeometry()
  stringGeo.setAttribute("position", new THREE.Float32BufferAttribute(strings, 3))
  group.add(new THREE.LineSegments(stringGeo, new THREE.LineBasicMaterial({ color: colors.string })))
  const poleMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.07, 0.09, 7, 6).translate(0, 3.5, 0),
    new THREE.MeshLambertMaterial({ color: colors.pole }),
    Math.max(poles.length, 1)
  )
  poleMesh.count = poles.length
  const m = new THREE.Matrix4()
  poles.forEach(([x, y, z], i) => poleMesh.setMatrixAt(i, m.makeTranslation(x, y - 0.2, z)))
  group.add(poleMesh)

  // ---- animation
  const q = new THREE.Quaternion()
  const qa = new THREE.Quaternion()
  const s = new THREE.Vector3()
  const v = new THREE.Vector3()
  const yAxis = new THREE.Vector3(0, 1, 0)
  const xAxis = new THREE.Vector3(1, 0, 0)
  const shoulder = new THREE.Vector3()
  let cheering = 0
  function update(riderX: number, riderZ: number, t: number) {
    cheering = 0
    people.forEach((pp, i) => {
      const dist = Math.hypot(pp.x - riderX, pp.z - riderZ)
      const excite = smooth01(50, 12, dist)
      if (excite > 0.5) cheering++
      const hop = excite * Math.abs(Math.sin(t * 8 + pp.phase)) * 0.3
      q.setFromAxisAngle(yAxis, -pp.yaw)
      s.setScalar(pp.scale)
      m.compose(v.set(pp.x, pp.y + hop, pp.z), q, s)
      bodies.setMatrixAt(i, m)
      m.compose(v.set(pp.x, pp.y + hop + 1.45 * pp.scale, pp.z), q, s)
      heads.setMatrixAt(i, m)
      // Arms: hang by the sides at rest, thrown up and waving when the rider is close.
      const wave = Math.sin(t * 10 + pp.phase) * 0.35
      const raise = 0.15 + excite * (2.5 + wave)
      for (const [mesh, side] of [
        [armsL, -1],
        [armsR, 1],
      ] as const) {
        shoulder.set(0, 1.22 * pp.scale, side * 0.21 * pp.scale).applyQuaternion(q)
        qa.setFromAxisAngle(xAxis, -side * raise) // swing outward, away from the body
        m.compose(v.set(pp.x, pp.y + hop, pp.z).add(shoulder), q.clone().multiply(qa), s)
        mesh.setMatrixAt(i, m)
      }
    })
    for (const mesh of [bodies, heads, armsL, armsR]) mesh.instanceMatrix.needsUpdate = true
    // Flags flutter about the string.
    flags.forEach((f, i) => {
      q.setFromAxisAngle(yAxis, f.yaw)
      qa.setFromAxisAngle(xAxis, Math.sin(t * 3 + f.phase) * 0.35)
      m.compose(v.set(f.x, f.y, f.z), q.multiply(qa), s.setScalar(1))
      flagMesh.setMatrixAt(i, m)
    })
    flagMesh.instanceMatrix.needsUpdate = true
  }
  update(Infinity, Infinity, 0)
  return {
    group,
    update,
    people: n,
    flags: flags.length,
    get cheering() {
      return cheering
    },
  }
}

/** Sidewalk paving: square slabs with joints. */
export function makePavingTexture(colors: { slab: string; joint: string }) {
  const size = 128
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = size
  const g = canvas.getContext("2d")!
  g.fillStyle = colors.joint
  g.fillRect(0, 0, size, size)
  g.fillStyle = colors.slab
  const n = 2
  const w = size / n
  for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) g.fillRect(i * w + 2, k * w + 2, w - 4, w - 4)
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
