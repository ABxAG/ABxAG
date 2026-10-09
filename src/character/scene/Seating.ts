/**
 * Seats and sitting styles.
 *
 * Sitting is solved, not keyframed. Every value below is derived from the
 * character's own leg measurements, so one set of styles fits any imported
 * model:
 *
 *   1. a seat (chair, sofa, stool, floor cushion or an invisible edge) is
 *      built at a height that suits her legs, and placed under her hips;
 *   2. the hips are lowered until they rest on its surface;
 *   3. each style describes where the knees, feet and hands should go
 *      relative to the seat and the floor, and two-bone IK places the limbs.
 *
 * The planner here is pure geometry (world space, character facing +Z);
 * PoseEditor.solveSeated executes the plan with the existing IK.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export type SeatKind = 'chair' | 'sofa' | 'stool' | 'cushion' | 'edge';
export type SitStyle =
  | 'upright' | 'relaxed' | 'crossed' | 'sideSaddle' | 'dangle' | 'hugKnees' | 'sideFold'
  | 'perch' | 'ankles' | 'leanBack' | 'handsOnKnees';

export const SEAT_LABEL: Record<SeatKind, string> = {
  chair: 'Chair',
  sofa: 'Sofa',
  stool: 'Bar stool',
  cushion: 'Floor cushion',
  edge: 'Edge (no seat)',
};

export const STYLE_LABEL: Record<SitStyle, string> = {
  upright: 'Upright',
  relaxed: 'Relaxed',
  crossed: 'Legs crossed',
  sideSaddle: 'Knees to the side',
  dangle: 'Legs dangling',
  hugKnees: 'Hugging knees',
  sideFold: 'Legs folded aside',
  perch: 'Perched, knees together',
  ankles: 'Ankles crossed',
  leanBack: 'Leaning back on her hands',
  handsOnKnees: 'Hands on her knees',
};

/** Which styles make physical sense on which seat (first is the default). */
export const STYLES_FOR_SEAT: Record<SeatKind, SitStyle[]> = {
  chair: ['upright', 'relaxed', 'crossed', 'sideSaddle'],
  sofa: ['relaxed', 'crossed', 'sideSaddle', 'upright'],
  stool: ['perch', 'ankles', 'dangle', 'crossed', 'upright'],
  cushion: ['sideFold', 'hugKnees'],
  // Edges (window tops, the taskbar): feminine, knees-together styles first.
  edge: ['perch', 'handsOnKnees', 'ankles', 'leanBack', 'crossed', 'dangle'],
};

/** Leg and body measurements in world space, from the character's rest pose. */
export interface SeatMeasures {
  /** Hip joints (thigh roots). */
  hipL: THREE.Vector3;
  hipR: THREE.Vector3;
  kneeL: THREE.Vector3;
  ankleL: THREE.Vector3;
  thigh: number;
  shin: number;
  /** Ankle joint height above the soles. */
  ankleHeight: number;
  /** Y of the floor she stands on (the soles). */
  floorY: number;
  height: number;
}

export interface LimbTarget {
  target: THREE.Vector3;
  pole: THREE.Vector3;
  /** Hands only: where the fingers should point (world direction). */
  aim?: THREE.Vector3;
}

export interface SeatPlan {
  seat: SeatKind;
  style: SitStyle;
  /** Height of the sitting surface. */
  seatTopY: number;
  /** Where the hip-joint midpoint should end up. */
  hipCenter: THREE.Vector3;
  /** Body lean in degrees: positive tips the torso forward. */
  spineLean: number;
  chestLean: number;
  /** Pelvis tilt (lower body) in degrees, positive = tipped forward. */
  pelvisTilt: number;
  /** Small turn of the torso toward the side the knees point, degrees. */
  torsoTurn: number;
  legs: { LEFT: LimbTarget; RIGHT: LimbTarget };
  hands: { LEFT: LimbTarget | null; RIGHT: LimbTarget | null };
  /** Seat geometry for the prop, world space. */
  prop: { frontZ: number; backZ: number; width: number; centerX: number };
  /** Legs swing freely (stool, edge) — drives the seated idle. */
  dangling: boolean;
  /**
   * How the hanging legs move in the seated idle: alternately (kicking),
   * together (crossed ankles), only the front leg, or not at all.
   */
  swing: 'alternate' | 'together' | 'front' | 'none';
  /** Which leg swings for `swing: 'front'`. */
  frontLeg?: 'LEFT' | 'RIGHT';
  /** Head tilt toward her left in degrees (a little tilt reads as relaxed and cute). */
  headTilt: number;
  /** Shoulders raised in degrees (a small shrug when leaning on straight arms). */
  shrug: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);

/**
 * Sitting-surface height for a seat kind.
 *
 * Seated, the knee joint sits about one thigh-thickness above the seat (the
 * thigh is roughly level), so for the feet to reach the floor the seat must
 * be lower than the standing knee by that thickness. Heights are therefore
 * built from the shin's vertical reach rather than from the knee directly.
 */
export function seatHeight(kind: SeatKind, m: SeatMeasures): number {
  const soleY = m.floorY + m.ankleHeight;

  const kneeAboveSeat = m.thigh * 0.2 * 1.05 + m.thigh * 0.06; // thigh radius + the thigh's slight downward slope
  const forShinDrop = (fraction: number) => soleY + m.shin * fraction - kneeAboveSeat;
  switch (kind) {
    case 'chair': return forShinDrop(0.93);
    case 'sofa': return forShinDrop(0.78);
    case 'stool': return forShinDrop(1.42);
    case 'cushion': return m.floorY + m.thigh * 0.11;
    case 'edge': return forShinDrop(1.25);
  }
}

/**
 * Plan a seated pose. `side` mirrors asymmetric styles (+1: knees to her
 * left / left leg on top, −1: the other way).
 */
export function planSeat(kind: SeatKind, style: SitStyle, m: SeatMeasures, side: 1 | -1 = 1): SeatPlan {
  const seatTopY = seatHeight(kind, m);
  // Sides come from the measured hips rather than an axis convention:
  // `toLeft` points from her right hip to her left hip.
  const center0 = m.hipL.clone().add(m.hipR).multiplyScalar(0.5);
  const toLeft = m.hipL.clone().sub(m.hipR).setY(0).normalize();
  const hipHalf = m.hipL.distanceTo(m.hipR) * 0.5;
  const thighRadius = m.thigh * 0.2;
  // The hip joint sits about one thigh radius above the surface it rests on.
  const hipCenter = new THREE.Vector3(center0.x, seatTopY + thighRadius * 1.05, center0.z);
  const offset = (base: THREE.Vector3, fwd: number, up: number, left: number) =>
    base.clone().addScaledVector(FORWARD, fwd).addScaledVector(UP, up).addScaledVector(toLeft, left);
  const dir = (fwd: number, up: number, left: number) =>
    new THREE.Vector3().addScaledVector(FORWARD, fwd).addScaledVector(UP, up).addScaledVector(toLeft, left).normalize();

  const hip = { LEFT: offset(hipCenter, 0, 0, hipHalf), RIGHT: offset(hipCenter, 0, 0, -hipHalf) };
  const out = { LEFT: 1, RIGHT: -1 } as const;
  const soleY = m.floorY + m.ankleHeight;

  /**
   * IK target for a leg whose knee should land at `knee`: the pole is pushed
   * out from the hip-ankle line through the planned knee, so the solver bends
   * the knee exactly where the style intends (never folding it upward).
   */
  const legTo = (s: 'LEFT' | 'RIGHT', knee: THREE.Vector3, ankle: THREE.Vector3): LimbTarget => {
    const mid = hip[s].clone().add(ankle).multiplyScalar(0.5);
    const outward = knee.clone().sub(mid);
    if (outward.lengthSq() < 1e-8) outward.copy(FORWARD);
    return { target: ankle, pole: knee.clone().addScaledVector(outward.normalize(), m.thigh) };
  };

  /** Knee at `thighDir`, foot on the floor (or hanging) below it. */
  const footDown = (s: 'LEFT' | 'RIGHT', thighDir: THREE.Vector3, footForward = 0.15, footOut = 0.05): LimbTarget => {
    const knee = hip[s].clone().addScaledVector(thighDir, m.thigh);
    const drop = knee.y - soleY;
    let ankle: THREE.Vector3;
    if (drop >= m.shin * 0.98) {
      // Seat too high for the floor: the shin hangs nearly straight.
      ankle = offset(knee, m.shin * footForward, -m.shin * 0.99, out[s] * m.shin * footOut);
    } else {
      // Feet planted: the shin angles forward until the sole reaches the floor.
      const reach = Math.sqrt(Math.max(0, m.shin * m.shin - drop * drop)) * 0.96;
      ankle = new THREE.Vector3(knee.x, soleY, knee.z).addScaledVector(FORWARD, reach).addScaledVector(toLeft, out[s] * m.shin * footOut);
    }
    return legTo(s, knee, ankle);
  };

  /** A hand resting on the top of a thigh, `along` 0 (hip) .. 1 (knee). */
  const handOnThigh = (s: 'LEFT' | 'RIGHT', legHip: THREE.Vector3, knee: THREE.Vector3, along: number, inward = 0.2): LimbTarget => {
    const p = legHip.clone().lerp(knee, along).addScaledVector(UP, thighRadius * 1.25).addScaledVector(toLeft, -out[s] * hipHalf * inward);
    return { target: p, pole: offset(p, -m.thigh * 0.7, m.thigh * 0.3, out[s] * m.thigh * 0.9), aim: dir(1, -0.5, -out[s] * 0.15) };
  };
  const handOnSeat = (s: 'LEFT' | 'RIGHT', fwd: number, outward = 1.9): LimbTarget => {
    const p = offset(hipCenter, m.thigh * fwd, -thighRadius * 0.95, out[s] * hipHalf * outward);
    return { target: p, pole: offset(p, -m.thigh * 0.8, m.thigh * 0.4, out[s] * m.thigh * 0.6), aim: dir(0.35, -1, 0) };
  };

  const plan: SeatPlan = {
    seat: kind,
    style,
    seatTopY,
    hipCenter,
    spineLean: 4,
    chestLean: 0,
    pelvisTilt: 0,
    torsoTurn: 0,
    legs: { LEFT: null as unknown as LimbTarget, RIGHT: null as unknown as LimbTarget },
    hands: { LEFT: null, RIGHT: null },
    prop: { frontZ: hipCenter.z + m.thigh * 0.72, backZ: hipCenter.z - m.thigh * 0.48, width: hipHalf * 2 * 2.6, centerX: hipCenter.x },
    dangling: false,
    swing: 'none',
    headTilt: 0,
    shrug: 0,
  };
  /**
   * Thigh direction with the knees drawn together: the thighs converge so the
   * knees end up about one thigh-thickness apart, as a woman sitting
   * properly holds them (rather than the hip-width stance).
   */
  const kneesTogether = (s: 'LEFT' | 'RIGHT', down = -0.08) => {
    const inward = THREE.MathUtils.clamp((hipHalf - thighRadius * 0.92) / m.thigh, 0, 0.3);
    return dir(1, down, -out[s] * inward);
  };
  /** A hanging shin from `knee`: toes forward by `fwd`, feet apart by `apart`. */
  const hang = (s: 'LEFT' | 'RIGHT', knee: THREE.Vector3, fwd: number, apart: number, lateral = 0) =>
    knee.clone().addScaledVector(dir(fwd, -1, out[s] * apart + lateral), m.shin);
  const kneeOf = (s: 'LEFT' | 'RIGHT', d: THREE.Vector3) => hip[s].clone().addScaledVector(d, m.thigh);

  switch (style) {
    case 'upright': {
      for (const s of ['LEFT', 'RIGHT'] as const) {
        const d = dir(1, -0.06, out[s] * 0.1);
        plan.legs[s] = footDown(s, d, 0.1);
        plan.hands[s] = handOnThigh(s, hip[s], kneeOf(s, d), 0.62);
      }
      plan.spineLean = 3;
      break;
    }
    case 'relaxed': {
      // Leaning back into the backrest, one foot forward, hands in the lap.
      plan.spineLean = -11;
      plan.chestLean = 3;
      plan.pelvisTilt = -6;
      const front = side === 1 ? 'LEFT' : 'RIGHT';
      for (const s of ['LEFT', 'RIGHT'] as const) {
        const d = dir(1, s === front ? -0.12 : -0.02, out[s] * 0.16);
        plan.legs[s] = footDown(s, d, s === front ? 0.45 : 0.05, 0.12);
      }
      const lapL = kneeOf('LEFT', dir(1, -0.07, 0.16)), lapR = kneeOf('RIGHT', dir(1, -0.07, -0.16));
      plan.hands.LEFT = handOnThigh('LEFT', hip.LEFT, lapL, 0.42, 0.75);
      plan.hands.RIGHT = handOnThigh('RIGHT', hip.RIGHT, lapR, 0.5, 0.7);
      break;
    }
    case 'crossed': {
      // `top` leg crosses over `under` at the knee.
      const top = side === 1 ? 'LEFT' : 'RIGHT';
      const under = top === 'LEFT' ? 'RIGHT' : 'LEFT';
      const underDir = dir(1, -0.05, out[under] * 0.04);
      plan.legs[under] = footDown(under, underDir, 0.2, 0.02);
      const underKnee = kneeOf(under, underDir);
      const kneeGoal = underKnee.clone().addScaledVector(UP, thighRadius * 1.9).addScaledVector(toLeft, out[under] * hipHalf * 0.3).addScaledVector(FORWARD, -m.thigh * 0.06);
      const topDir = kneeGoal.sub(hip[top]).normalize();
      const topKnee = kneeOf(top, topDir);
      const ankle = topKnee.clone().addScaledVector(dir(0.3, -1, out[under] * 0.32), m.shin * 0.97);
      plan.legs[top] = legTo(top, topKnee, ankle);
      // Hands rest along the top thigh: one near the knee, one mid-thigh.
      plan.hands[top] = handOnThigh(top, hip[top], topKnee, 0.5, 0.2);
      plan.hands[under] = handOnThigh(under, hip[top], topKnee, 0.82, -0.6);
      plan.spineLean = kind === 'sofa' ? -8 : 2;
      break;
    }
    case 'sideSaddle': {
      // Knees together, turned toward `side`; lower legs angled back the other way.
      for (const s of ['LEFT', 'RIGHT'] as const) {
        const d = dir(1, -0.05, side * 0.55 - out[s] * 0.12);
        const knee = kneeOf(s, d);
        const ankle = knee.clone().addScaledVector(dir(-0.18, -1, -side * 0.42), m.shin);
        ankle.y = Math.max(ankle.y, soleY);
        plan.legs[s] = legTo(s, knee, ankle);
      }
      const lap = kneeOf(side === 1 ? 'LEFT' : 'RIGHT', dir(1, -0.05, side * 0.4));
      const lapHand = side === 1 ? 'RIGHT' : 'LEFT';
      const supportHand = side === 1 ? 'LEFT' : 'RIGHT';
      plan.hands[lapHand] = handOnThigh(lapHand, hip[lapHand], lap, 0.55, 1.4);
      plan.hands[supportHand] = handOnSeat(supportHand, 0.1, 2.2);
      plan.torsoTurn = side * 8;
      plan.spineLean = 2;
      break;
    }
    case 'dangle': {
      plan.dangling = true;
      plan.swing = 'alternate';
      for (const s of ['LEFT', 'RIGHT'] as const) {
        const d = dir(1, -0.05, out[s] * 0.09);
        const knee = kneeOf(s, d);
        const ankle = knee.clone().addScaledVector(dir(s === 'LEFT' ? 0.16 : 0.06, -1, out[s] * 0.03), m.shin);
        plan.legs[s] = legTo(s, knee, ankle);
        // Hands grip the seat's front edge beside the thighs.
        plan.hands[s] = handOnSeat(s, 0.5, 1.55);
      }
      plan.spineLean = 5;
      break;
    }
    case 'perch': {
      // Knees together, feet a little apart and toes pointed: the light,
      // girlish way to sit on a ledge. Hands rest on the edge just behind the
      // hips with straight arms, shoulders lifted a touch.
      plan.dangling = true;
      plan.swing = 'alternate';
      for (const s of ['LEFT', 'RIGHT'] as const) {
        const knee = kneeOf(s, kneesTogether(s));
        plan.legs[s] = legTo(s, knee, hang(s, knee, s === 'LEFT' ? 0.12 : 0.04, 0.1));
        plan.hands[s] = handOnSeat(s, -0.16, 1.45);
      }
      plan.spineLean = -2;
      plan.chestLean = 3;
      plan.headTilt = side * 7;
      plan.shrug = 5;
      break;
    }
    case 'ankles': {
      // Knees together, ankles crossed (one in front of the other), hands
      // resting in her lap: demure and still.
      plan.dangling = true;
      plan.swing = 'together';
      const front = side === 1 ? 'LEFT' : 'RIGHT';
      for (const s of ['LEFT', 'RIGHT'] as const) {
        const knee = kneeOf(s, kneesTogether(s, -0.06));
        // Each ankle crosses past the midline toward the other side.
        const cross = -out[s] * (hipHalf / m.shin) * 1.05;
        plan.legs[s] = legTo(s, knee, hang(s, knee, s === front ? 0.16 : 0.02, 0, cross));
        plan.hands[s] = handOnThigh(s, hip[s], knee, 0.72, 1.05);
      }
      plan.spineLean = 6;
      plan.headTilt = -side * 9;
      break;
    }
    case 'leanBack': {
      // Leaning back on straight arms behind her, one leg kicking lazily.
      plan.dangling = true;
      plan.swing = 'front';
      const front = side === 1 ? 'LEFT' : 'RIGHT';
      plan.frontLeg = front;
      for (const s of ['LEFT', 'RIGHT'] as const) {
        const knee = kneeOf(s, kneesTogether(s, s === front ? 0.02 : -0.1));
        plan.legs[s] = legTo(s, knee, hang(s, knee, s === front ? 0.3 : 0.05, 0.05));
        plan.hands[s] = handOnSeat(s, -0.62, 1.3);
      }
      plan.spineLean = -15;
      plan.chestLean = 4;
      plan.pelvisTilt = -4;
      plan.headTilt = side * 5;
      plan.shrug = 8;
      break;
    }
    case 'handsOnKnees': {
      // Knees together, legs hanging straight down, hands folded over her
      // knees and a little forward lean: the classic shy ledge-sit.
      plan.dangling = true;
      plan.swing = 'together';
      const knees = { LEFT: kneeOf('LEFT', kneesTogether('LEFT', -0.04)), RIGHT: kneeOf('RIGHT', kneesTogether('RIGHT', -0.04)) };
      const between = knees.LEFT.clone().add(knees.RIGHT).multiplyScalar(0.5).addScaledVector(UP, thighRadius * 1.2).addScaledVector(FORWARD, -m.thigh * 0.04);
      for (const s of ['LEFT', 'RIGHT'] as const) {
        plan.legs[s] = legTo(s, knees[s], hang(s, knees[s], 0.03, 0.02));
        // One hand rests on the other on top of the knees.
        const hand = between.clone().addScaledVector(toLeft, out[s] * hipHalf * 0.22).addScaledVector(UP, s === 'LEFT' ? thighRadius * 0.35 : 0);
        plan.hands[s] = { target: hand, pole: offset(hand, -m.thigh * 0.5, -m.thigh * 0.2, out[s] * m.thigh * 0.9), aim: dir(0.6, -0.4, -out[s] * 0.6) };
      }
      plan.spineLean = 14;
      plan.chestLean = 4;
      plan.headTilt = side * 9;
      plan.shrug = 4;
      break;
    }
    case 'hugKnees': {
      // On the floor, knees drawn up, arms wrapped around the shins.
      plan.spineLean = 16;
      plan.chestLean = 8;
      plan.pelvisTilt = -14;
      for (const s of ['LEFT', 'RIGHT'] as const) {
        // Knees drawn up and together; feet flat on the floor in front of the hips.
        const d = dir(0.66, 0.74, -out[s] * 0.1);
        const knee = kneeOf(s, d);
        const ankle = new THREE.Vector3(knee.x, soleY, knee.z).addScaledVector(FORWARD, -m.shin * 0.1);
        ankle.addScaledVector(UP, Math.max(0, knee.y - soleY - m.shin * 0.97));
        plan.legs[s] = legTo(s, knee, ankle);
        const wrap = knee.clone().addScaledVector(FORWARD, m.thigh * 0.18).addScaledVector(UP, -m.shin * 0.38).addScaledVector(toLeft, -out[s] * hipHalf * 0.55);
        plan.hands[s] = { target: wrap, pole: offset(wrap, -m.thigh * 0.2, -m.thigh * 0.3, out[s] * m.thigh * 1.1), aim: dir(0.1, -0.2, -out[s]) };
      }
      plan.prop = { frontZ: hipCenter.z + m.thigh * 0.55, backZ: hipCenter.z - m.thigh * 0.55, width: hipHalf * 2 * 3, centerX: hipCenter.x };
      break;
    }
    case 'sideFold': {
      // Yokozuwari: both knees forward toward `side`, shins folded back along the floor.
      for (const s of ['LEFT', 'RIGHT'] as const) {
        // Knees rest on the floor ahead of her, toward `side`; the shins fold
        // back along the floor so both feet lie beside the opposite hip.
        const kneeGoal = offset(hip[s], m.thigh * 0.82, 0, side * m.thigh * 0.38 - out[s] * m.thigh * 0.06);
        kneeGoal.y = m.floorY + thighRadius * 0.9;
        const knee = hip[s].clone().addScaledVector(kneeGoal.sub(hip[s]).normalize(), m.thigh);
        const ankle = knee.clone().addScaledVector(dir(-0.5, 0, -side * 0.86), m.shin * 0.96);
        ankle.y = m.floorY + thighRadius * 0.55;
        plan.legs[s] = legTo(s, knee, ankle);
      }
      const supportHand = side === 1 ? 'RIGHT' : 'LEFT';
      const lapHand = side === 1 ? 'LEFT' : 'RIGHT';
      const floorHand = offset(hipCenter, m.thigh * 0.05, m.floorY - hipCenter.y + thighRadius * 0.35, out[supportHand] * hipHalf * 2.6);
      plan.hands[supportHand] = { target: floorHand, pole: offset(floorHand, -m.thigh * 0.7, m.thigh * 0.7, out[supportHand] * m.thigh * 0.4), aim: dir(0.2, -1, out[supportHand] * 0.3) };
      plan.hands[lapHand] = handOnThigh(lapHand, hip[lapHand], kneeOf(lapHand, dir(0.9, -0.28, side * 0.42)), 0.6, 0.6);
      plan.torsoTurn = -side * 6;
      plan.spineLean = 3;
      plan.prop = { frontZ: hipCenter.z + m.thigh * 0.6, backZ: hipCenter.z - m.thigh * 0.6, width: hipHalf * 2 * 3.2, centerX: hipCenter.x };
      break;
    }
  }
  return plan;
}

// ---- seat props ---------------------------------------------------------------------

const materials = {
  wood: () => new THREE.MeshStandardMaterial({ color: 0x5a3d2b, roughness: 0.48, metalness: 0 }),
  darkWood: () => new THREE.MeshStandardMaterial({ color: 0x2f2119, roughness: 0.5, metalness: 0 }),
  linen: () => new THREE.MeshStandardMaterial({ color: 0xcfc6b8, roughness: 0.92, metalness: 0 }),
  velvet: () => new THREE.MeshStandardMaterial({ color: 0x9a8b7e, roughness: 0.88, metalness: 0 }),
  steel: () => new THREE.MeshStandardMaterial({ color: 0xb4b9c0, roughness: 0.28, metalness: 0.9 }),
  leather: () => new THREE.MeshStandardMaterial({ color: 0x3a2a24, roughness: 0.42, metalness: 0 }),
  cushion: () => new THREE.MeshStandardMaterial({ color: 0xb7a3c9, roughness: 0.9, metalness: 0 }),
};

function box(w: number, h: number, d: number, material: THREE.Material, radius = 0): THREE.Mesh {
  const geometry = radius > 0 ? new RoundedBoxGeometry(w, h, d, 3, Math.min(radius, Math.min(w, h, d) * 0.49)) : new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function cylinder(r: number, h: number, material: THREE.Material, rTop = r): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rTop, r, h, 20), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Build the seat for a plan, in world space. Returns null for 'edge', which
 * deliberately has no prop (the desktop companion sits on real screen edges).
 */
export function buildSeatProp(plan: SeatPlan, m: SeatMeasures): THREE.Group | null {
  if (plan.seat === 'edge') return null;
  const group = new THREE.Group();
  group.name = `seat:${plan.seat}`;
  const top = plan.seatTopY;
  const floor = m.floorY;
  const depth = plan.prop.frontZ - plan.prop.backZ;
  const midZ = (plan.prop.frontZ + plan.prop.backZ) / 2;
  const width = plan.prop.width;
  const cx = plan.prop.centerX;
  const u = m.thigh; // unit for proportions

  if (plan.seat === 'chair') {
    const wood = materials.wood(), linen = materials.linen();
    const cushionH = u * 0.09;
    const frameH = u * 0.06;
    const seatY = top - cushionH;
    const cushion = box(width, cushionH, depth * 1.02, linen, cushionH * 0.45);
    cushion.position.set(cx, top - cushionH / 2, midZ);
    const frame = box(width * 1.04, frameH, depth * 1.04, wood, frameH * 0.2);
    frame.position.set(cx, seatY - frameH / 2, midZ);
    group.add(cushion, frame);
    const legH = seatY - frameH - floor;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const leg = cylinder(u * 0.035, legH, wood, u * 0.045);
      leg.position.set(cx + sx * width * 0.46, floor + legH / 2, midZ + sz * depth * 0.44);
      group.add(leg);
    }
    // Backrest: two posts and a padded panel, tilted back a little.
    const back = new THREE.Group();
    const backH = m.height * 0.36;
    for (const sx of [-1, 1]) {
      const post = box(u * 0.06, backH, u * 0.06, wood, u * 0.02);
      post.position.set(sx * width * 0.46, backH / 2, 0);
      back.add(post);
    }
    const panel = box(width * 0.88, backH * 0.55, u * 0.07, linen, u * 0.03);
    panel.position.set(0, backH * 0.6, u * 0.01);
    back.add(panel);
    back.position.set(cx, seatY, plan.prop.backZ - u * 0.03);
    back.rotation.x = -THREE.MathUtils.degToRad(9);
    group.add(back);
  } else if (plan.seat === 'sofa') {
    const velvet = materials.velvet(), wood = materials.darkWood();
    const w = width * 2.3;
    const seatCushionH = u * 0.2;
    const baseTop = top - seatCushionH;
    const base = box(w, baseTop - floor - u * 0.08, depth * 1.25, velvet, u * 0.06);
    base.position.set(cx, floor + u * 0.08 + (baseTop - floor - u * 0.08) / 2, midZ - depth * 0.08);
    const seat = box(w * 0.92, seatCushionH, depth * 1.05, velvet, seatCushionH * 0.4);
    seat.position.set(cx, top - seatCushionH / 2, midZ);
    const backCushion = box(w * 0.92, m.height * 0.3, u * 0.32, velvet, u * 0.12);
    backCushion.position.set(cx, top + m.height * 0.13, plan.prop.backZ - u * 0.12);
    backCushion.rotation.x = -THREE.MathUtils.degToRad(12);
    group.add(base, seat, backCushion);
    for (const sx of [-1, 1]) {
      const arm = box(u * 0.32, top - floor + u * 0.32, depth * 1.25, velvet, u * 0.12);
      arm.position.set(cx + sx * (w / 2 + u * 0.12), floor + (top - floor + u * 0.32) / 2, midZ - depth * 0.08);
      group.add(arm);
      for (const sz of [-1, 1]) {
        const foot = cylinder(u * 0.04, u * 0.08, wood, u * 0.05);
        foot.position.set(cx + sx * (w / 2 + u * 0.12), floor + u * 0.04, midZ + sz * depth * 0.5);
        group.add(foot);
      }
    }
  } else if (plan.seat === 'stool') {
    const steel = materials.steel(), leather = materials.leather();
    const r = u * 0.5;
    const padH = u * 0.12;
    const pad = cylinder(r, padH, leather, r * 0.96);
    pad.position.set(cx, top - padH / 2, midZ - u * 0.1);
    group.add(pad);
    const legH = top - padH - floor;
    const legs = 4;
    for (let i = 0; i < legs; i++) {
      const a = (i / legs) * Math.PI * 2 + Math.PI / 4;
      const leg = cylinder(u * 0.022, legH * 1.02, steel);
      const spread = r * 0.85;
      leg.position.set(cx + Math.cos(a) * spread * 0.75, floor + legH / 2, midZ - u * 0.1 + Math.sin(a) * spread * 0.75);
      leg.rotation.set(Math.sin(a) * 0.12, 0, -Math.cos(a) * 0.12);
      group.add(leg);
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.78, u * 0.02, 10, 40), steel);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(cx, floor + legH * 0.35, midZ - u * 0.1);
    ring.castShadow = true;
    group.add(ring);
  } else if (plan.seat === 'cushion') {
    const fabric = materials.cushion();
    const h = top - floor;
    const pad = box(width * 1.1, h, depth * 1.4, fabric, h * 0.48);
    pad.position.set(cx, floor + h / 2, midZ);
    group.add(pad);
  }
  // Shadow-catcher floor: invisible except for the shadows of the seat and of
  // her legs and feet, so both read as standing on something over ABxAG's
  // transparent stage.
  const floorSize = Math.max(width * 3, m.height * 1.4);
  const catcher = new THREE.Mesh(
    new THREE.PlaneGeometry(floorSize, floorSize),
    new THREE.ShadowMaterial({ opacity: 0.32, transparent: true, depthWrite: false })
  );
  catcher.rotation.x = -Math.PI / 2;
  catcher.position.set(cx, floor + u * 0.004, midZ);
  catcher.receiveShadow = true;
  catcher.renderOrder = -1;
  // A faint, soft-edged pool of light on the floor: on ABxAG's near-black
  // stage a shadow alone is invisible, so the floor needs something to darken.
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(floorSize * 0.36, 48),
    new THREE.MeshBasicMaterial({ map: floorGlowTexture(), transparent: true, depthWrite: false, toneMapped: false })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.set(cx, floor + u * 0.002, midZ + u * 0.15);
  glow.renderOrder = -2;
  group.add(glow, catcher);
  return group;
}

let glowTexture: THREE.CanvasTexture | null = null;

/** Radial falloff used for the floor pool of light (shared, built once). */
function floorGlowTexture(): THREE.CanvasTexture {
  if (glowTexture) return glowTexture;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(214, 206, 230, 0.34)');
  gradient.addColorStop(0.55, 'rgba(180, 170, 205, 0.12)');
  gradient.addColorStop(1, 'rgba(160, 150, 190, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  glowTexture = new THREE.CanvasTexture(canvas);
  glowTexture.colorSpace = THREE.SRGBColorSpace;
  return glowTexture;
}

/** Bones the AI idle layer must not move while seated. */
export const SEATED_LOCKED_SLOTS = [
  'ROOT', 'CENTER', 'GROOVE', 'WAIST', 'HIPS', 'LOWER_BODY',
  'LEFT_UPPER_LEG', 'RIGHT_UPPER_LEG', 'LEFT_LOWER_LEG', 'RIGHT_LOWER_LEG', 'LEFT_FOOT', 'RIGHT_FOOT',
];

