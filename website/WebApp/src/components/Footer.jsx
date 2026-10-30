import { Globe, Github, Code2, Bot } from 'lucide-react';

export default function Footer() {
  return (
    <footer className="border-t border-white/10 bg-dark-950 pt-12 pb-8">
      <div className="max-w-7xl mx-auto px-6">
        <div className="flex flex-col md:flex-row justify-between items-center mb-10 gap-6">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-abxag-500 rounded flex items-center justify-center">
              <Bot size={16} fill="white" stroke="none" />
            </div>
            <span className="font-bold text-lg tracking-tight">AB<span className="text-abxag-500">x</span>AG</span>
          </div>
          <div className="flex gap-4">
            <a href="https://github.com/ABxAG/ABxAG" target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-white transition-colors">
              <Github size={20} />
            </a>
            <a href="https://abxag.absup.dev" target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-white transition-colors">
              <Globe size={20} />
            </a>
          </div>
        </div>
        <div className="grid md:grid-cols-4 gap-8 mb-10">
          <div>
            <h4 className="font-semibold mb-4">পণ্য</h4>
            <ul className="space-y-2 text-sm text-slate-400">
              <li><a href="#" className="hover:text-white transition-colors">ডেস্কটপ অ্যাপ</a></li>
              <li><a href="#" className="hover:text-white transition-colors">ওয়েব অ্যাপ</a></li>
              <li><a href="#" className="hover:text-white transition-colors">ডাউনলোড</a></li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold mb-4">সমর্থন</h4>
            <ul className="space-y-2 text-sm text-slate-400">
              <li><a href="#" className="hover:text-white transition-colors">ডকুমেন্টেশন</a></li>
              <li><a href="#" className="hover:text-white transition-colors">ইস্যু রিপোর্ট</a></li>
              <li><a href="#" className="hover:text-white transition-colors">ফিডব্যাক</a></li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold mb-4">কমিউনিটি</h4>
            <ul className="space-y-2 text-sm text-slate-400">
              <li><a href="#" className="hover:text-white transition-colors">গITHUB ডিসকাশন</a></li>
              <li><a href="#" className="hover:text-white transition-colors">টুইটার</a></li>
              <li><a href="#" className="hover:text-white transition-colors">টেলগ্রাম</a></li>
            </ul>
          </div>
        </div>
        <div className="border-t border-white/10 pt-8 text-center text-xs text-slate-500">
          <p>
            © {new Date().getFullYear()} ABxAG. বানানো হয়েছে <span className="text-abxag-500">❤️</span> নিরpekTon প্রاهم্য সাথে।
          </p>
        </div>
      </div>
    </footer>
  );
}