import { Bot, Smartphone, Code2, ShieldCheck, Globe } from 'lucide-react';
import { useState } from 'react';

export default function Hero() {
  const [isTyping, setIsTyping] = useState(false);
  const typingText = "আপনার ব্যক্তিগত AI কম্প্যানিয়ন - এখন ব্রাউজারে!";
  const [displayText, setDisplayText] = useState('');

  useEffect(() => {
    let i = 0;
    const timer = setInterval(() => {
      setDisplayText(typingText.slice(0, i));
      i++;
      if (i > typingText.length) clearInterval(timer);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return (
    <section className="relative pt-20 pb-24 px-6 overflow-hidden">
      <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')] opacity-5 pointer-events-none" />
      
      <div className="max-w-7xl mx-auto relative z-10 grid lg:grid-cols-2 gap-12 items-center">
        <div className="space-y-8">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-abxag-500/10 border border-abxag-500/20 text-abxag-400 text-sm font-medium">
            <Globe size={16} />
            <span>এখন ব্রাউজারে চালু!</span>
          </div>
          <h1 className="text-5xl md:text-7xl font-bold leading-tight text-balance">
            আপনার <span className="text-transparent bg-clip-text bg-gradient-to-r from-abxag-400 to-cyan-400">ব্যক্তিগত</span> <br />
            AI কম্প্যানিয়ন
          </h1>
          <p className="text-xl text-slate-400 max-w-lg">
            ব্রাউজার থেকে কথা বলুন, বুঝুন, কাজ করুন। 
            <span className="text-abxag-400">কোনো ইনস্টলেশন ছাড়াই, নিজস্ব Gemini কী সহ।</span>
          </p>
          
          <div className="flex flex-col sm:flex-row gap-4">
            <button className="btn-primary flex items-center justify-center gap-2">
              <Bot size={20} />
              চ্যাট শুরু করুন
            </button>
            <button className="btn-secondary flex items-center justify-center gap-2">
              <Smartphone size={20} />
              ডেস্কটপ অ্যাপ ডাউনলোড
            </button>
          </div>

          <div className="grid md:grid-cols-3 gap-4 pt-4">
            <div className="p-4 bg-dark-900/50 border border-white/5 rounded-xl">
              <div className="text-abxag-500 mb-2"><Bot size={20} /></div>
              <h4 className="font-semibold">লোকাল প্রসেসিং</h4>
              <p className="text-xs text-slate-400">আপনার ডিভাইসে চলে</p>
            </div>
            <div className="p-4 bg-dark-900/50 border border-white/5 rounded-xl">
              <div className="text-abxag-500 mb-2"><ShieldCheck size={20} /></div>
              <h4 className="font-semibold">গোপনীয়তা</h4>
              <p className="text-xs text-slate-400">কোনো ডাটা শেয়ার নয়</p>
            </div>
            <div className="p-4 bg-dark-900/50 border border-white/5 rounded-xl">
              <div className="text-abxag-500 mb-2"><Code2 size={20} /></div>
              <h4 className="font-semibold">অপেন সোর্স</h4>
              <p className="text-xs text-slate-400">গিটহাবে পাবলিক</p>
            </div>
          </div>
        </div>

        <div className="relative flex justify-center">
          <div className="relative w-full max-w-md">
            <div className="absolute -inset-1 bg-gradient-to-r from-abxag-500 to-cyan-500 rounded-2xl blur opacity-20 animate-pulse" />
            <div className="glass-panel p-6 relative">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-abxag-500 flex items-center justify-center">
                  <Bot size={24} fill="white" />
                </div>
                <div>
                  <div className="text-sm font-medium text-white">ABxAG</div>
                  <div className="text-xs text-abxag-400">অনলাইন •sprachEN</div>
                </div>
              </div>
              <div className="h-48 overflow-y-auto pr-2 mb-4 space-y-3">
                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-dark-800 flex items-center justify-center shrink-0">
                    <Bot size={16} fill="white" />
                  </div>
                  <div className="bg-dark-900 p-3 rounded-2xl text-sm text-slate-200 border border-white/10 rounded-tr-none">
                    হ্যালো! আমি ABxAG। আপনি কীভাবে শুরু করছেন?
                  </div>
                </div>
                <div className="flex gap-3 justify-end">
                  <div className="bg-abxag-600 p-3 rounded-2xl text-sm text-white rounded-tl-none">
                    আমি ব্রাউজারে কাজ করি, ডেস্কটপের ন cercana।
                  </div>
                </div>
                {displayText && (
                  <div className="flex gap-3 justify-end animate-pulse">
                    <span className="text-abxag-500 text-sm animate-pulse">{displayText}…</span>
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="কিছু লিখুন..."
                  className="input-field flex-1"
                />
                <button className="bg-abxag-500 p-3 rounded-xl hover:bg-abxag-600 text-white">
                  <ArrowRight size={20} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}