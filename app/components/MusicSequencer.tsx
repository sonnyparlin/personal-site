"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ── Music model ────────────────────────────────────────────────────
// Pitches are locked to the C-major pentatonic (C D E G A) from middle
// C up to E5. Pentatonic means ANY combination the kid places sounds
// pleasant together — no wrong notes. The range C4..E5 also maps cleanly
// onto a treble staff with at most one ledger line (middle C), so the
// staff mirror stays readable.
//
// `staffStep` is the note's vertical position on the staff, counted in
// half-line-gaps DOWN from the top staff line (F5 = 0). Used by the SVG
// mirror to place noteheads.
type Pitch = { name: string; freq: number; staffStep: number; color: string };

const PITCHES: Pitch[] = [
  { name: "E5", freq: 659.25, staffStep: 1, color: "#ff5d5d" },
  { name: "D5", freq: 587.33, staffStep: 2, color: "#ff9e3d" },
  { name: "C5", freq: 523.25, staffStep: 3, color: "#ffd23d" },
  { name: "A4", freq: 440.0, staffStep: 5, color: "#7ed957" },
  { name: "G4", freq: 392.0, staffStep: 6, color: "#3dd6c4" },
  { name: "E4", freq: 329.63, staffStep: 8, color: "#4dabf7" },
  { name: "D4", freq: 293.66, staffStep: 9, color: "#7c6cff" },
  { name: "C4", freq: 261.63, staffStep: 10, color: "#c77dff" },
];

const STEPS = 16;
const N_ROWS = PITCHES.length;

// Layout (px). The grid + staff share the same column geometry so
// noteheads line up under the cells that placed them.
const CELL = 32;
const ROW_LABEL_W = 30;
const GRID_W = ROW_LABEL_W + STEPS * CELL;

// Staff geometry
const STAFF_TOP = 22; // y of the top staff line (F5)
const STAFF_GAP = 12; // px between adjacent staff lines
const HALF = STAFF_GAP / 2; // px per staffStep
const STAFF_BOTTOM_STEP = 8; // E4 is the bottom line
const MIDDLE_C_STEP = 10; // C4 needs a ledger line here

type Tempo = { label: string; bpm: number; icon: string };
const TEMPOS: Tempo[] = [
  { label: "Slow", bpm: 80, icon: "🐢" },
  { label: "Med", bpm: 112, icon: "🚶" },
  { label: "Fast", bpm: 150, icon: "🐇" },
];

// Instrument voices — each is just an oscillator type + gain envelope
// fed into the shared playNote, so swapping voices leaves the grid,
// scheduler, staff, and readout untouched. Secretly educational: same
// note, different timbre teaches that pitch and instrument are separate.
// `sustain` voices hold their peak then release (horn/flute); the rest
// pluck with an exponential decay (piano/bells/pluck).
type Instrument = {
  id: string;
  label: string;
  icon: string;
  type: OscillatorType;
  attack: number; // seconds to reach peak gain
  dur: number; // total note length (seconds)
  vol: number; // peak gain
  sustain?: boolean;
};
const INSTRUMENTS: Instrument[] = [
  { id: "piano", label: "Piano", icon: "🎹", type: "triangle", attack: 0.012, dur: 0.38, vol: 0.26 },
  { id: "bells", label: "Bells", icon: "🔔", type: "sine", attack: 0.005, dur: 1.1, vol: 0.3 },
  { id: "horn", label: "Horn", icon: "🎺", type: "sawtooth", attack: 0.04, dur: 0.5, vol: 0.16, sustain: true },
  { id: "flute", label: "Flute", icon: "🪈", type: "sine", attack: 0.08, dur: 0.55, vol: 0.22, sustain: true },
  { id: "pluck", label: "Pluck", icon: "🎸", type: "sawtooth", attack: 0.005, dur: 0.22, vol: 0.2 },
];

const ACCENT = "#3a4f8b";

function emptyGrid(): boolean[][] {
  return PITCHES.map(() => Array<boolean>(STEPS).fill(false));
}

export default function MusicSequencer() {
  const [grid, setGrid] = useState<boolean[][]>(emptyGrid);
  const [playing, setPlaying] = useState(false);
  const [currentStep, setCurrentStep] = useState(-1);
  const [bpm, setBpm] = useState(112);
  // "Now playing" readout: the notes sounding at the playhead while
  // playing, or the last note the kid tapped while stopped. Naming the
  // notes as they sound is how a beginner connects the music they like
  // to the letters on the staff.
  const [liveNotes, setLiveNotes] = useState<Pitch[]>([]);
  const [tapNote, setTapNote] = useState<Pitch | null>(null);
  const [instrument, setInstrument] = useState(0);

  // Audio + scheduler refs (closures inside the scheduler read these)
  const ctxRef = useRef<AudioContext | null>(null);
  const gridRef = useRef(grid);
  const bpmRef = useRef(bpm);
  const nextNoteTimeRef = useRef(0);
  const schedStepRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const noteQueueRef = useRef<{ step: number; time: number }[]>([]);
  const lastDrawnRef = useRef(-1);
  const instrumentRef = useRef(instrument);

  useEffect(() => {
    instrumentRef.current = instrument;
  }, [instrument]);
  useEffect(() => {
    gridRef.current = grid;
  }, [grid]);
  useEffect(() => {
    bpmRef.current = bpm;
  }, [bpm]);

  // Recompute the readout each time the playhead advances.
  useEffect(() => {
    if (!playing || currentStep < 0) {
      setLiveNotes([]);
      return;
    }
    setLiveNotes(PITCHES.filter((_, p) => grid[p][currentStep]));
  }, [playing, currentStep, grid]);

  const ensureCtx = useCallback(() => {
    if (!ctxRef.current) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      ctxRef.current = new Ctx();
    }
    if (ctxRef.current.state === "suspended") ctxRef.current.resume();
    return ctxRef.current;
  }, []);

  // Play one note in the currently selected instrument's voice. Reads
  // instrumentRef (not state) so the long-lived scheduler closure always
  // uses the latest pick without being rebuilt.
  const playNote = useCallback((freq: number, time: number) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const inst = INSTRUMENTS[instrumentRef.current];
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = inst.type;
    osc.frequency.value = freq;
    const { attack, dur, vol, sustain } = inst;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(vol, time + attack);
    if (sustain) {
      // Hold the peak, then a quick linear release at the tail.
      gain.gain.setValueAtTime(vol, time + Math.max(attack, dur - 0.08));
      gain.gain.linearRampToValueAtTime(0.0001, time + dur);
    } else {
      // Plucked: exponential decay from the peak.
      gain.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    }
    osc.connect(gain).connect(ctx.destination);
    osc.start(time);
    osc.stop(time + dur + 0.05);
  }, []);

  const previewNote = useCallback(
    (freq: number) => {
      const ctx = ensureCtx();
      playNote(freq, ctx.currentTime + 0.01);
    },
    [ensureCtx, playNote]
  );

  const stepDur = useCallback(() => 60 / bpmRef.current / 4, []); // 16th notes

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    noteQueueRef.current = [];
    lastDrawnRef.current = -1;
    setPlaying(false);
    setCurrentStep(-1);
  }, []);

  const start = useCallback(() => {
    const ctx = ensureCtx();
    schedStepRef.current = 0;
    nextNoteTimeRef.current = ctx.currentTime + 0.08;
    noteQueueRef.current = [];
    lastDrawnRef.current = -1;

    // Lookahead scheduler ("A Tale of Two Clocks"): the AudioContext
    // clock owns timing; setInterval just wakes us up to queue notes a
    // little ahead. Robust against the R3F canvas hogging the main thread.
    const SCHED_AHEAD = 0.1;
    const scheduler = () => {
      const c = ctxRef.current;
      if (!c) return;
      while (nextNoteTimeRef.current < c.currentTime + SCHED_AHEAD) {
        const step = schedStepRef.current;
        const t = nextNoteTimeRef.current;
        const g = gridRef.current;
        for (let p = 0; p < N_ROWS; p++) {
          if (g[p][step]) playNote(PITCHES[p].freq, t);
        }
        noteQueueRef.current.push({ step, time: t });
        nextNoteTimeRef.current += stepDur();
        schedStepRef.current = (step + 1) % STEPS;
      }
    };

    const draw = () => {
      const c = ctxRef.current;
      if (c) {
        const q = noteQueueRef.current;
        let step = lastDrawnRef.current;
        while (q.length && q[0].time <= c.currentTime) {
          step = q[0].step;
          q.shift();
        }
        if (step !== lastDrawnRef.current) {
          lastDrawnRef.current = step;
          setCurrentStep(step);
        }
      }
      rafRef.current = requestAnimationFrame(draw);
    };

    timerRef.current = window.setInterval(scheduler, 25);
    rafRef.current = requestAnimationFrame(draw);
    setPlaying(true);
  }, [ensureCtx, playNote, stepDur]);

  // Cleanup on unmount (route change closes the overlay).
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      ctxRef.current?.close().catch(() => {});
    };
  }, []);

  const toggleCell = useCallback(
    (p: number, step: number) => {
      const turningOn = !gridRef.current[p][step];
      setGrid((prev) => {
        const next = prev.map((row) => row.slice());
        next[p][step] = !next[p][step];
        return next;
      });
      if (turningOn) {
        previewNote(PITCHES[p].freq);
        setTapNote(PITCHES[p]);
      }
    },
    [previewNote]
  );

  const clear = useCallback(() => setGrid(emptyGrid()), []);

  const pickInstrument = useCallback(
    (i: number) => {
      // Update the ref synchronously so the preview below (and any
      // in-flight scheduler tick) uses the new voice immediately,
      // before the state-driven effect commits.
      instrumentRef.current = i;
      setInstrument(i);
      previewNote(440); // A4 — a quick taste of the new sound
    },
    [previewNote]
  );

  // Active notes as {step, pitchIndex} for the staff mirror.
  const placed: { step: number; p: number }[] = [];
  for (let p = 0; p < N_ROWS; p++) {
    for (let s = 0; s < STEPS; s++) if (grid[p][s]) placed.push({ step: s, p });
  }

  // What the readout shows: live notes while playing, else the last tap.
  const shownNotes = playing ? liveNotes : tapNote ? [tapNote] : [];

  const colX = (step: number) => ROW_LABEL_W + step * CELL + CELL / 2;
  const staffY = (staffStep: number) => STAFF_TOP + staffStep * HALF;
  const staffHeight = staffY(MIDDLE_C_STEP) + 18;

  return (
    <div className="font-pixel" style={{ color: "#f4f1de" }}>
      <p className="font-body text-xl mb-4 text-white/80">
        Tap the dots to make a tune, then press Play. Every note sounds good
        together — you can&apos;t make a mistake! Watch the note name light up
        as each one plays — that&apos;s how you learn them.
      </p>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button
          onClick={playing ? stop : start}
          className="font-pixel text-xs px-4 py-2 rounded transition-colors"
          style={{
            background: playing ? "#c0392b" : "#2e8b57",
            color: "#fff",
          }}
        >
          {playing ? "■ Stop" : "▶ Play"}
        </button>
        <button
          onClick={clear}
          className="font-pixel text-xs px-3 py-2 rounded border-2 border-white/25 text-white/80 hover:border-white/60 transition-colors"
        >
          Clear
        </button>
        <div className="flex items-center gap-1 ml-1">
          {TEMPOS.map((t) => (
            <button
              key={t.label}
              onClick={() => setBpm(t.bpm)}
              className="font-pixel text-xs px-2 py-2 rounded border-2 transition-colors"
              style={{
                borderColor: bpm === t.bpm ? ACCENT : "rgba(255,255,255,0.2)",
                background: bpm === t.bpm ? `${ACCENT}55` : "transparent",
                color: "#f4f1de",
              }}
              title={`${t.label} (${t.bpm} BPM)`}
            >
              {t.icon}
            </button>
          ))}
        </div>
      </div>

      {/* Instrument picker — swaps the synth voice for the whole grid.
          Same notes, different sound: pitch vs. timbre made tangible. */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="font-body text-lg text-white/55 mr-1">Sound:</span>
        {INSTRUMENTS.map((inst, i) => (
          <button
            key={inst.id}
            onClick={() => pickInstrument(i)}
            className="font-pixel text-xs flex items-center gap-1 px-2 py-2 rounded border-2 transition-colors"
            style={{
              borderColor:
                instrument === i ? ACCENT : "rgba(255,255,255,0.2)",
              background: instrument === i ? `${ACCENT}55` : "transparent",
              color: "#f4f1de",
            }}
            title={inst.label}
          >
            <span style={{ fontSize: 14 }}>{inst.icon}</span>
            <span style={{ fontSize: 8 }}>{inst.label}</span>
          </button>
        ))}
      </div>

      {/* Now-playing readout — names the note(s) currently sounding so
          the kid links the music they made to the letters on the staff. */}
      <div
        className="mb-4 flex items-center gap-3 rounded px-3 py-2"
        style={{
          background: "rgba(255,255,255,0.04)",
          border: `2px solid ${ACCENT}55`,
          minHeight: 52,
        }}
      >
        <span className="font-body text-lg text-white/55">♪ Note:</span>
        <div className="flex items-center gap-3">
          {shownNotes.length === 0 ? (
            <span className="font-body text-lg text-white/30">
              {playing ? "♩ rest" : "tap a dot or press Play"}
            </span>
          ) : (
            shownNotes.map((pitch) => (
              <span
                key={pitch.name}
                className="font-pixel"
                style={{
                  fontSize: 20,
                  color: pitch.color,
                  textShadow: `0 0 10px ${pitch.color}99`,
                }}
              >
                {pitch.name}
              </span>
            ))
          )}
        </div>
      </div>

      {/* Grid + staff share a horizontal scroll container so the full
          16 steps stay tappable on narrow phone viewports. */}
      <div className="overflow-x-auto pb-2">
        {/* Step grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `${ROW_LABEL_W}px repeat(${STEPS}, ${CELL}px)`,
            width: GRID_W,
          }}
        >
          {PITCHES.map((pitch, p) => (
            <div key={pitch.name} style={{ display: "contents" }}>
              <div
                className="flex items-center justify-end pr-1 font-pixel"
                style={{ fontSize: 8, color: pitch.color, height: CELL }}
              >
                {pitch.name}
              </div>
              {Array.from({ length: STEPS }, (_, s) => {
                const active = grid[p][s];
                const beat = Math.floor(s / 4) % 2 === 0;
                const isHead = s === currentStep;
                return (
                  <button
                    key={s}
                    onClick={() => toggleCell(p, s)}
                    aria-label={`${pitch.name} step ${s + 1}`}
                    style={{
                      width: CELL,
                      height: CELL,
                      border: "1px solid rgba(255,255,255,0.08)",
                      background: isHead
                        ? "rgba(255,255,255,0.14)"
                        : beat
                        ? "rgba(255,255,255,0.05)"
                        : "rgba(255,255,255,0.02)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                      padding: 0,
                    }}
                  >
                    <span
                      style={{
                        width: CELL * 0.62,
                        height: CELL * 0.62,
                        borderRadius: "50%",
                        background: active ? pitch.color : "transparent",
                        boxShadow: active
                          ? `0 0 6px ${pitch.color}aa`
                          : "none",
                        transition: "background 80ms",
                      }}
                    />
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Staff mirror */}
        <svg
          width={GRID_W}
          height={staffHeight}
          style={{ display: "block", marginTop: 10 }}
        >
          {/* 5 staff lines (F5, D5, B4, G4, E4 — staffSteps 0,2,4,6,8) */}
          {[0, 2, 4, 6, 8].map((ss) => (
            <line
              key={ss}
              x1={ROW_LABEL_W}
              y1={staffY(ss)}
              x2={GRID_W - 4}
              y2={staffY(ss)}
              stroke="rgba(255,255,255,0.4)"
              strokeWidth={1}
            />
          ))}
          {/* Treble clef */}
          <text
            x={ROW_LABEL_W - 26}
            y={staffY(STAFF_BOTTOM_STEP) + 2}
            fontSize={STAFF_GAP * 6.5}
            fill="#f4f1de"
            fontFamily="Georgia, 'Times New Roman', serif"
          >
            𝄞
          </text>
          {/* Playhead */}
          {playing && currentStep >= 0 && (
            <rect
              x={colX(currentStep) - CELL / 2}
              y={staffY(0) - 10}
              width={CELL}
              height={staffY(MIDDLE_C_STEP) - staffY(0) + 20}
              fill="rgba(255,255,255,0.1)"
            />
          )}
          {/* Noteheads */}
          {placed.map(({ step, p }, i) => {
            const pitch = PITCHES[p];
            const cx = colX(step);
            const cy = staffY(pitch.staffStep);
            const needsLedger = pitch.staffStep >= MIDDLE_C_STEP;
            return (
              <g key={i}>
                {needsLedger && (
                  <line
                    x1={cx - 10}
                    y1={cy}
                    x2={cx + 10}
                    y2={cy}
                    stroke="rgba(255,255,255,0.55)"
                    strokeWidth={1}
                  />
                )}
                {/* stem */}
                <line
                  x1={cx + 6}
                  y1={cy}
                  x2={cx + 6}
                  y2={cy - 26}
                  stroke={pitch.color}
                  strokeWidth={1.5}
                />
                <ellipse
                  cx={cx}
                  cy={cy}
                  rx={6}
                  ry={4.5}
                  fill={pitch.color}
                  stroke="#0f0f1e"
                  strokeWidth={0.5}
                />
                {/* Letter name to the left of the notehead — turns the
                    abstract notation into something a beginner can read. */}
                <text
                  x={cx - 11}
                  y={cy + 3.5}
                  textAnchor="middle"
                  fontSize={11}
                  fill={pitch.color}
                  style={{ fontFamily: "var(--font-vt323), monospace" }}
                >
                  {pitch.name[0]}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
