/**
 * Desktop companion renderer (?mode=companion), shown in a transparent,
 * frameless, always-on-top Electron window.
 *
 * - Only her silhouette catches the mouse: every cursor update hit-tests the
 *   rendered alpha and asks the shell to toggle click-through.
 * - Drag her anywhere; the shell moves the window (throw, fall, land) and
 *   streams the motion back so hair and clothes react physically.
 * - The shell decides what she does (walk, sit on an edge, stretch, peek in
 *   from a screen edge, play with an icon); CompanionActor performs it and
 *   reports where her feet / seat are so the window lands exactly on the
 *   surface she uses.
 * - A thin contour and a soft shadow keep her readable on any wallpaper.
 * - Activity and emotion mirror the main ABxAG window (BroadcastChannel).
 */
import React, { useEffect, useRef, useState } from 'react';
import { ABxAGCharacter } from '../character/ABxAGCharacter';
import type { CharacterSystem } from '../character/core/CharacterSystem';
import type { CharacterActivity } from '../character/behaviour/behaviours';
import { CompanionActor, type ActorCommand, type ActorMetrics } from './CompanionActor';

interface CompanionBridge {
  setInteractive(value: boolean): void;
  dragStart(): void;
  dragEnd(): void;
  poke(kind?: 'poke' | 'head_pat'): void;
  seat(offsetPx: number): void;
  contact(y: number, durationMs: number): void;
  metrics(metrics: ActorMetrics): void;
  done(act: string): void;
  summon(): void;
  contextMenu(): void;
  on(channel: string, callback: (payload: any) => void): () => void;
}

const bridge = (window as unknown as { abxag?: { companion?: CompanionBridge } }).abxag?.companion ?? null;
export const COMPANION_CHANNEL = 'abxag-character-state';

/** Wallpaper contrast: a crisp dark contour plus a soft drop shadow. */
function standOutFilter(amount: number): string {
  if (amount <= 0) return 'none';
  const a = Math.min(1, amount);
  return [
    `drop-shadow(0 0 ${0.6 + a * 0.6}px rgba(8, 6, 14, ${0.55 + a * 0.35}))`,
    `drop-shadow(0 0 ${2 + a * 3}px rgba(255, 255, 255, ${0.08 + a * 0.14}))`,
    // Her shadow cast on the window / wallpaper behind her, as if lit from
    // the front right (the Desktop Mate look): it grounds her in the scene.
    `drop-shadow(${-(14 + a * 12)}px ${-(4 + a * 6)}px ${5 + a * 5}px rgba(0, 0, 0, ${0.16 + a * 0.16}))`,
    `drop-shadow(${2 + a * 2}px ${4 + a * 4}px ${5 + a * 5}px rgba(0, 0, 0, ${0.22 + a * 0.2}))`,
  ].join(' ');
}

export const CompanionApp: React.FC = () => {
  const [characterId, setCharacterId] = useState<string | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [activity, setActivity] = useState<CharacterActivity>('idle');
  const [emotion, setEmotion] = useState('idle');
  const [standOut, setStandOut] = useState(0.7);
  const [shadow, setShadow] = useState<{ y: number; width: number; visible: boolean }>({ y: 0, width: 0, visible: false });
  const systemRef = useRef<CharacterSystem | null>(null);
  const actorRef = useRef<CompanionActor | null>(null);
  const interactive = useRef(false);
  const pressed = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const reactionTimer = useRef<number | null>(null);
  const followCursor = useRef(true);
  const lastActivity = useRef<CharacterActivity>('idle');

  // Transparent page.
  useEffect(() => {
    for (const el of [document.documentElement, document.body, document.getElementById('root')]) {
      if (el) el.style.background = 'transparent';
    }
    document.body.style.overflow = 'hidden';
  }, []);

  // Which character, cursor-follow and contrast preferences.
  useEffect(() => {
    fetch('/api/app-settings')
      .then((r) => r.json())
      .then((settings) => {
        setCharacterId(settings?.character?.activeCharacterId || undefined);
        followCursor.current = settings?.character?.eyeFollowCursor !== false;
        const amount = Number(settings?.companion?.standOut);
        if (Number.isFinite(amount)) setStandOut(amount);
        setReady(true);
      })
      .catch(() => setReady(true));
  }, []);

  // Mirror the main window's state; being spoken to calls her out.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(COMPANION_CHANNEL);
    channel.onmessage = (event) => {
      const data = event.data || {};
      if (data.activity) {
        if (data.activity !== 'idle' && lastActivity.current === 'idle') bridge?.summon();
        lastActivity.current = data.activity;
        setActivity(data.activity);
      }
      if (data.emotion) setEmotion(data.emotion);
      if (data.characterId && data.characterId !== characterId) setCharacterId(data.characterId);
    };
    return () => channel.close();
  }, [characterId]);

  const react = (nextEmotion: string, ms: number) => {
    setEmotion(nextEmotion);
    if (reactionTimer.current) window.clearTimeout(reactionTimer.current);
    reactionTimer.current = window.setTimeout(() => setEmotion('idle'), ms);
  };

  // Shell → renderer: motion, cursor, commands.
  useEffect(() => {
    if (!bridge) return;
    const offs = [
      bridge.on('companion:moved', (m: { dx: number; dy: number; kind: string; impact?: number }) => {
        const system = systemRef.current;
        if (!system) return;
        if (m.kind === 'teleport') {
          system.rebasePhysics();
          return;
        }
        system.addScreenMotion(m.dx, m.dy);
        actorRef.current?.onMoved(m.dx, m.dy, m.kind, m.impact ?? 0);
        if (m.kind === 'land' && (m.impact ?? 0) > 1400) react('surprised', 900);
      }),
      bridge.on('companion:cursor', (c: { x: number; y: number; width: number; height: number }) => {
        const system = systemRef.current;
        if (!system) return;
        // Look-at: map the cursor (possibly far outside the window) into a
        // bounded range so distant cursors read as "over there".
        if (followCursor.current) {
          const nx = (c.x / c.width) * 2 - 1;
          const ny = -((c.y / c.height) * 2 - 1);
          const squash = (v: number) => v / (1 + Math.abs(v) * 0.35);
          system.setEyeTracking(true);
          system.setPointer(Math.max(-1, Math.min(1, squash(nx))), Math.max(-1, Math.min(1, squash(ny))));
        }
        // Hit test: only her pixels catch the mouse.
        if (pressed.current) return;
        const inside = c.x >= 0 && c.y >= 0 && c.x < c.width && c.y < c.height;
        const hit = inside && system.alphaAt(c.x, c.y) > 24;
        if (hit !== interactive.current) {
          interactive.current = hit;
          bridge.setInteractive(hit);
        }
      }),
      bridge.on('companion:command', (command: string | ActorCommand) => {
        const actor = actorRef.current;
        if (!actor) return;
        const cmd: ActorCommand | null = typeof command === 'string'
          ? command === 'sit' ? { act: 'sit' } : command === 'stand' ? { act: 'stand' } : command === 'wave' ? { act: 'perform', name: 'wave' } : null
          : command;
        if (!cmd) return;
        if (cmd.act === 'perform' && cmd.name === 'wave') react('happy', 1800);
        actor.handle(cmd);
        setShadow((s) => ({ ...s, visible: cmd.act === 'sit' || cmd.act === 'peek' ? false : cmd.act === 'stand' || cmd.act === 'release' || cmd.act === 'walk' ? true : s.visible }));
      }),
      bridge.on('companion:state', (s: { state: string }) => {
        actorRef.current?.handle({ act: 'state', state: s.state });
        setShadow((prev) => ({ ...prev, visible: s.state === 'standing' }));
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => () => actorRef.current?.dispose(), []);

  const onPointerDown = (event: React.PointerEvent) => {
    if (!bridge || event.button !== 0) return;
    pressed.current = { x: event.screenX, y: event.screenY, moved: false };
    bridge.dragStart();
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const p = pressed.current;
    if (p && Math.abs(event.screenX - p.x) + Math.abs(event.screenY - p.y) > 4) p.moved = true;
  };
  const onPointerUp = (event: React.PointerEvent) => {
    const p = pressed.current;
    pressed.current = null;
    bridge?.dragEnd();
    if (p && !p.moved) {
      // A tap: a head tap is a pat, anywhere else a poke.
      const system = systemRef.current;
      const head = system?.slotScreenY('HEAD');
      const isHead = head !== null && head !== undefined && Math.abs(event.clientY - head) < (system?.stage.renderer.domElement.clientHeight ?? 500) * 0.08;
      bridge?.poke(isHead ? 'head_pat' : 'poke');
      react(isHead ? 'happy' : 'surprised', 1400);
    }
  };

  if (!ready) return null;
  return (
    <div
      className="fixed inset-0 select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => {
        e.preventDefault();
        bridge?.contextMenu();
      }}
    >
      {/* Contact shadow: she visibly stands ON the taskbar / window edge. */}
      {shadow.visible && shadow.width > 0 && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: '50%',
            top: shadow.y - 7,
            width: shadow.width,
            height: 14,
            transform: 'translateX(-50%)',
            background: 'radial-gradient(ellipse at center, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.22) 45%, rgba(0,0,0,0) 72%)',
            pointerEvents: 'none',
          }}
        />
      )}
      <div className="absolute inset-0" style={{ filter: standOutFilter(standOut) }}>
        <ABxAGCharacter
          clothInteraction={false}
          unloadWhenHidden={false}
          key={characterId ?? 'default'}
          characterId={characterId}
          activity={activity}
          emotion={emotion}
          outputAnalyser={null}
          inputAnalyser={null}
          controlsEnabled={false}
          showControlHint={false}
          onSystem={(system) => {
            systemRef.current = system;
            actorRef.current?.dispose();
            actorRef.current = null;
            if (!system) return;
            system.setViewLocked(true);
            // Fixed camera, floor exactly on the window's bottom edge: she
            // stands on whatever the window rests on (taskbar, a title bar).
            system.frameCompanion({ top: 0.16, width: 0.34, floorPx: 8 });
            const actor = new CompanionActor(system, {
              contact: (y, ms) => bridge?.contact(y, ms),
              metrics: (m) => {
                bridge?.metrics(m);
                setShadow((s) => ({ ...s, y: m.floorY, width: m.halfWidthPx * 3.2 }));
              },
              done: (act) => bridge?.done(act),
            });
            actorRef.current = actor;
            if (import.meta.env.DEV) (window as unknown as { __companion?: CompanionActor }).__companion = actor;
            actor.ready();
            setShadow((s) => ({ ...s, visible: true }));
          }}
        />
      </div>
    </div>
  );
};

export default CompanionApp;


