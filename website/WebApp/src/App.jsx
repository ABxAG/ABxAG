import { useState, useEffect, useRef } from 'react';
import {
  Mic, MicOff, Send, ArrowRight, Menu, X, Share2, Download,
  Brain, Eye, ShieldCheck, Layers, Bot, Smartphone, Code2,
  Activity, Wifi, Globe, MessageSquare, Volume2, VolumeX
} from 'lucide-react';
import Navbar from './components/Navbar';
import Hero from './components/Hero';
import ChatInterface from './components/ChatInterface';
import Features from './components/Features';
import DownloadSection from './components/DownloadSection';
import Footer from './components/Footer';

export default function App() {
  const [activePage, setActivePage] = useState('home');
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="min-h-screen flex flex-col selection:bg-abxag-500/30">
      <Navbar activePage={activePage} setActivePage={setActivePage} navOpen={navOpen} setNavOpen={setNavOpen} />
      
      <main className="flex-1 relative overflow-hidden">
        {activePage === 'home' && (
          <>
            <Hero />
            <Features />
            <DownloadSection />
          </>
        )}
        {activePage === 'chat' && <ChatInterface />}
        {activePage === 'about' && <AboutPage />}
        {activePage === 'download' && <DownloadSection />}
      </main>
      
      <Footer />
    </div>
  );
}

function AboutPage() {
  return (
    <div className="max-w-7xl mx-auto px-6 py-12">
      <h1 className="text-4xl font-bold mb-8 text-balance">ABxAG সম্পর্কে</h1>
      <div className="glass-panel p-8 mb-8">
        <h2 className="text-2xl font-bold mb-4">আমাদের লক্ষ্য</h2>
        <p className="text-slate-300 leading-relaxed mb-4">
          ABxAG আপনার ব্যক্তিগত 3D AI ডেস্কটপ কম্প্যানিয়ন। এটি আপনার নিজস্ব Gemini API কী ব্যবহার করে চলে, 
          তাই কোন ক্লাউড অ্যাকাউন্ট বা সাবস্ক্রিপশনের প্রয়োজন নেই।
        </p>
        <div className="grid md:grid-cols-3 gap-6 mt-6">
          <div className="p-4 bg-dark-900/50 rounded-xl">
            <div className="text-abxag-500 mb-2"><Brain size={24} /></div>
            <h3 className="font-semibold mb-2">স্থানীয় প্রসেসিং</h3>
            <p className="text-sm text-slate-400">সব প্রক্রিয়া আপনার কম্পিউটারে চলে, ডাটা বাইরে যায় না।</p>
          </div>
          <div className="p-4 bg-dark-900/50 rounded-xl">
            <div className="text-abxag-500 mb-2"><ShieldCheck size={24} /></div>
            <h3 className="font-semibold mb-2">গোপনীয়তা</h3>
            <p className="text-sm text-slate-400">আপনার ডাটা কখনো সার্ভারে সংরক্ষিত হয় না।</p>
          </div>
          <div className="p-4 bg-dark-900/50 rounded-xl">
            <div className="text-abxag-500 mb-2"><Code2 size={24} /></div>
            <h3 className="font-semibold mb-2">অপেন সোর্স</h3>
            <p className="text-sm text-slate-400">কোড গিটহাবে পাবলিক, যেকোনোારે যাচাই করতে পারেন।</p>
          </div>
        </div>
      </div>
    </div>
  );
}