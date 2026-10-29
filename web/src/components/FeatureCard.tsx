import { MotionDiv } from 'motion/react';
import { Mic, Monitor, Brain, Hand, Shield, Download as DownloadIcon } from 'lucide-react';

const features = [
  {
    id: 'voice',
    title: 'Voice Conversation',
    icon: <Mic size={20} className="text-cyan-400" />,
    iconBg: 'bg-cyan-500/10',
    color: 'cyan',
    desc: 'Talk naturally with Gemini Live. "Hey AB" wake word, reminders, alarms, and quiet hours — hands-free.',
  },
  {
    id: 'vision',
    title: 'Screen Vision',
    icon: <Monitor size={20} className="text-indigo-400" />,
    iconBg: 'bg-indigo-500/10',
    color: 'indigo',
    desc: 'With your permission, ABxAG sees your screen — OCR, vision, and screen analysis for real-time help.',
  },
  {
    id: 'memory',
    title: 'Memory & Mind',
    icon: <Brain size={20} className="text-purple-400" />,
    iconBg: 'bg-purple-500/10',
    color: 'purple',
    desc: 'Episodic memory, goals, learned skills, curiosity and presence — all processed locally on your PC.',
  },
  {
    id: 'control',
    title: 'PC Control',
    icon: <Hand size={20} className="text-emerald-400" />,
    iconBg: 'bg-emerald-500/10',
    color: 'emerald',
    desc: '96 local tools to control apps, files, mouse, keyboard, browser and clipboard — with confirmations.',
  },
  {
    id: 'safety',
    title: 'Safety First',
    icon: <Shield size={20} className="text-rose-400" />,
    iconBg: 'bg-rose-500/10',
    color: 'rose',
    desc: 'Your Gemini key is encrypted with Windows DPAPI. High-risk actions require confirmation. Emergency stop anytime.',
  },
  {
    id: 'download',
    title: 'Desktop App',
    icon: <DownloadIcon size={20} className="text-amber-400" />,
    iconBg: 'bg-amber-500/10',
    color: 'amber',
    desc: 'Windows Setup & Portable builds with auto-updates. Install once, stay current forever.',
  },
];

export function FeatureCard() {
  return (
    <section id="features" className="py-20 bg-black/30 border-t border-white/5">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16 animate-slide-in">
          <h2 className="font-display font-bold text-3xl sm:text-4xl text-white mb-4">
            Everything ABxAG can do
          </h2>
          <p className="text-slate-400 max-w-2xl mx-auto">
            A complete AI co-pilot for your desktop — voice, vision, memory, and control in one private package.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {features.map((feature) => (
            <div
              key={feature.id}
              className="group relative p-6 rounded-2xl border border-white/5 bg-white/5 hover:bg-white/10 hover:border-white/10 transition-all duration-300 animate-slide-in"
              style={{ animationDelay: `${features.indexOf(feature) * 0.1}s` }}
            >
              <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300 {feature.iconBg}">
                {feature.icon}
              </div>
              <h3 className="font-bold text-lg text-white mb-2">{feature.title}</h3>
              <p className="text-sm text-slate-400 leading-relaxed">{feature.desc}</p>
              <div className="mt-6 pt-4 border-t border-white/5 flex items-center gap-1">
                <span className="text-[10px] font-mono text-{feature.color}-400 font-bold tracking-wider uppercase">
                  {feature.color}
                </span>
                <div className="h-px flex-1 bg-white/5" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
