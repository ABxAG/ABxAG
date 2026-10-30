import { useState, useEffect, useRef } from 'react';
import { Send, Mic, MicOff, Bot, User, ArrowRight } from 'lucide-react';

export default function ChatInterface() {
  const [messages, setMessages] = useState([
    {
      id: 1,
      text: 'হ্যালো! আমি ABxAG ওয়েব ভার্সন। আমি কীভাবে আপনাকে সাহায্য করতে পারি?',
      sender: 'bot',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const messagesEndRef = useRef(null);
  const recognitionRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = false;
      recognitionRef.current.interimResults = false;
      recognitionRef.current.lang = 'bn-BD';

      recognitionRef.current.onresult = (event) => {
        const transcript = event.results[0][0].transcript;
        setInput(transcript);
      };

      recognitionRef.current.onerror = () => {
        setVoiceEnabled(false);
      };
    }
  }, []);

  const sendMessage = (e) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMessage = {
      id: Date.now(),
      text: input,
      sender: 'user',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsTyping(true);

    // Simulate bot response
    setTimeout(() => {
      const responses = [
        'বুঝতে পেরেছি! আপনি কি আরও কিছু জানতে চান?',
        'আমি 브우জারে 작동 করি, ডেস্কটপের মতো পূর্ণ ক্ষমতা নেই।',
        'আপনার Gemini API কী দিয়ে শুরু করুন।',
        'ABxAG ডেস্কটপ অ্যাপে বেশি ফিচার পাবেন।',
      ];
      const randomResponse = responses[Math.floor(Math.random() * responses.length)];
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          text: randomResponse,
          sender: 'bot',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
      setIsTyping(false);
    }, 1500);
  };

  const toggleVoice = () => {
    if (!recognitionRef.current) return;
    if (voiceEnabled) {
      recognitionRef.current.stop();
      setVoiceEnabled(false);
    } else {
      recognitionRef.current.start();
      setVoiceEnabled(true);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 h-full flex flex-col">
      <div className="glass-panel p-6 mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-abxag-500 flex items-center justify-center">
            <Bot size={20} fill="white" />
          </div>
          <div>
            <h3 className="font-bold text-white">ABxAG</h3>
            <p className="text-xs text-slate-400">ওয়েব ভার্সন - ডেমো মোড</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleVoice}
            className={`p-2 rounded-lg transition-colors ${
              voiceEnabled
                ? 'bg-red-500/20 text-red-400'
                : 'bg-white/10 text-slate-400 hover:bg-white/20'
            }`}
          >
            {voiceEnabled ? <MicOff size={20} /> : <Mic size={20} />}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-4 pr-2 mb-4" ref={messagesEndRef}>
        {messages.map((msg) => (
          <div key={msg.id} className="flex gap-3">
            {msg.sender === 'user' ? (
              <>
                <div className="flex justify-end">
                  <div className="chat-message chat-message-own">
                    <p className="text-sm">{msg.text}</p>
                    <span className="text-xs text-white/50 mt-1 block text-right">{msg.time}</span>
                  </div>
                  <div className="w-6 h-6 rounded-full bg-abxag-500 flex items-center justify-center text-white text-xs">
                    <User size={14} />
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="w-6 h-6 rounded-full bg-dark-800 flex items-center justify-center text-white text-xs shrink-0">
                  <Bot size={14} />
                </div>
                <div className="chat-message chat-message-other">
                  <p className="text-sm">{msg.text}</p>
                  <span className="text-xs text-slate-500 mt-1 block">{msg.time}</span>
                </div>
              </>
            )}
          </div>
        ))}
        {isTyping && (
          <div className="flex gap-3">
            <div className="w-6 h-6 rounded-full bg-dark-800 flex items-center justify-center shrink-0">
              <Bot size={14} />
            </div>
            <div className="chat-message chat-message-other">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce"></span>
                <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></span>
                <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0.4s' }}></span>
              </div>
            </div>
          </div>
        )}
      </div>

      <form onSubmit={sendMessage} className="glass-panel p-4">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="কিছু লিখুন বা ভয়েস ডিয়ে বলুন..."
            className="input-field flex-1"
          />
          <button type="submit" className="bg-abxag-500 p-3 rounded-xl hover:bg-abxag-600 text-white transition-colors">
            <Send size={20} />
          </button>
        </div>
      </form>
    </div>
  );
}