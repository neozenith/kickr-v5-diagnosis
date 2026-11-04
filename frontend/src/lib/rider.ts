// Procedural cyclist on a road bike, in metres.
// Local frame: +x forward, +y up, +z to the rider's right. Origin on the ground under the bottom bracket.
// Legs and arms are two-bone IK chains: feet follow the pedals, hands stay on the bars.
import * as THREE from "three"

const WHEEL_R = 0.34
const REAR = new THREE.Vector3(-0.41, WHEEL_R, 0)
const FRONT = new THREE.Vector3(0.6, WHEEL_R, 0)
const BB = new THREE.Vector3(0, 0.27, 0)
const SEAT = new THREE.Vector3(-0.17, 0.95, 0)
const HEAD_TOP = new THREE.Vector3(0.5, 0.9, 0)
const HEAD_BOTTOM = new THREE.Vector3(0.53, 0.74, 0)
const BAR = new THREE.Vector3(0.56, 0.98, 0)
const CRANK = 0.17
const THIGH = 0.47
const SHIN = 0.47
const UPPER_ARM = 0.3
const FOREARM = 0.3
const HIP = new THREE.Vector3(-0.13, 1.02, 0)
const SHOULDER = new THREE.Vector3(0.3, 1.38, 0)
const HALF_HIPS = 0.1
const HALF_SHOULDERS = 0.18
const HALF_BAR = 0.2

const UP = new THREE.Vector3(0, 1, 0)
const tmp = new THREE.Vector3()

/** Place a unit-height cylinder so it spans a to b. */
function span(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) {
  tmp.subVectors(b, a)
  const len = tmp.length()
  mesh.position.addVectors(a, b).multiplyScalar(0.5)
  mesh.scale.set(1, len, 1)
  mesh.quaternion.setFromUnitVectors(UP, tmp.normalize())
}

/**
 * Two-bone IK in the x-y plane. Returns the middle joint.
 * bend = +1 puts the joint forward of the chain (knees), -1 below it (elbows).
 */
function solve(root: THREE.Vector3, target: THREE.Vector3, a: number, b: number, bend: 1 | -1) {
  const dx = target.x - root.x
  const dy = target.y - root.y
  const d = Math.min(Math.hypot(dx, dy), a + b - 1e-4)
  const base = Math.atan2(dy, dx)
  const cos = (a * a + d * d - b * b) / (2 * a * d)
  const alpha = Math.acos(Math.max(-1, Math.min(1, cos)))
  const ang = base + bend * alpha
  return new THREE.Vector3(root.x + a * Math.cos(ang), root.y + a * Math.sin(ang), root.z)
}

export type RiderColors = { frame: string; jersey: string; skin: string; tyre: string; shorts: string }

export class Rider {
  readonly group = new THREE.Group()
  private wheels: THREE.Group[] = []
  private limbs: Record<string, THREE.Mesh> = {}
  private joints: Record<string, THREE.Mesh> = {}
  private crankArms: THREE.Mesh[] = []
  private pedals: THREE.Mesh[] = []
  crankAngle = 0
  wheelAngle = 0

  constructor(c: RiderColors) {
    const mat = (color: string) => new THREE.MeshLambertMaterial({ color })
    const frame = mat(c.frame)
    const jersey = mat(c.jersey)
    const skin = mat(c.skin)
    const tyre = mat(c.tyre)
    const shorts = mat(c.shorts)
    const tube = (r: number, m: THREE.Material) => new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 10), m)
    const ball = (r: number, m: THREE.Material) => new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), m)

    // Wheels: tyre, rim and spokes, so rotation is visible.
    for (const centre of [REAR, FRONT]) {
      const w = new THREE.Group()
      w.add(new THREE.Mesh(new THREE.TorusGeometry(WHEEL_R - 0.015, 0.016, 8, 40), tyre))
      w.add(new THREE.Mesh(new THREE.TorusGeometry(WHEEL_R - 0.045, 0.008, 6, 40), frame))
      for (let i = 0; i < 6; i++) {
        const s = tube(0.004, frame)
        s.scale.y = 2 * (WHEEL_R - 0.05)
        s.rotation.z = (i / 6) * Math.PI
        w.add(s)
      }
      w.position.copy(centre)
      this.wheels.push(w)
      this.group.add(w)
    }

    // Frame.
    const tubes: [THREE.Vector3, THREE.Vector3, number][] = [
      [BB, SEAT, 0.018],
      [BB, HEAD_BOTTOM, 0.022],
      [SEAT, HEAD_TOP, 0.016],
      [REAR, BB, 0.012],
      [REAR, SEAT, 0.011],
      [HEAD_BOTTOM, HEAD_TOP, 0.02],
      [HEAD_BOTTOM, FRONT, 0.012],
      [HEAD_TOP, BAR, 0.014],
    ]
    for (const [a, b, r] of tubes) {
      const t = tube(r, frame)
      span(t, a, b)
      this.group.add(t)
    }
    const bar = tube(0.014, frame)
    span(bar, BAR.clone().setZ(-HALF_BAR), BAR.clone().setZ(HALF_BAR))
    this.group.add(bar)
    const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.04, 0.12), tyre)
    saddle.position.copy(SEAT).add(new THREE.Vector3(0, 0.03, 0))
    this.group.add(saddle)

    // Cranks and pedals, one per side.
    for (let i = 0; i < 2; i++) {
      const arm = tube(0.012, frame)
      const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.08), tyre)
      this.crankArms.push(arm)
      this.pedals.push(pedal)
      this.group.add(arm, pedal)
    }

    // Body.
    const torso = tube(0.13, jersey)
    span(torso, HIP, SHOULDER)
    this.group.add(torso)
    const head = ball(0.11, skin)
    head.position.copy(SHOULDER).add(new THREE.Vector3(0.12, 0.2, 0))
    this.group.add(head)
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), frame)
    helmet.position.copy(head.position).add(new THREE.Vector3(-0.01, 0.02, 0))
    helmet.rotation.z = 0.35
    this.group.add(helmet)
    const pelvis = ball(0.13, shorts)
    pelvis.position.copy(HIP)
    this.group.add(pelvis)

    for (const side of ["L", "R"]) {
      this.limbs[`thigh${side}`] = tube(0.065, shorts)
      this.limbs[`shin${side}`] = tube(0.045, skin)
      this.limbs[`upper${side}`] = tube(0.045, jersey)
      this.limbs[`fore${side}`] = tube(0.035, skin)
      this.joints[`knee${side}`] = ball(0.05, skin)
      this.joints[`foot${side}`] = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.08), tyre)
      this.joints[`elbow${side}`] = ball(0.04, jersey)
    }
    Object.values(this.limbs).forEach((m) => this.group.add(m))
    Object.values(this.joints).forEach((m) => this.group.add(m))
    this.pose()
  }

  /** Mesh count, so tests can check the model was built. */
  get parts() {
    let n = 0
    this.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) n++
    })
    return n
  }

  /** Advance pedals by cadence (rpm) and wheels by road speed (m/s) over dt seconds. */
  update(cadence: number, speed: number, dt: number) {
    this.crankAngle = (this.crankAngle + (cadence / 60) * Math.PI * 2 * dt) % (Math.PI * 2)
    this.wheelAngle = (this.wheelAngle + (speed / WHEEL_R) * dt) % (Math.PI * 2)
    this.pose()
  }

  private pose() {
    for (const w of this.wheels) w.rotation.z = -this.wheelAngle
    const sides: ["L" | "R", number, number][] = [
      ["L", -1, this.crankAngle],
      ["R", 1, this.crankAngle + Math.PI],
    ]
    sides.forEach(([s, z, ang], i) => {
      const pedal = new THREE.Vector3(BB.x + CRANK * Math.cos(ang), BB.y - CRANK * Math.sin(ang), z * 0.12)
      span(this.crankArms[i], BB.clone().setZ(z * 0.06), pedal)
      this.pedals[i].position.copy(pedal)

      const hip = HIP.clone().setZ(z * HALF_HIPS)
      const foot = pedal.clone().setZ(z * HALF_HIPS)
      const knee = solve(hip, foot, THIGH, SHIN, 1)
      span(this.limbs[`thigh${s}`], hip, knee)
      span(this.limbs[`shin${s}`], knee, foot)
      this.joints[`knee${s}`].position.copy(knee)
      this.joints[`foot${s}`].position.copy(foot).add(new THREE.Vector3(0.03, 0.02, 0))

      const shoulder = SHOULDER.clone().setZ(z * HALF_SHOULDERS)
      const hand = BAR.clone().setZ(z * HALF_BAR)
      const elbow = solve(shoulder, hand, UPPER_ARM, FOREARM, -1)
      span(this.limbs[`upper${s}`], shoulder, elbow)
      span(this.limbs[`fore${s}`], elbow, hand)
      this.joints[`elbow${s}`].position.copy(elbow)
    })
  }
}
