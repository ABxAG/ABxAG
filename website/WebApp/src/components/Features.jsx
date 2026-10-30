import { Brain, Eye, ShieldCheck, MessageSquare, Layers, Bot, Zap } from 'lucide-react';

const features = [
  {
    icon: <Brain className="text-abxag-500" />,
    title: 'ভয়েস কথোপকথন',
    desc: 'ব্রাউজার থেকে কথা বলুন, রিয়েল-টাইমে উত্তর পান।',
  },
  {
    icon: <Eye className="text-abxag-500" />,
    title: 'স্ক্রিন ভিশন',
    desc: 'আপনার স্ক্রিনের কন্টেন্ট বুঝতে এবং বিশ্লেষণ করতে পারে।',
  },
  {
    icon: <ShieldCheck className="text-abxag-500" />,
    title: 'গোপনীয়তা',
    desc: 'আপনার Gemini কী এনক্রিপ্টেড রাখা হয়, কখনো শেয়ার হয় না।',
  },
  {
    icon: <MessageSquare className="text-abxag-500" />,
    title: 'চ্যাট ইন্টারফেস',
    desc: 'সহজ ও সুন্দর চ্যাট ইন্টারফেস ব্যবহার করুন।',
  },
  {
    icon: <Layers className="text-abxag-500" />,
    title: '৩D ক্যারেক্টার',
    desc: 'আপনার পছন্দের 3D মডেল امپোর্ট করুন।',
  },
  {
    icon: <Zap className="text-abxag-500" />,
    title: 'দ্রুত ও হালকা',
    desc: 'ব্রাউজারে অস্থায়ী, ডেস্কটপে পূর্ণ গতিতে।',
  },
];

export default function Features() {
  return (
    <section className="py-24 px-6 bg-dark-900/30">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">ABxAG কী করে?</h2>
          <p className="text-slate-400 max-w-2xl mx-auto">ব্রাউজার versionsে কিছু ফিচার সীমিত, ডেস্কটপে পূর্ণ।</p>
        </div>
        <div className="grid md:grid-cols-3 gap-6">
          {features.map((feature, i) => (
            <div key={i} className="glass-panel p-6 hover:border-abxag-500/30 transition-colors group">
              <div className="w-12 h-12 bg-dark-900 rounded-lg flex items-center justify-center mb-4 group-hover:bg-abxag-500/20 transition-colors">
                {feature.icon}
              </div>
              <h3 className="text-lg font-bold mb-2">{feature.title}</h3>
              <p className="text-sm text-slate-400 leading-relaxed">{feature.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}