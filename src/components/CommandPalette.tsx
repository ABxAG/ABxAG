import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { motion } from "motion/react";
import { Terminal } from "lucide-react";
import { filterCommands, moveSelection, type CommandDef } from "../lib/commandPalette";

export type { CommandDef };

interface Props {
  open: boolean;
  onClose: () => void;
  commands: CommandDef[];
}

export function CommandPalette({ open, onClose, commands }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => filterCommands(query, commands), [query, commands]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open ]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!open) return null;

  const choose = (i: number) => {
    const cmd = results[i];
    if (!cmd) return;
    onClose();
    // Let the close animation start before the command toggles UI.
    window.setTimeout(() => cmd.run(), 30);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => moveSelection(i, 1, results.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => moveSelection(i, -1, results.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(index);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="ABxAG command palette"
      className="fixed inset-0 z-[90] flex items-start justify-center pt-[16vh] px-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: -10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: -6 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        onClick={(e) => e.stopPropagation()}
        className="cyber-panel relative w-[min(560px,92vw)] overflow-hidden rounded-2xl"
      >
        <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
          <Terminal size={16} className="shrink-0 text-cyan-300" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Type a command… (Esc to close)"
            aria-label="Command search"
            className="w-full bg-transparent font-mono text-sm text-white outline-none placeholder:text-white/30"
          />
          <kbd className="shrink-0 rounded-md border border-white/15 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-white/50">
            ⌘K
          </kbd>
        </div>
        <div ref={listRef} className="max-h-[46vh] overflow-y-auto p-2" role="listbox" aria-label="Commands">
          {results.length === 0 && (
            <p className="px-3 py-6 text-center font-mono text-xs text-white/35">
              No matching command. Try “screen”, “keys” or “studio”.
            </p>
          )}
          {results.map((cmd, i) => (
            <button
              key={cmd.id}
              type="button"
              role="option"
              aria-selected={i === index}
              data-index={i}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(i)}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition cursor-pointer ${
                i === index
                  ? "bg-cyan-400/15 text-white shadow-[0_0_24px_rgba(34,211,238,0.25)]"
                  : "text-white/70 hover:bg-white/5"
              }`}
            >
              <span className={`font-mono text-[11px] ${i === index ? "text-cyan-300" : "text-white/30"}`}>
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="flex-1">
                <span className="block text-sm font-medium">{cmd.title}</span>
                {cmd.hint && <span className="block font-mono text-[11px] text-white/40">{cmd.hint}</span>}
              </span>
              {i === index && <span className="font-mono text-[11px] text-cyan-300/80">↵</span>}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-4 border-t border-white/10 px-4 py-2 font-mono text-[10px] text-white/35">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
        </div>
      </motion.div>
    </motion.div>
  );
}
