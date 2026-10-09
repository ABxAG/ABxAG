# ABxAG final update: development report

Version 1.4.2 · October 2026 · Windows desktop (Electron + Node backend + Python desktop agent + React/three.js renderer)

This report covers what the final update added, how each part was verified, and what is still limited. All tests listed were run on the build described here.

## 1. What changed

### Fixes in 1.4.2
- **Blank dark ABxAG window:** an empty window (Electron's background with nothing painted) is now detected and recovered:
  - every 15 s, a window that stops answering or has an empty page is reloaded;
  - a page that fails to load is retried;
  - an interface error shows "ABxAG hit a problem and is reloading…" and reloads, instead of unmounting everything;
  - a backend that stops answering for about 45 s is restarted;
  - page errors are written to `logs/crash.log`.
- **Peeking hands:** her hands now hold the screen edge at head height with fingers up, her head tilts around the edge, and the far arm crosses her chest. Before, her hands were crossed in front of her chest at odd angles.
- **Sit anywhere (like Desktop Mate):** drop her onto any window and she lands on its top edge and sits, legs over the edge. On the taskbar she sits half the time. On a ledge too high for her to stand on, she sits and stays seated. At large sizes she can now use far more windows, because only room for her seated upper body is needed.
- **New seated poses:** hands folded on her knees (the Desktop Mate pose), and chin resting on her hand with legs crossed.

### Fixes in 1.4.1 (from your test session)
- **"Open Downloads and select all .zip files" works.**
  - The voice model had no tool for this, so it improvised: clicking a column header, typing, and `shift+end` / `shift+down` keys the agent rejected.
  - New `selectFiles` (voice) / `fs.select` (task engine) tool: it opens the folder in File Explorer, or reuses a window already showing it, and selects the matching files through Explorer's own interface. On your PC it selected all 49 ZIP files in Downloads in 0.6 s.
  - ZIP files count as "folders" to Explorer, which the first version tripped over; that is handled.
- **Searching files no longer times out.** `searchFiles` walked every subfolder of Downloads with no limit. It now skips `node_modules`, `.git` and cache folders, stops at a depth of 4 and has an 8-second budget. The same search now takes 0.25 s.
- **Keyboard combos:** `shift+end`, `ctrl + a`, `["shift+down", …]` and similar spellings are accepted.
- **Clicks:** a cursor nudged by your own mouse no longer cancels a click; the agent re-places it up to 4 times.
- **Auto-start in development:** writing the launcher failed (`illegal newline value`); fixed.
- **The icon game never started.** The desktop itself (Program Manager / WorkerW) was counted as a window covering every icon. Shell windows, the taskbars and invisible ("cloaked") Store-app windows are now excluded. She still only plays with icons you can actually see, so not while a window is maximised over the desktop.
- **Hide and peek:** she hides about 4× more often (Playful: about 8×) and comes back after 15–45 s. She tiptoes away (crouched, hands up, looking back over her shoulder) and peeks back in, hands first.
- **A companion freeze:** a walk could be given a non-number position, which threw inside a timer on every tick. Positions are now checked, and a failing timer stops cleanly.
- **Lower memory use:** the main window's 3D character is unloaded 20 s after the window is hidden in the tray, and rebuilt when it is shown again. The desktop companion is unaffected.
- **Your PC was out of memory during testing:** Windows reported "the paging file is too small" (error 1455) and could not start new processes. While that happens, apps fail to open and programs crash. ABxAG is not the main user: at the time, Filmora, Wallpaper Engine, Chrome, two ChatGPT windows, Discord and Steam held most of the memory. A larger page file, or closing unused apps, prevents it.

### New in 1.4.0: speed, stability and a living desktop companion

**Faster and safer PC tasks**
- **Opening apps went from about 33 s to under 2 s.** The app finder walked your whole Desktop recursively, including project folders with `node_modules` (13.7 s). Then the Store-app lookup timed out cold, so it fell back to typing into Windows Search. Desktops are now scanned top-level only, and installed apps are indexed in the background when the agent starts, cached on disk and refreshed every 15 minutes. WhatsApp (a Store app) is now found directly.
- **A message is never sent twice in one task.** The log showed "Hi, main Myra bol rahi hun." sent to the same chat twice: WhatsApp had not shown it yet, so the planner typed it again. The executor now refuses to submit the same text again in the same task (whether by typing with Enter or typing then Enter), and tells the planner to look for the sent message instead. A regression test covers it.
- **Less waiting on the model.**
  - An overloaded model that Auto ranked is skipped at once instead of being retried, with a cool-down of 45 s, then 3 min, then 8 min if it keeps failing.
  - Routine steps use low thinking; only recovery steps and screenshot steps think harder.

**Crash protection**
- **Backend:** one unhandled promise rejection used to kill it, and Electron then closed ABxAG. Both now log a stack trace (keys redacted) and keep running. If the backend does exit, it restarts automatically, giving up after 4 crashes in 5 minutes.
- **Windows:** crashed or hung pages reload themselves (at most 3 times a minute). GPU and renderer crashes are logged to `logs/crash.log`.
- **Character:** a lost WebGL context rebuilds her, and one bad frame no longer freezes her for good.

**Desktop companion**
- **Feet on the surface.**
  - The camera used to follow her hip bone, so every weight shift or bounce slid her feet off the taskbar and she looked like she was hovering. The camera is now fixed, and the floor sits exactly at the window's bottom edge.
  - Sole points come from the shoe vertices. MMD models weight shoes to `足首D`/`足先EX`, which were missed before.
  - She lands only on window tops you can actually see: not covered by another window, and not a maximised window's top. She hops down if her window closes, moves away, or gets covered, and she never ends up off screen by accident.
- **Sitting on edges.**
  - She sits on the taskbar or a window's title bar with her legs hanging over it, and the window drops so her seat line lies exactly on the edge.
  - New styles: knees together with hands on the edge; ankles crossed with hands in the lap; leaning back on her hands with one leg swinging. She sits turned three-quarters to you rather than square-on.
  - While seated she kicks her legs in bursts, changes style, stretches her arms over her head with a yawn, yawns behind her hand, and looks around.
- **Lazy idle moves:** overhead stretch with a yawn, hand-to-mouth yawn, hands clasped behind her back, tucking her hair, giggling.
- **She lives on her own:** walks along the taskbar and window tops with a real walk cycle (feet planted; walk speed is computed from her leg length), sits down, gets up, and stretches. Settings → Character & companion → *How lively* (Calm / Normal / Playful) and *Walk around*.
- **Hide and peek:** now and then she walks off a screen edge (only an edge with no second monitor beyond it). When you call her, or by herself later, she peeks back in: hands first, then her tilted head, then she steps out and waves. Talking to ABxAG calls her out.
- **Desktop icon game (opt-in):** she walks to a waist-high desktop icon, grabs it, and tugs it a few steps. The icon's original spot is saved first (`companion/icon-positions.json`). Say "put the icons back" (voice tool `companionAction`), or use her right-click menu or the tray, and every icon she moved glides back. This uses the documented Windows Shell interface (`IFolderView`); no Explorer memory is read or written. It is off by default for new installs and turned on for you, because you asked for it.
- **Stands out from the wallpaper:** a thin dark contour, a faint light halo and a soft drop shadow, plus a contact shadow under her feet. Adjustable with *Stand out from the wallpaper*.
- **Lighter on Windows:** the companion renders at 45 fps while idle and at full rate only while she moves or is being dragged.

### Agent and PC control (backend)
- **Autonomous task loop.** Plans each step, observes the screen, acts, then checks the result. Retries are bounded and failures are classified, and a task can be paused, resumed, taken over by you, handed back, or continued after a restart.
- **Permission engine and approvals.** Every capability (files, messages, commands, installs, power, camera…) is set to Allow, Ask or Block. Installs, purchases, account changes, running downloads and power actions can never be set to Allow. An approval request is automatically denied if nobody answers within 3 minutes.
- **Model registry and router.** Gemini is the primary provider; your key is stored encrypted and never sent to the renderer. *Auto* chooses a model per job, falls back to another when one fails or runs out of quota, and tells you when it does.
- **Presence and conversation.** Away detection, return greetings, check-ins, and automatic do-not-disturb during full-screen apps, meetings or recordings.
- **Desktop agent.** A frozen Python agent exposes 81 tools. The PyInstaller spec was missing five modules (UI automation, perception, extended file/input tools), so the previous installer's agent lacked those tools. It now bundles all of them, and its tool list matches the development agent exactly.
- **Live settings.** The step limit and the mouse-conflict wait now take effect immediately instead of only after a restart.

### App UI
- **Task panel (HUD).** Shows the running task, its plan with the current step, recent actions, and Pause / Resume / Take over / Hand back / Stop buttons. ABxAG's questions can be answered by clicking an option or typing. An *Emergency stop* button and an offer to continue an interrupted task are included.
- **Approval dialog.** Shows what ABxAG wants to do, the details, and a countdown. *Allow for this session* appears where the backend permits it. Approvals always appear, even with the task panel hidden. When ABxAG's window is hidden or unfocused, Windows shows a notification and the taskbar icon flashes.
- **Model selector.** A brain icon in the header picks the brain, voice and background models. It shows availability, lets you test a model, re-check availability and toggle automatic fallback.
- **Settings redesign.** Sidebar sections: General, AI models & keys, Voice, PC control & safety, Privacy, Presence, Character & companion, System, About. Only settings the app actually honours are shown. Privacy uses the enforced permission system (screen, clipboard, microphone, camera).
- **First-run onboarding.** Welcome → character → AI → what ABxAG may do → presence and companion → done. It can be re-run from Settings → System.

### Characters
- **Generic import.** Any PMX character imports from a local folder, with skeleton and finger mapping, a physics-chain analysis and an honest compatibility report. All 7 supplied models plus the built-in Evelyn import and pass the 15 runtime checks.
- **Character Studio.** Direct grab-and-drag posing with IK, individual finger joints, physics tuning and WASD camera keys.
- **Desktop companion.** ABxAG stands or sits on your desktop or taskbar, can be dragged and thrown, and has a tray menu.

### Graphics: realism shading (new)
A **Realism** slider (Settings → Character & companion; default 85%) blends the original anime shader with physically based shading:
- skin subsurface scattering, so light bleeds warm through the shadow edge instead of turning grey;
- physically based specular with per-material roughness (skin, hair, fabric, leather, metal, jewellery, eyes);
- soft studio reflections from a procedural environment map (soft boxes, ceiling, floor);
- fabric sheen, so black cloth shows its folds and satin reads as satin;
- texture colours kept true (the warm key light is limited to about a third of its colour).

One bug was found and fixed during tuning. These MMD models mix triangle windings, so some visible faces had normals pointing away from the camera, and the physically based terms washed the whole model grey. The realism path now orients normals toward the viewer.

### Sitting (new)
The old fixed "sit" pose (she floated, with no seat) is gone.
- **Seats:** chair, sofa, bar stool, floor cushion, and an invisible *edge* used by the desktop companion. Each is built at a height that fits the character's own legs.
- **Styles:** upright, relaxed (leaning back), legs crossed, knees to the side, legs dangling, hugging knees, legs folded aside. The Studio lets you mirror the asymmetric ones.
- **Solving:** the hips are lowered onto the seat surface, the legs are solved with IK so the feet reach the floor (or hang), and the hands rest on the thighs, the seat or the knees. The pose eases in over about one second.
- **While seated:** breathing, gaze and the upper body stay alive, while hips and legs are protected from idle sway so she doesn't slide. Dangling legs swing out of phase, and a crossed top foot bobs now and then.
- A pose-system bug was fixed along the way: finishing a pose transition used to erase the translation of bones that only moved without rotating (the hips), which also affected saved poses.

### Real cloth on every garment (new in 1.3.0)
Garments that the model authors skinned straight to the body (sleeves, gloves, bodices, tops) used to move like painted-on skin. A new vertex-level cloth layer (`src/character/physics/ClothLayer.ts`) now simulates every clothing surface on every character:
- **Fabric particles.** Each garment piece is welded and clustered into fabric particles (about 1,400–2,500 per character), linked along the mesh's own edges.
- **Stays worn.** Each particle follows the place the body carries it, on a spring within limited slack. Strand-rigged fabric (skirt panels, coat tails) is loose. Body-skinned fabric only sways (at most about 1.3% of her height), because these models have no body modelled underneath and must never open a gap.
- **Inertia.** Fast moves and window drags make fabric trail and flare, and it settles back when she stops.
- **Body contact.** Collision is relative to the worn shape, so fabric can't sink into her legs or body, and is never pushed off where she wears it.
- **Grabbing.** Drag on her clothes in the main view, or Shift+drag in Character Studio, to tug the fabric. It swings back on release.
- **Settings:** Settings → Character & companion → *Real cloth* and *Cloth looseness*.

Measured on all 10 characters: stable with no blow-ups, settling to the worn shape at rest, at 2.3–5.2 ms per frame. Ellen, Jane Doe and Heron Thoth (white) keep some fabric moving at rest, because their own skirt strands never fully settle.

Clothes cannot be removed or come off; that is a deliberate design limit.

### Cloth strands (improved)
Skirt, jacket and sleeve strands used to be simulated as independent sticks. They are now joined into a **sheet**: neighbouring strands at the same depth are linked, strongly resisting stretch while allowing the fabric to bunch. A skirt now moves, opens and drapes as one piece and rests on the thighs when sitting. Each character gets between 20 and 129 links; Jane Doe has no skirt strands, so she gets none. The solver costs about 1.5 ms per frame.

## 2. Verification (this build)
| Check | Result |
|---|---|
| Type check (`tsc --noEmit`) | pass |
| Agent / runtime tests | 43 / 43 pass |
| Character profile tests | 9 / 9 pass |
| Python desktop-agent tests | 31 / 31 pass |
| In-app character checks (Astra 2) | 15 / 15 pass: renders, textures, skeleton, pose, hand/foot IK, fingers, expressions, animation, hair and cloth physics, companion rendering, dragging, sitting, cursor look-at |
| Sitting on all 8 characters (chair: upright and crossed) | hips 0.21 thigh-lengths above the seat, feet exactly on the floor, thighs forward, physics stable |
| Frozen desktop agent | 81 tools, identical to the development agent |
| Cloth layer on all 10 characters | builds, stays finite, settles back after a drag, 2.3–5.2 ms per frame |
| In-app checks on Heron Thoth (white), imported in 1.3.0 | 15 / 15 pass |
| 1.4.0: duplicate-send guard | regression test passes (the same text cannot be submitted twice in one task) |
| 1.4.0: app launch | WhatsApp found as a Store app in about 0.1 s with a warm index (was 33 s through Windows Search); shortcut scan 13.7 s → 0.1 s |
| 1.4.0: companion poses (Astra 2, browser) | feet on the window's bottom edge; perch, ankles and lean-back sitting; seated and standing stretch; walk cycle; peek; reach and tug |
| 1.4.0: companion on the real desktop (Heron Thoth white) | stood on the taskbar, walked, and sat on the taskbar edge with legs hanging; icon list read through the backend (25 icons) |
| UI | task panel, approval dialog, model selector, settings and onboarding checked in the running app; the task panel and approval dialog with sample data on the dev-only `ui-preview.html` page (not part of the installer) |

## 3. Known limits (honest)
- **The reference images are 2D illustrations** (AI-painted and hand-drawn). A real-time 3D PMX model with these textures cannot match a painting pixel for pixel. Realism makes skin, cloth and reflections more believable, but painted texture detail such as pores, fabric weave and hand-drawn shading would need new art or texture work.
- **Body-skinned fabric only sways.** The cloth layer moves it, but these models have no body under the clothes, so its slack is kept small. Fabric doesn't fold or wrinkle beyond what the mesh already models. There is no self-collision between layers of the same garment, and shadows don't follow the cloth's movement.
- **Settings that are stored but not used yet:** companion click-through, interaction level and walk-around; FPS caps; perception poll interval; head follow; idle variety; the three privacy toggles (privacy is enforced through permissions instead). They are hidden from Settings.
- **Free Gemini keys have small daily quotas** (about 20 requests a day on some models), so long PC tasks may stop until the quota resets.
- **Companion limits:** the walk is procedural, and her feet slide a little at the start and end of a walk. The icon game moves only icons that are not hidden behind a window, at about her waist height, and only when auto-arrange is off. She peeks only from screen edges with no second monitor beyond them. Some models' strap or ribbon physics swing outward when she raises her arms.
- **The installer is not code-signed with a trusted certificate**, so Windows SmartScreen may warn on first run.

## 4. Decisions left to you
1. **Evelyn's licence.** The built-in Evelyn model is by the same author as the 7 imported models, whose licence forbids redistribution, and the installer bundles it (`assets/characters/evelyn`). Either remove it from `electron-builder.yml` `files` and ship without a default character, or obtain permission.
2. **Your current permissions.** In this data folder, *Delete files*, *Send messages* and *Run commands* are set to **Allow** (the defaults are Ask). If that wasn't intended, change them in Settings → PC control & safety.
3. **The development `.env` file** in the project folder holds Gemini keys in plain text. The installer does not include it, but consider deleting it or rotating those keys.

## 5. Build
```
npm test          # type check + agent + character + Python tests
npm run dist      # renderer + backend + launcher → release/ABxAG-Setup-<version>.exe and ABxAG-Portable-<version>.exe
python -m PyInstaller desktop_agent.spec --noconfirm --distpath agent_dist --workpath agent_build   # rebuild the frozen agent when its code changes
```

