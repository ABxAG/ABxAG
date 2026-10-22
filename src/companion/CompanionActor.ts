/**
 * The desktop companion's body.
 *
 * The Electron shell is the brain: it knows the screen (windows, taskbar,
 * icons, edges) and moves the window. This actor is the body: it turns the
 * shell's commands into solved, character-independent poses and procedural
 * motion, and reports back the measurements the shell needs to place the
 * window exactly (where the surface line is in the canvas, how fast her walk
 * moves, where her hands are).
 *
 * The camera is fixed in world space (CharacterSystem.frameCompanion), so a
 * world height maps to one canvas row: the floor under her rest stance is
 * the window's bottom edge, and a seat's surface is a known row.
 */
import * as THREE from 'three';
import type { CharacterSystem } from '../character/core/CharacterSystem';
import type { PoseData } from '../character/editor/PoseEditor';
import { SEATED_LOCKED_SLOTS, type SitStyle } from '../character/scene/Seating';

export type ActorCommand =
  | { act: 'sit'; style?: SitStyle; side?: 1 | -1 }
  | { act: 'stand' }
  | { act: 'perform'; name: string }
  | { act: 'walk'; dir: 1 | -1; sneak?: boolean }
  | { act: 'stop' }
  | { act: 'peek'; side: 'left' | 'right'; phase: 'hands' | 'head' | 'out' }
  | { act: 'reach'; x: number; y: number }
  | { act: 'tug' }
  | { act: 'release' }
  | { act: 'state'; state: string }
  | { act: 'ledge'; near: boolean; kind?: 'sit' | 'hang' }
  | { act: 'hang' }
  | { act: 'lie'; side?: 1 | -1 };

export interface ActorBridge {
  /** Canvas row of the line she rests on (floor or seat), and how long to ease the window there. */
  contact(y: number, durationMs: number): void;
  metrics(metrics: ActorMetrics): void;
  done(act: string): void;
}

export interface ActorMetrics {
  /** Screen speed of her walk, CSS px per second. */
  walkSpeed: number;
  /** Character height on screen, CSS px. */
  heightPx: number;
  /** Half the body's width on screen, CSS px. */
  halfWidthPx: number;
  /** Canvas x of the hand nearest the peek edge / reach target, when relevant. */
  handX?: number;
  handY?: number;
  /** Canvas x of the head's leading side while peeking. */
  headX?: number;
  /** Canvas row of the floor (rest-stance soles). */
  floorY: number;
}

const WALK = { frequency: 0.9, thigh: 0.25, knee: 0.5, turn: 0.9 };
const SNEAK = { frequency: 0.75, stride: 0.7 };
const SEATED_STYLES: SitStyle[] = ['perch', 'handsOnKnees', 'ankles', 'leanBack', 'crossed'];
/** Body turn while seated (radians, times the seat side). */
const SEATED_TURN: Partial<Record<SitStyle, number>> & Record<'perch', number> = { perch: 0.55, handsOnKnees: 0.22, ankles: 0.5, leanBack: 0.38, crossed: 0.5, dangle: 0.3 };

export class CompanionActor {
  private mode: 'stand' | 'sit' | 'walk' | 'peek' | 'reach' | 'lie' | 'hang' = 'stand';
  /** What the magnet preview shows while held over a ledge. */
  private ledgeKind: 'sit' | 'hang' = 'sit';
  /** Lying on a ledge: 0..1 weight of the leg pose, and which way her head points. */
  private lieWeight = 0;
  private lieSide: 1 | -1 = 1;
  private readonly lieEuler = new THREE.Euler();
  private readonly lieQuat = new THREE.Quaternion();
  private walkWeight = 0;
  /** Tiptoeing away (hide and peek): smaller, slower steps, crouched, looking back. */
  private sneak = false;
  private walkTarget = 0;
  private walkDir: 1 | -1 = 1;
  private phase = 0;
  private turnNow = 0;
  private turnTarget = 0;
  private seatStyle: SitStyle = 'perch';
  private seatSide: 1 | -1 = 1;
  private pending: Array<{ at: number; run: () => void; generation: number }> = [];
  /** Bumped by every new command: steps scheduled by an older one are dropped. */
  private generation = 0;
  private time = 0;
  private tugT = -1;
  private reachPose: PoseData | null = null;
  private tugPose: PoseData | null = null;
  private waitingBehaviour: string | null = null;
  /** Picked up / falling: 0..1 blend of the dangling pose. */
  private heldTarget = 0;
  private heldWeight = 0;
  /** Held over a window edge: fold into a sitting shape (the magnet preview). */
  private ledgeTarget = 0;
  private ledgeWeight = 0;
  /** Window motion this frame (px), and its smoothed velocity (px/s). */
  private motionRaw = { x: 0, y: 0 };
  private velocity = { x: 0, y: 0 };
  /** Landing knee-bend: time since touchdown and its strength. */
  private landT = -1;
  private landAmount = 0;
  private readonly removeLayer: () => void;

  constructor(private readonly system: CharacterSystem, private readonly bridge: ActorBridge) {
    this.removeLayer = system.addPoseLayer((delta, pose, bones) => this.tick(delta, pose, bones));
    // Full display rate always: a 45 fps cap on a 60 Hz screen renders every
    // other vsync (30 fps, uneven) and her idle motion visibly stutters.
    system.setFrameRateCap(null);
  }

  dispose(): void {
    this.removeLayer();
    this.pending = [];
  }

  // ---- measurements ------------------------------------------------------------

  private get height(): number {
    return this.system.worldHeight;
  }

  private legLength(): number {
    const m = this.system.legMeasures;
    return m ? m.thigh + m.shin : this.height * 0.47;
  }

  /** World speed of the walk cycle: the stance foot sweeps 2·L·sin(A) per step. */
  private walkWorldSpeed(): number {
    const f = WALK.frequency * (this.sneak ? SNEAK.frequency : 1);
    const a = WALK.thigh * (this.sneak ? SNEAK.stride : 1);
    return 4 * this.legLength() * f * Math.sin(a) * 0.82;
  }

  metrics(extra: Partial<ActorMetrics> = {}): ActorMetrics {
    const px = this.system.worldPerPixel();
    return {
      walkSpeed: (this.walkWorldSpeed() * Math.sin(WALK.turn)) / px,
      heightPx: this.height / px,
      halfWidthPx: (this.height * 0.13) / px,
      floorY: this.system.floorCanvasY() ?? this.system.stage.renderer.domElement.clientHeight,
      ...extra,
    };
  }

  /** Report where she rests: the floor while standing, the seat line while seated. */
  private reportContact(durationMs: number): void {
    const y = this.mode === 'sit' ? this.system.seatLineCanvasY() : this.system.floorCanvasY();
    if (y !== null && Number.isFinite(y)) this.bridge.contact(y, durationMs);
  }

  ready(): void {
    this.bridge.metrics(this.metrics());
    this.reportContact(0);
  }

  // ---- commands ------------------------------------------------------------------

  handle(command: ActorCommand): void {
    // A new command supersedes whatever was still scheduled (a stretch
    // returning to its seated pose must not fire after she stood up).
    if (command.act !== 'state' || command.state === 'held' || command.state === 'falling') {
      this.generation += 1;
      this.waitingBehaviour = null;
    }
    switch (command.act) {
      case 'sit':
        this.sit(command.style, command.side);
        break;
      case 'stand':
        this.standUp(0.9);
        break;
      case 'perform':
        this.perform(command.name);
        break;
      case 'walk':
        this.walk(command.dir, command.sneak === true);
        break;
      case 'stop':
        this.stopWalking();
        break;
      case 'peek':
        this.peek(command.side, command.phase);
        break;
      case 'reach':
        this.reach(command.x, command.y);
        break;
      case 'tug':
        this.tug();
        break;
      case 'release':
        this.release();
        break;
      case 'ledge':
        this.ledgeTarget = command.near ? 1 : 0;
        if (command.near) this.ledgeKind = command.kind ?? 'sit';
        break;
      case 'hang':
        this.hang();
        break;
      case 'lie':
        this.lie(command.side ?? (Math.random() < 0.5 ? 1 : -1));
        break;
      case 'state':
        if (command.state !== 'held') this.ledgeTarget = 0;
        if (command.state === 'held' || command.state === 'falling') {
          if (this.mode === 'walk') this.stopWalking(true);
          if (this.mode === 'sit' || this.mode === 'peek' || this.mode === 'reach' || this.mode === 'hang') this.standUp(0.25);
          this.system.stopBehaviour();
          this.system.setIdleBehaviours(false);
          if (command.state === 'held') {
            // Picked up: dangle, arms out, a little startled.
            this.heldTarget = 1;
            this.system.playBehaviour('heldFace');
          } else {
            this.heldTarget = Math.max(this.heldTarget, 0.7);
          }
        } else if (command.state === 'standing') {
          this.heldTarget = 0;
          this.system.setIdleBehaviours(true);
        }
        break;
    }
  }

  /** The window moved (drag, fall, carried, walk): feeds the dangling swing and the landing. */
  onMoved(dx: number, dy: number, kind: string, impact = 0): void {
    if (kind === 'teleport') return;
    this.motionRaw.x += dx;
    this.motionRaw.y += dy;
    if (kind === 'land') {
      this.heldTarget = 0;
      this.landT = 0;
      this.landAmount = THREE.MathUtils.clamp(impact / 2200, 0.25, 1);
    }
  }

  private later(seconds: number, run: () => void): void {
    this.pending.push({ at: this.time + seconds, run, generation: this.generation });
  }

  // ---- sitting -------------------------------------------------------------------

  private sit(style?: SitStyle, side?: 1 | -1): void {
    // Ease out of a walk that is still winding down (no pop of arms/turn).
    this.stopWalking(false);
    this.system.stopBehaviour();
    this.seatStyle = style && SEATED_STYLES.includes(style) ? style : SEATED_STYLES[Math.floor(Math.random() * 3)];
    this.seatSide = side ?? (Math.random() < 0.5 ? 1 : -1);
    const duration = this.mode === 'sit' ? 1.3 : 1.1;
    this.mode = 'sit';
    this.system.setIdleBehaviours(false);
    const plan = this.system.inNeutralTurn(() => this.system.sit({ seat: 'edge', style: this.seatStyle, side: this.seatSide, duration }));
    if (!plan) {
      this.mode = 'stand';
      this.system.setIdleBehaviours(true);
      return;
    }
    // Sit angled to the viewer, not square-on: knees together and pointing
    // off to one side is how a ledge-sit reads as relaxed and feminine (and
    // a short skirt is not facing the camera).
    this.turnTarget = this.seatSide * (SEATED_TURN[this.seatStyle] ?? 0.5);
    this.reportContact(duration * 1000);
    this.later(duration, () => this.bridge.done('sit'));
  }

  private standUp(duration: number): void {
    if (this.mode === 'lie') {
      this.getUp();
      return;
    }
    if (this.mode === 'hang') {
      this.clearSolvedPose(duration);
      this.heldTarget = 0;
    }
    const wasSitting = this.mode === 'sit';
    if (this.mode === 'peek' || this.mode === 'reach') this.clearSolvedPose(duration);
    if (wasSitting) this.system.stand(duration);
    this.turnTarget = 0;
    this.mode = 'stand';
    this.system.setIdleBehaviours(true);
    this.reportContact(duration * 1000);
    this.later(duration, () => this.bridge.done('stand'));
  }

  // ---- hanging from a title bar --------------------------------------------------

  /**
   * Both hands grip a window's title bar overhead; she hangs below it with
   * her legs dangling and kicking (the dangle layer). Reports the grip row
   * as her contact line, so the shell puts her hands on the bar.
   */
  private hang(): void {
    const editor = this.system.poseEditor;
    if (!editor) return;
    this.stopWalking(true);
    if (this.mode === 'sit') this.system.stand(0);
    this.faceViewer();
    this.system.stopBehaviour();
    this.mode = 'hang';
    this.ledgeTarget = 0;
    const H = this.height;
    const head = this.system.slotWorld('HEAD');
    if (!head) return;
    const grip = (x: number) => head.clone().add(new THREE.Vector3(x * H, H * 0.12, H * 0.03));
    const pose = editor.solveBody({
      headNod: -8,
      shrug: 14,
      hands: {
        LEFT: { target: grip(0.075), pole: grip(0.075).add(new THREE.Vector3(H * 0.15, -H * 0.1, -H * 0.05)), aim: new THREE.Vector3(0, 1, 0.25) },
        RIGHT: { target: grip(-0.075), pole: grip(-0.075).add(new THREE.Vector3(-H * 0.15, -H * 0.1, -H * 0.05)), aim: new THREE.Vector3(0, 1, 0.25) },
      },
      handPreset: { LEFT: 'fist', RIGHT: 'fist' },
    });
    editor.blendAmount = 0.5;
    editor.setOwnership('BLENDED');
    editor.apply(pose, { duration: 0.35 });
    this.heldTarget = 1; // legs dangle and swing
    this.system.setIdleBehaviours(false);
    // Grip row: just above the wrists (the fingers wrap the bar).
    const row = this.system.worldToCanvas(grip(0).add(new THREE.Vector3(0, H * 0.02, 0))).y;
    this.bridge.contact(row, 350);
    this.later(0.4, () => this.bridge.done('hang'));
  }

  // ---- lying down on a high ledge ------------------------------------------------

  /**
   * Lie on her side along the ledge, facing the viewer: head propped on her
   * lower hand, upper hand resting on her hip, knees bent, top foot swinging.
   * Used where there is no room above the ledge to sit. The shell turns the
   * window landscape first; framing waits until the canvas has that shape.
   */
  private lie(side: 1 | -1): void {
    const editor = this.system.poseEditor;
    if (!editor) return;
    this.stopWalking(true);
    if (this.mode === 'sit') this.system.stand(0);
    this.faceViewer();
    this.system.stopBehaviour();
    this.lieSide = side;
    this.mode = 'lie';
    const H = this.height;
    // Solve upright (facing the viewer), then turn her into profile and lay
    // her face-down: on her stomach along the ledge, propped on her elbows,
    // chin in her hands, looking round at you, lower legs kicking up.
    // side +1: head toward screen-left.
    this.system.setRoll(0);
    this.turnNow = this.turnTarget = 0;
    this.system.setTurn(0);
    const head = this.system.slotWorld('HEAD');
    if (!head) return;
    const chin = head.clone().add(new THREE.Vector3(0, -H * 0.065, H * 0.11));
    const lat = new THREE.Vector3(1, 0, 0);
    const pose = editor.solveBody({
      spineLean: -18,
      chestLean: -6,
      headNod: -28,
      headTurn: side * 78,
      hands: {
        LEFT: { target: chin.clone().addScaledVector(lat, H * 0.035), pole: chin.clone().add(new THREE.Vector3(H * 0.12, -H * 0.2, H * 0.1)), aim: new THREE.Vector3(-0.3, 1, 0.2) },
        RIGHT: { target: chin.clone().addScaledVector(lat, -H * 0.035), pole: chin.clone().add(new THREE.Vector3(-H * 0.12, -H * 0.2, H * 0.1)), aim: new THREE.Vector3(0.3, 1, 0.2) },
      },
      handPreset: { LEFT: 'relaxed', RIGHT: 'relaxed' },
    });
    editor.blendAmount = 0.5;
    editor.setOwnership('BLENDED');
    editor.apply(pose, { duration: 0 });
    this.lieWeight = 1;
    const turn = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    this.turnNow = this.turnTarget = turn;
    this.system.setTurn(turn);
    const baseRoll = side > 0 ? Math.PI / 2 : -Math.PI / 2;
    this.system.setRoll(baseRoll);
    this.system.rebasePhysics();
    // Measure once the window is landscape and the pose weights have eased
    // in (the shell keeps her faded out until 'lie' is done).
    this.reframeWhen((w, h) => w > h && editor.settled, () => {
      // Tip her so elbows and knees rest on the same line: chest propped
      // up, hips and thighs down on the ledge (not hovering above it on
      // straight arms like she is diving).
      const rowOf = (slot: string) => {
        const p = this.system.slotWorld(slot);
        return p ? this.system.worldToCanvas(p).y : NaN;
      };
      const gap = (roll: number) => {
        this.system.setRoll(roll);
        this.system.stepFrames(1);
        const elbow = Math.max(rowOf('LEFT_LOWER_ARM'), rowOf('RIGHT_LOWER_ARM'));
        const knee = Math.max(rowOf('LEFT_LOWER_LEG'), rowOf('RIGHT_LOWER_LEG'));
        return knee - elbow;
      };
      const g0 = gap(baseRoll);
      const g1 = gap(baseRoll + 0.1);
      let roll = baseRoll;
      if (Number.isFinite(g0) && Number.isFinite(g1) && Math.abs(g1 - g0) > 1e-3) {
        roll = baseRoll + THREE.MathUtils.clamp((-g0 * 0.1) / (g1 - g0), -0.3, 0.3);
      }
      this.system.setRoll(roll);
      this.system.rebasePhysics();
      this.system.stepFrames(3);
      const points = [...this.system.solePoints()];
      for (const slot of ['HEAD', 'LEFT_HAND', 'RIGHT_HAND', 'LOWER_BODY', 'LEFT_SHOULDER', 'RIGHT_SHOULDER', 'LEFT_LOWER_LEG', 'RIGHT_LOWER_LEG', 'LEFT_LOWER_ARM', 'RIGHT_LOWER_ARM', 'LEFT_FOOT', 'RIGHT_FOOT']) {
        const p = this.system.slotWorld(slot);
        if (p) points.push(p);
      }
      // Hair top and body thickness around the bones; headroom for the
      // kicking feet.
      const thick = H * 0.07;
      const padded = points.flatMap((p) => [p.clone().add(new THREE.Vector3(0, thick * 1.6, 0)), p.clone().add(new THREE.Vector3(0, -thick * 0.8, 0))]);
      const row = this.system.frameAround(padded, { margin: 0.05, floorPx: 6 });
      if (row !== null) this.bridge.contact(row, 0);
      this.bridge.metrics(this.metrics());
      this.bridge.done('lie');
    });
  }

  /** From lying back to standing (the shell turns the window portrait again). */
  private getUp(): void {
    const editor = this.system.poseEditor;
    this.lieWeight = 0;
    this.system.setRoll(0);
    this.turnNow = this.turnTarget = 0;
    this.system.setTurn(0);
    this.system.rebasePhysics();
    editor?.apply({ version: 2, space: 'bind', bones: {} }, { duration: 0 });
    editor?.setOwnership('AI');
    this.mode = 'stand';
    this.system.setIdleBehaviours(true);
    this.reframeWhen((w, h) => h > w, () => {
      this.system.frameCompanion({ top: 0.16, width: 0.34, floorPx: 8 });
      this.reportContact(0);
      this.bridge.metrics(this.metrics());
      this.bridge.done('stand');
    });
  }

  /** Run `work` once the page has the expected shape (the window resize lands asynchronously). */
  private reframeWhen(ready: (w: number, h: number) => boolean, work: () => void, tries = 0): void {
    const el = this.system.stage.renderer.domElement.parentElement ?? document.body;
    const w = el.clientWidth || window.innerWidth;
    const h = el.clientHeight || window.innerHeight;
    if (ready(w, h) || tries > 70) {
      this.system.resize(w, h);
      work();
      return;
    }
    window.setTimeout(() => this.reframeWhen(ready, work, tries + 1), 25);
  }

  /** Seated performances, solved from the current seat so the legs stay put. */
  private seatedPerformance(name: string): boolean {
    const editor = this.system.poseEditor;
    const plan = this.system.seatPlan;
    if (!editor || !plan) return false;
    const H = this.height;
    const head = this.system.inNeutralTurn(() => this.system.slotWorld('HEAD'));
    if (!head) return false;
    const toLeft = new THREE.Vector3(1, 0, 0);
    const front = new THREE.Vector3(0, 0, 1);
    const solve = (p: typeof plan) => this.system.inNeutralTurn(() => editor.solveSeated(p));
    const seated = () => solve(plan);
    if (name === 'switch') {
      // Change how she sits (knees together, ankles crossed, leaning back…).
      const others = SEATED_STYLES.filter((s) => s !== this.seatStyle);
      this.sit(others[Math.floor(Math.random() * others.length)], Math.random() < 0.5 ? 1 : -1);
      return true;
    }
    if (name === 'stretchUp') {
      // Both arms high over her head, fingers laced, leaning back a little.
      const top = head.clone().addScaledVector(new THREE.Vector3(0, 1, 0), H * 0.2);
      const up = { ...plan, spineLean: plan.spineLean - 6, headTilt: 0, shrug: 10, hands: {
        LEFT: { target: top.clone().addScaledVector(toLeft, H * 0.025).addScaledVector(front, H * 0.01), pole: top.clone().addScaledVector(toLeft, H * 0.3).addScaledVector(front, -H * 0.05) },
        RIGHT: { target: top.clone().addScaledVector(toLeft, -H * 0.025).addScaledVector(front, H * 0.01), pole: top.clone().addScaledVector(toLeft, -H * 0.3).addScaledVector(front, -H * 0.05) },
      } };
      editor.apply(solve(up), { duration: 1.2 });
      this.system.playBehaviour('yawnFace');
      this.later(2.8, () => editor.apply(seated(), { duration: 1.1 }));
      this.later(4.0, () => this.bridge.done('perform'));
      return true;
    }
    if (name === 'yawn') {
      const mouth = head.clone().addScaledVector(front, H * 0.07).addScaledVector(new THREE.Vector3(0, -1, 0), H * 0.035);
      const yawn = { ...plan, headTilt: plan.headTilt * 0.5, hands: {
        ...plan.hands,
        RIGHT: { target: mouth.clone().addScaledVector(toLeft, -H * 0.005), pole: mouth.clone().addScaledVector(toLeft, -H * 0.25).addScaledVector(new THREE.Vector3(0, -1, 0), H * 0.2) },
      } };
      editor.apply(solve(yawn), { duration: 0.7 });
      this.system.playBehaviour('yawnFace');
      this.later(2.3, () => editor.apply(seated(), { duration: 0.8 }));
      this.later(3.1, () => this.bridge.done('perform'));
      return true;
    }
    if (name === 'think') {
      // Chin on her hand, leaning forward a little, eyes off to the side.
      const chin = head.clone().addScaledVector(front, H * 0.055).addScaledVector(new THREE.Vector3(0, 1, 0), H * 0.005);
      const think = { ...plan, spineLean: plan.spineLean + 10, headTilt: plan.headTilt * 0.5, hands: {
        ...plan.hands,
        RIGHT: { target: chin.clone().addScaledVector(toLeft, -H * 0.012), pole: chin.clone().addScaledVector(toLeft, -H * 0.12).addScaledVector(new THREE.Vector3(0, -1, 0), H * 0.3).addScaledVector(front, H * 0.1), aim: new THREE.Vector3(0.2, 1, 0.3) },
      } };
      editor.apply(solve(think), { duration: 0.9 });
      this.system.playBehaviour('curiousFace');
      this.later(4.2, () => editor.apply(seated(), { duration: 0.9 }));
      this.later(5.2, () => this.bridge.done('perform'));
      return true;
    }
    if (name === 'lookAround') {
      this.system.playBehaviour('curiousFace');
      this.later(3, () => this.bridge.done('perform'));
      return true;
    }
    return false;
  }

  // ---- standing performances -----------------------------------------------------

  private perform(name: string): void {
    if (this.mode === 'sit') {
      if (!this.seatedPerformance(name)) this.later(0.1, () => this.bridge.done('perform'));
      return;
    }
    if (this.system.playBehaviour(name)) this.waitingBehaviour = name;
    else this.later(0.1, () => this.bridge.done('perform'));
  }

  // ---- walking -------------------------------------------------------------------

  private walk(dir: 1 | -1, sneak = false): void {
    this.sneak = sneak;
    if (this.mode === 'sit') this.standUp(0.5);
    if (this.mode === 'peek' || this.mode === 'reach') this.clearSolvedPose(0.4);
    this.system.stopBehaviour();
    this.mode = 'walk';
    this.walkDir = dir;
    this.walkTarget = 1;
    this.turnTarget = dir * WALK.turn;
    this.system.setIdleBehaviours(false);
    this.bridge.metrics(this.metrics());
  }

  private stopWalking(immediate = false): void {
    if (this.mode !== 'walk' && this.walkTarget === 0) return;
    this.walkTarget = 0;
    this.turnTarget = 0;
    if (immediate) {
      this.walkWeight = 0;
      this.turnNow = 0;
      this.system.setTurn(0);
    }
    if (this.mode === 'walk') this.mode = 'stand';
    this.system.setIdleBehaviours(true);
  }

  // ---- peeking in from a screen edge ----------------------------------------------

  /**
   * `side` is the screen edge she is behind: 'left' means she is off the
   * left edge, leaning into the screen toward +x.
   */
  private peek(side: 'left' | 'right', phase: 'hands' | 'head' | 'out'): void {
    const editor = this.system.poseEditor;
    const hips = this.system.slotWorld('LOWER_BODY') ?? this.system.slotWorld('HIPS');
    const floor = this.system.floorY;
    if (!editor || !hips || floor === null) return;
    if (phase === 'out') {
      this.system.playBehaviour('happyFace');
      this.standUp(0.8);
      return;
    }
    this.stopWalking(true);
    if (this.mode === 'sit') this.system.stand(0);
    this.faceViewer();
    if (phase === 'hands') this.system.stopBehaviour();
    this.mode = 'peek';
    this.system.setIdleBehaviours(false);
    const H = this.height;
    const s = side === 'left' ? 1 : -1; // +1: the screen interior is toward +x (her left)
    const x = new THREE.Vector3(1, 0, 0);
    const front = new THREE.Vector3(0, 0, 1);
    const at = (lateral: number, height: number, forward: number) =>
      new THREE.Vector3(hips.x, floor, hips.z).addScaledVector(x, s * lateral * H).setY(floor + height * H).addScaledVector(front, forward * H);
    const near = s > 0 ? 'LEFT' : 'RIGHT';
    const far = s > 0 ? 'RIGHT' : 'LEFT';
    // Peeking round a corner: both hands hold the screen edge (fingers
    // curled over it toward the screen, backs of the hands to the viewer)
    // and stay there, while her head leans out PAST them. In the first phase
    // only her fingers show; in the second her head comes out beyond the
    // edge and the window does not move.
    const edge = 0.11;
    const nearHand = at(edge, 0.86, 0.03);
    const farHand = at(edge - 0.004, 0.74, 0.06);
    const fingersIn = new THREE.Vector3(s, 0.15, 0.12);
    const out = phase === 'head';
    const pose = editor.solveBody({
      hipOffset: new THREE.Vector3(s * (out ? 0.06 : 0.01) * H, 0, 0),
      spineRoll: s * (out ? 26 : 4),
      chestLean: 3,
      spineTurn: -s * 8,
      headTilt: s * (out ? 28 : 6),
      headTurn: -s * 8,
      hands: {
        [near]: { target: nearHand, pole: nearHand.clone().add(new THREE.Vector3(-s * H * 0.14, -H * 0.32, -H * 0.12)), aim: fingersIn },
        [far]: { target: farHand, pole: farHand.clone().add(new THREE.Vector3(-s * H * 0.06, -H * 0.3, H * 0.25)), aim: fingersIn },
      },
      handPreset: { LEFT: 'relaxed', RIGHT: 'relaxed' },
    });
    const solved = editor.solvedPositions;
    this.lockLegs(true);
    editor.blendAmount = 0.6;
    editor.setOwnership('BLENDED');
    editor.apply(pose, { duration: phase === 'hands' ? 0 : 0.7 });
    if (phase === 'head') this.system.playBehaviour('curiousFace');
    // Leading edges, in canvas x: fingertips of the hand nearest the
    // interior, and the side of her head.
    const lead = (s > 0 ? Math.max : Math.min);
    const tips = ['LEFT_MIDDLE_DISTAL', 'RIGHT_MIDDLE_DISTAL', 'LEFT_MIDDLE_INTERMEDIATE', 'RIGHT_MIDDLE_INTERMEDIATE', 'LEFT_HAND', 'RIGHT_HAND']
      .map((slot) => solved.get(slot)).filter((p): p is THREE.Vector3 => Boolean(p))
      .map((p) => this.system.worldToCanvas(p).x);
    const px = this.system.worldPerPixel();
    // Where the screen edge should be: a finger-length in from the tips, so
    // her whole fingers show curled over it.
    const handX = (tips.length ? lead(...tips) : this.system.worldToCanvas(nearHand).x) - (s * H * 0.04) / px;
    const headPoint = solved.get('HEAD') ?? at(0, 0.9, 0);
    const headX = this.system.worldToCanvas(headPoint).x + (s * H * 0.075) / px;
    this.bridge.metrics(this.metrics({ handX, handY: this.system.worldToCanvas(nearHand).y, headX }));
    this.later(phase === 'hands' ? 0.05 : 0.7, () => this.bridge.done('peek'));
  }

  // ---- reaching for (and pulling) a desktop icon -----------------------------------

  private reach(canvasX: number, canvasY: number): void {
    const editor = this.system.poseEditor;
    const hips = this.system.slotWorld('LOWER_BODY') ?? this.system.slotWorld('HIPS');
    const floor = this.system.floorY;
    if (!editor || !hips || floor === null) return;
    this.stopWalking(true);
    if (this.mode === 'sit') this.system.stand(0);
    this.faceViewer();
    this.system.stopBehaviour();
    this.mode = 'reach';
    this.system.setIdleBehaviours(false);
    const H = this.height;
    const depth = hips.clone().add(new THREE.Vector3(0, 0, H * 0.1));
    const target = this.system.canvasToWorld(canvasX, canvasY, depth);
    const side = target.x >= hips.x ? 1 : -1;
    // Bend just enough for the hands to reach; she picks icons near waist
    // height, so this stays a light dip (a deep squat flips a short skirt).
    const handHeight = target.y - floor;
    const crouch = THREE.MathUtils.clamp((0.5 - handHeight / H) * 0.6, 0, 0.12) * H;
    const lean = THREE.MathUtils.clamp(12 + (crouch / H) * 110, 12, 26);
    const lateral = new THREE.Vector3(1, 0, 0);
    const hand = (offset: number) => target.clone().addScaledVector(lateral, offset * H);
    const solve = (pullBack: number) => editor.solveBody({
      hipOffset: new THREE.Vector3(-side * pullBack * H, -crouch, -pullBack * H * 0.2),
      plantFeet: true,
      spineLean: lean - pullBack * 120,
      spineRoll: side * (8 - pullBack * 40),
      spineTurn: side * 14,
      headNod: 10,
      headTurn: side * 10,
      hands: {
        LEFT: { target: hand(0.025), pole: hand(0.025).add(new THREE.Vector3(H * 0.2, -H * 0.15, -H * 0.15)) },
        RIGHT: { target: hand(-0.025), pole: hand(-0.025).add(new THREE.Vector3(-H * 0.2, -H * 0.15, -H * 0.15)) },
      },
      handPreset: { LEFT: 'fist', RIGHT: 'fist' },
    });
    this.reachPose = this.system.inNeutralTurn(() => solve(0));
    this.tugPose = this.system.inNeutralTurn(() => solve(0.06));
    this.lockLegs(true);
    const editorRef = editor;
    editorRef.blendAmount = 0.5;
    editorRef.setOwnership('BLENDED');
    editorRef.apply(this.reachPose, { duration: 0.8 });
    this.bridge.metrics(this.metrics({ handX: canvasX, handY: canvasY }));
    this.later(0.85, () => this.bridge.done('reach'));
  }

  /** One tug on whatever she holds: lean back hard, then recover (≈0.7 s). */
  private tug(): void {
    const editor = this.system.poseEditor;
    if (!editor || !this.tugPose || !this.reachPose || this.mode !== 'reach') {
      this.bridge.done('tug');
      return;
    }
    this.system.playBehaviour('effortFace');
    editor.apply(this.tugPose, { duration: 0.42 });
    this.later(0.45, () => editor.apply(this.reachPose!, { duration: 0.45 }));
    this.later(0.9, () => this.bridge.done('tug'));
  }

  private release(): void {
    this.reachPose = this.tugPose = null;
    this.standUp(0.6);
    this.later(0.7, () => this.system.playBehaviour('giggle'));
  }

  private clearSolvedPose(duration: number): void {
    const editor = this.system.poseEditor;
    if (!editor) return;
    this.lockLegs(false);
    editor.apply({ version: 2, space: 'bind', bones: {} }, { duration });
    this.later(duration, () => {
      if (this.mode !== 'sit' && this.mode !== 'peek' && this.mode !== 'reach') editor.setOwnership('AI');
    });
  }

  /** Turn to face the viewer at once (before solving a planted pose). */
  private faceViewer(): void {
    this.turnNow = this.turnTarget = 0;
    this.system.setTurn(0);
  }

  /** Hips and legs ignore idle sway while a planted pose is held. */
  private lockLegs(locked: boolean): void {
    const pose = this.system.poseBuffer;
    const humanoid = this.system.rig?.humanoid;
    if (!pose || !humanoid) return;
    for (const slot of SEATED_LOCKED_SLOTS) {
      const bone = humanoid[slot]?.bone;
      if (!bone) continue;
      if (locked) pose.aiSuppressed.add(bone);
      else pose.aiSuppressed.delete(bone);
    }
  }

  // ---- per frame ------------------------------------------------------------------

  /**
   * Held up by the cursor or falling: legs hang with soft knees and kick a
   * little, arms go out for balance, and both swing behind the motion like a
   * pendulum. Landing bends the knees to absorb the drop. All of it is eased
   * in and out, so nothing snaps.
   */
  private dangle(delta: number, pose: import('../character/animation/PoseBuffer').PoseBuffer, bones: CharacterSystem['boneMap']): void {
    const k = 1 - Math.exp(-10 * delta);
    const dt = Math.max(1e-3, delta);
    this.velocity.x += (this.motionRaw.x / dt - this.velocity.x) * k;
    this.velocity.y += (this.motionRaw.y / dt - this.velocity.y) * k;
    this.motionRaw.x = this.motionRaw.y = 0;
    this.heldWeight += (this.heldTarget - this.heldWeight) * (1 - Math.exp(-7 * delta));
    if (this.heldWeight < 0.002 && this.heldTarget === 0) this.heldWeight = 0;
    const f = this.system.frontSign;
    this.ledgeWeight += (this.ledgeTarget - this.ledgeWeight) * (1 - Math.exp(-9 * delta));
    if (this.ledgeWeight > 0.002) {
      const s = this.ledgeWeight * this.heldWeight;
      if (this.ledgeKind === 'hang') {
        // Arms reach up for the title bar: she will hang from it.
        pose.addEuler(bones.armL, 0, -0.25, 2.3, s);
        pose.addEuler(bones.armR, 0, 0.25, -2.3, s);
      } else {
        // Thighs come forward and knees fold: she is ready to sit.
        pose.addEuler(bones.legL, -f * 1.05, 0, 0, s);
        pose.addEuler(bones.legR, -f * 1.05, 0, 0, s);
        pose.addEuler(bones.kneeL, f * 0.75, 0, 0, s);
        pose.addEuler(bones.kneeR, f * 0.75, 0, 0, s);
      }
    }
    const w = this.heldWeight;
    if (w > 0) {
      const vx = THREE.MathUtils.clamp(this.velocity.x / 1400, -1, 1);
      const vy = THREE.MathUtils.clamp(this.velocity.y / 1400, -1, 1);
      const t = this.time;
      const kickL = Math.sin(t * 2.3) * 0.12;
      const kickR = Math.sin(t * 2.3 + 2.2) * 0.12;
      const lift = Math.max(0, -vy) * 0.35; // carried upward: knees draw up
      for (const [leg, knee, ankle, kick] of [[bones.legL, bones.kneeL, bones.ankleL, kickL], [bones.legR, bones.kneeR, bones.ankleR, kickR]] as const) {
        pose.addEuler(leg, -f * (0.3 + kick * 0.6 + lift * 0.5), 0, -f * 0.35 * vx, w);
        pose.addEuler(knee, f * (0.7 + kick + lift), 0, 0, w);
        pose.addEuler(ankle, f * 0.4, 0, 0, w);
      }
      // Arms out for balance, trailing the motion.
      // Arms loose and a little out, elbows soft, hands drifting with the motion.
      const arms = this.mode === 'hang' ? 0 : w;
      if (arms > 0) pose.addEuler(bones.armL, 0, -0.2, 0.26 - 0.22 * vx + 0.15 * vy, w);
      pose.addEuler(bones.armR, 0, 0.2, -0.26 - 0.22 * vx - 0.15 * vy, arms);
      pose.addEuler(bones.elbowL, 0, -0.55, 0.1, arms);
      pose.addEuler(bones.elbowR, 0, 0.55, -0.1, arms);
      pose.addEuler(bones.upperBody, -0.05 * f, 0, 0.1 * vx, w);
      pose.addEuler(bones.head, 0.04 * f, 0, 0.08 - 0.12 * vx, w);
    }
    if (this.landT >= 0) {
      this.landT += delta;
      const p = Math.min(1, this.landT / 0.5);
      const a = Math.sin(p * Math.PI) * this.landAmount;
      if (p >= 1) this.landT = -1;
      const L = this.legLength() * this.system.modelUnitsPerWorld;
      // Knees bend and the body dips, feet staying put.
      pose.addTranslation(bones.center, 0, -L * 0.07 * a, 0, 1);
      pose.addEuler(bones.legL, -f * 0.32 * a, 0, 0, 1);
      pose.addEuler(bones.legR, -f * 0.32 * a, 0, 0, 1);
      pose.addEuler(bones.kneeL, f * 0.62 * a, 0, 0, 1);
      pose.addEuler(bones.kneeR, f * 0.62 * a, 0, 0, 1);
      pose.addEuler(bones.ankleL, -f * 0.3 * a, 0, 0, 1);
      pose.addEuler(bones.ankleR, -f * 0.3 * a, 0, 0, 1);
      pose.addEuler(bones.upperBody, f * 0.12 * a, 0, 0, 1);
    }
  }

  private tick(delta: number, pose: import('../character/animation/PoseBuffer').PoseBuffer, bones: CharacterSystem['boneMap']): void {
    this.time += delta;
    if (this.pending.length) {
      this.pending = this.pending.filter((p) => p.generation === this.generation);
      const due = this.pending.filter((p) => p.at <= this.time);
      this.pending = this.pending.filter((p) => p.at > this.time);
      for (const p of due) {
        try {
          p.run();
        } catch (error) {
          console.warn('[companion] step failed:', error);
        }
      }
    }
    if (this.waitingBehaviour && this.system.behaviourName !== this.waitingBehaviour) {
      this.waitingBehaviour = null;
      this.bridge.done('perform');
    }
    if (this.tugT >= 0) this.tugT += delta;

    this.dangle(delta, pose, bones);
    if (this.lieWeight > 0 && this.mode === 'lie') {
      // Thighs flat on the ledge, shins up in the air swinging alternately,
      // toes pointed. These are absolute joint angles, so they go on the
      // full-weight user layer (procedural offsets are halved while the
      // editor's pose blends in, which left the shins barely lifted).
      const f = this.system.frontSign;
      const t = this.time;
      const burst = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 0.31));
      const kickL = Math.sin(t * 1.9) * 0.38 * burst;
      const kickR = Math.sin(t * 1.9 + Math.PI * 0.85) * 0.38 * burst;
      const set = (bone: string | undefined, x: number, z = 0) => {
        if (!bone) return;
        this.lieEuler.set(x, 0, z, 'XYZ');
        pose.setUserRotation(bone, this.lieQuat.setFromEuler(this.lieEuler));
      };
      set(bones.legL, f * 0.06, 0.04);
      set(bones.legR, f * 0.06, -0.04);
      set(bones.kneeL, f * (1.55 + kickL));
      set(bones.kneeR, f * (1.55 + kickR));
      set(bones.ankleL, f * 0.4);
      set(bones.ankleR, f * 0.4);
    }

    // Turn toward the walking direction and back.
    const k = 1 - Math.exp(-5 * delta);
    this.turnNow += (this.turnTarget - this.turnNow) * k;
    if (Math.abs(this.turnNow) > 1e-4 || this.turnTarget !== 0) this.system.setTurn(this.turnNow);

    // Gait: thighs swing about the hip, knees fold in the swing phase, the
    // body dips so the stance foot stays on the ground, and the arms swing
    // against the legs. Window motion (shell) supplies the travel.
    this.walkWeight += (this.walkTarget - this.walkWeight) * (1 - Math.exp(-6 * delta));
    if (this.walkWeight < 0.002) {
      this.walkWeight = 0;
      if (this.walkTarget === 0) return;
    }
    const w = this.walkWeight;
    const sneak = this.sneak ? 1 : 0;
    this.phase += delta * Math.PI * 2 * WALK.frequency * (sneak ? SNEAK.frequency : 1) * (0.4 + 0.6 * w);
    const f = this.system.frontSign;
    const legs: Array<[string | undefined, string | undefined, string | undefined, number]> = [
      [bones.legL, bones.kneeL, bones.ankleL, this.phase],
      [bones.legR, bones.kneeR, bones.ankleR, this.phase + Math.PI],
    ];
    let dip = 0;
    for (const [leg, knee, ankle, phase] of legs) {
      const swing = Math.sin(phase); // + forward
      const thigh = WALK.thigh * (sneak ? SNEAK.stride : 1) * swing;
      // Swing phase (foot travelling forward); the knee folds most just
      // after toe-off and straightens before the heel lands.
      const lift = Math.max(0, Math.cos(phase + 0.3)) ** 1.4;
      pose.addEuler(leg, -f * (thigh - lift * 0.12), 0, 0, w);
      pose.addEuler(knee, f * (lift * WALK.knee * (sneak ? 1.25 : 1) + 0.05 + sneak * 0.12), 0, 0, w);
      pose.addEuler(ankle, f * (-thigh * 0.45 + lift * 0.25), 0, 0, w);
      if (Math.cos(phase) <= 0) dip = Math.max(dip, 1 - Math.cos(thigh));
    }
    const L = this.legLength() * this.system.modelUnitsPerWorld;
    pose.addTranslation(bones.center, 0, -dip * L - Math.abs(Math.sin(this.phase * 2)) * L * 0.006, 0, w);
    pose.addEuler(bones.lowerBody, 0, Math.sin(this.phase) * 0.06, 0, w);
    pose.addEuler(bones.upperBody, 0, -Math.sin(this.phase) * 0.05, 0, w);
    pose.addEuler(bones.armL, 0, Math.sin(this.phase) * 0.28, 0, w);
    pose.addEuler(bones.armR, 0, Math.sin(this.phase) * 0.28, 0, w);
    pose.addEuler(bones.head, 0, Math.sin(this.phase) * 0.03, 0, w);
    if (sneak) {
      // Sneaking: knees soft, body low and forward, hands up by her chest,
      // and a look back over her shoulder at you.
      pose.addTranslation(bones.center, 0, -L * 0.035, 0, w);
      pose.addEuler(bones.upperBody, f * 0.16, 0, 0, w);
      pose.addEuler(bones.upperBody2, f * 0.06, -this.walkDir * 0.25, 0, w);
      pose.addEuler(bones.head, -f * 0.05, -this.walkDir * 0.55, 0, w);
      pose.addEuler(bones.armL, 0, -0.45, -0.25, w);
      pose.addEuler(bones.armR, 0, 0.45, 0.25, w);
      pose.addEuler(bones.elbowL, 0, -1.5, 0, w);
      pose.addEuler(bones.elbowR, 0, 1.5, 0, w);
    }
  }
}
