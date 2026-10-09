/**
 * Inverse kinematics for posing: analytic two-bone limbs and a look-at head.
 *
 * Limbs use an anatomical hinge rather than a free swing. The elbow/knee only
 * bends about its hinge axis (measured once from the rest pose and the
 * character's facing), bend angles are clamped to a natural range, and the
 * whole limb then swings and twists at the shoulder/hip so the middle joint
 * points at a pole hint (elbows back and down, knees forward). That keeps the
 * forearm and shin meshes from corkscrewing, which free CCD-style solvers do.
 */
import * as THREE from 'three';

export interface LimbChain {
  root: THREE.Bone;
  mid: THREE.Bone;
  end: THREE.Bone;
  kind: 'arm' | 'leg';
  /** Hinge axis in the mid bone's PARENT frame at rest. */
  hingeParent: THREE.Vector3;
  /** Mid bone rest local rotation. */
  midRest: THREE.Quaternion;
  /** Rest bend angle between upper and lower segment, radians. */
  restBend: number;
  minBend: number;
  maxBend: number;
  upperLength: number;
  lowerLength: number;
}

export interface LimbSolveResult {
  reached: boolean;
  /** Distance from the end effector to the requested target (world units). */
  error: number;
  bendDeg: number;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _t = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _parentQ = new THREE.Quaternion();
const _worldQ = new THREE.Quaternion();

function worldPos(bone: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
  bone.updateWorldMatrix(true, false);
  return out.setFromMatrixPosition(bone.matrixWorld);
}

/** Apply a WORLD-space rotation delta to a bone (pre-multiplied). */
export function rotateBoneWorld(bone: THREE.Bone, delta: THREE.Quaternion): void {
  bone.getWorldQuaternion(_worldQ);
  _worldQ.premultiply(delta);
  if (bone.parent) bone.parent.getWorldQuaternion(_parentQ);
  else _parentQ.identity();
  bone.quaternion.copy(_parentQ.invert().multiply(_worldQ));
  bone.updateWorldMatrix(false, true);
}

/**
 * Build a limb from the current (rest) skeleton.
 * `front` is the unit facing direction in world space.
 */
export function createLimb(root: THREE.Bone, mid: THREE.Bone, end: THREE.Bone, kind: 'arm' | 'leg', front: THREE.Vector3): LimbChain {
  const a = worldPos(root, new THREE.Vector3());
  const b = worldPos(mid, new THREE.Vector3());
  const c = worldPos(end, new THREE.Vector3());
  const upper = b.clone().sub(a);
  const lower = c.clone().sub(b);
  const upperDir = upper.clone().normalize();
  // Elbows flex so the forearm moves forward; knees so the shin moves back.
  const bendToward = kind === 'arm' ? front.clone() : front.clone().negate();
  let hinge = new THREE.Vector3().crossVectors(upperDir, bendToward);
  if (hinge.lengthSq() < 1e-8) hinge = new THREE.Vector3(1, 0, 0);
  hinge.normalize();
  // Sign: a positive rotation about the hinge must move the lower segment toward `bendToward`.
  const test = upperDir.clone().applyAxisAngle(hinge, 0.2);
  if (test.dot(bendToward) < upperDir.dot(bendToward)) hinge.negate();
  // Express in the mid bone's parent frame so it follows the limb.
  const parentQ = new THREE.Quaternion();
  mid.parent?.getWorldQuaternion(parentQ);
  const hingeParent = hinge.clone().applyQuaternion(parentQ.clone().invert());
  const restBend = upper.angleTo(lower);
  return {
    root, mid, end, kind,
    hingeParent,
    midRest: mid.quaternion.clone(),
    restBend,
    minBend: THREE.MathUtils.degToRad(kind === 'arm' ? 2 : 1),
    maxBend: THREE.MathUtils.degToRad(kind === 'arm' ? 150 : 155),
    upperLength: upper.length(),
    lowerLength: lower.length(),
  };
}

/**
 * Solve a limb so its end reaches `target`, bending toward `pole`.
 * When `keepEndWorld` is given, the end bone keeps that world rotation
 * (a planted foot, a hand holding its orientation).
 */
export function solveLimb(limb: LimbChain, target: THREE.Vector3, pole: THREE.Vector3, keepEndWorld?: THREE.Quaternion): LimbSolveResult {
  const { root, mid, end } = limb;
  const a = worldPos(root, _a);
  // World scale may differ from model units; measure live lengths.
  const lab = worldPos(mid, _b).distanceTo(a);
  const lbc = worldPos(end, _c).distanceTo(_b);
  const wanted = _t.copy(target);
  let distance = wanted.distanceTo(a);

  // Interior angle at the middle joint from the law of cosines, clamped to
  // the hinge range so the joint never hyperextends or folds through itself.
  const minReach = Math.sqrt(lab * lab + lbc * lbc - 2 * lab * lbc * Math.cos(Math.PI - limb.maxBend));
  const maxReach = Math.sqrt(lab * lab + lbc * lbc - 2 * lab * lbc * Math.cos(Math.PI - limb.minBend));
  const clamped = THREE.MathUtils.clamp(distance, minReach, maxReach);

  // 1. Hinge the middle joint about its anatomical axis only. The rest pose
  // may already be slightly bent in some other plane (relaxed base pose), so
  // the hinge angle that yields the wanted reach is found numerically rather
  // than assumed from the law of cosines.
  mid.quaternion.copy(limb.midRest);
  mid.updateWorldMatrix(false, true);
  const b0 = worldPos(mid, new THREE.Vector3());
  const c0 = worldPos(end, new THREE.Vector3());
  const upperVec = b0.clone().sub(a);
  const lowerVec = c0.clone().sub(b0);
  mid.parent?.getWorldQuaternion(_parentQ);
  const hingeWorld = limb.hingeParent.clone().applyQuaternion(mid.parent ? _parentQ : _q.identity()).normalize();
  const reachAt = (theta: number) => _v1.copy(lowerVec).applyAxisAngle(hingeWorld, theta).add(upperVec).length();
  const bendAt = (theta: number) => _v2.copy(lowerVec).applyAxisAngle(hingeWorld, theta).angleTo(upperVec);
  // Straightest hinge angle, then bend forward from there.
  let straight = 0;
  let best = Infinity;
  for (let i = -90; i <= 90; i += 1) {
    const theta = (i / 90) * Math.PI;
    const bendHere = bendAt(theta);
    if (bendHere < best) {
      best = bendHere;
      straight = theta;
    }
  }
  let lo = straight + limb.minBend;
  let hi = straight + limb.maxBend;
  // Reach shrinks monotonically as the joint bends past straight.
  for (let i = 0; i < 40; i += 1) {
    const midTheta = (lo + hi) / 2;
    if (reachAt(midTheta) > clamped) lo = midTheta;
    else hi = midTheta;
  }
  const theta = (lo + hi) / 2;
  mid.quaternion.copy(limb.midRest).premultiply(_q.setFromAxisAngle(limb.hingeParent, theta));
  mid.updateWorldMatrix(false, true);
  const bend = bendAt(theta);

  // 2. Swing the root so the end effector lies on the root→target line.
  worldPos(end, _c);
  _v1.subVectors(_c, a).normalize();
  _v2.subVectors(wanted, a);
  if (_v2.lengthSq() < 1e-10) _v2.copy(_v1);
  _v2.normalize();
  rotateBoneWorld(root, _q.setFromUnitVectors(_v1, _v2));

  // 3. Twist about the root→target axis so the middle joint faces the pole.
  worldPos(mid, _b);
  const axis = _v2;
  const midOff = _v1.subVectors(_b, a);
  midOff.addScaledVector(axis, -midOff.dot(axis));
  const poleOff = _c.subVectors(pole, a);
  poleOff.addScaledVector(axis, -poleOff.dot(axis));
  if (midOff.lengthSq() > 1e-10 && poleOff.lengthSq() > 1e-10) {
    midOff.normalize();
    poleOff.normalize();
    const angle = Math.atan2(_t.crossVectors(midOff, poleOff).dot(axis), midOff.dot(poleOff));
    rotateBoneWorld(root, _q.setFromAxisAngle(axis, angle));
  }

  // 4. End orientation.
  if (keepEndWorld) {
    end.parent?.updateWorldMatrix(true, false);
    if (end.parent) end.parent.getWorldQuaternion(_parentQ);
    else _parentQ.identity();
    end.quaternion.copy(_parentQ.invert().multiply(keepEndWorld));
    end.updateWorldMatrix(false, true);
  }

  const reachedPos = worldPos(end, _c);
  const error = reachedPos.distanceTo(target);
  distance = Math.max(distance, 1e-6);
  return { reached: error < 0.02 * (lab + lbc), error, bendDeg: THREE.MathUtils.radToDeg(bend) };
}

export interface LookChain {
  /** Bones from the lowest contributor up to the head, with weights summing to 1. */
  bones: Array<{ bone: THREE.Bone; weight: number }>;
  maxYaw: number;
  maxPitch: number;
}

/**
 * Turn neck/head (and a little chest) toward a world point. Returns the
 * applied yaw/pitch in degrees. `front` is the body facing in world space.
 */
export function solveLook(chain: LookChain, target: THREE.Vector3, front: THREE.Vector3): { yawDeg: number; pitchDeg: number } {
  const head = chain.bones[chain.bones.length - 1].bone;
  const origin = worldPos(head, new THREE.Vector3());
  const base = chain.bones[0].bone.parent ?? chain.bones[0].bone;
  const baseQ = base.getWorldQuaternion(new THREE.Quaternion());
  // Direction to target in the base's frame, measured against facing.
  const dir = target.clone().sub(origin).applyQuaternion(baseQ.clone().invert()).normalize();
  const fwd = front.clone().applyQuaternion(baseQ.clone().invert()).normalize();
  const fwdYaw = Math.atan2(fwd.x, fwd.z);
  let yaw = Math.atan2(dir.x, dir.z) - fwdYaw;
  yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
  const pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
  const y = THREE.MathUtils.clamp(yaw, -chain.maxYaw, chain.maxYaw);
  // Looking up is a negative X rotation for a +Z-facing PMX head; flip with facing.
  const p = THREE.MathUtils.clamp(pitch, -chain.maxPitch, chain.maxPitch) * (fwd.z >= 0 ? -1 : 1);
  for (const { bone, weight } of chain.bones) {
    bone.quaternion.setFromEuler(new THREE.Euler(p * weight, y * weight, 0, 'YXZ'));
    bone.updateWorldMatrix(false, true);
  }
  return { yawDeg: THREE.MathUtils.radToDeg(y), pitchDeg: THREE.MathUtils.radToDeg(p) };
}
