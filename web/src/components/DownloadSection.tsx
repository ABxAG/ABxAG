import { Download, ExternalLink, GitHub, Windows, Play } from 'lucide-react';

export function DownloadSection() {
  return (
    <section id="download" className="py-20 border-t border-white/5 bg-black/40 relative overflow-hidden">
      {/* Background glow */}
      <div className="absolute top-[-10%] left-[-10%] w-[600px] h-[600px] bg-indigo-600/20 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[700px] h-[700px] bg-cyan-600/15 rounded-full blur-[150px] pointer-events-none" />
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.008)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.008)_1px,transparent_1px)] bg-[size:40px_40px] pointer-events-none opacity-30" />

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16 animate-slide-in">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-indigo-300 text-xs font-mono tracking-widest mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
            <span>Latest: v1.1.29</span>
          </div>
          <h2 className="font-display font-bold text-3xl sm:text-4xl text-white mb-4">
            Ready to meet ABxAG?
          </h2>
          <p className="text-slate-400 max-w-2xl mx-auto mb-8">
            Download the Windows desktop app and bring your own Gemini API key. No cloud account. No subscription.
          </p>
        </div>

        <div className="grid lg:grid-cols-2 gap-8 items-center">
          <div className="animate-slide-in" style={{ animationDelay: '0.1s' }}>
            <div className="space-y-6">
              <div className="flex items-center justify-between p-6 rounded-2xl border border-white/10 bg-white/5">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <Windows size={20} className="text-blue-400" />
                    <span className="text-xs font-mono text-indigo-400 font-bold uppercase">Windows</span>
                  </div>
                  <h3 className="font-bold text-xl text-white">ABxAG Setup</h3>
                  <p className="text-sm text-slate-400">Installer with auto-updates and differential patches</p>
                </div>
                <a
                  href="https://github.com/ABxAG/ABxAG/releases/latest"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white text-black font-semibold text-sm tracking-widest hover:bg-gray-200 transition-colors"
                >
                  <Download size={16} />
                  <span>Download Setup (.exe)</span>
                </a>
              </div>

              <div className="flex items-center justify-between p-6 rounded-2xl border border-white/10 bg-white/5">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-6 h-6 rounded bg-gradient-to-br from-gray-600 to-gray-800 flex items-center justify-center border border-white/10">
                      <span className="text-[10px] font-bold text-white">P</span>
                    </div>
                    <span className="text-xs font-mono text-indigo-400 font-bold uppercase">Windows</span>
                  </div>
                  <h3 className="font-bold text-xl text-white">ABxAG Portable</h3>
                  <p className="text-sm text-slate-400">Single file, no installation required</p>
                </div>
                <a
                  href="https://github.com/ABxAG/ABxAG/releases/latest"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white text-black font-semibold text-sm tracking-widest hover:bg-gray-200 transition-colors"
                >
                  <Download size={16} />
                  <span>Download Portable</span>
                </a>
              </div>

              <div className="p-6 rounded-2xl border border-white/10 bg-white/5">
                <h4 className="font-bold text-white mb-2">Quick Start</h4>
                <ol className="list-decimal list-inside text-sm text-slate-400 space-y-2 font-mono">
                  <li>Install and launch ABxAG</li>
                  <li>Paste your free Gemini API key (stored encrypted on your PC)</li>
                  <li>Import your 3D character model</li>
                  <li>Say "Hey AB"</li>
                </ol>
              </div>
            </div>
          </div>

          <div className="relative animate-slide-in" style={{ animationDelay: '0.2s' }}>
            <div className="relative group">
              <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/20 to-cyan-500/10 rounded-3xl border border-white/10 overflow-hidden" />
              <div className="relative z-10 p-8 flex flex-col items-center justify-center min-h-[300px]">
                <div className="w-32 h-32 rounded-full bg-indigo-900/80 flex items-center justify-center mb-6 border border-indigo-500/30 shadow-[0_0_50px_rgba(99,102,241,0.4)] relative z-10">
                  <span className="text-5xl">🤖</span>
                </div>
                <div className="text-center space-y-4">
                  <h3 className="font-bold text-xl text-white">Get a Free Gemini Key</h3>
                  <p className="text-sm text-slate-400 max-w-md">
                    ABxAG uses your own Gemini API key from Google AI Studio. It's free and never leaves your computer.
                  </p>
                  <a
                    href="https://aistudio.google.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 px-6 py-3 rounded-xl border border-white/10 bg-white/5 text-xs font-mono tracking-widest text-white hover:bg-white/10 transition-colors"
                  >
                    <ExternalLink size={16} />
                    <span>Get Gemini API Key</span>
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-16 border-t border-white/10 pt-8 flex flex-col sm:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-2 text-xs font-mono text-slate-500">
            <span>ABxAG v1.1.29</span>
            <span>•</span>
            <span>Private • Local-First • Windows 10/11</span>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/ABxAG/ABxAG"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs font-mono tracking-widest text-white/40 hover:text-white transition-colors"
            >
              <GitHub size={16} />
              <span>View on GitHub</span>
            </a>
            <a
              href="https://abxag.absup.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs font-mono tracking-widest text-white/40 hover:text-white transition-colors"
            >
              <ExternalLink size={16} />
              <span>Official Website</span>
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
