/**
 * Last line of defence for the renderer: an uncaught error while rendering
 * would unmount the whole interface and leave an empty dark window. Instead
 * the error is reported and the page reloads itself (at most 3 times in two
 * minutes, so a page that fails on load cannot spin).
 */
import React from 'react';

const KEY = 'abxag:crash-reloads';
const Base = (React as unknown as { Component: new (props: unknown) => { props: { children?: unknown }; state: { failed: boolean }; setState(s: { failed: boolean }): void } }).Component;

function recentReloads(): number[] {
  try {
    const now = Date.now();
    return (JSON.parse(sessionStorage.getItem(KEY) || '[]') as number[]).filter((at) => now - at < 120_000);
  } catch {
    return [];
  }
}

export class CrashGuard extends Base {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error('[ABxAG] interface crashed:', error instanceof Error ? error.stack || error.message : String(error));
    const reloads = recentReloads();
    if (reloads.length >= 3) return;
    try {
      sessionStorage.setItem(KEY, JSON.stringify([...reloads, Date.now()]));
    } catch {
      /* storage unavailable */
    }
    window.setTimeout(() => window.location.reload(), 1_500);
  }

  render(): unknown {
    if (!this.state.failed) return this.props.children;
    return (
      <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0f', color: '#cbd5e1', fontFamily: 'system-ui, sans-serif', fontSize: 14, flexDirection: 'column', gap: 12 }}>
        <div>ABxAG hit a problem and is reloading…</div>
        <button type="button" onClick={() => window.location.reload()} style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid #334155', background: '#111827', color: '#e2e8f0', cursor: 'pointer' }}>
          Reload now
        </button>
      </div>
    );
  }
}

