import { useEffect, useMemo, useRef, useState } from "react"
import * as THREE from "three"
import type { Data, Layout } from "plotly.js-dist-min"

import { Plot, plotlyTheme, useResolvedMode } from "@/components/plot"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Slider } from "@/components/ui/slider"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Rider } from "@/lib/rider"
import { buildRoute, exaggerate, rideStep, routeIndex, sample, SWITCHBACKS, type Route } from "@/lib/route"
import {
  driftClouds,
  makeClouds,
  makeCobbleTexture,
  makeFestival,
  makePavingTexture,
  makeRidge,
  makeSky,
  makeTrees,
  makeVillage,
} from "@/lib/scenery"
import { ensureStream, getStream, RETAIN_S, type Source, SOURCES, useStream } from "@/lib/stream"

type PowerSource = "pm_crank" | "ftms" | "manual"
const POWER_LABEL: Record<PowerSource, string> = {
  pm_crank: "4iiii reference",
  ftms: "Trainer (FTMS)",
  manual: "Manual",
}

type Ride = {
  d: number
  v: number
  power: number
  cadence: number
  grade: number
  y: number
  laps: number
  elapsed: number
}

const ROAD_W = 7
const LIFT = 0.2 // road surface above the route centreline height
const GRID_STEP = 10 // metres between terrain grid lines
const GRID_MAJOR = 5 // every 5th line is brighter
const NEAR = 70 // metres: road points within this radius shape the ground
const SIDEWALK = 2.2 // village sidewalk width (m)

/** Which stretch of road a segment belongs to: plain tarmac, or the village's cobbles. */
type Surface = "tarmac" | "cobbles"
const surfaceOf = (zone: string | undefined): Surface => (zone === "village" ? "cobbles" : "tarmac")

/**
 * Flat strip that follows the loop, offset sideways from the centreline, on one surface.
 * UVs are in metres / TILE so textures keep a constant scale along and across the road.
 */
const TILE = 2
function ribbon(route: Route, offset: number, width: number, lift: number, surface: Surface = "tarmac") {
  const pts = route.points
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    const h = Math.atan2(q.z - p.z, q.x - p.x)
    const nx = -Math.sin(h)
    const nz = Math.cos(h)
    const o1 = offset + width / 2
    const o2 = offset - width / 2
    pos.push(p.x + nx * o1, p.y + lift, p.z + nz * o1, p.x + nx * o2, p.y + lift, p.z + nz * o2)
    uv.push(0, p.d / TILE, width / TILE, p.d / TILE)
    if (surfaceOf(p.zone) !== surface) continue
    const a = i * 2
    const b = ((i + 1) % pts.length) * 2
    idx.push(a, b, a + 1, a + 1, b, b + 1)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/** Centreline dashes on tarmac: DASH metres painted, GAP metres bare, sampled along the loop. */
function dashes(route: Route, dash = 3, gap = 6, width = 0.15) {
  const pos: number[] = []
  const idx: number[] = []
  const v = route.zones.village
  let n = 0
  for (let s = 0; s + dash < route.length; s += dash + gap) {
    if (s + dash > v.from - 2 && s < v.to + 2) continue // no paint on cobbles
    const a = sample(route, s)
    const b = sample(route, s + dash)
    const nx = -Math.sin(a.heading) * (width / 2)
    const nz = Math.cos(a.heading) * (width / 2)
    const y1 = a.y + LIFT + 0.03
    const y2 = b.y + LIFT + 0.03
    pos.push(a.x + nx, y1, a.z + nz, a.x - nx, y1, a.z - nz, b.x + nx, y2, b.z + nz, b.x - nx, y2, b.z - nz)
    const k = n * 4
    idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3)
    n++
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return { geometry: g, count: n }
}

/**
 * Ground height at (x, z).
 * - Beside the road: the road's own height, so the road is cut into the hillside.
 * - Between nearby road sections (e.g. switchback legs): a weighted blend of their heights,
 *   which forms the slope between them.
 * - Further out: rolling hills.
 */
function makeGround(route: Route) {
  const coarse = route.points.filter((_, i) => i % 8 === 0)
  const index = routeIndex(route.points)
  const smooth = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)
  }
  return (x: number, z: number) => {
    let best = Infinity
    let yc = 0
    for (const p of coarse) {
      const d2 = (p.x - x) ** 2 + (p.z - z) ** 2
      if (d2 < best) {
        best = d2
        yc = p.y
      }
    }
    let dn = Infinity
    let yn = 0
    let wsum = 0
    let ysum = 0
    index.near(x, z, NEAR, (p, d2) => {
      if (d2 < dn) {
        dn = d2
        yn = p.y
      }
      const w = 1 / (d2 + 16)
      wsum += w
      ysum += w * p.y
    })
    let near = yc - 0.5
    if (wsum > 0) {
      const t = smooth(ROAD_W / 2 + 0.5, ROAD_W / 2 + 20, Math.sqrt(dn))
      near = yn * (1 - t) + (ysum / wsum) * t - 0.4
    }
    const fall = smooth(NEAR, 600, Math.sqrt(best))
    const hills = 18 * Math.sin(x / 210 + 0.7) * Math.cos(z / 260) + 9 * Math.sin((x + z) / 120)
    return near * (1 - fall) + (hills - 4) * fall
  }
}

function terrainGeometry(ground: (x: number, z: number) => number) {
  const size = 3200
  const seg = 320 // 10 m vertices; the grid itself is per-pixel
  const g = new THREE.PlaneGeometry(size, size, seg, seg)
  g.rotateX(-Math.PI / 2)
  const pos = g.attributes.position
  for (let i = 0; i < pos.count; i++) pos.setY(i, ground(pos.getX(i), pos.getZ(i)))
  g.computeVertexNormals()
  return g
}

/**
 * Terrain material with a world-space grid drawn in the fragment shader:
 * minor lines every GRID_STEP metres, major lines every GRID_MAJOR steps.
 * The lines drape over the hills and cost nothing per vertex.
 */
function gridMaterial(ground: string, minor: string, major: string) {
  const m = new THREE.MeshLambertMaterial({ color: ground })
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uStep = { value: GRID_STEP }
    shader.uniforms.uMajor = { value: GRID_MAJOR }
    shader.uniforms.uMinorColor = { value: new THREE.Color(minor) }
    shader.uniforms.uMajorColor = { value: new THREE.Color(major) }
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGridPos;")
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\nvGridPos = (modelMatrix * vec4(transformed, 1.0)).xyz;"
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vGridPos;
uniform float uStep;
uniform float uMajor;
uniform vec3 uMinorColor;
uniform vec3 uMajorColor;
float gridLine(vec2 p, float step) {
  vec2 c = p / step;
  vec2 g = abs(fract(c - 0.5) - 0.5) / (1.5 * fwidth(c));
  return 1.0 - min(min(g.x, g.y), 1.0);
}`
      )
      .replace(
        "#include <fog_fragment>",
        `gl_FragColor.rgb = mix(gl_FragColor.rgb, uMinorColor, 0.35 * gridLine(vGridPos.xz, uStep));
gl_FragColor.rgb = mix(gl_FragColor.rgb, uMajorColor, 0.7 * gridLine(vGridPos.xz, uStep * uMajor));
#include <fog_fragment>`
      )
  }
  return m
}

const VERT = 2.5 // display-only height exaggeration (see exaggerate in lib/route)

const mixHex = (a: string, b: string, t: number) => "#" + new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString()

function Scene({
  route: trueRoute,
  ride,
  step,
  testId,
}: {
  route: Route
  ride: React.RefObject<Ride>
  step: React.RefObject<(dt: number) => void>
  testId: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const mode = useResolvedMode()
  const theme = plotlyTheme(mode)
  const route = useMemo(() => exaggerate(trueRoute, VERT), [trueRoute])

  useEffect(() => {
    const el = host.current
    if (!el) return
    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true })
    renderer.setPixelRatio(devicePixelRatio)
    renderer.setSize(el.clientWidth, el.clientHeight)
    el.appendChild(renderer.domElement)

    // Sky: dusk in dark mode, daylight in light mode, both from the profile palette.
    const sky =
      mode === "dark"
        ? { top: mixHex(theme.diverging.positive["1"], "#000000", 0.55), horizon: theme.sequential[3] }
        : { top: mixHex(theme.colorway[5], "#ffffff", 0.35), horizon: mixHex(theme.colorway[5], "#ffffff", 0.82) }
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(sky.horizon)
    scene.fog = new THREE.Fog(sky.horizon, 150, 1700)
    const camera = new THREE.PerspectiveCamera(60, el.clientWidth / el.clientHeight, 0.2, 9000)
    const skyDome = makeSky(sky)
    scene.add(skyDome)

    scene.add(new THREE.HemisphereLight(0xffffff, theme.paper_bgcolor, 1.6))
    const sun = new THREE.DirectionalLight(0xffffff, 1.4)
    sun.position.set(600, 900, 300)
    scene.add(sun)

    // Mountains: three ridges at increasing distance, fading into the horizon colour.
    const cx = route.points.reduce((a, p) => a + p.x, 0) / route.points.length
    const cz = route.points.reduce((a, p) => a + p.z, 0) / route.points.length
    const ridges = [
      { radius: 2100, height: 150, fade: 0.3, seed: 11 },
      { radius: 3200, height: 280, fade: 0.55, seed: 23 },
      { radius: 4800, height: 520, fade: 0.78, seed: 37 },
    ]
    for (const r of ridges) {
      scene.add(
        makeRidge({ cx, cz, radius: r.radius, base: -25, height: r.height, seed: r.seed, color: mixHex(theme.muted[1], sky.horizon, r.fade) })
      )
    }
    const clouds = makeClouds({ cx, cz, color: mixHex("#ffffff", sky.horizon, 0.25), count: 28, seed: 5 })
    scene.add(clouds)

    // Ground: rolling terrain with a world grid, plus a far plane out to the mountains.
    const ground = makeGround(route)
    scene.add(new THREE.Mesh(terrainGeometry(ground), gridMaterial(theme.muted[0], theme.font_color, theme.colorway[0])))
    const far = new THREE.Mesh(
      new THREE.CircleGeometry(6000, 64).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: theme.muted[0] })
    )
    far.position.set(cx, -30, cz)
    scene.add(far)

    // Village at the bottom of the switchbacks: houses on the cobbled streets, and a church.
    const village = makeVillage({
      route,
      heightAt: ground,
      roadW: ROAD_W,
      sidewalk: SIDEWALK,
      seed: 13,
      colors: {
        walls: ["#f1e6d2", "#e8dcc4", mixHex("#f1e6d2", theme.colorway[1], 0.25), mixHex("#efe9df", theme.colorway[0], 0.2)],
        roofs: [mixHex(theme.colorway[6], "#000000", 0.25), mixHex(theme.colorway[1], "#000000", 0.35), mixHex(theme.colorway[3], "#000000", 0.4)],
        church: "#d9d2c3",
        spire: mixHex(theme.colorway[7], "#000000", 0.35),
      },
    })
    scene.add(village.group)

    const trees = makeTrees({
      route,
      heightAt: ground,
      avoid: village.avoid,
      roadClear: ROAD_W / 2 + 3,
      count: 1400,
      seed: 7,
      colors: {
        trunk: mixHex(theme.colorway[1], "#000000", 0.55),
        crowns: [theme.colorway[4], theme.colorway[7], mixHex(theme.colorway[4], "#000000", 0.3)],
      },
    })
    scene.add(trees.group)

    const paint = (color: string) =>
      new THREE.MeshLambertMaterial({ color, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
    scene.add(new THREE.Mesh(ribbon(route, 0, ROAD_W, LIFT), new THREE.MeshLambertMaterial({ color: theme.colorway[0], side: THREE.DoubleSide })))
    const cobbles = makeCobbleTexture({
      mortar: mixHex(theme.muted[0], "#000000", 0.45),
      stones: [theme.muted[1], theme.muted[2], mixHex(theme.muted[2], theme.colorway[1], 0.2), mixHex(theme.muted[1], theme.colorway[0], 0.15)],
    })
    scene.add(
      new THREE.Mesh(
        ribbon(route, 0, ROAD_W, LIFT, "cobbles"),
        new THREE.MeshLambertMaterial({ map: cobbles, side: THREE.DoubleSide })
      )
    )
    // Village sidewalks: paved, raised a kerb's height above the cobbles.
    const paving = new THREE.MeshLambertMaterial({
      map: makePavingTexture({ slab: "#cfc8bb", joint: "#8f897e" }),
      side: THREE.DoubleSide,
    })
    for (const side of [-1, 1]) {
      scene.add(new THREE.Mesh(ribbon(route, side * (ROAD_W / 2 + SIDEWALK / 2), SIDEWALK, LIFT + 0.12, "cobbles"), paving))
    }

    // Festival for the race: a cheering crowd on the sidewalks and bunting across the streets.
    const festival = makeFestival({
      route,
      heightAt: ground,
      roadW: ROAD_W,
      sidewalk: SIDEWALK,
      lift: LIFT,
      seed: 21,
      colors: {
        shirts: [theme.colorway[0], theme.colorway[1], theme.colorway[2], theme.colorway[3], theme.colorway[4], theme.colorway[6], "#f4f1ea"],
        skins: ["#f6d7b8", "#e8b98f", "#c68642", "#8d5524", "#5c3a21"],
        flags: [theme.colorway[0], theme.colorway[1], theme.colorway[2], theme.colorway[3], theme.colorway[4], theme.colorway[6]],
        pole: "#6b6b6b",
        string: "#e8e8e8",
      },
    })
    scene.add(festival.group)
    for (const side of [-1, 1]) {
      scene.add(new THREE.Mesh(ribbon(route, side * (ROAD_W / 2 - 0.35), 0.15, LIFT + 0.02), paint("#ffffff")))
    }
    const centre = dashes(route)
    scene.add(new THREE.Mesh(centre.geometry, paint("#ffffff")))

    // Start/finish arch: two posts and a banner the rider passes under.
    const s0 = sample(route, 0)
    const gateMat = new THREE.MeshLambertMaterial({ color: theme.colorway[1] })
    const gate = new THREE.Group()
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 5, 0.4), gateMat)
      post.position.set(0, 2.5, side * (ROAD_W / 2 + 1))
      gate.add(post)
    }
    const banner = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.9, ROAD_W + 2.4), gateMat)
    banner.position.set(0, 4.6, 0)
    gate.add(banner)
    gate.position.set(s0.x, s0.y + LIFT, s0.z)
    gate.rotation.y = -s0.heading
    scene.add(gate)

    // Cyclist, riding in the left lane.
    const rider = new Rider({
      frame: theme.colorway[3],
      jersey: theme.colorway[1],
      shorts: theme.muted[0],
      skin: theme.colorway[6],
      tyre: theme.plot_bgcolor,
    })
    scene.add(rider.group)

    el.dataset.gridStep = String(GRID_STEP)
    el.dataset.dashes = String(centre.count)
    el.dataset.riderParts = String(rider.parts)
    el.dataset.trees = String(trees.count)
    el.dataset.ridges = String(ridges.length)
    el.dataset.clouds = String(clouds.children.length)
    el.dataset.vert = String(VERT)
    // Switchbacks: hairpin count, and how far apart the ends of the 1 km section are as the crow flies.
    const sbA = sample(trueRoute, SWITCHBACKS.from)
    const sbB = sample(trueRoute, SWITCHBACKS.to)
    el.dataset.switchbacks = String(trueRoute.switchbacks)
    el.dataset.switchbackSpan = Math.hypot(sbB.x - sbA.x, sbB.z - sbA.z).toFixed(0)
    el.dataset.villageTurns = String(trueRoute.villageTurns)
    el.dataset.villageFrom = (trueRoute.zones.village.from / 1000).toFixed(3)
    el.dataset.houses = String(village.houses)
    el.dataset.church = String(village.church)
    el.dataset.people = String(festival.people)
    el.dataset.flags = String(festival.flags)

    const camPos = new THREE.Vector3()
    const look = new THREE.Vector3()
    const lookTarget = new THREE.Vector3()
    let camReady = false
    let last = performance.now()
    let raf = 0
    let frame = 0
    const draw = () => {
      const r = ride.current
      const now = performance.now()
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now
      // Physics steps here, once per rendered frame, so position and camera move together.
      step.current(dt)
      rider.update(r.cadence, r.v, dt)
      driftClouds(clouds, dt)
      const d = r.d
      const p = sample(route, d)
      const lane = -1.6 // metres along the rider's +z (right), so negative keeps left, as in Australia
      rider.group.position.set(p.x - Math.sin(p.heading) * lane, p.y + LIFT, p.z + Math.cos(p.heading) * lane)
      rider.group.rotation.set(0, -p.heading, Math.atan(p.grade / 100))
      festival.update(rider.group.position.x, rider.group.position.z, now / 1000)
      const behind = sample(route, d - 4.5)
      camPos.set(behind.x - Math.sin(behind.heading) * (lane + 2.6), behind.y + 1.7, behind.z + Math.cos(behind.heading) * (lane + 2.6))
      // Frame-rate independent smoothing: the same response at 30 or 144 fps.
      const first = !camReady
      const ease = first ? 1 : 1 - Math.exp(-dt * 5)
      camReady = true
      camera.position.lerp(camPos, ease)
      lookTarget.set(rider.group.position.x, rider.group.position.y + 1.1, rider.group.position.z)
      look.lerp(lookTarget, first ? 1 : 1 - Math.exp(-dt * 12))
      camera.lookAt(look)
      skyDome.position.copy(camera.position)
      renderer.render(scene, camera)
      el.dataset.riderDistance = d.toFixed(3)
      if (++frame % 6 === 0) {
        el.dataset.crankAngle = rider.crankAngle.toFixed(3)
        el.dataset.cheering = String(festival.cheering)
        // True (unexaggerated) height of the rider's road position, to check against the HUD.
        el.dataset.riderElevation = (p.y / VERT).toFixed(2)
        el.dataset.riderGrade = (p.grade / VERT).toFixed(2)
      }
      raf = requestAnimationFrame(draw)
    }
    camera.position.set(s0.x - 8, s0.y + 2.4, s0.z)
    raf = requestAnimationFrame(draw)

    const ro = new ResizeObserver(() => {
      renderer.setSize(el.clientWidth, el.clientHeight)
      camera.aspect = el.clientWidth / el.clientHeight
      camera.updateProjectionMatrix()
    })
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      renderer.dispose()
      el.removeChild(renderer.domElement)
    }
  }, [route, trueRoute, ride, step, theme, mode])

  return <div ref={host} className="h-[36rem] w-full overflow-hidden rounded-lg" data-testid={testId} />
}

/**
 * Latest value of a metric from a source, or 0 once it goes quiet.
 * Crank meters stop sending cadence when the cranks stop, so stale means 0.
 */
function fresh(metric: "power" | "cadence", src: Source) {
  const s = getStream()
  const series = s.series[`${metric}.${src}`]
  const n = series?.t.length ?? 0
  if (!n || s.latestT - series.t[n - 1] > 2) return 0
  const v = series.v[n - 1]
  return Number.isFinite(v) ? v : 0
}

const TREND_S = RETAIN_S // 5 minutes
const TREND: { metric: "power" | "cadence" | "speed"; label: string; sources: Source[] }[] = [
  { metric: "power", label: "W", sources: ["pm_crank", "ftms", "cps", "ant_fe"] },
  { metric: "cadence", label: "rpm", sources: ["pm_crank", "ftms", "cps", "ant_fe"] },
  { metric: "speed", label: "km/h", sources: ["ftms", "cps", "ant_fe"] },
]
const TREND_NAME: Record<Source, string> = { pm_crank: "4iiii", ftms: "FTMS", cps: "CPS", ant_fe: "ANT+" }

/** Top-left overlay: 5-minute live trend of power, cadence and speed from every streamed input. */
function LiveTrend({ active, children }: { active: PowerSource; children: React.ReactNode }) {
  const tick = useStream((s) => Math.floor(s.latestT * 2)) // redraw at 2 Hz
  const sse = useStream((s) => s.sse)
  const mode = useResolvedMode()
  const theme = plotlyTheme(mode)
  const { data, layout } = useMemo(() => {
    const s = getStream()
    const data: Data[] = TREND.flatMap(({ metric, sources }, row) =>
      sources.map((src) => {
        const series = s.series[`${metric}.${src}`] ?? { t: [], v: [] }
        const driving = src === active
        return {
          type: "scatter",
          mode: "lines",
          name: TREND_NAME[src],
          legendgroup: src,
          showlegend: row === 0,
          x: [...series.t],
          y: [...series.v],
          yaxis: row === 0 ? "y" : `y${row + 1}`,
          line: { color: theme.colorway[SOURCES.indexOf(src)], width: driving ? 2.5 : 1.2 },
          opacity: driving || active === "manual" ? 1 : 0.7,
          hovertemplate: `${TREND_NAME[src]} %{y:.0f}<extra></extra>`,
        } as Data
      })
    )
    const axis = (domain: [number, number], title: string) => ({
      domain,
      title: { text: title, standoff: 4 },
      gridcolor: theme.gridcolor,
      zerolinecolor: theme.gridcolor,
      rangemode: "tozero" as const,
    })
    const layout: Partial<Layout> = {
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      margin: { l: 40, r: 6, t: 4, b: 20 },
      font: { size: 10 },
      showlegend: true,
      legend: { orientation: "h", y: 1.12, x: 0, font: { size: 10 } },
      hovermode: "x unified",
      xaxis: { range: [s.latestT - TREND_S, s.latestT], ticksuffix: " s", anchor: "y3" },
      yaxis: axis([0.7, 1], "W"),
      yaxis2: axis([0.36, 0.64], "rpm"),
      yaxis3: axis([0, 0.3], "km/h"),
    }
    return { data, layout }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, active, theme])
  return (
    <Card
      size="sm"
      className="absolute top-3 left-3 w-[min(28rem,calc(50%-1.5rem))] bg-card/80 backdrop-blur-sm"
      data-testid="inputs-overlay"
    >
      <CardHeader>
        <CardTitle>Live inputs</CardTitle>
        <CardDescription>Last 5 minutes, all streamed sources</CardDescription>
        <CardAction>
          <Badge variant={sse === "live" ? "secondary" : "destructive"}>{sse}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-3 gap-3" data-testid="ride-stats">
          {children}
        </div>
        <Plot data={data} layout={layout} className="h-64 w-full" testId="inputs-trend" />
      </CardContent>
    </Card>
  )
}

const START_KM = 4.0

/** Bottom-right HUD: top-down map of the loop, shaded by elevation, with start line and rider. */
function RouteMap({ route, d }: { route: Route; d: number }) {
  const mode = useResolvedMode()
  const theme = plotlyTheme(mode)
  const base = useMemo<Data[]>(
    () => [
      {
        type: "scatter",
        mode: "markers",
        x: route.points.map((p) => p.x),
        y: route.points.map((p) => p.z),
        marker: {
          size: 4,
          color: route.points.map((p) => p.y),
          // Low ground dark, high ground light, from the profile's sequential palette.
          colorscale: [...theme.sequential].reverse().map((c, i, a) => [i / (a.length - 1), c] as [number, string]),
          showscale: false,
        },
        hovertemplate: "%{marker.color:.0f} m<extra></extra>",
        name: "route",
      },
    ],
    [route, theme]
  )
  const data = useMemo<Data[]>(() => {
    const start = sample(route, 0)
    const here = sample(route, d)
    return [
      ...base,
      {
        type: "scatter",
        mode: "text+markers",
        x: [start.x],
        y: [start.z],
        marker: { symbol: "line-ns-open", size: 14, color: theme.colorway[1], line: { width: 3, color: theme.colorway[1] } },
        text: ["start"],
        textposition: "top center",
        textfont: { color: theme.font_color, size: 10 },
        hoverinfo: "skip",
        name: "start",
      },
      {
        type: "scatter",
        mode: "markers",
        x: [here.x],
        y: [here.z],
        marker: { size: 12, color: theme.colorway[3], line: { width: 2, color: theme.font_color } },
        hoverinfo: "skip",
        name: "rider",
      },
    ]
  }, [base, route, d, theme])
  const layout = useMemo<Partial<Layout>>(
    () => ({
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      margin: { l: 4, r: 4, t: 4, b: 4 },
      hovermode: "closest",
      // Same orientation as the 3D world seen from above: +x right, +z down the screen.
      xaxis: { visible: false, scaleanchor: "y", scaleratio: 1 },
      yaxis: { visible: false, autorange: "reversed", rangemode: "normal" },
    }),
    []
  )
  return (
    <Card
      size="sm"
      className="absolute right-3 bottom-3 w-[min(18rem,calc(50%-1.5rem))] bg-card/80 backdrop-blur-sm"
      data-testid="map-overlay"
    >
      <CardHeader>
        <CardTitle>Route map</CardTitle>
        <CardDescription>Top-down, shaded by elevation</CardDescription>
      </CardHeader>
      <CardContent>
        <Plot data={data} layout={layout} className="h-44 w-full" testId="route-map" />
      </CardContent>
    </Card>
  )
}

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-2xl tabular-nums" data-testid={testId}>
        {value}
      </span>
    </div>
  )
}

export function RoutePage() {
  const route = useMemo(buildRoute, [])
  // Start (and reset) at START_KM, or at ?at=<km> when given (tests and screenshots use it).
  const atParam = new URLSearchParams(location.search).get("at")
  const startD = (atParam === null ? START_KM : Number(atParam)) * 1000
  const ride = useRef<Ride>({
    d: startD,
    v: 0,
    power: 0,
    cadence: 0,
    grade: sample(route, startD).grade,
    y: sample(route, startD).y,
    laps: 0,
    elapsed: 0,
  })
  const [source, setSource] = useState<PowerSource>("pm_crank")
  const [manual, setManual] = useState(200)
  const [manualCadence, setManualCadence] = useState(90)
  const [running, setRunning] = useState(true)
  const [view, setView] = useState<Ride>(ride.current)
  const mode = useResolvedMode()
  const theme = plotlyTheme(mode)

  // Physics: stepped by the 3D view once per rendered frame, so position and camera stay in lockstep.
  const step = useRef<(dt: number) => void>(() => {})
  useEffect(() => {
    step.current = (dt: number) => {
      if (!running) return
      const r = ride.current
      const p = sample(route, r.d)
      r.grade = p.grade
      r.y = p.y
      r.v = rideStep(r.v, r.power, p.grade, dt)
      const before = r.d
      r.d = (r.d + r.v * dt) % route.length
      if (r.d < before) r.laps++
      r.elapsed += dt
    }
  }, [route, running])

  // Inputs sampled at 20 Hz; React view state (HUD numbers, charts) at 5 Hz.
  useEffect(() => {
    ensureStream()
    let n = 0
    const id = setInterval(() => {
      const r = ride.current
      if (source === "manual") {
        r.power = manual
        r.cadence = manualCadence
      } else {
        r.power = fresh("power", source)
        r.cadence = fresh("cadence", source)
      }
      if (++n % 4 === 0) setView({ ...r })
    }, 50)
    return () => clearInterval(id)
  }, [source, manual, manualCadence])

  // The route trace never changes: build it once so 5 Hz updates only move the rider marker.
  const profileBase = useMemo<Data>(
    () => ({
      type: "scatter",
      mode: "lines",
      x: route.points.map((p) => p.d / 1000),
      y: route.points.map((p) => p.y),
      fill: "tozeroy",
      line: { color: theme.colorway[0], width: 2 },
      name: "elevation",
      hovertemplate: "%{x:.2f} km, %{y:.0f} m<extra></extra>",
    }),
    [route, theme]
  )
  const profile = useMemo<Data[]>(
    () => [
      profileBase,
      {
        type: "scatter",
        mode: "markers",
        x: [view.d / 1000],
        y: [view.y],
        marker: { color: theme.colorway[3], size: 12 },
        name: "rider",
      },
    ],
    [profileBase, theme, view.d, view.y]
  )
  const profileLayout = useMemo<Partial<Layout>>(
    () => ({
      // Transparent, compact: the overlay card supplies the background.
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      margin: { l: 32, r: 6, t: 4, b: 22 },
      font: { size: 10 },
      xaxis: { range: [0, route.length / 1000], ticksuffix: " km" },
      yaxis: { rangemode: "normal", ticksuffix: " m" },
      hovermode: "closest",
    }),
    [route]
  )

  const reset = () => {
    Object.assign(ride.current, { d: startD, v: 0, laps: 0, elapsed: 0 })
    setView({ ...ride.current })
  }

  return (
    <div className="flex flex-col gap-4">
      <Card size="sm">
        <CardHeader>
          <CardTitle>Virtual circuit</CardTitle>
          <CardDescription>
            {(route.length / 1000).toFixed(2)} km loop, {route.climb.toFixed(0)} m climbing per lap, grades{" "}
            {route.minGrade.toFixed(1)}% to {route.maxGrade.toFixed(1)}%
          </CardDescription>
          <CardAction className="flex flex-wrap items-center gap-2">
            <ToggleGroup
              value={[source]}
              onValueChange={(v: string[]) => v[0] && setSource(v[0] as PowerSource)}
              variant="outline"
              size="sm"
              data-testid="power-source"
            >
              {(Object.keys(POWER_LABEL) as PowerSource[]).map((k) => (
                <ToggleGroupItem key={k} value={k} data-testid={`power-source-${k}`}>
                  {POWER_LABEL[k]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Button size="sm" variant="outline" onClick={() => setRunning(!running)} data-testid="ride-toggle">
              {running ? "Pause" : "Ride"}
            </Button>
            <Button size="sm" variant="outline" onClick={reset} data-testid="ride-reset">
              Reset
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {source === "manual" && (
            <div className="flex flex-wrap items-center gap-4">
              <span className="text-sm text-muted-foreground">Manual power</span>
              <Slider
                className="max-w-xs"
                min={0}
                max={600}
                step={10}
                value={[manual]}
                onValueChange={(v) => setManual(Array.isArray(v) ? v[0] : v)}
                data-testid="manual-power"
              />
              <Badge variant="secondary">{manual} W</Badge>
              <span className="text-sm text-muted-foreground">Manual cadence</span>
              <Slider
                className="max-w-xs"
                min={0}
                max={130}
                step={5}
                value={[manualCadence]}
                onValueChange={(v) => setManualCadence(Array.isArray(v) ? v[0] : v)}
                data-testid="manual-cadence"
              />
              <Badge variant="secondary">{manualCadence} rpm</Badge>
            </div>
          )}
          <div className="relative">
            <Scene route={route} ride={ride} step={step} testId="route-scene" />
            <LiveTrend active={source}>
              <Stat label="power (W)" value={view.power.toFixed(0)} testId="ride-power" />
              <Stat label="cadence (rpm)" value={view.cadence.toFixed(0)} testId="ride-cadence" />
              <Stat label="speed (km/h)" value={(view.v * 3.6).toFixed(1)} testId="ride-speed" />
            </LiveTrend>
            <Card
              size="sm"
              className="absolute top-3 right-3 w-[min(26rem,calc(50%-1.5rem))] bg-card/80 backdrop-blur-sm"
              data-testid="elevation-overlay"
            >
              <CardHeader>
                <CardTitle>Elevation profile</CardTitle>
                <CardDescription>Rider position on the loop</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="grid grid-cols-4 gap-3" data-testid="route-stats">
                  <Stat label="grade (%)" value={view.grade.toFixed(1)} testId="ride-grade" />
                  <Stat label="elevation (m)" value={view.y.toFixed(0)} testId="ride-elevation" />
                  <Stat label="distance (km)" value={(view.d / 1000).toFixed(2)} testId="ride-distance" />
                  <Stat label="laps" value={String(view.laps)} testId="ride-laps" />
                </div>
                <Plot data={profile} layout={profileLayout} className="h-36 w-full" testId="elevation-profile" />
              </CardContent>
            </Card>
            <RouteMap route={route} d={view.d} />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
