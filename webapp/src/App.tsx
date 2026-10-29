import { useState, useEffect, useRef, type FormEvent } from 'react';
import { Send, Power, Mic, Volume2, Settings, Info, Compass, X, Brain, Monitor } from 'lucide-react';
import * as THREE from 'three';

// Simple 3D Character Viewer
function CharacterViewer({ state }: { state: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const frameRef = useRef<number>(0);

  useEffect(() => {
    if (!canvasRef.current) return;

    const canvas = canvasRef.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020205);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(50, canvas.clientWidth / canvas.clientHeight, 0.1, 100);
    camera.position.set(0, 1, 3);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    rendererRef.current = renderer;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0x404040, 0.5);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(1, 2, 3);
    scene.add(directionalLight);
    const pointLight = new THREE.PointLight(0x8b5cf6, 1, 10);
    pointLight.position.set(-2, 2, 2);
    scene.add(pointLight);

    // Create a simple character-like mesh (sphere head + cylinder body)
    const group = new THREE.Group();

    // Head
    const headGeometry = new THREE.SphereGeometry(0.4, 32, 32);
    const headMaterial = new THREE.MeshStandardMaterial({ color: 0xa78bfa, roughness: 0.3, metalness: 0.1 });
    const head = new THREE.Mesh(headGeometry, headMaterial);
    head.position.y = 1.2;
    group.add(head);

    // Body
    const bodyGeometry = new THREE.CylinderGeometry(0.3, 0.4, 0.8, 32);
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x6366f1, roughness: 0.4, metalness: 0.1 });
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    body.position.y = 0.4;
    group.add(body);

    // Eyes
    const eyeGeometry = new THREE.SphereGeometry(0.08, 16, 16);
    const eyeMaterial = new THREE.MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x22d3ee, emissiveIntensity: 0.5 });
    const leftEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
    leftEye.position.set(-0.15, 1.3, 0.35);
    group.add(leftEye);
    const rightEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
    rightEye.position.set(0.15, 1.3, 0.35);
    group.add(rightEye);

    // Glow ring
    const ringGeometry = new THREE.TorusGeometry(0.6, 0.02, 16, 100);
    const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x8b5cf6, transparent: true, opacity: 0.6 });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.position.y = 0.8;
    ring.rotation.x = Math.PI / 2;
    group.add(ring);

    scene.add(group);
    meshRef.current = head;

    // Animation loop
    let time = 0;
    function animate() {
      frameRef.current = requestAnimationFrame(animate);
      time += 0.01;

      // Idle animation
      group.position.y = Math.sin(time * 0.5) * 0.05;
      group.rotation.y = Math.sin(time * 0.3) * 0.1;
      ring.rotation.z = time * 0.5;

      // State-based color changes
      if (state === 'listening') {
        headMaterial.color.setHex(0x22d3ee);
        eyeMaterial.emissiveIntensity = 0.8;
      } else if (state === 'speaking') {
        headMaterial.color.setHex(0xa855f7);
        eyeMaterial.emissiveIntensity = 1.0;
      } else {
        headMaterial.color.setHex(0xa78bfa);
        eyeMaterial.emissiveIntensity = 0.5;
      }

      renderer.render(scene, camera);
    }
    animate();

    // Handle resize
    const handleResize = () => {
      if (!canvasRef.current || !cameraRef.current || !rendererRef.current) return;
      const w = canvasRef.current.clientWidth;
      const h = canvasRef.current.clientHeight;
      cameraRef.current.aspect = w / h;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener('resize', handleResize);
      renderer.dispose();
      scene.clear();
    };
  }, [state]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  );
}

export default function App() {
  const [state, setState] = useState<'disconnected' | 'listening' | 'speaking' | 'connecting'>('disconnected');
  const [textMessage, setTextMessage] = useState('');
  const [messages, setMessages] = useState<{ role: string; text: string }[]>([]);
  const [showGuide, setShowGuide] = useState(false);

  const handleToggleConnection = () => {
    if (state === 'disconnected') {
      setState('listening');
    } else {
      setState('disconnected');
    }
  };

  const handleSendText = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const text = textMessage.trim();
    if (!text) return;
    setMessages((prev) => [...prev, { role: 'user', text }]);
    setTextMessage('');
    setState('speaking');
    // Simulate response
    setTimeout(() => {
      setMessages((prev) => [...prev, { role: 'assistant', text: `I heard you say: "${text}". This is a web demo — for the full experience, download ABxAG for Windows!` }]);
      setState('listening');
    }, 1500);
  };

  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      background: 'linear-gradient(135deg, #020205 0%, #0a0a1a 50%, #020205 100%)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      position: 'relative',
    }}>
      {/* Ambient background */}
      <div style={{ position: 'absolute', top: '-10%', left: '-10%', width: '500px', height: '500px', background: 'radial-gradient(circle, rgba(139,92,246,0.15) 0%, transparent 70%)', borderRadius: '50%', filter: 'blur(120px)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', bottom: '-10%', right: '-10%', width: '600px', height: '600px', background: 'radial-gradient(circle, rgba(34,211,238,0.15) 0%, transparent 70%)', borderRadius: '50%', filter: 'blur(150px)', pointerEvents: 'none' }} />

      {/* Header */}
      <header style={{
        position: 'relative',
        zIndex: 30,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '1rem 2rem',
        maxWidth: '1200px',
        margin: '0 auto',
        width: '100%',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.875rem', fontWeight: 600, letterSpacing: '0.4em', color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase' }}>
            ABxAG Web
          </span>
          <div style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: state === 'listening' || state === 'speaking' ? '#22d3ee' : 'rgba(255,255,255,0.1)',
          }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
          <a href="https://abxag.absup.dev" style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.75rem', textDecoration: 'none', fontFamily: 'monospace', letterSpacing: '0.1em' }}>
            WEBSITE
          </a>
          <a href="https://abxag.absup.dev/DownLoad/" style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.75rem', textDecoration: 'none', fontFamily: 'monospace', letterSpacing: '0.1em' }}>
            DOWNLOAD
          </a>
          <button
            onClick={() => setShowGuide(!showGuide)}
            style={{ color: 'rgba(255,255,255,0.25)', fontSize: '0.75rem', fontFamily: 'monospace', letterSpacing: '0.1em', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
          >
            <Compass size={14} />
            <span style={{ display: window.innerWidth > 640 ? 'inline' : 'none' }}>FEATURES</span>
          </button>
        </div>
      </header>

      {/* Main content */}
      <main style={{
        position: 'relative',
        zIndex: 10,
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
        maxWidth: '900px',
        margin: '0 auto',
        width: '100%',
      }}>
        {/* 3D Character */}
        <div style={{
          width: '100%',
          height: '40vh',
          minHeight: '200px',
          position: 'relative',
          marginBottom: '1rem',
        }}>
          <CharacterViewer state={state} />
        </div>

        {/* Dialogue */}
        <div style={{
          width: '100%',
          maxWidth: '600px',
          minHeight: '6rem',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          marginBottom: '1rem',
        }}>
          {messages.length > 0 ? (
            <div style={{ width: '100%', maxHeight: '200px', overflowY: 'auto', padding: '0.5rem' }}>
              {messages.map((msg, i) => (
                <div key={i} style={{
                  marginBottom: '0.75rem',
                  padding: '0.75rem 1rem',
                  borderRadius: '1rem',
                  background: msg.role === 'user' ? 'rgba(34,211,238,0.1)' : 'rgba(139,92,246,0.1)',
                  border: `1px solid ${msg.role === 'user' ? 'rgba(34,211,238,0.2)' : 'rgba(139,92,246,0.2)'}`,
                  textAlign: msg.role === 'user' ? 'right' : 'left',
                }}>
                  <p style={{ fontSize: '0.875rem', color: msg.role === 'user' ? '#22d3ee' : '#a78bfa', lineHeight: 1.5 }}>
                    {msg.text}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <span style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.3em', color: 'rgba(255,255,255,0.3)', fontWeight: 500 }}>
              {state === 'listening' ? 'I am listening. Speak freely...' : state === 'connecting' ? 'Connecting...' : 'Connect to awaken ABxAG'}
            </span>
          )}
        </div>

        {/* Text input */}
        <form
          onSubmit={handleSendText}
          style={{
            display: 'flex',
            width: '100%',
            maxWidth: '500px',
            alignItems: 'center',
            gap: '0.5rem',
            borderRadius: '1rem',
            border: '1px solid rgba(255,255,255,0.1)',
            background: 'rgba(0,0,0,0.3)',
            padding: '0.5rem',
            backdropFilter: 'blur(20px)',
          }}
        >
          <input
            value={textMessage}
            onChange={(e) => setTextMessage(e.target.value)}
            placeholder="Type a message to ABxAG..."
            style={{ flex: 1, background: 'transparent', padding: '0.5rem 0.75rem', fontSize: '0.875rem', color: 'white' }}
          />
          <button
            type="submit"
            disabled={!textMessage.trim()}
            style={{
              width: '40px',
              height: '40px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '0.75rem',
              background: 'rgba(34,211,238,0.15)',
              color: '#22d3ee',
              border: '1px solid rgba(34,211,238,0.3)',
              opacity: !textMessage.trim() ? 0.35 : 1,
            }}
          >
            <Send size={16} />
          </button>
        </form>

        {/* Connect button */}
        <div style={{ marginTop: '1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
          <button
            onClick={handleToggleConnection}
            style={{
              width: '80px',
              height: '80px',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.5s',
              cursor: 'pointer',
              background: state === 'disconnected' ? 'rgba(255,255,255,0.1)' : state === 'listening' ? 'rgba(34,211,238,0.15)' : state === 'speaking' ? 'rgba(168,85,247,0.9)' : 'rgba(245,158,11,0.9)',
              border: state === 'disconnected' ? '1px solid rgba(255,255,255,0.15)' : state === 'listening' ? '1px solid rgba(34,211,238,0.8)' : state === 'speaking' ? '1px solid rgba(168,85,247,0.95)' : '1px solid rgba(245,158,11,0.95)',
              color: 'white',
              boxShadow: state === 'disconnected' ? '0 0 20px rgba(255,255,255,0.02)' : state === 'listening' ? '0 0 35px rgba(34,211,238,0.3)' : state === 'speaking' ? '0 0 35px rgba(168,85,247,0.4)' : '0 0 35px rgba(245,158,11,0.4)',
              transform: state === 'disconnected' ? 'scale(1)' : 'scale(1.05)',
            }}
            title={state === 'disconnected' ? 'Awaken ABxAG' : 'Sleep'}
          >
            {state === 'disconnected' ? (
              <Power size={24} style={{ opacity: 0.8 }} />
            ) : state === 'listening' ? (
              <Mic size={24} style={{ color: '#22d3ee' }} />
            ) : state === 'speaking' ? (
              <Volume2 size={24} />
            ) : (
              <div style={{ width: '24px', height: '24px', border: '2px solid white', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
            )}
          </button>
        </div>
      </main>

      {/* Footer */}
      <footer style={{
        position: 'relative',
        zIndex: 10,
        textAlign: 'center',
        padding: '1rem',
        color: 'rgba(255,255,255,0.3)',
        fontSize: '0.75rem',
        fontFamily: 'monospace',
      }}>
        ABxAG Web Demo · For the full desktop experience, <a href="https://abxag.absup.dev/DownLoad/" style={{ color: '#22d3ee', textDecoration: 'none' }}>download ABxAG</a>
      </footer>

      {/* Feature Guide Modal */}
      {showGuide && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.7)',
          backdropFilter: 'blur(10px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 50,
          padding: '1rem',
        }} onClick={() => setShowGuide(false)}>
          <div style={{
            background: 'rgba(15,15,25,0.95)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '1.5rem',
            padding: '2rem',
            maxWidth: '500px',
            width: '100%',
          }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h2 style={{ fontSize: '1.25rem', fontWeight: 600, color: '#a78bfa' }}>ABxAG Features</h2>
              <button onClick={() => setShowGuide(false)} style={{ color: 'rgba(255,255,255,0.5)' }}>
                <X size={20} />
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {[
                { icon: '🎙', title: 'Voice Conversation', desc: 'Talk naturally with Gemini Live. "Hey AB" wake word.' },
                { icon: '👁', title: 'Screen Vision', desc: 'Sees and understands your screen with permission.' },
                { icon: '🖐', title: 'PC Control', desc: '96 local tools for apps, files, input, browser.' },
                { icon: '🧠', title: 'Memory & Mind', desc: 'Episodic memory, goals, learned skills.' },
                { icon: '🧍', title: '3D Character', desc: 'Import any .pmx/.vrm/.glb/.fbx/.obj model.' },
                { icon: '🔄', title: 'Auto-Update', desc: 'Hybrid updater with differential installs.' },
              ].map((f, i) => (
                <div key={i} style={{
                  display: 'flex',
                  gap: '1rem',
                  padding: '1rem',
                  borderRadius: '0.75rem',
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.05)',
                }}>
                  <span style={{ fontSize: '1.5rem' }}>{f.icon}</span>
                  <div>
                    <h3 style={{ fontSize: '0.875rem', fontWeight: 600, color: '#a78bfa', marginBottom: '0.25rem' }}>{f.title}</h3>
                    <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)', lineHeight: 1.5 }}>{f.desc}</p>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
              <a href="https://abxag.absup.dev/DownLoad/" style={{
                display: 'inline-block',
                padding: '0.75rem 2rem',
                borderRadius: '0.75rem',
                background: 'linear-gradient(135deg, #8b5cf6, #6366f1)',
                color: 'white',
                textDecoration: 'none',
                fontWeight: 600,
                fontSize: '0.875rem',
              }}>
                Download ABxAG for Windows
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}