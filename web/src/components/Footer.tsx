export function Footer() {
  return (
    <footer className="border-t border-white/5 bg-black/50 py-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row justify-between items-center gap-6">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-gradient-to-tr from-indigo-500 to-cyan-400 flex items-center justify-center">
            <span className="text-white font-bold text-[10px]">A</span>
          </div>
          <span className="font-display font-bold text-sm tracking-tight text-white">
            AB<span className="text-indigo-400">x</span>AG Web Demo
          </span>
        </div>

        <div className="flex items-center gap-6 text-xs font-mono text-slate-500">
          <a
            href="https://abxag.absup.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-white transition-colors"
          >
            Website
          </a>
          <a
            href="https://abxag.absup.dev/DownLoad/"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-white transition-colors"
          >
            Download
          </a>
          <a
            href="https://abxag.absup.dev/RoadMap/"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-white transition-colors"
          >
            Roadmap
          </a>
          <a
            href="https://github.com/ABxAG/ABxAG"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-white transition-colors"
          >
            GitHub
          </a>
        </div>

        <div className="text-[10px] text-slate-500 font-mono">
          Made with ❤️ by @ABsUP · Powered by your own Gemini API key
        </div>
      </div>
    </footer>
  );
}
