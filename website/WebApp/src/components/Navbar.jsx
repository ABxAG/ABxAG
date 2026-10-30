import { useState } from 'react';
import { Menu, X, Bot, Download, Globe, MessageSquare, Layers } from 'lucide-react';

export default function Navbar({ activePage, setActivePage, navOpen, setNavOpen }) {
  const [scrolled, setScrolled] = useState(false);

  const handleScroll = () => {
    setScrolled(window.scrollY > 20);
  };

  useEffect(() => {
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const navItems = [
    { label: 'হোম', icon: <Globe size={18} />, page: 'home', onClick: () => setActivePage('home') },
    { label: 'চ্যাট', icon: <MessageSquare size={18} />, page: 'chat', onClick: () => setActivePage('chat') },
    { label: 'ফিচার', icon: <Layers size={18} />, page: 'features', onClick: () => setActivePage('features') },
    { label: 'ডাউনলোড', icon: <Download size={18} />, page: 'download', onClick: () => setActivePage('download') },
  ];

  return (
    <nav className={`fixed top-0 w-full z-50 transition-all duration-300 ${scrolled ? 'bg-dark-950/90 border-b border-white/5' : 'bg-transparent'}`}>
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2 cursor-pointer" onClick={() => setActivePage('home')}>
          <div className="w-8 h-8 bg-abxag-500 rounded-lg flex items-center justify-center shadow-abxag-500/30">
            <Bot size={20} fill="white" stroke="none" />
          </div>
          <span className="font-bold text-xl tracking-tight">AB<span className="text-abxag-500">x</span>AG</span>
        </div>

        <div className="hidden md:flex items-center gap-6">
          {navItems.map((item) => (
            <button
              key={item.page}
              onClick={() => { item.onClick(); setNavOpen(false); }}
              className={`flex items-center gap-2 text-sm font-medium transition-colors ${
                activePage === item.page
                  ? 'text-abxag-500'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => window.location.href = 'https://abxag.absup.dev/DownLoad/'}
            className="btn-secondary hidden md:block"
          >
            ডাউনলোড
          </button>
          <button
            className="md:hidden p-2 text-slate-400 hover:text-white"
            onClick={() => setNavOpen(!navOpen)}
          >
            {navOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </div>

      {navOpen && (
        <div className="md:hidden absolute top-16 left-0 w-full bg-dark-950 border-b border-white/10 p-6 space-y-4 animate-in fade-in slide-down-from-top-2 duration-200">
          {navItems.map((item) => (
            <button
              key={item.page}
              onClick={() => { item.onClick(); setNavOpen(false); }}
              className="w-full text-left px-4 py-3 text-lg font-medium bg-dark-900/50 rounded-xl hover:bg-white/10 transition-colors"
            >
              {item.label}
            </button>
          ))}
          <button
            onClick={() => { window.location.href = 'https://abxag.absup.dev/DownLoad/'; setNavOpen(false); }}
            className="w-full btn-primary"
          >
            ডাউনলোড করুন
          </button>
        </div>
      )}
    </nav>
  );
}