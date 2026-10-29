import { useState } from 'react';
import { Mic, MicOff, Send, ArrowRight, Mic as MicIcon } from 'lucide-react';

const exampleConversations = [
  { user: "Hey AB, what's on my screen?", abxag: "I can see your screen! You have three browser tabs open — GitHub, YouTube, and a documentation page. Would you like me to help with any of them?" },
  { user: "Change your background to crimson", abxag: "Shifted my aesthetic atmosphere to crimson. How does it look?" },
  { user: "Set a reminder for 3 PM tomorrow", abxag: "Reminder set for tomorrow at 3:00 PM. I'll notify you when it's time." },
  { user: "Search for Python tutorials on YouTube", abxag: "Opening YouTube and searching for Python tutorials. Found several great results — which one would you like me to play?" },
];

export function VoiceDemo() {
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [conversationIndex, setConversationIndex] = useState(0);
  const [userInput, setUserInput] = useState('');

  const nextConversation = () => {
    setConversationIndex((prev) => (prev + 1) % exampleConversations.length);
  };

  const simulateConversation = () => {
    setIsListening(true);
    setTimeout(() => {
      setIsListening(false);
      setIsSpeaking(true);
      setTimeout(() => {
        setIsSpeaking(false);
        setTimeout(nextConversation, 2000);
      }, 3500);
    }, 2000);
  };

  const current = exampleConversations[conversationIndex];

  return (
    <section className="py-20 border-t border-white/5 bg-black/30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16 animate-slide-in">
          <h2 className="font-display font-bold text-3xl sm:text-4xl text-white mb-4">
            Voice Chat Simulator
          </h2>
          <p className="text-slate-400 max-w-2xl mx-auto mb-8">
            Experience ABxAG's voice capabilities. Try speaking or typing — ABxAG responds naturally through Gemini Live.
          </p>
        </div>

        <div className="lg:grid-cols-2 gap-12 items-start">
          {/* Chat Window */}
          <div className="flex flex-col h-[500px]">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-indigo-900/80 flex items-center justify-center border border-indigo-500/30">
                  <span className="text-white font-bold text-xs">AB</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className={`w-2 h-2 rounded-full ${isSpeaking ? 'bg-purple-400 animate-pulse' : 'bg-white/10'}`} />
                  <span className="text-[10px] font-mono text-slate-400 uppercase">{isSpeaking ? 'speaking' : 'idle'}</span>
                </div>
              </div>
              <div className="w-8 h-8 rounded-full bg-cyan-900/50 flex items-center justify-center border border-cyan-500/30">
                <Mic className="w-4 h-4 text-cyan-400" />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto space-y-4 pr-2">
              {exampleConversations.slice(0, conversationIndex + 1).map((conv, i) => (
                <div key={i} className="flex gap-4 animate-slide-in" style={{ animationDelay: `${i * 0.1}s` }}>
                  {i <= conversationIndex && (
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-slate-800 border border-white/10 flex items-center justify-center">
                      <span className="text-[10px] font-bold text-white">{i % 2 === 0 ? 'A' : 'U'}</span>
                    </div>
                  )}
                  <div className="flex-1">
                    {i % 2 === 0 ? (
                      <div className="bg-slate-800/50 border border-white/10 p-4 rounded-2xl rounded-tr-none text-sm text-slate-200 leading-relaxed">
                        {conv.user}
                      </div>
                    ) : (
                      <div className="bg-indigo-500/10 border border-indigo-500/20 p-4 rounded-2xl rounded-tl-none text-sm text-indigo-200 leading-relaxed">
                        {conv.abxag}
                      </div>
                    )}
                  </div>
                  {i % 2 === 1 ? (
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-indigo-900/80 flex items-center justify-center border border-indigo-500/30">
                      <span className="text-white font-bold text-xs">AB</span>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>

            <div className="mt-6">
              <button
                onClick={simulateConversation}
                className="w-full py-3 px-6 rounded-xl border border-white/10 bg-white/5 text-xs font-mono tracking-widest text-white hover:bg-white/10 transition-colors flex items-center justify-center gap-2"
              >
                {isListening || isSpeaking ? (
                  <>
                    <div className="w-3 h-3 rounded-full border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>{isListening ? 'Listening...' : 'ABxAG responding...'}</span>
                  </>
                ) : (
                  <>
                    <MicIcon size={16} />
                    <span>Start Demo Conversation</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Input Panel */}
          <div className="mt-8 lg:mt-0">
            <div className="p-6 rounded-2xl border border-white/10 bg-white/5">
              <h3 className="font-bold text-white mb-6">Try Your Own</h3>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  placeholder="Type a message to ABxAG..."
                  className="flex-1 px-4 py-3 rounded-xl border border-white/10 bg-black/50 text-white placeholder-slate-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none text-sm font-mono transition-colors"
                />
                <button
                  onClick={() => {
                    if (!userInput.trim()) return;
                    setIsListening(true);
                    setTimeout(() => {
                      setIsListening(false);
                      setIsSpeaking(true);
                      setTimeout(() => {
                        setIsSpeaking(false);
                        setUserInput('');
                      }, 2000);
                    }, 1500);
                  }}
                  className="px-6 py-3 rounded-xl bg-white text-black font-semibold text-sm tracking-widest hover:bg-gray-200 transition-colors"
                >
                  <Send size={16} /> Send
                </button>
              </div>
              <div className="mt-4 pt-4 border-t border-white/5">
                <p className="text-[10px] font-mono text-slate-500">
                  <span className="text-indigo-400">Tip:</span> Try saying "change background to gold", "set a reminder", or "what's on my screen?"
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
