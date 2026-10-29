import { Navbar } from './components/Navbar';
import { Hero } from './components/Hero';
import { FeatureCard } from './components/FeatureCard';
import { ResizeDemo } from './components/ResizeDemo';
import { VoiceDemo } from './components/VoiceDemo';
import { DownloadSection } from './components/DownloadSection';
import { Footer } from './components/Footer';

export default function App() {
  return (
    <div className="bg-black text-white selection:bg-indigo-500/30 selection:text-white">
      <Navbar />
      <Hero />
      <FeatureCard />
      <ResizeDemo />
      <VoiceDemo />
      <DownloadSection />
      <Footer />
    </div>
  );
}
