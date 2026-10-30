import { Download, Globe, Smartphone } from 'lucide-react';

export default function DownloadSection() {
  return (
    <section className="py-24 px-6 relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-dark-950/20 to-transparent pointer-events-none" />
      <div className="max-w-5xl mx-auto relative z-10 text-center">
        <h2 className="text-3xl md:text-4xl font-bold mb-6">ডেস্কটপে পূর্ণ অভিজ্ঞতা পান</h2>
        <p className="text-slate-400 text-lg mb-10 max-w-2xl mx-auto">
          ব্রাউজার versionsে সীমিত ফিচার আছে। পূর্ণ PC কন্ট্রোল, 3D কম্প্যানিয়ন, এবং অটো-আপডেট পেতে ডেস্কটপ অ্যাপ ব্যবহার করুন।
        </p>
        <div className="grid md:grid-cols-2 gap-6 max-w-md mx-auto">
          <a
            href="https://abxag.absup.dev/DownLoad/"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary flex items-center justify-center gap-3"
          >
            <Download size={20} />
            <span>ইনস্টলার ডাউনলোড (Windows)</span>
          </a>
          <a
            href="https://abxag.absup.dev/DownLoad/"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary flex items-center justify-center gap-3"
          >
            <Smartphone size={20} />
            <span>পোর্টেবল ভెర্সন</span>
          </a>
        </div>
        <div className="mt-8 flex items-center justify-center gap-3 text-sm text-slate-500">
          <Globe size={16} />
          <span>ওয়েবসাইট: <a href="https://abxag.absup.dev" className="text-abxag-400 hover:underline">abxag.absup.dev</a></span>
        </div>
      </div>
    </section>
  );
}