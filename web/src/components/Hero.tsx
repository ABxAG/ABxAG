import { useState } from 'react';
import { Play, Mic, Monitor, Brain, Hand, Zap } from 'lucide-react';

export function Hero() {
  const [isPlaying, setIsPlaying] = useState(false);

  return (
    <section id="home" className="relative min-h-screen flex items-center justify-center overflow-hidden bg-[#0a0a0f]">
      {/* Background Glows */}
      <div className="absolute top-[-10%] left-[-10%] w-[600px] h-[600px] bg-indigo-600/20 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[700px] h-[700px] bg-cyan-600/15 rounded-full blur-[150px] pointer-events-none" />
      <div className="absolute top-[20%] right-[10%] w-[400px] h-[400px] bg-purple-600/10 rounded-full blur-[100px] pointer-events-none" />

      {/* Grid */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.008)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.008)_1px,transparent_1px)] bg-[size:40px_40px] pointer-events-none opacity-30" />

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col lg:flex-row items-center justify-between gap-8">
        <div className="flex-1 max-w-lg animate-slide-in">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-indigo-300 text-xs font-mono tracking-widest mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
            <span>Web Demo v1.0.0</span>
          </div>

          <h1 className="font-display font-bold text-5xl sm:text-6xl text-white leading-tight tracking-tight mb-6">
            Your private<span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-cyan-400"> 3D AI companion</span>
          </h1>

          <p className="text-slate-300 text-lg sm:text-xl leading-relaxed mb-8 max-w-md">
            ABxAG is your personal AI companion for Windows. Talk by voice, see your screen when allowed, control apps and files — all powered by your own Gemini API key. No cloud account. No subscription.
          </p>

          <div className="flex flex-col sm:flex-row gap-4">
            <button
              onClick={() => setIsPlaying(true)}
              className="flex items-center gap-2 px-6 py-3 bg-white text-black font-semibold text-sm tracking-widest hover:bg-gray-200 transition-colors rounded-lg"
            >
              <Play size={18} />
              <span>Try the Web Demo</span>
            </button>
            <a
              href="https://abxag.absup.dev/DownLoad/"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-6 py-3 rounded-lg border border-white/10 bg-white/5 text-sm font-mono tracking-widest text-white hover:bg-white/10 transition-colors"
            >
              <Download size={18} />
              <span>Get the Desktop App</span>
            </a>
          </div>
        </div>

        <div className="flex-1 max-w-lg animate-slide-in" style={{ animationDelay: '0.2s' }}>
          <div className="relative group">
            <div className="absolute inset-0 bg-gradient-to-b from-indigo-500/20 to-cyan-500/10 rounded-3xl border border-white/10 overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_center,_rgba(168,85,247,0.15)_0%,_transparent_70%)]" />
            </div>

            <div className="relative z-10 flex flex-col items-center justify-center p-8 min-h-[300px]">
              <div className="mb-6 flex items-center justify-center gap-2">
                <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                <span className="text-xs font-mono text-cyan-300">LIVE DEMO</span>
              </div>

              <div className="w-32 h-32 rounded-2xl border border-white/10 bg-slate-900/50 flex items-center justify-center relative overflow-hidden">
                <div className="absolute inset-0 bg-[conic-gradient(from_0deg,#8b5cf6_0%,#06b6d4_25%,#8b5cf6_50%,#8b5cf6_75%,#8b5cf6_100%)] opacity-20 animate-[spin_3s_linear_infinite]" />
                <div className="relative z-10">
                  <div className="w-20 h-20 rounded-full bg-indigo-900/80 flex items-center justify-center border border-indigo-500/30 shadow-[0_0_40px_rgba(99,102,241,0.3)]">
                    <span className="text-3xl">👋</span>
                  </div>
                </div>
              </div>

              <div className="mt-6 grid grid-cols-2 gap-4 text-center">
                <div className="p-3 rounded-xl border border-white/5 bg-white/5">
                  <div className="w-8 h-8 rounded-lg bg-cyan-500/10 flex items-center justify-center mb-2">
                    <Mic size={16} className="text-cyan-400" />
                  </div>
                  <div className="text-xs font-mono text-white/60">Voice</div>
                </div>
                <div className="p-3 rounded-xl border border-white/5 bg-white/5">
                  <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center mb-2">
                    <Monitor size={16} className="text-indigo-400" />
                  </div>
                  <div className="text-xs font-mono text-white/60">Vision</div>
                </div>
              </div>

              <div className="mt-6 grid grid-cols-2 gap-4 text-center">
                <div className="p-3 rounded-xl border border-white/5 bg-white/5">
                  <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center mb-2">
                    <Brain size={16} className="text-purple-400" />
                  </div>
                  <div className="text-xs font-mono text-white/60">Memory</div>
                </div>
                <div className="p-3 rounded-xl border border-white/5 bg-white/5">
                  <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center mb-2">
                    <Hand size={16} className="text-emerald-400" />
                  </div>
                  <div className="text-xs font-mono text-white/60">Control</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
