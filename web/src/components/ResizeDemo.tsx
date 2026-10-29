import { useState } from 'react';

export function ResizeDemo() {
  const [scale, setScale] = useState(1);

  const handleVoiceCommand = (command: string) => {
    const lower = command.toLowerCase();
    if (lower.includes('bigger') || lower.includes('large') || lower.includes('boro')) {
      setScale(Math.min(2.5, scale + 0.25));
    } else if (lower.includes('smaller') || lower.includes('small') || lower.includes('choto')) {
      setScale(Math.max(0.4, scale - 0.25));
    } else if (lower.includes('reset') || lower.includes('normal')) {
      setScale(1);
    }
  };

  return (
    <section id="demo" className="py-20 border-t border-white/5 bg-black/20">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16 animate-slide-in">
          <h2 className="font-display font-bold text-3xl sm:text-4xl text-white mb-4">
            Try Companion Resize
          </h2>
          <p className="text-slate-400 max-w-2xl mx-auto mb-8">
            ABxAG's desktop companion doll can change size via voice or text. Try the commands below or use the slider.
          </p>
          <div className="flex flex-wrap justify-center gap-2 mb-8">
            {['"boro koro" / "make larger"', '"choto koro" / "make smaller"', '"reset size" / "normal size"'].map((cmd, i) => (
              <span key={i} className="px-3 py-1 rounded-full border border-white/10 bg-white/5 text-xs font-mono text-indigo-300">
                {cmd}
              </span>
            ))}
          </div>
        </div>

        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div className="relative group">
            <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/10 to-cyan-500/5 rounded-3xl border border-white/10 overflow-hidden" />
            <div className="relative z-10 p-8 flex items-center justify-center min-h-[400px]">
              <div
                className={`relative w-48 h-80 rounded-3xl border border-white/20 bg-slate-900/60 flex items-center justify-center shadow-[0_0_60px_rgba(168,85,247,0.2)] transition-transform duration-500 ease-out`}
                style={{ transform: `scale(${scale})` }}
              >
                <div className="absolute inset-0 bg-[conic-gradient(from_0deg,#8b5cf6_0%,#06b6d4_25%,#8b5cf6_50%,#8b5cf6_100%)] opacity-10 rounded-3xl blur-[20px]" />
                <div className="z-10 flex flex-col items-center justify-center text-center">
                  <div className="w-16 h-16 rounded-full bg-indigo-900/80 flex items-center justify-center mb-4 border border-indigo-500/30 shadow-[0_0_30px_rgba(99,102,241,0.4)]">
                    <span className="text-4xl">👋</span>
                  </div>
                  <div className="text-xs font-mono text-indigo-300 mb-2">ABxAG Companion</div>
                  <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                    <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${scale * 100}%` }} />
                  </div>
                  <div className="mt-2 text-[10px] font-mono text-slate-500">
                    Scale: {scale.toFixed(2)}×
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="p-6 rounded-2xl border border-white/10 bg-white/5">
              <h3 className="font-bold text-white mb-4">Voice Commands (Bengali/English)</h3>
              <div className="space-y-3">
                {[
                  ['"boro koro"', 'বড় করো', '+0.25 scale'],
                  ['"choto koro"', 'ছোট করো', '-0.25 scale'],
                  ['"reset size"', 'রিসেট সাইজ', 'Reset to 1.0'],
                  ['"size 1.5"', 'সাইজ ১.৫', 'Absolute scale'],
                ].map(([cmd, bn, effect]) => (
                  <div key={cmd} className="flex justify-between items-center p-3 rounded-xl border border-white/5 bg-white/3">
                    <div>
                      <div className="text-sm font-mono text-indigo-300">{cmd}</div>
                      <div className="text-[10px] text-slate-500">{bn}</div>
                    </div>
                    <div className="text-[10px] font-mono text-emerald-400">{effect}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="p-6 rounded-2xl border border-white/10 bg-white/5">
              <h3 className="font-bold text-white mb-4">Interactive Slider</h3>
              <div className="space-y-4">
                <div className="flex justify-between text-xs font-mono text-slate-400">
                  <span>0.4× (Tiny)</span>
                  <span>2.5× (Huge)</span>
                </div>
                <input
                  type="range"
                  min="0.4"
                  max="2.5"
                  step="0.05"
                  value={scale}
                  onChange={(e) => setScale(parseFloat(e.target.value))}
                  className="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                />
                <div className="flex items-center justify-between">
                  <span className="text-sm font-mono text-white">Current Scale:</span>
                  <span className="text-sm font-bold text-indigo-400">{scale.toFixed(2)}×</span>
                </div>
              </div>
            </div>

            <div className="p-6 rounded-2xl border border-white/10 bg-white/5">
              <h3 className="font-bold text-white mb-4">Quick Test</h3>
              <div className="space-y-3">
                {[
                  { label: 'Make Larger', cmd: '"boro koro"', action: () => handleVoiceCommand('bigger') },
                  { label: 'Make Smaller', cmd: '"choto koro"', action: () => handleVoiceCommand('smaller') },
                  { label: 'Reset Size', cmd: '"reset size"', action: () => handleVoiceCommand('reset') },
                ].map((item) => (
                  <button
                    key={item.label}
                    onClick={item.action}
                    className="w-full flex justify-between items-center px-4 py-3 rounded-xl border border-white/10 bg-white/5 text-sm font-mono text-white hover:bg-white/10 transition-colors"
                  >
                    <span>{item.label}</span>
                    <span className="text-[10px] text-indigo-400">{item.cmd}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
