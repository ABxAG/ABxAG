## ABxAG v1.1.27

### New — No artificial limits, no refusals

- **Anti-refusal system instructions**: The Live voice model now has explicit rules:
  - **NEVER** say "I'm just a language model", "I cannot", "I'm unable to", "As an AI"
  - **TRY ANYWAY** using available tools — let the tool fail with a real error
  - If a tool is missing, say what you **CAN** do instead
  - No moralizing, lecturing, or explaining limitations — be helpful, concise, action-oriented

- **Gemini safety filters disabled** (all 4 categories set to `BLOCK_NONE`):
  - **Text/Chat model** (brain, planning, vision): `models/providers/gemini/client.ts`
  - **Live Voice model** (real-time audio): `server.ts`
  - Categories: HATE_SPEECH, DANGEROUS_CONTENT, HARASSMENT, SEXUALLY_EXPLICIT

- **Result**: ABxAG will now *attempt* any action via tools instead of preemptively refusing. Risky actions (file deletion, system changes, messaging) still go through your **confirmation broker** — you stay in control, but the model won't say "I can't do that" before trying.

### Also includes v1.1.26 features:

- **Companion Sleep/Wake**: *"so jao"*, *"sleep"*, *"uto"*, *"wake up"*
- **Hide/Show Window**: *"chup jao"*, *"hide window"*, *"dekhao"*, *"show window"*
- **Resize**: *"choto koro"*, *"boro koro"*, *"reset size"* (0.4×–2.5×)

### Fixed

- **Companion getter recursion bug fixed** (v1.1.26): `sleeping`/`windowHidden` getters now use internal backing properties
- **Embedded Python interpreter fix** (v1.1.26): Bundle verified before launch, fallback to local Python

### Verified

- tsc clean - 129 agent tests, 8 character, 32 Python
- All companion sleep/wake/resize tests pass
- Public build: no bundled character models, users import their own on first run