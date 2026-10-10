/**
 * Character autonomy: she changes her own look when long idle.
 *
 * Conservative by design — a switch only happens when ALL hold:
 *   - at least 2 characters exist (built-in counts),
 *   - 45+ minutes since the last pointer/key/voice interaction,
 *   - 6+ hours since the last automatic switch,
 *   - fewer than 2 automatic switches today,
 *   - the tab is visible and the host says now is a good moment
 *     (no voice session, no task, no open panel).
 *
 * The host applies the switch (and persists it); this hook only decides.
 */
import { useEffect, useRef } from "react";
import { listAllCharacters } from "../character/config/registry";

const STORE_KEY = "abxag:auto-switch";
const IDLE_MIN = 45;
const MIN_GAP_HOURS = 6;
const MAX_PER_DAY = 2;
const CHECK_MS = 60_000;

interface AutoSwitchRecord {
  date: string; // YYYY-MM-DD
  count: number;
  lastAt: number;
}

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function readRecord(): AutoSwitchRecord {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AutoSwitchRecord>;
      if (parsed.date === todayLocal()) {
        return { date: parsed.date, count: Number(parsed.count) || 0, lastAt: Number(parsed.lastAt) || 0 };
      }
    }
  } catch {
    /* corrupted or unavailable storage */
  }
  return { date: todayLocal(), count: 0, lastAt: 0 };
}

function writeRecord(record: AutoSwitchRecord): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(record));
  } catch {
    /* private mode etc. */
  }
}

export function useCharacterAutonomy(options: {
  enabled: boolean;
  currentId: string | undefined;
  /** False while voice is live, a task runs, or any panel/modal is open. */
  canSwitchNow: () => boolean;
  onSwitch: (id: string) => void;
}): void {
  const lastActivity = useRef<number>(Date.now());
  const optsRef = useRef(options);
  optsRef.current = options;

  // Any interaction resets the idle clock.
  useEffect(() => {
    if (!options.enabled) return;
    const poke = () => { lastActivity.current = Date.now(); };
    window.addEventListener("pointerdown", poke, { passive: true });
    window.addEventListener("keydown", poke);
    return () => {
      window.removeEventListener("pointerdown", poke);
      window.removeEventListener("keydown", poke);
    };
  }, [options.enabled]);

  useEffect(() => {
    if (!options.enabled) return;
    const timer = setInterval(() => {
      const opts = optsRef.current;
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastActivity.current < IDLE_MIN * 60_000) return;
      if (!opts.canSwitchNow()) return;
      const record = readRecord();
      if (record.count >= MAX_PER_DAY) return;
      if (Date.now() - record.lastAt < MIN_GAP_HOURS * 3_600_000) return;
      void listAllCharacters().then((all) => {
        if (all.length < 2) return;
        const others = all.filter((c) => c.id !== opts.currentId);
        const pool = others.length > 0 ? others : all;
        const pick = pool[Math.floor(Math.random() * pool.length)];
        if (!pick || pick.id === opts.currentId) return;
        writeRecord({ date: todayLocal(), count: record.count + 1, lastAt: Date.now() });
        lastActivity.current = Date.now();
        opts.onSwitch(pick.id);
      }).catch(() => undefined);
    }, CHECK_MS);
    return () => clearInterval(timer);
  }, [options.enabled]);
}
