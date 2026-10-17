/**
 * Audible alert for a ringing alarm, independent of any voice session.
 *
 * The voice pipeline only speaks when a live session is connected, and the OS
 * notification is silent whenever Windows notification sounds are off — which
 * left alarms firing with no sound at all. This plays a chime through WebAudio
 * (no asset, no volume surprises), announces the reminder with the browser's
 * speech synthesis, and asks the Electron shell to raise attention so a hidden
 * or minimised window still gets noticed.
 *
 * Chromium throttles timers in a hidden window, so the chime is scheduled from
 * the moment the event arrives rather than from a countdown.
 */

const MUTE_KEY = "abxag.alarm.muted";

let context: AudioContext | null = null;
let activeNodes: OscillatorNode[] = [];
let playing = false;

export function isAlarmMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAlarmMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    /* storage unavailable - the setting just will not persist */
  }
}

/** Whether a chime is currently sounding (used to avoid stacking repeats). */
export function isAlarmSoundPlaying(): boolean {
  return playing;
}

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!context) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      context = new Ctor();
    }
    // Autoplay policy: a window the user has interacted with resumes fine, but
    // an alarm can be the first sound after a cold start, so never throw.
    if (context.state === "suspended") void context.resume().catch(() => {});
    return context;
  } catch {
    return null;
  }
}

/** Stop a chime that is still ringing (used when the alarm is acknowledged). */
export function stopAlarmSound(): void {
  playing = false;
  for (const node of activeNodes) {
    try {
      node.stop();
    } catch {
      /* already stopped */
    }
  }
  activeNodes = [];
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* speech synthesis not supported */
  }
}

/**
 * Ring: a short rising chime played three times, then say what the reminder is.
 * Returns false when nothing could be played (muted, or no audio here).
 */
export function startAlarmSound(label = "alarm", options?: { speak?: boolean; repeat?: number }): boolean {
  const speak = options?.speak ?? true;
  const repeat = options?.repeat ?? 3;
  if (isAlarmMuted()) return false;
  stopAlarmSound();

  const ctx = audioContext();
  let sounded = false;
  if (ctx && repeat > 0) {
    const now = ctx.currentTime;
    // Rising third, twice per repeat: reads as "attention", not a click.
    const notes = [880, 1174.66];
    for (let pass = 0; pass < repeat; pass++) {
      const at = now + pass * 0.7;
      notes.forEach((freq, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        const start = at + index * 0.18;
        // Short attack/decay envelope; a bare oscillator clicks.
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.32);
        activeNodes.push(osc);
      });
    }
    playing = true;
    sounded = true;
  }

  if (speak) speakLabel(label);
  return sounded;
}

function speakLabel(label: string): void {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const utterance = new SpeechSynthesisUtterance(`Your reminder: ${label}`);
    utterance.rate = 1.05;
    utterance.volume = 1;
    synth.speak(utterance);
  } catch {
    /* no speech engine installed */
  }
}

/**
 * Make a hidden or minimised window impossible to ignore: flash the taskbar
 * button and pull the window forward. A no-op in the browser (dev in a tab).
 */
export function raiseShellForAlarm(): void {
  try {
    const bridge = (window as unknown as { abxag?: { alarm?: { raise?: () => void } } }).abxag;
    bridge?.alarm?.raise?.();
  } catch {
    /* not running inside Electron */
  }
  try {
    window.dispatchEvent(new CustomEvent("abxag:alarm-raise"));
  } catch {
    /* headless test env */
  }
}

/**
 * Announce alarms that were already ringing when we connected.
 *
 * The runtime publishes `utility.fired` at startup, which usually beats the
 * renderer's socket, so a reminder that came due while ABxAG was closed (or
 * while the window was not listening) is re-seeded from GET /api/utilities
 * instead. Those need the same attention as a fresh ring: sound plus a raised
 * window, once per alarm.
 */
export function reportPendingAlarms(
  alarms: ReadonlyArray<{ id: string; label: string; kind?: string; missed?: boolean }>,
  options?: { speak?: boolean },
): number {
  if (!alarms.length) return 0;
  const list = [...alarms];
  raiseShellForAlarm();
  // Sound every alarm, but speak them as one announcement so several overdue
  // reminders do not talk over each other.
  list.forEach((alarm, index) => startAlarmSound(alarm.label, { speak: index === 0, ...options }));
  return list.length;
}