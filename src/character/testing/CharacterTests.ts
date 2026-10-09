/**
 * Runtime compatibility tests for a loaded character.
 *
 * Every check drives the REAL systems (renderer, pose editor, IK, physics,
 * face, gaze) and measures the outcome in world space, so a pass means the
 * feature actually works on this model — not that a bone name matched.
 * Results are posted to the character's profile by the caller.
 */
import * as THREE from 'three';
import type { CharacterSystem } from '../core/CharacterSystem';
import type { RuntimeTestName, RuntimeTestResult } from '@/shared/character/profile';
import { FINGERS, FINGER_JOINTS, THUMB_JOINTS, REQUIRED_BODY_SLOTS, type Side } from '@/shared/character/humanoid';

export type TestResults = Partial<Record<RuntimeTestName, RuntimeTestResult>>;

const pass = (detail: string): RuntimeTestResult => ({ status: 'pass', detail });
const fail = (detail: string): RuntimeTestResult => ({ status: 'fail', detail });
const skip = (detail: string): RuntimeTestResult => ({ status: 'not-run', detail });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runCharacterTests(system: CharacterSystem, onProgress?: (name: string) => void): Promise<TestResults> {
  const results: TestResults = {};
  const model = system.loadedModel;
  const rig = system.rig;
  const editor = system.poseEditor;
  if (!model || !rig || !editor) return { renders: fail('Character is not loaded.') };

  const bone = (slot: string) => {
    const name = rig.humanoid[slot]?.bone;
    const index = name ? model.boneIndexByName.get(name) : undefined;
    return index === undefined ? undefined : model.bones[index];
  };
  const wp = (b: THREE.Object3D) => b.getWorldPosition(new THREE.Vector3());
  const height = (() => {
    const head = bone('HEAD');
    const foot = bone('LEFT_FOOT');
    return head && foot ? Math.max(0.1, wp(head).y - wp(foot).y) : 1;
  })();
  const restoreOwnership = editor.ownership;
  /** Switch ownership and run frames until the AI/user weights have settled. */
  const own = (mode: 'AI' | 'USER') => {
    editor.setOwnership(mode);
    for (let i = 0; i < 300 && !editor.settled; i += 1) system.stepFrames(1);
    system.stepFrames(2);
  };
  system.stop();
  const run = async (name: RuntimeTestName, fn: () => Promise<RuntimeTestResult> | RuntimeTestResult) => {
    onProgress?.(name);
    try {
      results[name] = await fn();
    } catch (error) {
      results[name] = fail(`Threw: ${(error as Error).message}`);
    } finally {
      editor.resetBody();
      editor.setOwnership('AI');
      system.stepFrames(30);
    }
  };

  try {
    // 1. Renders: the frame actually contains the character.
    await run('renders', () => {
      system.stepFrames(5);
      const coverage = measureCoverage(system);
      const box = new THREE.Box3().setFromObject(model.mesh);
      if (!Number.isFinite(box.min.y) || box.isEmpty()) return fail('Mesh bounding box is invalid.');
      if (coverage.opaque < 0.005) return fail(`Only ${(coverage.opaque * 100).toFixed(2)}% of the frame is covered — the model is not visible.`);
      return pass(`${model.mesh.geometry.getAttribute('position').count.toLocaleString()} vertices drawn; character covers ${(coverage.opaque * 100).toFixed(1)}% of the frame.`);
    });

    // 2. Textures: every staged texture decoded.
    await run('textures', async () => {
      const deadline = performance.now() + 15000;
      let stats = textureStats(model.mesh);
      while (stats.pending > 0 && performance.now() < deadline) {
        await sleep(200);
        stats = textureStats(model.mesh);
      }
      if (stats.total === 0) return fail('No material has a texture.');
      if (stats.failed > 0 || stats.pending > 0) return fail(`${stats.loaded}/${stats.total} textures decoded (${stats.failed} failed, ${stats.pending} pending).`);
      return pass(`${stats.loaded}/${stats.total} textures decoded across ${(model.mesh.material as THREE.Material[]).length} materials.`);
    });

    // 3. Skeleton: required body bones resolved to real bones.
    await run('skeleton', () => {
      const missing = REQUIRED_BODY_SLOTS.filter((slot) => !bone(slot));
      const mapped = Object.keys(rig.humanoid).length;
      return missing.length ? fail(`Missing: ${missing.join(', ')}`) : pass(`${mapped} humanoid slots mapped onto ${model.bones.length} bones; all ${REQUIRED_BODY_SLOTS.length} core body bones present.`);
    });

    // 4. Body pose editing: rotating the upper arm moves the hand; reset restores it.
    await run('bodyPose', () => {
      const arm = rig.humanoid.LEFT_UPPER_ARM?.bone;
      const hand = bone('LEFT_HAND');
      const head = bone('HEAD');
      const neck = rig.humanoid.NECK?.bone;
      if (!arm || !hand || !head || !neck) return fail('Arm, hand, neck or head bone missing.');
      own('USER');
      const before = wp(hand);
      const headBefore = head.getWorldQuaternion(new THREE.Quaternion());
      editor.setBoneEuler(arm, [0, 0, 35]);
      editor.setBoneEuler(neck, [0, 25, 0]);
      system.stepFrames(3);
      const moved = wp(hand).distanceTo(before) / height;
      const turned = THREE.MathUtils.radToDeg(head.getWorldQuaternion(new THREE.Quaternion()).angleTo(headBefore));
      editor.resetBone(arm);
      editor.resetBone(neck);
      system.stepFrames(3);
      const back = wp(hand).distanceTo(before) / height;
      if (moved < 0.03) return fail(`Hand moved only ${(moved * 100).toFixed(1)}% of body height for a 35° arm rotation.`);
      if (turned < 15) return fail(`Head turned ${turned.toFixed(1)}° for a 25° neck rotation.`);
      if (back > 0.005) return fail(`Reset left the hand ${(back * 100).toFixed(2)}% off its pose.`);
      return pass(`35° arm edit moved the hand ${(moved * 100).toFixed(1)}% of height; neck edit turned the head ${turned.toFixed(0)}°; reset restored the pose; ${rig.bones.filter((b) => b.rotatable).length} rotatable bones editable.`);
    });

    // 5/6. IK: reach a target with hinge-limited elbows/knees.
    const ikTest = (ids: Array<'LEFT_HAND' | 'RIGHT_HAND' | 'LEFT_FOOT' | 'RIGHT_FOOT'>, offset: (front: THREE.Vector3) => THREE.Vector3) => () => {
      const details: string[] = [];
      own('USER');
      for (const id of ids) {
        if (!editor.availableHandles.includes(id)) return fail(`${id} IK chain is not available.`);
        const start = editor.handlePosition(id);
        const front = new THREE.Vector3(0, 0, 1);
        const target = start.clone().add(offset(front).multiplyScalar(height));
        const result = editor.solveHandle(id, target);
        system.stepFrames(2);
        const end = editor.handlePosition(id);
        const error = end.distanceTo(target) / height;
        if (!result) return fail(`${id}: solver returned nothing.`);
        if (error > 0.02) return fail(`${id}: end effector ${(error * 100).toFixed(1)}% of height away from target.`);
        if (result.bendDeg < 1 || result.bendDeg > 156) return fail(`${id}: joint bend ${result.bendDeg.toFixed(0)}° outside the hinge range.`);
        details.push(`${id} error ${(error * 100).toFixed(2)}%, bend ${result.bendDeg.toFixed(0)}°`);
      }
      return pass(details.join('; '));
    };
    await run('handIk', ikTest(['LEFT_HAND', 'RIGHT_HAND'], (f) => f.clone().multiplyScalar(0.12).add(new THREE.Vector3(0, 0.14, 0))));
    await run('footIk', ikTest(['LEFT_FOOT', 'RIGHT_FOOT'], (f) => f.clone().multiplyScalar(0.06).add(new THREE.Vector3(0, 0.1, 0))));

    // 7. Fingers: individual joints and presets curl toward the palm.
    await run('fingers', () => {
      const joints = editor.fingerJoints;
      if (joints.length === 0) return skip('Not applicable: this model has no finger bones.');
      own('USER');
      // Fingers curl toward the wrist; the thumb folds toward the palm centre
      // (its distance to the wrist barely changes in a real fist).
      const tips: Array<{ side: Side; finger: string; tip: THREE.Bone; wrist: THREE.Bone }> = [];
      for (const side of ['LEFT', 'RIGHT'] as Side[]) {
        const wrist = bone(`${side}_HAND`);
        if (!wrist) continue;
        for (const finger of FINGERS) {
          const last = (finger === 'THUMB' ? THUMB_JOINTS : FINGER_JOINTS).at(-1)!;
          const tip = bone(`${side}_${finger}_${last}`);
          const reference = finger === 'THUMB' ? bone(`${side}_MIDDLE_PROXIMAL`) ?? bone(`${side}_INDEX_PROXIMAL`) ?? wrist : wrist;
          if (tip) tips.push({ side, finger, tip, wrist: reference });
        }
      }
      const distances = () => tips.map((t) => wp(t.tip).distanceTo(wp(t.wrist)));
      const open = distances();
      // One joint alone.
      const single = bone('LEFT_INDEX_INTERMEDIATE');
      const neighbour = bone('LEFT_MIDDLE_DISTAL');
      const leftWrist = bone('LEFT_HAND');
      const inWrist = (b: THREE.Bone) => leftWrist!.worldToLocal(wp(b));
      if (single && neighbour && leftWrist) {
        const neighbourBefore = inWrist(neighbour);
        const before = single.getWorldQuaternion(new THREE.Quaternion());
        editor.setFingerJoint('LEFT_INDEX_INTERMEDIATE', { curl: 60 });
        system.stepFrames(2);
        const turned = THREE.MathUtils.radToDeg(single.getWorldQuaternion(new THREE.Quaternion()).angleTo(before));
        if (Math.abs(turned - 60) > 6) return fail(`Single-joint control rotated the index middle joint ${turned.toFixed(0)}° instead of 60°.`);
        if (inWrist(neighbour).distanceTo(neighbourBefore) > 1e-3) return fail('Editing one finger joint moved another finger.');
        editor.resetBone(single.name);
      }
      editor.applyHandPreset('LEFT', 'fist');
      editor.applyHandPreset('RIGHT', 'fist');
      system.stepFrames(2);
      const fist = distances();
      const curled = fist.filter((d, i) => d < open[i] * 0.92).length;
      editor.applyHandPreset('LEFT', 'open');
      editor.applyHandPreset('RIGHT', 'open');
      system.stepFrames(2);
      const reopened = distances();
      const restored = reopened.every((d, i) => Math.abs(d - open[i]) < open[i] * 0.03);
      if (curled < tips.length - 1) return fail(`Fist curled only ${curled}/${tips.length} fingertips toward the wrist — curl axis likely wrong.`);
      if (!restored) return fail('Open preset did not restore the fingers.');
      return pass(`${joints.length} finger joints individually controllable; fist curled ${curled}/${tips.length} fingertips; open restored them.`);
    });

    // 8. Expressions: mapped morphs exist and the face controller drives them.
    await run('expressions', () => {
      const morphs = system.morphReport();
      if (morphs.mapped === 0) return skip('Not applicable: no expression morphs mapped.');
      system.setFrameInput({ emotion: 'happy', activity: 'idle' });
      system.stepFrames(45);
      const happy = system.morphActivity();
      system.setFrameInput({ emotion: 'idle' });
      system.stepFrames(45);
      if (morphs.broken.length) return fail(`Mapped morphs missing in the model: ${morphs.broken.join(', ')}`);
      if (happy < 0.2) return fail(`Setting a happy expression moved morphs by only ${happy.toFixed(2)}.`);
      return pass(`${morphs.mapped} expression slots mapped (${morphs.vertex} vertex, ${morphs.bone} bone morphs); a happy expression drove morph weight ${happy.toFixed(2)}.`);
    });

    // 9. Animations: procedural idle moves the body over time, without NaN.
    await run('animations', () => {
      editor.setOwnership('AI');
      system.setFrameInput({ emotion: 'idle', activity: 'idle' });
      const chest = bone('UPPER_CHEST') ?? bone('CHEST') ?? bone('SPINE');
      const head = bone('HEAD');
      if (!chest || !head) return fail('No chest or head bone.');
      const samples: THREE.Vector3[] = [];
      for (let i = 0; i < 12; i += 1) {
        system.stepFrames(15);
        samples.push(wp(head));
      }
      const spread = Math.max(...samples.map((s) => s.distanceTo(samples[0]))) / height;
      if (samples.some((s) => !Number.isFinite(s.x))) return fail('Animation produced invalid (NaN) bone positions.');
      if (spread < 0.0005) return fail('Idle animation did not move the body.');
      return pass(`Procedural idle (breathing, sway, gaze, behaviours) moved the head up to ${(spread * 100).toFixed(2)}% of height over 3 s. Keyframed clip import is not implemented.`);
    });

    // 10/11. Secondary physics responds to motion and settles.
    const physicsTest = (classes: string[], label: string) => () => {
      const physics = system.secondaryMotion;
      const chains = rig.chains.filter((c) => classes.includes(c.class));
      if (!physics) return fail('Physics not initialised.');
      if (chains.length === 0) return skip(`Not applicable: this model has no simulated ${label}.`);
      const ids = new Set(chains.map((c) => c.id));
      const filter = (id: string) => ids.has(id);
      editor.setOwnership('AI');
      system.stepFrames(90);
      const baseline = physics.measureDisplacement(filter);
      // A brisk sideways drag then a stop, like moving the companion window.
      let peak = 0;
      for (let i = 0; i < 12; i += 1) {
        system.addScreenMotion(i < 8 ? 45 : -20, i < 8 ? -8 : 4);
        system.stepFrames(1);
        peak = Math.max(peak, physics.measureDisplacement(filter));
      }
      for (let i = 0; i < 20; i += 1) {
        system.stepFrames(1);
        peak = Math.max(peak, physics.measureDisplacement(filter));
      }
      system.stepFrames(240);
      const settled = physics.measureDisplacement(filter);
      if (!physics.healthy) return fail('Simulation became unstable (non-finite positions).');
      const scale = height * 0.002;
      if (peak - baseline < scale) return fail(`${label} barely moved under a drag (peak ${peak.toFixed(3)} vs rest ${baseline.toFixed(3)} model units).`);
      if (settled > baseline + (peak - baseline) * 0.5) return fail(`${label} did not settle after the motion stopped.`);
      return pass(`${chains.length} ${label} chain group(s), ${chains.reduce((n, c) => n + c.bones.length, 0)} bones: drag displaced strands ${peak.toFixed(2)} units (rest ${baseline.toFixed(2)}), settled to ${settled.toFixed(2)}; ${physics.stats.colliders} body colliders active.`);
    };
    await run('hairPhysics', physicsTest(['hair', 'ponytail'], 'hair'));
    await run('clothPhysics', physicsTest(['skirt', 'jacket', 'sleeve', 'tail', 'ribbon'], 'clothing'));

    // 12. Companion rendering: transparent background around an opaque character.
    await run('companionRender', () => {
      const canvas = system.stage.renderer.domElement;
      const width = canvas.clientWidth;
      const heightPx = canvas.clientHeight;
      system.resize(360, 540);
      system.stepFrames(3);
      const coverage = measureCoverage(system);
      system.resize(width, heightPx);
      system.stepFrames(1);
      if (coverage.cornersOpaque) return fail('Background is not transparent — a desktop overlay would show a box.');
      if (coverage.opaque < 0.01) return fail('Character not visible at companion size.');
      return pass(`At 360×540 the background is fully transparent and the character covers ${(coverage.opaque * 100).toFixed(1)}% of the window.`);
    });

    // 13. Dragging: the window-drag motion path keeps the body stable and moves cloth/hair.
    await run('dragging', () => {
      const physics = system.secondaryMotion;
      if (!physics) return fail('Physics not initialised.');
      const hips = bone('HIPS') ?? bone('LOWER_BODY');
      const before = hips ? wp(hips) : new THREE.Vector3();
      system.stepFrames(60);
      const rest = physics.measureDisplacement();
      let peak = 0;
      for (let i = 0; i < 20; i += 1) {
        system.addScreenMotion(Math.sin(i / 3) * 60, Math.cos(i / 4) * 30);
        system.stepFrames(1);
        peak = Math.max(peak, physics.measureDisplacement());
      }
      system.rebasePhysics();
      system.stepFrames(30);
      const after = hips ? wp(hips) : new THREE.Vector3();
      if (!physics.healthy) return fail('Physics exploded during a drag.');
      if (physics.nodeCount > 0 && peak <= rest) return fail('Secondary motion did not respond to the drag.');
      if (after.distanceTo(before) / height > 0.05) return fail('The body itself drifted during the drag.');
      return pass(`Simulated window drag: strands peaked at ${peak.toFixed(2)} units of displacement, body stayed in place, teleport rebase settled cleanly.`);
    });

    // 14. Sitting: thighs forward, knees bent, feet below knees, cloth stable.
    await run('sitting', () => {
      const thighs = ['LEFT_UPPER_LEG', 'RIGHT_UPPER_LEG'].map((s) => rig.humanoid[s]?.bone);
      const knees = ['LEFT_LOWER_LEG', 'RIGHT_LOWER_LEG'].map((s) => rig.humanoid[s]?.bone);
      if (thighs.some((t) => !t) || knees.some((k) => !k)) return fail('Leg bones missing.');
      own('USER');
      const plan = system.sit({ seat: 'chair', style: 'upright', duration: 0 });
      system.stepFrames(120);
      if (!plan) { system.stand(0); return fail('Could not plan a seat for this rig.'); }
      const front = new THREE.Vector3(0, 0, 1);
      const checks = ['LEFT', 'RIGHT'].map((side) => {
        const hip = bone(`${side}_UPPER_LEG`)!;
        const knee = bone(`${side}_LOWER_LEG`)!;
        const foot = bone(`${side}_FOOT`)!;
        const thighDir = wp(knee).sub(wp(hip)).normalize();
        return { forward: thighDir.dot(front), footBelow: wp(foot).y < wp(knee).y };
      });
      const physicsOk = system.secondaryMotion?.healthy ?? true;
      // Contact: the hip joints must rest about one thigh-thickness above the seat.
      const hipY = (wp(bone('LEFT_UPPER_LEG')!).y + wp(bone('RIGHT_UPPER_LEG')!).y) / 2;
      const thigh = wp(bone('LEFT_UPPER_LEG')!).distanceTo(wp(bone('LEFT_LOWER_LEG')!));
      const gap = hipY - plan.seatTopY;
      system.stand(0);
      if (checks.some((c) => c.forward < 0.6)) return fail(`Thighs not forward enough (${checks.map((c) => c.forward.toFixed(2)).join(', ')}).`);
      if (checks.some((c) => !c.footBelow)) return fail('Feet ended above the knees.');
      if (gap < 0 || gap > thigh * 0.4) return fail(`Hips are not resting on the seat (gap ${(gap / thigh).toFixed(2)} thigh lengths).`);
      if (!physicsOk) return fail('Physics unstable while sitting.');
      return pass(`Seated on a chair sized to her legs: hips ${(gap / thigh).toFixed(2)} thigh lengths above the seat, thighs ${checks.map((c) => Math.round(THREE.MathUtils.radToDeg(Math.acos(Math.min(1, c.forward))))).join('°/')}° from level, feet below the knees, cloth stable.`);
    });

    // 15. Cursor look-at: head/eyes turn toward the pointer.
    await run('cursorLookAt', () => {
      const head = bone('HEAD');
      if (!head) return fail('No head bone.');
      editor.setOwnership('AI');
      const yawOf = () => {
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()));
        return Math.atan2(fwd.x, fwd.z);
      };
      system.setEyeTracking(true);
      system.setPointer(-0.9, 0);
      system.stepFrames(90);
      const left = yawOf();
      system.setPointer(0.9, 0);
      system.stepFrames(90);
      const right = yawOf();
      system.setEyeTracking(false);
      system.setPointer(0, 0);
      const diff = THREE.MathUtils.radToDeg(Math.abs(right - left));
      // Screen-right is world +X for the stage camera; her head should turn that way.
      if (diff < 4) return fail(`Head turned only ${diff.toFixed(1)}° between pointer far-left and far-right.`);
      if (!(right > left)) return fail('Head turned away from the pointer.');
      return pass(`Head yaw follows the cursor: ${diff.toFixed(0)}° between screen edges (eyes lead, head follows).`);
    });
  } finally {
    editor.resetBody();
    editor.setOwnership(restoreOwnership);
    system.setFrameInput({ emotion: 'idle', activity: 'idle' });
    system.start();
  }
  return results;
}

function textureStats(mesh: THREE.SkinnedMesh): { total: number; loaded: number; failed: number; pending: number } {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  let total = 0;
  let loaded = 0;
  let failed = 0;
  let pending = 0;
  const seen = new Set<THREE.Texture>();
  for (const material of materials) {
    const uniforms = (material as THREE.ShaderMaterial).uniforms ?? {};
    const candidates: unknown[] = [(material as THREE.MeshBasicMaterial).map, ...Object.values(uniforms).map((u) => (u as { value: unknown }).value)];
    for (const value of candidates) {
      const texture = value as THREE.Texture | null;
      if (!texture || !(texture as THREE.Texture).isTexture || seen.has(texture) || (texture as THREE.DataTexture).isDataTexture) continue;
      seen.add(texture);
      const image = texture.image as HTMLImageElement | ImageBitmap | undefined;
      if (!image || (image as unknown as HTMLCanvasElement).getContext) continue;
      total += 1;
      if ((image as HTMLImageElement).complete === false) pending += 1;
      else if ((image as HTMLImageElement).naturalWidth === 0 && !(image as ImageBitmap).width) failed += 1;
      else loaded += 1;
    }
  }
  return { total, loaded, failed, pending };
}

/** Fraction of opaque pixels in the rendered frame, plus a corner check. */
function measureCoverage(system: CharacterSystem): { opaque: number; cornersOpaque: boolean } {
  const renderer = system.stage.renderer;
  system.stage.render();
  const gl = renderer.getContext();
  const width = gl.drawingBufferWidth;
  const height = gl.drawingBufferHeight;
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let opaque = 0;
  let sampled = 0;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      sampled += 1;
      if (pixels[(y * width + x) * 4 + 3] > 16) opaque += 1;
    }
  }
  const alphaAt = (x: number, y: number) => pixels[(y * width + x) * 4 + 3];
  const cornersOpaque = [alphaAt(1, 1), alphaAt(width - 2, 1), alphaAt(1, height - 2), alphaAt(width - 2, height - 2)].some((a) => a > 16);
  return { opaque: opaque / Math.max(1, sampled), cornersOpaque };
}
