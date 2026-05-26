"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import GameWorld from "./GameWorld";
import { getSectionByPath } from "@/app/lib/sections";

// Custom event names CameraRig + the router listen for. Decoupling
// via window.dispatchEvent avoids prop-drilling a ref/callback from
// GameShell through GameWorld → Scene → CameraRig just for these
// little overlay buttons.
const RESET_CAMERA_EVENT = "reset-camera";
const CHESS_NEW_GAME_EVENT = "chess-new-game";
const CHESS_RESIGN_EVENT = "chess-resign";

// Easter-egg discovery tally. Each id is dispatched on
// `easter-egg-found` (from Scene) when the corresponding
// choreography completes; the pill listens and persists the
// found set in localStorage. No in-UI list of egg names — the
// pill is just a tally so visitors don't get spoilers.
const EGG_IDS = ["gator", "coaster", "golf", "river", "balloon"] as const;
const EGG_STORAGE_KEY = "personal-site:eggs-found";

// Play-mode background music. Loops while play mode is active,
// pauses on exit. Volume is intentionally modest so the synthesized
// belt-pickup chirp and chess move taps still cut through. The
// mute preference persists in localStorage so a kid who muted on
// one visit doesn't get blasted on the next.
const MUSIC_SRC = "/game-music.mp3";
const MUSIC_VOLUME = 0.45;
const MUSIC_MUTE_STORAGE_KEY = "personal-site:music-muted";

// One-shot fanfare played the moment the kid collects their final
// belt (count === PLAY_BELT_TOTAL). Louder than the loop so it
// cuts through; obeys the same mute toggle as the bg music since
// it's "the game's music" from a user perspective.
const SUCCESS_SRC = "/belt-success.mp3";
const SUCCESS_VOLUME = 0.7;

function ResetViewButton() {
  return (
    <button
      type="button"
      onClick={() => {
        window.dispatchEvent(new CustomEvent(RESET_CAMERA_EVENT));
      }}
      aria-label="Reset camera to plaza view"
      className="
        absolute bottom-4 right-4 z-10
        h-12 w-12 rounded-full
        flex items-center justify-center
        bg-black/60 hover:bg-black/80 active:bg-black/90
        text-white text-xl
        border border-white/20
        backdrop-blur-sm
        shadow-lg shadow-black/40
        transition-colors
        cursor-pointer
        select-none
      "
    >
      {/* Viewfinder-corners icon — universally read as "reframe /
          fit to view," which matches what the button actually does
          (snap the camera back to the default plaza vantage). */}
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M3 9V3h6" />
        <path d="M21 9V3h-6" />
        <path d="M3 15v6h6" />
        <path d="M21 15v6h-6" />
      </svg>
    </button>
  );
}

// Bottom-left companion to ResetViewButton. Clears every
// `personal-site:*` localStorage entry (level unlocks, easter-egg
// tally, character selection, music-muted, etc.) and reloads so the
// visitor lands fresh on level 1. Two-state — the bare ↻ icon
// expands into a confirmation pill on click so an accidental tap
// doesn't wipe a returning visitor's progress. Visible in both
// portfolio + play modes so anyone can demo the locked-building
// flow without DevTools. Hidden inside the full 3D interiors
// (chess/academy/puzzle) — they have their own Exit button up top
// and the bottom-left corner stays clear for their own UI.
function ResetProgressButton() {
  const [confirming, setConfirming] = useState(false);
  function doReset() {
    if (typeof window === "undefined") return;
    try {
      Object.keys(window.localStorage)
        .filter((k) => k.startsWith("personal-site:"))
        .forEach((k) => window.localStorage.removeItem(k));
    } catch {
      // private mode / storage blocked — nothing to clear, just reload
    }
    window.location.reload();
  }
  if (confirming) {
    return (
      <div
        role="dialog"
        aria-label="Confirm reset progress"
        className="
          absolute bottom-4 left-4 z-10
          flex items-center gap-2
          bg-black/80 text-white
          border border-amber-300/60
          rounded-full
          backdrop-blur-sm
          shadow-lg shadow-black/40
          pl-4 pr-2 py-1
          select-none
        "
      >
        <span className="text-xs sm:text-sm uppercase tracking-wider">
          Reset progress?
        </span>
        <button
          type="button"
          onClick={doReset}
          className="
            h-8 px-3 rounded-full
            bg-amber-400 hover:bg-amber-300 active:bg-amber-500
            text-black text-xs font-bold uppercase tracking-wider
            cursor-pointer transition-colors
          "
        >
          Yes
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="
            h-8 px-3 rounded-full
            bg-white/15 hover:bg-white/25
            text-white text-xs font-bold uppercase tracking-wider
            cursor-pointer transition-colors
          "
        >
          No
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      aria-label="Reset progress"
      title="Reset progress"
      className="
        absolute bottom-4 left-4 z-10
        h-12 w-12 rounded-full
        flex items-center justify-center
        bg-black/60 hover:bg-black/80 active:bg-black/90
        text-white text-xl
        border border-white/20
        backdrop-blur-sm
        shadow-lg shadow-black/40
        transition-colors
        cursor-pointer
        select-none
      "
    >
      {/* Lucide-style rotate-ccw refresh icon. SVG (not a unicode
          glyph) so it renders identically across fonts — Press
          Start 2P doesn't have ↻ and falls back to an ugly box
          that reads as a letter. Sized to fill the pill cleanly. */}
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
        <path d="M3 3v5h5" />
      </svg>
    </button>
  );
}

// Exit-the-scene button shown on routes that render a full 3D
// interior (currently /jiu-jitsu and /chess). Navigates back to the
// plaza via plain anchor-style routing (Next.js intercepts it).
// The 3D scene flips back to the plaza on the route change.
function ExitSceneButton({ label }: { label: string }) {
  const router = useRouter();
  // CLIENT-side navigation (not <a href> with full page reload).
  // A reload would nuke React state — play mode would flip off,
  // belt count + points would reset, character position would
  // re-init. The character SELECTION survives because it's stored
  // in localStorage, but everything else would vanish. router.push
  // keeps React state intact across the route change.
  return (
    <button
      type="button"
      onClick={() => router.push("/")}
      aria-label={`Exit ${label} and return to the plaza`}
      className="
        absolute top-4 left-4 z-10
        h-12 px-4
        flex items-center gap-2
        bg-black/60 hover:bg-black/80 active:bg-black/90
        text-white text-sm uppercase tracking-wider
        border border-white/20
        rounded-full
        backdrop-blur-sm
        shadow-lg shadow-black/40
        transition-colors
        cursor-pointer
        select-none
      "
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M15 18l-6-6 6-6" />
      </svg>
      <span>Exit</span>
    </button>
  );
}

// Captured-pieces HUD for /chess. Shows two rows (Stockfish's
// captures on top, player's captures on bottom) with Unicode chess
// piece glyphs colored to match the side whose piece was taken.
// State arrives via the `chess-captures-update` window event that
// ChessRoom dispatches whenever the captures lists change.
type PieceType = "p" | "n" | "b" | "r" | "q" | "k";
type PieceColor = "w" | "b";
type CapturesPayload = {
  player: PieceType[];
  ai: PieceType[];
  playerColor: PieceColor;
};
// Unicode chess glyphs — outline (white) variants in the "w" row,
// filled (black) variants in the "b" row. Modern OS fonts ship
// these reliably; if a system lacks them they fall back to a
// generic placeholder glyph (still readable in context).
const PIECE_GLYPH: Record<PieceColor, Record<PieceType, string>> = {
  w: { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" },
  b: { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" },
};
// Standard material values for the +N material advantage label.
const PIECE_VALUE: Record<PieceType, number> = {
  q: 9,
  r: 5,
  b: 3,
  n: 3,
  p: 1,
  k: 0,
};

function ChessCapturesHUD() {
  const [data, setData] = useState<CapturesPayload>({
    player: [],
    ai: [],
    playerColor: "w",
  });
  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<CapturesPayload>).detail;
      if (detail) setData(detail);
    }
    window.addEventListener("chess-captures-update", handler);
    return () =>
      window.removeEventListener("chess-captures-update", handler);
  }, []);
  const opponentColor: PieceColor = data.playerColor === "w" ? "b" : "w";
  // Material advantage: positive = player ahead, negative = AI ahead.
  const playerScore = data.player.reduce(
    (s, t) => s + PIECE_VALUE[t],
    0
  );
  const aiScore = data.ai.reduce((s, t) => s + PIECE_VALUE[t], 0);
  const diff = playerScore - aiScore;
  return (
    <div
      className="
        absolute top-20 left-4 z-10
        flex flex-col gap-2
        bg-black/60 backdrop-blur-sm
        border border-white/20
        rounded-xl
        px-3 py-2
        shadow-lg shadow-black/40
      "
    >
      {/* Sonny's captures (pieces of player's color taken by the AI,
          which is visually represented by Sonny across the table) */}
      <div className="flex items-center gap-1 text-2xl">
        <span className="text-[10px] uppercase tracking-wider opacity-70 text-white mr-1">
          Sonny
        </span>
        {data.ai.length === 0 ? (
          <span className="text-xs text-white/40">—</span>
        ) : (
          data.ai.map((t, i) => (
            <span key={i} className="text-white leading-none">
              {PIECE_GLYPH[data.playerColor][t]}
            </span>
          ))
        )}
        {diff < 0 && (
          <span className="text-xs text-white/70 ml-1">+{-diff}</span>
        )}
      </div>
      {/* Player's captures (pieces of opponent's color taken by player) */}
      <div className="flex items-center gap-1 text-2xl">
        <span className="text-[10px] uppercase tracking-wider opacity-70 text-white mr-1">
          You
        </span>
        {data.player.length === 0 ? (
          <span className="text-xs text-white/40">—</span>
        ) : (
          data.player.map((t, i) => (
            <span key={i} className="text-white leading-none">
              {PIECE_GLYPH[opponentColor][t]}
            </span>
          ))
        )}
        {diff > 0 && (
          <span className="text-xs text-white/70 ml-1">+{diff}</span>
        )}
      </div>
    </div>
  );
}

// In-game buttons shown only on /chess. Both wired to ChessRoom
// via window CustomEvents so they don't need refs into the
// canvas's React tree.
function ChessControls() {
  return (
    <div
      className="
        absolute top-4 right-4 z-10
        flex gap-2
      "
    >
      <button
        type="button"
        onClick={() =>
          window.dispatchEvent(new CustomEvent(CHESS_RESIGN_EVENT))
        }
        aria-label="Resign the current chess game"
        className="
          h-12 px-4
          flex items-center justify-center
          bg-black/60 hover:bg-black/80 active:bg-black/90
          text-white text-sm uppercase tracking-wider
          border border-white/20
          rounded-full
          backdrop-blur-sm
          shadow-lg shadow-black/40
          transition-colors
          cursor-pointer
          select-none
        "
      >
        Resign
      </button>
      <button
        type="button"
        onClick={() =>
          window.dispatchEvent(new CustomEvent(CHESS_NEW_GAME_EVENT))
        }
        aria-label="Start a new chess game"
        className="
          h-12 px-4
          flex items-center justify-center
          bg-black/60 hover:bg-black/80 active:bg-black/90
          text-white text-sm uppercase tracking-wider
          border border-white/20
          rounded-full
          backdrop-blur-sm
          shadow-lg shadow-black/40
          transition-colors
          cursor-pointer
          select-none
        "
      >
        New Game
      </button>
    </div>
  );
}

// Total black belts hidden in the world during play mode. 5 sit
// at ground level around the plaza (see `BELT_PICKUPS` in
// GameWorld); the other 3 will float in the lazy river. When this
// changes, update the corresponding world data too.
// Denominator on the `▰ X/Y BELTS` pill. Matches the layout in
// GameWorld:
//   - 5 plaza belts (ground)
//   - 1 carnival belt (ground)
//   - 3 bridge belts (atop each arch deck)
//   - 10 river belts (mid-float along the lazy-river curve)
//   - 1 golf belt (next to the cup, awarded on first sink)
//   - 1 chess belt (awarded on first chess win per play session)
// = 21. Bump this in lockstep with BELT_PICKUPS / RIVER_BELT_PICKUPS
// edits or the HUD count will drift from the actual total.
const PLAY_BELT_TOTAL = 22;
// Number of belts the kid can collect by walking around the world
// (5 plaza + 1 carnival + 3 bridge + 10 river + 1 golf cup). Chess
// + puzzle belts add 1 each, bringing the displayed tally to 22 —
// but the "jump for joy" fanfare in BeltSuccessChime fires the
// moment they've collected all the WALKING ones, so it stays
// pinned to this lower count even as PLAY_BELT_TOTAL grows.
const PLAY_WALKING_BELT_TOTAL = 20;

// Points scoring. Belts contribute a fixed amount per pickup;
// chess wins add a bonus on top of the belt the win also grants;
// missed putts on the golf green subtract a penalty so kids
// can't infinite-attempt the cup. Resets on every
// `play-mode-reset` (same lifecycle as the belt counter — score
// is per-session, not cumulative across visits). PointsHUD
// clamps the running score at 0 so a string of missed putts
// doesn't push it negative.
const POINTS_PER_BELT = 100;
const POINTS_PER_CHESS_WIN = 500;
const POINTS_PER_PUZZLE_WIN = 1000;
const POINTS_PER_PUTT_MISS = 25;

// localStorage flag set when the kid completes level 1 (= wins
// chess after collecting all 20 walking belts). Future levels
// (level 2 = puzzle house in the former CODE building) gate on
// this — the puzzle-house door reads it on mount to decide
// whether to allow entry. Persisted across reloads so progress
// sticks.
const LEVEL2_UNLOCK_STORAGE_KEY = "personal-site:level2-unlocked";
// Set after the kid solves all 3 puzzles in the puzzle house. The
// MUSIC building reads its minLevel against the unlocked level and
// pops into the plaza when this flips to "1".
const LEVEL3_UNLOCK_STORAGE_KEY = "personal-site:level3-unlocked";

// Toggle that flips between portfolio mode (click-to-walk + orbit
// camera + easter eggs) and play mode (WASD + jump + follow cam +
// stripe collectibles). The button label and color change with the
// active mode so the affordance is obvious.
function PlayToggleButton({
  playMode,
  onToggle,
}: {
  playMode: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={playMode ? "Exit play mode" : "Enter play mode"}
      className={`
        absolute top-4 right-4 z-10 select-none
        h-12 px-4
        flex items-center gap-2
        text-white text-sm uppercase tracking-wider
        border rounded-full
        backdrop-blur-sm
        shadow-lg shadow-black/40
        transition-colors
        cursor-pointer
        ${
          playMode
            ? "bg-red-600/70 hover:bg-red-600/85 border-red-300/40"
            : "bg-emerald-600/70 hover:bg-emerald-600/85 border-emerald-300/40"
        }
      `}
    >
      {playMode ? (
        <>
          <span aria-hidden>✕</span>
          <span>Exit Play</span>
        </>
      ) : (
        <>
          <span aria-hidden>▶</span>
          <span>Play</span>
        </>
      )}
    </button>
  );
}

// HUD shown only while play mode is active — a running black-belt
// tally the kid can glance at to see how many they have left to
// grab. Owns its own count state and listens to `belt-collected`
// + `play-mode-reset` window events directly. This is DELIBERATE:
// if the count lived on GameShell, every collect would re-render
// GameShell → GameWorld → the whole 3D scene tree, producing a
// one-frame hitch that read as a "blip" when grabbing a belt.
// Co-locating the state with the HUD that reads it isolates the
// update so the canvas never reconciles on collect. Same pattern
// as `EasterEggTally` above.
function BeltHUD() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    function onCollect() {
      setCount((n) => n + 1);
    }
    function onReset() {
      setCount(0);
    }
    window.addEventListener("belt-collected", onCollect);
    window.addEventListener("play-mode-reset", onReset);
    return () => {
      window.removeEventListener("belt-collected", onCollect);
      window.removeEventListener("play-mode-reset", onReset);
    };
  }, []);
  return (
    <div
      role="status"
      aria-label={`${count} of ${PLAY_BELT_TOTAL} black belts collected`}
      className="
        absolute top-20 right-4 z-10 select-none
        h-12 px-4
        flex items-center gap-2
        bg-black/60
        text-white text-sm uppercase tracking-wider
        border border-white/20
        rounded-full
        backdrop-blur-sm
        shadow-lg shadow-black/40
      "
    >
      <span aria-hidden className="text-amber-300 leading-none">▰</span>
      <span className="tabular-nums">
        {count}/{PLAY_BELT_TOTAL}
      </span>
      <span className="opacity-80">belts</span>
    </div>
  );
}

// Running points tally. Sits below `<BeltHUD>` in the top-right
// stack. Owns its own count + listens directly to the
// `belt-collected` (+POINTS_PER_BELT) and `chess-won`
// (+POINTS_PER_CHESS_WIN) window events so GameShell never
// re-renders on score change — same anti-blip pattern as BeltHUD.
// Number is grouped with commas so 1,200 reads clearly. Reset to
// 0 on `play-mode-reset`.
function PointsHUD() {
  const [score, setScore] = useState(0);
  useEffect(() => {
    function onBelt() {
      setScore((n) => n + POINTS_PER_BELT);
    }
    function onChess() {
      setScore((n) => n + POINTS_PER_CHESS_WIN);
    }
    function onPuzzle() {
      setScore((n) => n + POINTS_PER_PUZZLE_WIN);
    }
    function onPuttMiss() {
      // Clamp at 0 so a streak of misses doesn't tank the score
      // into negatives — confusing for kids and out of step with
      // the "earn belts" framing of the rest of the game.
      setScore((n) => Math.max(0, n - POINTS_PER_PUTT_MISS));
    }
    function onReset() {
      setScore(0);
    }
    window.addEventListener("belt-collected", onBelt);
    window.addEventListener("chess-won", onChess);
    window.addEventListener("puzzle-won", onPuzzle);
    window.addEventListener("putt-missed", onPuttMiss);
    window.addEventListener("play-mode-reset", onReset);
    return () => {
      window.removeEventListener("belt-collected", onBelt);
      window.removeEventListener("chess-won", onChess);
      window.removeEventListener("puzzle-won", onPuzzle);
      window.removeEventListener("putt-missed", onPuttMiss);
      window.removeEventListener("play-mode-reset", onReset);
    };
  }, []);
  return (
    <div
      role="status"
      aria-label={`${score} points`}
      className="
        absolute top-36 right-4 z-10 select-none
        h-12 px-4
        flex items-center gap-2
        bg-black/60
        text-white text-sm uppercase tracking-wider
        border border-white/20
        rounded-full
        backdrop-blur-sm
        shadow-lg shadow-black/40
      "
    >
      <span aria-hidden className="text-amber-300 leading-none">★</span>
      <span className="tabular-nums">{score.toLocaleString()}</span>
      <span className="opacity-80">pts</span>
    </div>
  );
}

// Hint shown the moment the kid hits 20/21 belts. The 21st belt
// is ONLY earnable by winning a chess game (see ChessRoom +
// chess-player-won dispatch), and it isn't obvious from the
// HUD which slot is "chess." This banner appears center-top
// once the walking belts are all collected, and stays up until
// Centered banner shown when the visitor clicks a LOCKED building
// on the plaza. Listens for `show-locked-banner` events fired by
// GameWorld's handleBuildingClick when a section's minLevel is
// above the unlocked level. Auto-hides after ~3 seconds. State
// lives here so GameShell stays inert (no scene-tree re-render
// on every banner toggle). Visible in both portfolio + play mode
// since locked buildings are visible in both.
function LockedBuildingBanner() {
  const [msg, setMsg] = useState<{ label: string; level: number } | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    let hideTid: ReturnType<typeof setTimeout> | null = null;
    function onShow(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { sectionLabel: string; requiredLevel: number }
        | undefined;
      if (!detail) return;
      setMsg({ label: detail.sectionLabel, level: detail.requiredLevel });
      if (hideTid) clearTimeout(hideTid);
      hideTid = setTimeout(() => setMsg(null), 6000);
    }
    window.addEventListener("show-locked-banner", onShow);
    return () => {
      window.removeEventListener("show-locked-banner", onShow);
      if (hideTid) clearTimeout(hideTid);
    };
  }, []);
  if (!msg) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="
        absolute top-[18%] left-1/2 -translate-x-1/2 z-40 select-none
        pointer-events-none
        animate-in fade-in zoom-in-95 duration-200
      "
    >
      <div
        className="
          flex items-center gap-3
          px-6 py-3
          bg-black/75 text-white
          border-2 border-amber-300/70
          rounded-full
          backdrop-blur-sm
          shadow-2xl shadow-black/60
        "
      >
        <span className="text-2xl" aria-hidden>
          🔒
        </span>
        <span className="text-sm sm:text-base uppercase tracking-wider font-semibold">
          {msg.label} — Unlock by completing Level {msg.level}
        </span>
      </div>
    </div>
  );
}

// the chess win lands the 21st belt → celebration fires →
// banner is dismissed on play-mode-reset. Tracks its own count
// + chess-belt-seen flag from window events so GameShell stays
// inert (same anti-blip pattern as BeltHUD).
function ChessHintBanner() {
  const router = useRouter();
  const [visible, setVisible] = useState(false);
  // Refs let the click handler read the latest count + dismissal
  // state without re-binding listeners every render.
  const dismissedRef = useRef(false);
  useEffect(() => {
    let celebrationDone = false;
    let chessAwarded = false;
    let dismissed = false;
    function recompute() {
      // Banner shows AFTER the jump-for-joy celebration ends (which
      // itself fires at the 20th walking belt — see BeltSuccessChime
      // above). If chess has already been won, no banner — the kid
      // has nothing left to do. Once the kid dismisses (move key or
      // tap), banner stays hidden until next play-mode-reset.
      dismissedRef.current = dismissed;
      setVisible(celebrationDone && !chessAwarded && !dismissed);
    }
    function onCollect(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail === "chess") {
        chessAwarded = true;
        recompute();
      }
    }
    function onCelebrationDone() {
      celebrationDone = true;
      recompute();
    }
    function onReset() {
      celebrationDone = false;
      chessAwarded = false;
      dismissed = false;
      recompute();
    }
    // Any movement key (WASD / arrows / Space jump) dismisses the
    // hint so it stops covering the play area once the kid resumes
    // playing. Stays dismissed until `play-mode-reset` clears the
    // session. TouchControls dispatch real KeyboardEvents on window
    // so a single physical-key listener handles both input modes.
    //
    // **Critical gate** (two parts):
    //
    // (1) Only count key presses AFTER the celebration has ended.
    //     The kid is often holding W/A/D to walk into the 20th
    //     belt; mid-celebration presses would otherwise dismiss
    //     the banner before it ever rendered.
    //
    // (2) Ignore `e.repeat = true` events. If the kid is STILL
    //     holding the same key when the celebration ends, the
    //     browser fires auto-repeat keydowns every ~30 ms; the
    //     first one after `celebrationDone` would dismiss the
    //     banner the same frame it appears. By requiring a fresh
    //     press (`!e.repeat`), the kid has to actually release
    //     and re-press a key to dismiss — exactly the "I'm done
    //     reading, back to playing" signal we want. TouchControls
    //     fire keydowns from PointerDown only (no auto-repeat) so
    //     a touch tap always has `e.repeat = false`.
    function onKey(e: KeyboardEvent) {
      if (!celebrationDone) return;
      if (e.repeat) return;
      const k = e.code;
      const isGameKey =
        k === "KeyW" || k === "KeyA" || k === "KeyS" || k === "KeyD" ||
        k === "ArrowUp" || k === "ArrowDown" ||
        k === "ArrowLeft" || k === "ArrowRight" ||
        k === "Space";
      if (isGameKey && !dismissed) {
        dismissed = true;
        recompute();
      }
    }
    window.addEventListener("belt-collected", onCollect);
    window.addEventListener("celebration-done", onCelebrationDone);
    window.addEventListener("play-mode-reset", onReset);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("belt-collected", onCollect);
      window.removeEventListener("celebration-done", onCelebrationDone);
      window.removeEventListener("play-mode-reset", onReset);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  if (!visible) return null;
  // Clickable: tapping the pill is a shortcut to the chess room.
  // Hides itself immediately (so the chip doesn't linger over the
  // transition) and pushes the route — same destination as the
  // proximity auto-enter when you walk up to the chess building.
  return (
    <button
      type="button"
      onClick={() => {
        dismissedRef.current = true;
        setVisible(false);
        router.push("/chess");
      }}
      aria-label="Beat Sonny at chess to earn your final belt"
      className="
        absolute top-72 left-1/2 -translate-x-1/2 z-20 select-none
        max-w-[88vw] w-max
        px-5 py-3
        flex items-center gap-3
        bg-amber-500/95 hover:bg-amber-400/95 active:bg-amber-600/95
        text-amber-950 text-xs sm:text-sm uppercase tracking-wide font-semibold
        text-center cursor-pointer
        border-2 border-amber-200/80
        rounded-2xl
        backdrop-blur-sm
        shadow-lg shadow-black/50
        transition-colors
        animate-in fade-in slide-in-from-top-3 duration-300
      "
    >
      <span aria-hidden className="text-lg leading-none">♟</span>
      <span>Beat Sonny at chess to earn your final belt!</span>
    </button>
  );
}

// Invisible companion to BeltHUD — listens to `belt-collected`
// + `play-mode-reset`, keeps its own running count, and plays
// the one-shot fanfare MP3 the moment the count crosses
// `PLAY_BELT_TOTAL`. Audio side-effect lives here (not inside
// BeltHUD) so the HUD stays a pure-display component and so the
// success chime can be muted in sync with the bg music via the
// shared `musicMuted` prop — the kid who muted the loop
// presumably doesn't want a sudden trumpet either.
function BeltSuccessChime({ musicMuted }: { musicMuted: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Init the audio element once (client only). Preloads so the
  // playback on completion is instant — the file is tiny (~57 KB)
  // so the cost is negligible.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const a = new Audio(SUCCESS_SRC);
    a.preload = "auto";
    a.volume = SUCCESS_VOLUME;
    audioRef.current = a;
    return () => {
      a.pause();
      a.src = "";
      audioRef.current = null;
    };
  }, []);
  // Mirror the bg-music mute state onto the chime so the toggle
  // applies to both.
  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = musicMuted;
  }, [musicMuted]);
  // Count + fire the fanfare AND the celebration. Reset on play-mode
  // toggle. The `belts-complete` window event is picked up by Scene
  // in GameWorld, which puts the character into `mode = "celebrating"`
  // — hops with arms in the air for ~4 sec to match the fanfare's
  // length.
  //
  // **Trigger is the 20 walking belts, NOT the 21-total** — kids
  // celebrate the moment they've collected everything they can
  // get from the world (plaza + carnival + bridges + river + golf).
  // The chess belt (detail === "chess") doesn't advance the
  // walkingCount, so winning chess BEFORE collecting all walking
  // belts won't pre-fire the celebration. Once celebrated, the
  // chime won't re-fire even if chess later pushes total to 21.
  useEffect(() => {
    let walkingCount = 0;
    let celebrated = false;
    function onCollect(e: Event) {
      const detail = (e as CustomEvent).detail;
      // Chess + puzzle belts come from level-complete celebrations,
      // not from walking the world — they shouldn't bump
      // walkingCount or re-trigger the fanfare.
      if (detail === "chess" || detail === "puzzle") return;
      walkingCount += 1;
      if (celebrated) return;
      if (walkingCount === PLAY_WALKING_BELT_TOTAL) {
        celebrated = true;
        const a = audioRef.current;
        if (a) {
          a.currentTime = 0;
          const p = a.play();
          if (p && typeof p.then === "function") {
            p.catch(() => {
              // Autoplay blocked or playback interrupted — silent
              // failure, nothing else depends on this sound.
            });
          }
        }
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("belts-complete"));
        }
      }
    }
    function onReset() {
      walkingCount = 0;
      celebrated = false;
      const a = audioRef.current;
      if (a) {
        a.pause();
        a.currentTime = 0;
      }
    }
    window.addEventListener("belt-collected", onCollect);
    window.addEventListener("play-mode-reset", onReset);
    return () => {
      window.removeEventListener("belt-collected", onCollect);
      window.removeEventListener("play-mode-reset", onReset);
    };
  }, []);
  return null;
}

// One-shot falling-confetti burst. Renders N small colored
// rectangles at the top of the viewport that fall through to the
// bottom with random horizontal drift + rotation. Pure CSS
// animation — no per-frame JS — so it's cheap even with 80+
// pieces. `active` is the show/hide signal; when it flips true
// the burst spawns + the keyframes run for ~5 s before the
// component auto-unmounts.
type ConfettiPiece = {
  id: number;
  left: number;     // viewport-relative starting x (%)
  size: number;     // base side length (px)
  color: string;
  delay: number;    // start delay (ms)
  duration: number; // total fall duration (ms)
  rotate: number;   // initial rotation (deg)
  drift: number;    // horizontal drift across the fall (vw)
};
function ConfettiBurst({ active }: { active: boolean }) {
  const [pieces, setPieces] = useState<ConfettiPiece[]>([]);
  useEffect(() => {
    if (!active) {
      setPieces([]);
      return;
    }
    const colors = [
      "#fbbf24", "#f87171", "#60a5fa", "#34d399",
      "#a78bfa", "#f472b6", "#fde047", "#fb923c",
    ];
    const N = 80;
    const seeded: ConfettiPiece[] = Array.from({ length: N }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      size: 6 + Math.random() * 8,
      color: colors[Math.floor(Math.random() * colors.length)],
      delay: Math.random() * 600,
      duration: 3200 + Math.random() * 2400,
      rotate: Math.random() * 360,
      drift: (Math.random() - 0.5) * 28,
    }));
    setPieces(seeded);
    // Hold the burst long enough that the slowest piece (duration
    // + delay) finishes. After that, drop the DOM nodes.
    const tid = setTimeout(() => setPieces([]), 6500);
    return () => clearTimeout(tid);
  }, [active]);
  if (pieces.length === 0) return null;
  return (
    <>
      <style>{`
        @keyframes confetti-fall {
          0%   { transform: translate(0, -20px) rotate(var(--rot-start)); opacity: 1; }
          85%  { opacity: 1; }
          100% { transform: translate(var(--drift), 110vh) rotate(calc(var(--rot-start) + 720deg)); opacity: 0; }
        }
        .confetti-piece {
          position: absolute;
          top: 0;
          animation-name: confetti-fall;
          animation-timing-function: cubic-bezier(0.45, 0, 0.6, 1);
          animation-fill-mode: forwards;
        }
      `}</style>
      <div className="fixed inset-0 z-30 pointer-events-none overflow-hidden">
        {pieces.map((p) => (
          <div
            key={p.id}
            className="confetti-piece rounded-sm"
            style={{
              left: `${p.left}vw`,
              width: `${p.size}px`,
              height: `${p.size * 0.4}px`,
              backgroundColor: p.color,
              animationDelay: `${p.delay}ms`,
              animationDuration: `${p.duration}ms`,
              ["--drift" as string]: `${p.drift}vw`,
              ["--rot-start" as string]: `${p.rotate}deg`,
            } as React.CSSProperties}
          />
        ))}
      </div>
    </>
  );
}

// Big celebratory overlay shown after the kid wins chess (= 21st
// belt). Listens for `level-complete` (detail: 1) and shows:
//   - confetti burst (<ConfettiBurst>)
//   - centered "LEVEL 1 COMPLETE!" message
//   - reuses the belt-success fanfare audio for the cheer
// Persists `LEVEL2_UNLOCK_STORAGE_KEY = "1"` on first show so the
// future puzzle house (in the CODE building) can gate entry on it.
// Auto-hides after ~6 s — long enough that the jump-for-joy
// celebration in Scene (4 s) finishes with a beat to spare.
function Level1CompleteOverlay({
  musicMuted,
  onContinue,
}: {
  musicMuted: boolean;
  onContinue: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const a = new Audio(SUCCESS_SRC);
    a.preload = "auto";
    a.volume = SUCCESS_VOLUME;
    audioRef.current = a;
    return () => {
      a.pause();
      a.src = "";
      audioRef.current = null;
    };
  }, []);
  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = musicMuted;
  }, [musicMuted]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onLevelComplete(e: Event) {
      const lvl = (e as CustomEvent).detail;
      if (lvl !== 1) return;
      setVisible(true);
      // Storage flag is written by the dispatch site (GameShell's
      // deferred level-complete useEffect) before the event fires,
      // so other listeners — like GameWorld's unlocked-level state
      // — see the up-to-date value when their handler runs.
      // Play the cheer.
      const a = audioRef.current;
      if (a) {
        a.currentTime = 0;
        const p = a.play();
        if (p && typeof p.then === "function") {
          p.catch(() => {});
        }
      }
    }
    function onReset() {
      setVisible(false);
    }
    window.addEventListener("level-complete", onLevelComplete);
    window.addEventListener("play-mode-reset", onReset);
    return () => {
      window.removeEventListener("level-complete", onLevelComplete);
      window.removeEventListener("play-mode-reset", onReset);
    };
  }, []);
  // Auto-hide once visible.
  useEffect(() => {
    if (!visible) return;
    const tid = setTimeout(() => setVisible(false), 6500);
    return () => clearTimeout(tid);
  }, [visible]);
  return (
    <>
      <ConfettiBurst active={visible} />
      {visible && (
        <div
          role="status"
          aria-live="polite"
          className="
            absolute top-[28%] left-1/2 -translate-x-1/2 z-40 select-none
            text-center
            animate-in fade-in zoom-in-95 duration-500
          "
        >
          <div
            className="
              text-amber-300 text-5xl sm:text-7xl font-black uppercase
              tracking-wider leading-none
              drop-shadow-[0_6px_24px_rgba(0,0,0,0.85)]
            "
            style={{
              textShadow:
                "0 0 12px rgba(251, 191, 36, 0.6), 0 4px 0 rgba(0, 0, 0, 0.5)",
            }}
          >
            Level 1
            <br />
            Complete!
          </div>
          <div
            className="
              mt-5 text-white text-sm sm:text-lg uppercase tracking-widest
              font-semibold opacity-95
              drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]
            "
          >
            ★ Level 2 unlocked ★
          </div>
          <button
            type="button"
            onClick={() => {
              // Hide the overlay immediately, then let GameShell
              // flip play mode off + dispatch walk-to-section so
              // the existing click-to-walk cinematic plays out.
              setVisible(false);
              onContinue();
            }}
            className="
              mt-8 px-6 py-3
              bg-amber-400 hover:bg-amber-300 active:bg-amber-500
              text-black font-bold text-base sm:text-lg uppercase tracking-wider
              rounded-full border-2 border-amber-200
              shadow-lg shadow-amber-900/40
              cursor-pointer transition-colors
            "
          >
            Continue ▸
          </button>
        </div>
      )}
    </>
  );
}

// Level 2 celebration. Same structure as the level 1 overlay —
// confetti + centred message + fanfare audio — but reads
// `level-complete` (detail: 2). No Continue button: the kid has
// already been routed back to the plaza by GameShell's
// puzzle-room-complete handler, and the unlocked MUSIC building
// is the natural next-step affordance.
function Level2CompleteOverlay({ musicMuted }: { musicMuted: boolean }) {
  const [visible, setVisible] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const a = new Audio(SUCCESS_SRC);
    a.preload = "auto";
    a.volume = SUCCESS_VOLUME;
    audioRef.current = a;
    return () => {
      a.pause();
      a.src = "";
      audioRef.current = null;
    };
  }, []);
  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = musicMuted;
  }, [musicMuted]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onLevelComplete(e: Event) {
      const lvl = (e as CustomEvent).detail;
      if (lvl !== 2) return;
      setVisible(true);
      const a = audioRef.current;
      if (a) {
        a.currentTime = 0;
        const p = a.play();
        if (p && typeof p.then === "function") {
          p.catch(() => {});
        }
      }
    }
    function onReset() {
      setVisible(false);
    }
    window.addEventListener("level-complete", onLevelComplete);
    window.addEventListener("play-mode-reset", onReset);
    return () => {
      window.removeEventListener("level-complete", onLevelComplete);
      window.removeEventListener("play-mode-reset", onReset);
    };
  }, []);
  useEffect(() => {
    if (!visible) return;
    const tid = setTimeout(() => setVisible(false), 6500);
    return () => clearTimeout(tid);
  }, [visible]);
  return (
    <>
      <ConfettiBurst active={visible} />
      {visible && (
        <div
          role="status"
          aria-live="polite"
          className="
            absolute top-[28%] left-1/2 -translate-x-1/2 z-40 select-none
            text-center
            animate-in fade-in zoom-in-95 duration-500
          "
        >
          <div
            className="
              text-emerald-300 text-5xl sm:text-7xl font-black uppercase
              tracking-wider leading-none
              drop-shadow-[0_6px_24px_rgba(0,0,0,0.85)]
            "
            style={{
              textShadow:
                "0 0 12px rgba(110, 231, 183, 0.6), 0 4px 0 rgba(0, 0, 0, 0.5)",
            }}
          >
            Level 2
            <br />
            Complete!
          </div>
          <div
            className="
              mt-5 text-white text-sm sm:text-lg uppercase tracking-widest
              font-semibold opacity-95
              drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]
            "
          >
            ★ Music house unlocked ★
          </div>
        </div>
      )}
    </>
  );
}

// Mute / unmute the background play-mode music. Renders a small
// pill with a speaker icon; tapping toggles the parent's `muted`
// state, which both flips `audio.muted` on the HTMLAudioElement
// and persists the preference to localStorage. Placed at the
// bottom of the right-side stack: Play → Belts → Points → Mute.
function MuteButton({
  muted,
  onToggle,
}: {
  muted: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={muted ? "Unmute music" : "Mute music"}
      title={muted ? "Unmute music" : "Mute music"}
      className="
        absolute top-52 right-4 z-10 select-none
        h-12 px-4
        flex items-center gap-2
        bg-black/60 hover:bg-black/75
        text-white text-sm uppercase tracking-wider
        border border-white/20
        rounded-full
        backdrop-blur-sm
        shadow-lg shadow-black/40
        cursor-pointer
        transition-colors
      "
    >
      <span aria-hidden className="leading-none">
        {muted ? "🔇" : "🔊"}
      </span>
      <span>{muted ? "Muted" : "Music"}</span>
    </button>
  );
}

// Mobile touch controls — shown only on coarse-pointer devices
// while play mode is active. Two thumb clusters at the bottom of
// the screen:
//   - LEFT (forward / back stacked)
//   - RIGHT (turn-left + turn-right, with JUMP above)
// Each button dispatches a synthetic KeyboardEvent so the existing
// play-mode input pipeline (which listens on window keydown/keyup)
// handles them with no extra glue. PointerCancel + PointerLeave
// also fire keyup so a finger that slides off a button doesn't
// leave the key "stuck down".
function TouchControls() {
  const [isTouch, setIsTouch] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(pointer: coarse)");
    setIsTouch(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsTouch(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  if (!isTouch) return null;

  function emit(key: string, code: string, type: "keydown" | "keyup") {
    window.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true }));
  }
  function bind(key: string, code: string) {
    return {
      onPointerDown: (e: React.PointerEvent) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        emit(key, code, "keydown");
      },
      onPointerUp: () => emit(key, code, "keyup"),
      onPointerCancel: () => emit(key, code, "keyup"),
      onPointerLeave: () => emit(key, code, "keyup"),
    };
  }

  const buttonClass =
    "select-none touch-none flex items-center justify-center " +
    "bg-black/55 active:bg-black/80 " +
    "text-white text-2xl font-bold " +
    "border border-white/25 rounded-full " +
    "backdrop-blur-sm shadow-lg shadow-black/40 " +
    "transition-colors";

  return (
    <>
      {/* LEFT CLUSTER — forward / back stacked. Bottom-left corner. */}
      <div className="absolute bottom-6 left-6 z-10 flex flex-col gap-3">
        <button
          type="button"
          aria-label="Move forward"
          className={`${buttonClass} w-16 h-16`}
          {...bind("w", "KeyW")}
        >
          ↑
        </button>
        <button
          type="button"
          aria-label="Move backward"
          className={`${buttonClass} w-16 h-16`}
          {...bind("s", "KeyS")}
        >
          ↓
        </button>
      </div>
      {/* RIGHT CLUSTER — jump on top, turn-left / turn-right below.
          Slight width on each side so the cluster reads as a single
          touch target zone. */}
      <div className="absolute bottom-6 right-6 z-10 flex flex-col items-center gap-3">
        <button
          type="button"
          aria-label="Jump"
          className={`${buttonClass} w-20 h-16 text-sm tracking-wider uppercase`}
          {...bind(" ", "Space")}
        >
          Jump
        </button>
        <div className="flex gap-3">
          <button
            type="button"
            aria-label="Turn left"
            className={`${buttonClass} w-16 h-16`}
            {...bind("a", "KeyA")}
          >
            ←
          </button>
          <button
            type="button"
            aria-label="Turn right"
            className={`${buttonClass} w-16 h-16`}
            {...bind("d", "KeyD")}
          >
            →
          </button>
        </div>
      </div>
    </>
  );
}

// Tiny on-screen hint of the play-mode controls — fades out after
// a few seconds so it doesn't clutter the screen. Adapts the
// shown hint to the device: desktop sees the keyboard mapping,
// touch sees a "rotate your phone for more room" tip on portrait
// (the touch button overlay already shows the controls visually).
function PlayControlsHint() {
  const [visible, setVisible] = useState(true);
  const [isTouch, setIsTouch] = useState(false);
  const [isPortrait, setIsPortrait] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setVisible(false), 5000);
    return () => clearTimeout(id);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const touchMq = window.matchMedia("(pointer: coarse)");
    const portraitMq = window.matchMedia("(orientation: portrait)");
    setIsTouch(touchMq.matches);
    setIsPortrait(portraitMq.matches);
    const onTouch = (e: MediaQueryListEvent) => setIsTouch(e.matches);
    const onPortrait = (e: MediaQueryListEvent) => setIsPortrait(e.matches);
    touchMq.addEventListener("change", onTouch);
    portraitMq.addEventListener("change", onPortrait);
    return () => {
      touchMq.removeEventListener("change", onTouch);
      portraitMq.removeEventListener("change", onPortrait);
    };
  }, []);
  if (!visible) return null;
  // Touch portrait → suggest rotating for more room.
  // Touch landscape → no hint (controls are obvious on screen).
  // Desktop → keyboard mapping.
  if (isTouch && !isPortrait) return null;
  return (
    <div
      className="
        absolute top-4 left-1/2 -translate-x-1/2 z-10 select-none
        px-4 py-2
        bg-black/60
        text-white text-xs uppercase tracking-wider
        border border-white/20
        rounded-full
        backdrop-blur-sm
        shadow-lg shadow-black/40
        pointer-events-none
      "
    >
      {isTouch ? (
        <>
          Tip: rotate your phone for more room
        </>
      ) : (
        <>
          Move: <span className="text-amber-300">WASD</span> &nbsp;•&nbsp;
          Turn: <span className="text-amber-300">←/→</span> &nbsp;•&nbsp;
          Jump: <span className="text-amber-300">Space</span>
        </>
      )}
    </div>
  );
}

// Top-left HUD chip — a no-spoilers tally of how many easter eggs
// the visitor has found, with a small × on the right that resets
// the count. Discovery state arrives via the `easter-egg-found`
// window event Scene dispatches when a choreography completes;
// the found set is persisted in localStorage so the tally
// survives reloads.
function EasterEggTally() {
  const [found, setFound] = useState<Set<string>>(new Set());

  // Load discovery state on mount.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(EGG_STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setFound(new Set(parsed.filter((x): x is string => typeof x === "string")));
      }
    } catch {
      // Ignore: corrupted JSON, storage disabled, etc. Tally just stays at 0.
    }
  }, []);

  // Listen for completions dispatched from Scene.
  useEffect(() => {
    function handler(e: Event) {
      const id = (e as CustomEvent<string>).detail;
      if (!id) return;
      setFound((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        try {
          window.localStorage.setItem(
            EGG_STORAGE_KEY,
            JSON.stringify([...next])
          );
        } catch {
          // Storage might be disabled in private mode — tally still
          // works for the current session.
        }
        return next;
      });
    }
    window.addEventListener("easter-egg-found", handler);
    return () => window.removeEventListener("easter-egg-found", handler);
  }, []);

  function reset() {
    setFound(new Set());
    try {
      window.localStorage.removeItem(EGG_STORAGE_KEY);
    } catch {
      // Storage might be disabled — UI tally still clears.
    }
  }

  const total = EGG_IDS.length;
  const count = found.size;

  // Right padding shrinks when the reset button is present so the
  // chip stays visually balanced — the button absorbs the gap.
  const hasFound = count > 0;
  return (
    <div
      className={`
        absolute top-4 left-4 z-10 select-none
        h-12 pl-4 ${hasFound ? "pr-1" : "pr-4"}
        flex items-center gap-2
        bg-black/60
        text-white text-sm uppercase tracking-wider
        border border-white/20
        rounded-full
        backdrop-blur-sm
        shadow-lg shadow-black/40
      `}
      role="status"
      aria-label={`${count} of ${total} easter eggs found`}
    >
      <span aria-hidden className="text-amber-300 leading-none">★</span>
      <span className="tabular-nums">
        {count}/{total}
      </span>
      <span className="opacity-80">explored</span>
      {hasFound && (
        <button
          type="button"
          onClick={reset}
          aria-label="Reset easter egg progress"
          title="Reset progress"
          className="
            ml-1 w-8 h-8
            flex items-center justify-center
            text-white/60 hover:text-white
            hover:bg-white/15 active:bg-white/25
            rounded-full
            transition-colors
            cursor-pointer
          "
        >
          {/* Circular-arrow "reset" glyph — open at the top, with
              an arrowhead so it reads as "rewind / start over"
              rather than "refresh the page". */}
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 4v6h6" />
          </svg>
        </button>
      )}
    </div>
  );
}

// "EXIT" overlay button shown while the character is riding the
// lazy-river tube. Hidden otherwise — the river dispatches a
// `river-active` window CustomEvent (true/false) when the rider
// boards / leaves. Tap fires `river-exit` which the tubing tick
// consumes on the next frame to walk the character back to the
// plaza.
function RiverExitButton() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    function onActive(e: Event) {
      const detail = (e as CustomEvent<boolean>).detail;
      setVisible(!!detail);
    }
    window.addEventListener("river-active", onActive);
    return () => window.removeEventListener("river-active", onActive);
  }, []);
  if (!visible) return null;
  return (
    <button
      type="button"
      onClick={() => {
        window.dispatchEvent(new CustomEvent("river-exit"));
      }}
      aria-label="Exit the lazy river"
      className="
        absolute bottom-4 left-1/2 -translate-x-1/2 z-10
        h-12 px-6
        flex items-center gap-2
        bg-red-700/85 hover:bg-red-700 active:bg-red-800
        text-white text-base uppercase tracking-wider font-semibold
        border border-white/30
        rounded-full
        backdrop-blur-sm
        shadow-lg shadow-black/40
        transition-colors
        cursor-pointer
        select-none
      "
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M18 6L6 18" />
        <path d="M6 6l12 12" />
      </svg>
      <span>Exit ride</span>
    </button>
  );
}

// Putt HUD — power meter + attempts/sinks counter + a control hint.
// Shown while the kid is addressing or playing a putt (driven by the
// `putting-active` window event). Power fills via `putt-stats` events
// dispatched from the putting tick.
function PuttHUD() {
  const [visible, setVisible] = useState(false);
  const [power, setPower] = useState(0);
  const [attempts, setAttempts] = useState(0);
  const [sinks, setSinks] = useState(0);
  useEffect(() => {
    function onActive(e: Event) {
      const detail = (e as CustomEvent<boolean>).detail;
      setVisible(!!detail);
      if (!detail) {
        setPower(0);
        setAttempts(0);
        setSinks(0);
      }
    }
    window.addEventListener("putting-active", onActive);
    return () => window.removeEventListener("putting-active", onActive);
  }, []);
  useEffect(() => {
    function onStats(e: Event) {
      const d = (e as CustomEvent<{ attempts: number; sinks: number; power: number }>).detail;
      if (!d) return;
      setPower(d.power);
      setAttempts(d.attempts);
      setSinks(d.sinks);
    }
    window.addEventListener("putt-stats", onStats);
    return () => window.removeEventListener("putt-stats", onStats);
  }, []);
  if (!visible) return null;
  return (
    <>
      {/* Bottom-centre vertical power meter — left of the DONE button.
          Empty grey box; bright green bar fills upward with power. */}
      <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-10 flex items-end gap-3 select-none pointer-events-none">
        <div className="w-6 h-32 bg-black/60 border border-white/30 rounded-md overflow-hidden flex flex-col-reverse">
          <div
            className="w-full bg-gradient-to-t from-amber-400 to-emerald-400 transition-[height] duration-75 ease-linear"
            style={{ height: `${Math.round(Math.max(0, Math.min(1, power)) * 100)}%` }}
          />
        </div>
        <div className="flex flex-col items-start gap-1 text-white text-xs uppercase tracking-wider bg-black/60 px-3 py-2 rounded-md border border-white/20 backdrop-blur-sm">
          <span>Sinks <span className="text-amber-300 tabular-nums">{sinks}</span></span>
          <span>Putts <span className="text-amber-300 tabular-nums">{attempts}</span></span>
          <span className="opacity-70 normal-case text-[10px] tracking-normal">
            ← / → aim · hold space
          </span>
        </div>
      </div>
    </>
  );
}

// "DONE" button for the play-mode putt. Wired exactly like the river
// exit — `putting-active` shows/hides it, click fires `putt-done`
// which the putting tick consumes to walk the kid off the green.
function PuttDoneButton() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    function onActive(e: Event) {
      const detail = (e as CustomEvent<boolean>).detail;
      setVisible(!!detail);
    }
    window.addEventListener("putting-active", onActive);
    return () => window.removeEventListener("putting-active", onActive);
  }, []);
  if (!visible) return null;
  return (
    <button
      type="button"
      onClick={() => {
        window.dispatchEvent(new CustomEvent("putt-done"));
      }}
      aria-label="Finish putting and walk away"
      className="
        absolute bottom-4 left-1/2 -translate-x-1/2 z-10
        h-12 px-6
        flex items-center gap-2
        bg-emerald-700/85 hover:bg-emerald-700 active:bg-emerald-800
        text-white text-base uppercase tracking-wider font-semibold
        border border-white/30
        rounded-full
        backdrop-blur-sm
        shadow-lg shadow-black/40
        transition-colors
        cursor-pointer
        select-none
      "
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M5 13l4 4 10-10" />
      </svg>
      <span>Done</span>
    </button>
  );
}

export default function GameShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const section = getSectionByPath(pathname ?? "/");
  // The jiu-jitsu and chess routes render their content as full 3D
  // scenes INSIDE the canvas (the academy interior / chess study),
  // not as 2D overlays. Skip the overlay container for them so
  // canvas clicks still pass through, and add an exit button.
  const isAcademy = pathname === "/jiu-jitsu";
  const isChess = pathname === "/chess";
  const isPuzzle = pathname === "/puzzle";
  const isFullScene = isAcademy || isChess || isPuzzle;
  const exitLabel = isAcademy
    ? "the academy"
    : isChess
    ? "chess"
    : "the puzzle house";

  // Play mode (the Mario-style kid game) only makes sense on the
  // plaza route. Navigating away auto-exits via the effect below.
  const [playMode, setPlayMode] = useState(false);
  useEffect(() => {
    // Play mode is "alive" on the plaza route AND on the two
    // play-compatible interior scenes (chess, academy) — those
    // are reachable BY walking up to their building in play mode,
    // so the toggle has to survive the navigation. All other
    // routes (music, code, personal-life) reset play mode like
    // before.
    const playCompatible =
      pathname === "/" ||
      pathname === "/chess" ||
      pathname === "/jiu-jitsu" ||
      pathname === "/puzzle";
    if (!playCompatible) setPlayMode(false);
    // Block pushing needs tank controls, so the puzzle room
    // auto-enables play mode the moment the route lands there —
    // whether the kid arrived via the Continue button (which
    // flipped play mode off for the cinematic walk) or directly
    // by URL bar / building click.
    if (pathname === "/puzzle") setPlayMode(true);
  }, [pathname]);
  useEffect(() => {
    // Tell Scene to reset the belt meshes' collected state.
    // `BeltHUD` listens for this too and zeros its own counter
    // (state lives there, not here — see the BeltHUD comment).
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("play-mode-reset"));
  }, [playMode]);

  // Chess-win belt + points bonus. ChessRoom fires
  // `chess-player-won` every time the player wins a game. We
  // dedupe to one award per play-mode session so the kid can't
  // farm chess for unlimited belts. The `awardedRef` resets on
  // every play-mode toggle (the `play-mode-reset` effect above
  // also fires here as a co-tenant of the same lifecycle).
  const chessAwardedRef = useRef(false);
  // Set on chess-win, consumed when the kid returns to `/`. We
  // can't fire the level-1 celebration on /chess directly — the
  // celebration physics lives in Scene's play tick, which is
  // gated on `isOnHome`. Defer until the route transitions back.
  const pendingLevel1Ref = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    chessAwardedRef.current = false; // new play session = new chance
    pendingLevel1Ref.current = false;
    function onChessWin() {
      if (chessAwardedRef.current) return;
      chessAwardedRef.current = true;
      // Belt + chirp + the +100 PointsHUD will pick up from this
      // event automatically — and BeltSuccessChime will too if
      // this is the 21st belt.
      window.dispatchEvent(
        new CustomEvent("belt-collected", { detail: "chess" })
      );
      // +500 bonus on top of the +100 from the belt.
      window.dispatchEvent(new CustomEvent("chess-won"));
      // Queue the level-1 celebration for when the kid returns
      // to the plaza route.
      pendingLevel1Ref.current = true;
    }
    window.addEventListener("chess-player-won", onChessWin);
    return () => window.removeEventListener("chess-player-won", onChessWin);
  }, [playMode]);

  // Fire the deferred level-1 celebration once the kid is back on
  // `/`. Dispatched as `level-complete` (detail: 1) so the Scene
  // can teleport + jump-for-joy AND <Level1CompleteOverlay> can
  // show the confetti + message. A small setTimeout delay lets
  // the route transition fully settle before the celebration runs
  // (otherwise the play HUDs might still be mid-mount and the
  // play tick's `isOnHome` check might not yet be true).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (pathname !== "/") return;
    if (!pendingLevel1Ref.current) return;
    pendingLevel1Ref.current = false;
    // Persist the level-2 unlock BEFORE dispatching `level-complete`
    // so any listener that re-reads localStorage on the event (e.g.
    // GameWorld's unlocked-level state, which mounts the puzzle
    // house when the flag goes up) sees the new value.
    try {
      window.localStorage.setItem(LEVEL2_UNLOCK_STORAGE_KEY, "1");
    } catch {
      // Storage might be unavailable in private mode — celebration
      // still plays, but progress doesn't stick across reloads.
    }
    const tid = setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("level-complete", { detail: 1 })
      );
    }, 250);
    return () => clearTimeout(tid);
  }, [pathname]);

  // ── Puzzle-house win (level 2) ─────────────────────────────
  // PuzzleRoom dispatches `puzzle-room-complete` the moment the
  // kid steps into the lit exit portal. Mirror the chess flow:
  // dedupe one award per play session, fire the belt + points
  // events, queue the level-2 celebration, and push the router
  // back to "/". The deferred dispatch effect below picks up the
  // pending flag, writes the level-3 unlock, and fires
  // `level-complete` (detail 2) so Scene + <Level2CompleteOverlay>
  // run the celebration on the plaza.
  const puzzleAwardedRef = useRef(false);
  const pendingLevel2Ref = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    puzzleAwardedRef.current = false;
    pendingLevel2Ref.current = false;
    function onPuzzleWin() {
      if (puzzleAwardedRef.current) return;
      puzzleAwardedRef.current = true;
      // 22nd belt (BeltHUD bumps; chime + walking-belt tally are
      // already gated against detail === "puzzle" so no second
      // jump-for-joy fanfare fires here — the level-2 overlay
      // owns the celebration audio).
      window.dispatchEvent(
        new CustomEvent("belt-collected", { detail: "puzzle" })
      );
      // +1000 bonus on top of the +100 from the belt.
      window.dispatchEvent(new CustomEvent("puzzle-won"));
      pendingLevel2Ref.current = true;
      router.push("/");
    }
    window.addEventListener("puzzle-room-complete", onPuzzleWin);
    return () => window.removeEventListener("puzzle-room-complete", onPuzzleWin);
  }, [playMode, router]);

  // Deferred level-2 dispatch — same staging as level 1.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (pathname !== "/") return;
    if (!pendingLevel2Ref.current) return;
    pendingLevel2Ref.current = false;
    try {
      window.localStorage.setItem(LEVEL3_UNLOCK_STORAGE_KEY, "1");
    } catch {
      // Private mode — progress doesn't persist, celebration still plays.
    }
    const tid = setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("level-complete", { detail: 2 })
      );
    }, 350);
    return () => clearTimeout(tid);
  }, [pathname]);

  // ── Play-mode background music ──
  // Single HTMLAudioElement created on mount, looped, volume capped.
  // It's NOT attached to the DOM tree — we manage play/pause via
  // the ref so React re-renders don't restart the track. Browser
  // autoplay policies require a user gesture before .play() will
  // succeed; the Play button click that flips `playMode` to true
  // counts as that gesture, so the first play() call inside the
  // play-mode effect works cleanly. Muted preference is persisted
  // in localStorage so the choice survives reloads.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [musicMuted, setMusicMuted] = useState(false);
  // Initialize the audio element + restore the persisted mute state.
  // Done in an effect so window/Audio are only touched client-side.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const audio = new Audio(MUSIC_SRC);
    audio.loop = true;
    audio.volume = MUSIC_VOLUME;
    audio.preload = "auto";
    audioRef.current = audio;
    try {
      const stored = window.localStorage.getItem(MUSIC_MUTE_STORAGE_KEY);
      if (stored === "1") {
        audio.muted = true;
        setMusicMuted(true);
      }
    } catch {
      // localStorage can throw in private-browsing / sandboxed
      // iframes; the music just plays unmuted in that case.
    }
    return () => {
      audio.pause();
      audio.src = "";
      audioRef.current = null;
    };
  }, []);
  // Start music on play-mode entry, pause on exit. The first call
  // runs inside the toggle's click stack so the autoplay gate is
  // already satisfied — .play() returns a promise that we swallow
  // to silence the AbortError that fires if the user toggles play
  // mode back off before the buffer is ready.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playMode) {
      audio.currentTime = 0;
      const p = audio.play();
      if (p && typeof p.then === "function") {
        p.catch(() => {
          // Autoplay was blocked or play() was interrupted. Silent
          // failure — the mute button still works if it ever does
          // start; nothing else in the game depends on the music.
        });
      }
    } else {
      audio.pause();
      audio.currentTime = 0;
    }
  }, [playMode]);
  // Mirror the muted state onto the audio element + persist it.
  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.muted = musicMuted;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(
          MUSIC_MUTE_STORAGE_KEY,
          musicMuted ? "1" : "0"
        );
      } catch {
        // ignore — see init effect comment
      }
    }
  }, [musicMuted]);

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#1a1a2e]">
      <GameWorld playMode={playMode} />
      {/* Play-mode HUDs that need to survive route changes. Belts +
          Points + the success chime are rendered for every
          play-compatible route (home / chess / academy) so their
          internal count state persists across the walk-into-chess →
          win → walk-out flow — otherwise a chess win earned during
          play mode would be lost when BeltHUD unmounted, then reset
          to 0 on return to home. Chess scene's own HUD lives at
          `top-4 right-4` (ChessControls) which is above the play
          HUDs starting at `top-20`, so no overlap. */}
      {playMode && <BeltHUD />}
      {playMode && <PointsHUD />}
      {playMode && <ChessHintBanner />}
      {playMode && <BeltSuccessChime musicMuted={musicMuted} />}
      {playMode && (
        <Level1CompleteOverlay
          musicMuted={musicMuted}
          onContinue={() => {
            // Flip play mode off so the existing portfolio
            // click-to-walk pipeline can drive Sonny to the
            // puzzle-house door. Play mode auto-re-enables when
            // the route lands on /puzzle (the puzzle room needs
            // tank controls for block pushing). GameWorld's
            // walk-to-section listener bypasses its play-mode
            // guard, so the dispatch is safe to fire immediately
            // — no need to wait for React to commit the state
            // update.
            setPlayMode(false);
            window.dispatchEvent(
              new CustomEvent("walk-to-section", { detail: "puzzle" })
            );
          }}
        />
      )}
      {playMode && <Level2CompleteOverlay musicMuted={musicMuted} />}
      {playMode && (
        <MuteButton
          muted={musicMuted}
          onToggle={() => setMusicMuted((v) => !v)}
        />
      )}
      {isFullScene ? (
        <>
          <ExitSceneButton label={exitLabel} />
          {isChess && (
            <>
              <ChessControls />
              <ChessCapturesHUD />
            </>
          )}
          <ResetViewButton />
          <div className="hidden">{children}</div>
        </>
      ) : section ? (
        <div className="absolute inset-0 z-10 pointer-events-auto">
          {children}
        </div>
      ) : (
        // children of "/" route render nothing meaningful, but mounting them
        // keeps Next.js happy.
        <>
          {/* Hide the tally + reset-view in play mode so the screen
              isn't cluttered while platforming. The play HUD takes
              their slots. */}
          {!playMode && <EasterEggTally />}
          {!playMode && <ResetViewButton />}
          <PlayToggleButton
            playMode={playMode}
            onToggle={() => setPlayMode((v) => !v)}
          />
          {playMode && <PlayControlsHint />}
          {playMode && <TouchControls />}
          <RiverExitButton />
          <PuttHUD />
          <PuttDoneButton />
          {/* Shown when the visitor clicks a locked building on the
              plaza — auto-hides after a few seconds. Mounted in
              both portfolio + play modes since locked buildings
              are visible in both. */}
          <LockedBuildingBanner />
          {/* Bottom-left wipe-everything button. Companion to
              ResetViewButton (bottom-right) so the corners pair
              visually — view-reset on the right, progress-reset
              on the left. Hidden in play mode because the mobile
              TouchControls left-thumb cluster sits at the same
              bottom-left corner, AND kids actively playing have
              no reason to wipe their belt count mid-session.
              Returning visitors who want to demo the locked
              state should exit play mode first. */}
          {!playMode && <ResetProgressButton />}
          <div className="hidden">{children}</div>
        </>
      )}
    </div>
  );
}
