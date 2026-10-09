/**
 * Character Studio: import, inspect, pose and test any character.
 *
 *  - left:   built-in + locally imported characters, import from a path
 *  - centre: the live character (click a bone to select it, drag gizmos,
 *            drag IK handles; right-drag orbits, wheel zooms)
 *  - right:  Pose · Fingers · Bones · Physics · Report & profile
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Boxes, Hand, Layers, PersonStanding, Wind, ClipboardCheck, X, Upload, Loader2, Star } from 'lucide-react';
import { ABxAGCharacter } from '../../character/ABxAGCharacter';
import type { CharacterSystem } from '../../character/core/CharacterSystem';
import { listAllCharacters, isBuiltInCharacter, type CharacterListing } from '../../character/config/registry';
import type { CharacterProfile } from '@/shared/character/profile';
import { studioApi, physicsFromSettings, type AppSettingsLite } from './studioApi';
import { runCharacterTests } from '../../character/testing/CharacterTests';
import { PosePanel } from './PosePanel';
import { FingerPanel } from './FingerPanel';
import { BonesPanel } from './BonesPanel';
import { PhysicsPanel } from './PhysicsPanel';
import { ReportPanel } from './ReportPanel';

type Tab = 'pose' | 'fingers' | 'bones' | 'physics' | 'report';

export interface CharacterStudioProps {
  initialCharacterId?: string;
  onClose?: () => void;
  /** Called when the user makes a character the active companion. */
  onActiveCharacterChange?: (id: string) => void;
}

/** Re-render on any pose-editor change, throttled to animation frames. */
export function useEditorVersion(system: CharacterSystem | null): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const editor = system?.poseEditor;
    if (!editor) return;
    let raf = 0;
    const unsubscribe = editor.subscribe(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setVersion((v) => v + 1);
      });
    });
    return () => {
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [system]);
  return version;
}

export const CharacterStudio: React.FC<CharacterStudioProps> = ({ initialCharacterId, onClose, onActiveCharacterChange }) => {
  const [characters, setCharacters] = useState<CharacterListing[]>([]);
  const [characterId, setCharacterId] = useState<string | undefined>(initialCharacterId);
  const [system, setSystem] = useState<CharacterSystem | null>(null);
  const [profile, setProfile] = useState<CharacterProfile | null>(null);
  const [settings, setSettings] = useState<AppSettingsLite | null>(null);
  const [tab, setTab] = useState<Tab>('pose');
  const [gizmos, setGizmos] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [importPath, setImportPath] = useState('');
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const version = useEditorVersion(system);
  const pointer = useRef<{ x: number; y: number; button: number; moved: boolean; grabbed: boolean } | null>(null);
  const viewport = useRef<HTMLDivElement | null>(null);

  const refreshList = useCallback(async () => {
    const list = await listAllCharacters();
    setCharacters(list);
    return list;
  }, []);

  useEffect(() => {
    void refreshList().then((list) => {
      if (!characterId && list.length) setCharacterId(list[0].id);
    });
    studioApi.settings().then(setSettings).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setProfile(null);
    if (!characterId || isBuiltInCharacter(characterId)) return;
    studioApi.profile(characterId).then(setProfile).catch((error) => setMessage(error.message));
  }, [characterId]);

  // Apply persisted physics settings to every newly loaded character.
  useEffect(() => {
    if (!system || !settings) return;
    system.setPhysicsSettings(physicsFromSettings(settings.physics));
    system.setPhysicsDebug(settings.developer?.physicsDebug ?? false);
  }, [system, settings]);

  useEffect(() => {
    system?.poseEditor?.setEnabled(true);
    system?.poseEditor?.setGizmoAllowed(gizmos);
  }, [system, gizmos]);

  // Show the whole character when one loads.
  useEffect(() => {
    if (system) system.frameFullBody();
  }, [system]);

  // Keyboard camera: WASD orbit, Q/E zoom, R/F up/down, Z/C left/right, Home reset.
  useEffect(() => {
    if (!system) return;
    const held = new Set<string>();
    let raf = 0;
    let last = performance.now();
    const step = () => {
      raf = requestAnimationFrame(step);
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (held.size === 0) return;
      const h = system.worldHeight;
      const fast = held.has('shift') ? 2.2 : 1;
      let yaw = 0;
      let pitch = 0;
      let zoom = 0;
      let panX = 0;
      let panY = 0;
      if (held.has('a')) yaw -= 1.8 * dt * fast;
      if (held.has('d')) yaw += 1.8 * dt * fast;
      if (held.has('w')) pitch += 1.1 * dt * fast;
      if (held.has('s')) pitch -= 1.1 * dt * fast;
      if (held.has('q')) zoom -= h * 0.9 * dt * fast;
      if (held.has('e')) zoom += h * 0.9 * dt * fast;
      if (held.has('r')) panY += h * 0.5 * dt * fast;
      if (held.has('f')) panY -= h * 0.5 * dt * fast;
      if (held.has('z')) panX -= h * 0.5 * dt * fast;
      if (held.has('c')) panX += h * 0.5 * dt * fast;
      if (yaw || pitch) system.orbitBy(yaw, pitch);
      if (zoom) system.zoomBy(zoom);
      if (panX || panY) system.panBy(panX, panY);
    };
    raf = requestAnimationFrame(step);
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'home') {
        system.frameFullBody();
        system.setView('front');
        return;
      }
      if ('wasdqerfzc'.includes(key) || key === 'shift') {
        held.add(key);
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => held.delete(e.key.toLowerCase());
    const blur = () => held.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [system]);


  // Development hook: drive the studio from the console / automated checks.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __studio?: unknown }).__studio = {
      system,
      characterId,
      select: (id: string) => setCharacterId(id),
      runTests: async (record = true) => {
        if (!system) throw new Error('No character loaded');
        const results = await runCharacterTests(system);
        if (record && characterId && !isBuiltInCharacter(characterId)) setProfile(await studioApi.recordTests(characterId, results as Record<string, never>));
        return results;
      },
    };
  }, [system, characterId]);

  const doImport = async (source?: string) => {
    const path = (source ?? importPath).trim();
    if (!path) return;
    setImporting(true);
    setMessage(`Importing ${path}…`);
    try {
      const result = await studioApi.importSource(path);
      await refreshList();
      setCharacterId(result.profile.id);
      const issues = result.profile.report.items.filter((i) => i.status !== 'supported').length;
      setMessage(`${result.replaced ? 'Updated' : 'Imported'} ${result.profile.displayName}. ${issues ? `${issues} capability notes — see Report.` : 'All capabilities supported.'}${result.warnings.length ? ` ${result.warnings.join(' ')}` : ''}`);
      setImportPath('');
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const browse = async () => {
    const bridge = (window as unknown as { abxag?: { pickCharacterSource?: () => Promise<string | null> } }).abxag;
    if (!bridge?.pickCharacterSource) {
      setMessage('Paste the full path of a .zip, folder or model file (.pmx/.pmd/.vrm/.glb/.gltf/.fbx/.obj — the file picker is available in the desktop app).');
      return;
    }
    const picked = await bridge.pickCharacterSource();
    if (picked) {
      setImportPath(picked);
      void doImport(picked);
    }
  };

  const makeActive = async () => {
    if (!characterId) return;
    try {
      const next = await studioApi.patchSettings({ character: { activeCharacterId: characterId } });
      setSettings(next);
      onActiveCharacterChange?.(characterId);
      setMessage(`${characters.find((c) => c.id === characterId)?.displayName ?? characterId} is now ABxAG's character.`);
    } catch (error) {
      setMessage((error as Error).message);
    }
  };

  // ---- viewport input: grab body parts, orbit, pan, zoom ---------------------
  const ndc = (event: { clientX: number; clientY: number }) => {
    const rect = viewport.current!.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * 2 - 1, y: -(((event.clientY - rect.top) / rect.height) * 2 - 1) };
  };
  const [hover, setHover] = useState<{ label: string; x: number; y: number } | null>(null);
  const lastHover = useRef(0);
  const onPointerDown = (event: React.PointerEvent) => {
    const editor = system?.poseEditor;
    let grabbed = false;
    // Shift + drag pulls her clothes; a plain drag poses her body.
    if (event.button === 0 && event.shiftKey && system) {
      const { x, y } = ndc(event);
      if (system.grabClothAt(x, y)) {
        pointer.current = { x: event.clientX, y: event.clientY, button: event.button, moved: false, grabbed: false, cloth: true };
        (event.target as Element).setPointerCapture?.(event.pointerId);
        return;
      }
    }
    if (event.button === 0 && editor && !gizmos) {
      const { x, y } = ndc(event);
      grabbed = !!editor.beginGrab(x, y);
      if (grabbed) setHover(null);
    }
    pointer.current = { x: event.clientX, y: event.clientY, button: event.button, moved: false, grabbed };
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const p = pointer.current;
    const editor = system?.poseEditor;
    if (!system) return;
    if (!p) {
      // Hover: show which body part a press would grab (throttled raycast).
      if (!editor || gizmos) return;
      const now = performance.now();
      if (now - lastHover.current < 120) return;
      lastHover.current = now;
      const { x, y } = ndc(event);
      const info = editor.partAt(x, y);
      editor.setHover(info);
      const rect = viewport.current!.getBoundingClientRect();
      setHover(info ? { label: info.label, x: event.clientX - rect.left, y: event.clientY - rect.top } : null);
      return;
    }
    if (p.cloth) {
      const { x, y } = ndc(event);
      system.dragClothTo(x, y);
      return;
    }
    const dx = event.clientX - p.x;
    const dy = event.clientY - p.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) p.moved = true;
    if (p.grabbed && editor) {
      const { x, y } = ndc(event);
      editor.dragTo(x, y);
      return;
    }
    if (p.button === 1) system.panBy(-dx * system.worldHeight * 0.0016, dy * system.worldHeight * 0.0016);
    else if (p.button === 2 || p.button === 0) system.orbitBy(dx * 0.008, dy * 0.006);
    p.x = event.clientX;
    p.y = event.clientY;
  };
  const onPointerUp = (event: React.PointerEvent) => {
    const p = pointer.current;
    pointer.current = null;
    if (p?.cloth) {
      system?.releaseCloth();
      return;
    }
    const editor = system?.poseEditor;
    if (p?.grabbed) {
      editor?.endGrab();
      return;
    }
    // Precise mode: a click selects a bone or IK handle for the gizmo.
    if (!p || !editor || !gizmos || p.button !== 0 || p.moved || editor.isDragging) return;
    const { x, y } = ndc(event);
    const handle = editor.pickHandle(x, y);
    if (handle) {
      editor.selectHandle(handle);
      return;
    }
    const bone = editor.pick(x, y);
    if (bone) editor.select(bone);
  };
  const onDoubleClick = (event: React.MouseEvent) => {
    const editor = system?.poseEditor;
    if (!editor) return;
    const { x, y } = ndc(event);
    const info = editor.partAt(x, y);
    if (info) editor.resetBone(info.bone);
  };
  const onWheel = (event: React.WheelEvent) => system?.zoomBy(event.deltaY * 0.01 * (system.worldHeight / 20));

  const active = characters.find((c) => c.id === characterId);
  const isActiveCompanion = settings?.character.activeCharacterId === characterId;
  const tabs: Array<[Tab, string, React.ReactNode]> = [
    ['pose', 'Pose', <PersonStanding key="p" size={14} />],
    ['fingers', 'Fingers', <Hand key="f" size={14} />],
    ['bones', 'Bones', <Layers key="b" size={14} />],
    ['physics', 'Physics', <Wind key="w" size={14} />],
    ['report', 'Report', <ClipboardCheck key="r" size={14} />],
  ];

  const panel = useMemo(() => {
    if (!system?.poseEditor) return <div className="p-4 text-xs text-slate-500">Loading character…</div>;
    switch (tab) {
      case 'pose':
        return <PosePanel system={system} characterId={characterId!} version={version} />;
      case 'fingers':
        return <FingerPanel system={system} version={version} />;
      case 'bones':
        return <BonesPanel system={system} version={version} />;
      case 'physics':
        return (
          <PhysicsPanel
            system={system}
            profile={profile}
            settings={settings}
            onSettings={setSettings}
            onProfile={(p) => setProfile(p)}
            onReload={() => setReloadKey((k) => k + 1)}
          />
        );
      case 'report':
        return (
          <ReportPanel
            system={system}
            characterId={characterId!}
            profile={profile}
            onProfile={(p) => {
              setProfile(p);
              void refreshList();
            }}
            onDeleted={async () => {
              const list = await refreshList();
              setCharacterId(list[0]?.id);
            }}
          />
        );
    }
  }, [system, tab, version, profile, settings, characterId, refreshList]);

  return (
    <div className="fixed inset-0 z-[80] flex bg-slate-950/95 text-slate-200 backdrop-blur">
      {/* character list */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-white/10">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          <Boxes size={16} className="text-cyan-300" />
          <span className="text-sm font-semibold tracking-wide">Character Studio</span>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {characters.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCharacterId(c.id)}
              className={`mb-1 w-full rounded-lg border px-3 py-2 text-left transition ${
                c.id === characterId ? 'border-cyan-400/50 bg-cyan-500/10' : 'border-transparent hover:border-white/10 hover:bg-white/5'
              }`}
            >
              <div className="flex items-center gap-1.5 text-sm">
                {c.displayName}
                {settings?.character.activeCharacterId === c.id && <Star size={11} className="text-amber-300" fill="currentColor" />}
              </div>
              <div className="mt-0.5 text-[10px] uppercase tracking-wider text-slate-500">
                {c.source === 'built-in' ? 'built-in' : 'local import'}
                {c.summary && ` · ${c.summary.supported}✓ ${c.summary.partial ? `${c.summary.partial}⚠ ` : ''}${c.summary.unsupported ? `${c.summary.unsupported}✗` : ''}`}
                {c.summary && (c.summary.testsPassed || c.summary.testsFailed) ? ` · tests ${c.summary.testsPassed}/${c.summary.testsPassed + c.summary.testsFailed}` : ''}
              </div>
            </button>
          ))}
        </div>
        <div className="space-y-2 border-t border-white/10 p-3">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Import local model (.zip / folder / .pmx / .pmd / .vrm / .glb / .fbx / .obj)</div>
          <input
            value={importPath}
            onChange={(e) => setImportPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && doImport()}
            placeholder="C:\Users\…\model.zip"
            className="w-full rounded-md border border-white/10 bg-slate-900 px-2 py-1.5 text-xs outline-none focus:border-cyan-400/50"
          />
          <div className="flex gap-2">
            <button type="button" onClick={browse} className="flex-1 rounded-md border border-white/10 px-2 py-1.5 text-xs hover:bg-white/5">
              Browse…
            </button>
            <button
              type="button"
              disabled={importing || !importPath.trim()}
              onClick={() => doImport()}
              className="flex flex-1 items-center justify-center gap-1 rounded-md bg-cyan-500/20 px-2 py-1.5 text-xs text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-40"
            >
              {importing ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} Import
            </button>
          </div>
          <p className="text-[10px] leading-snug text-slate-500">Imported models stay in your local ABxAG data folder and are never bundled or uploaded.</p>
        </div>
      </aside>

      {/* viewport */}
      <main className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-white/10 px-4 py-2 text-xs">
          <span className="font-medium">{active?.displayName ?? '—'}</span>
          <label className="flex items-center gap-1.5 text-slate-400">
            <input type="checkbox" checked={gizmos} onChange={(e) => setGizmos(e.target.checked)} /> Precise gizmos
          </label>
          <select
            key={characterId}
            onChange={(e) => {
              if (!system) return;
              if (e.target.value === 'full') return system.frameFullBody();
              const [slot, factor] = e.target.value.split('|');
              const bone = system.rig?.humanoid[slot]?.bone ?? null;
              system.stage.clearPan();
              system.setCameraFocus(bone, Number(factor) * system.worldHeight);
            }}
            className="rounded border border-white/10 bg-slate-900 px-1 py-0.5 text-[11px]"
            defaultValue="full"
          >
            <option value="full">View: full body</option>
            <option value="UPPER_CHEST|1.2">View: upper body</option>
            <option value="HEAD|0.55">View: face</option>
            <option value="LEFT_HAND|0.32">View: left hand</option>
            <option value="RIGHT_HAND|0.32">View: right hand</option>
            <option value="LEFT_FOOT|0.6">View: feet</option>
          </select>
          <span className="truncate text-slate-500">
            {gizmos ? 'Click a bone or handle, then drag the gizmo' : 'Drag any body part to pose · double-click resets it'} · WASD orbit · Q/E zoom · R/F up/down · Z/C left/right · Home reset
          </span>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              disabled={!characterId || isActiveCompanion}
              onClick={makeActive}
              className="rounded-md border border-amber-400/40 px-2 py-1 text-amber-200 hover:bg-amber-500/10 disabled:opacity-40"
            >
              {isActiveCompanion ? 'Active character' : 'Use as ABxAG'}
            </button>
            {onClose && (
              <button type="button" onClick={onClose} className="rounded-md p-1 hover:bg-white/10" aria-label="Close studio">
                <X size={16} />
              </button>
            )}
          </div>
        </div>
        <div
          ref={viewport}
          className="relative flex-1"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
          onDoubleClick={onDoubleClick}
          onPointerLeave={() => {
            if (!pointer.current) {
              setHover(null);
              system?.poseEditor?.setHover(null);
            }
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {hover && (
            <div
              className="pointer-events-none absolute z-10 rounded-md border border-cyan-400/30 bg-slate-950/85 px-2 py-1 text-[11px] text-cyan-100 shadow-lg"
              style={{ left: hover.x + 14, top: hover.y + 14 }}
            >
              {hover.label}
            </div>
          )}
          {characterId && (
            <ABxAGCharacter
              clothInteraction={false}
              key={`${characterId}:${reloadKey}`}
              characterId={characterId}
              activity="idle"
              emotion="idle"
              outputAnalyser={null}
              inputAnalyser={null}
              controlsEnabled={false}
              showControlHint={false}
              onSystem={setSystem}
            />
          )}
        </div>
        {message && (
          <div className="absolute bottom-3 left-1/2 max-w-xl -translate-x-1/2 rounded-lg border border-white/10 bg-slate-900/95 px-3 py-2 text-xs text-slate-300 shadow-xl">
            {message}
            <button type="button" className="ml-3 text-slate-500 hover:text-slate-300" onClick={() => setMessage(null)}>
              dismiss
            </button>
          </div>
        )}
      </main>

      {/* panels */}
      <aside className="flex w-[360px] shrink-0 flex-col border-l border-white/10">
        <nav className="flex border-b border-white/10">
          {tabs.map(([id, label, icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] uppercase tracking-wider ${tab === id ? 'bg-white/5 text-cyan-200' : 'text-slate-500 hover:text-slate-300'}`}
            >
              {icon}
              {label}
            </button>
          ))}
        </nav>
        <div className="flex-1 overflow-y-auto">{panel}</div>
      </aside>
    </div>
  );
};

export default CharacterStudio;


