import { useState } from 'react';
import { Menu, X, Download, GitHub, ExternalLink } from 'lucide-react';

export function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false);

  const navLinks = [
    { name: 'Home', href: '#home' },
    { name: 'Features', href: '#features' },
    { name: 'Demo', href: '#demo' },
    { name: 'Download', href: '#download' },
  ];

  return (
    <nav className="fixed top-0 w-full z-50 border-b border-white/5 bg-black/40 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded bg-gradient-to-tr from-indigo-500 to-cyan-400 flex items-center justify-center">
              <span className="text-white font-bold text-xs">A</span>
            </div>
            <span className="font-display font-bold text-xl tracking-tight text-white">
              AB<span className="text-indigo-400">x</span>AG
            </span>
          </div>

          <div className="hidden lg:flex items-center gap-8">
            {navLinks.map((link) => (
              <a
                key={link.name}
                href={link.href}
                className="text-xs font-mono tracking-widest text-white/40 hover:text-white transition-colors"
              >
                {link.name}
              </a>
            ))}
            <a
              href="https://github.com/ABxAG/ABxAG"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs font-mono tracking-widest text-white/40 hover:text-white transition-colors"
            >
              <GitHub size={14} />
              <span>GitHub</span>
            </a>
          </div>

          <div className="flex items-center gap-3">
            <a
              href="https://abxag.absup.dev/DownLoad/"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-xs font-mono text-white hover:bg-white/10 transition-colors"
            >
              <Download size={14} />
              <span>Download</span>
            </a>
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="lg:hidden p-2 text-white/40 hover:text-white"
            >
              {menuOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>
      </div>

      {menuOpen && (
        <div className="lg:hidden border-t border-white/5 bg-black/90 backdrop-blur-md">
          <div className="max-w-7xl mx-auto px-4 py-4 space-y-2">
            {navLinks.map((link) => (
              <a
                key={link.name}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className="block px-3 py-2 text-xs font-mono tracking-widest text-white/40 hover:bg-white/5 hover:text-white rounded-lg transition-colors"
              >
                {link.name}
              </a>
            ))}
            <a
              href="https://github.com/ABxAG/ABxAG"
              target="_blank"
              rel="noopener noreferrer"
              className="block px-3 py-2 text-xs font-mono tracking-widest text-white/40 hover:bg-white/5 hover:text-white rounded-lg transition-colors"
            >
              <GitHub size={16} /> GitHub
            </a>
            <a
              href="https://abxag.absup.dev/DownLoad/"
              target="_blank"
              rel="noopener noreferrer"
              className="block px-3 py-2 text-xs font-mono tracking-widest text-white/40 hover:bg-white/5 hover:text-white rounded-lg transition-colors"
            >
              <Download size={16} /> Download
            </a>
          </div>
        </div>
      )}
    </nav>
  );
}
