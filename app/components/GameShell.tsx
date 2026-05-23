"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
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
const EGG_IDS = ["gator", "coaster", "golf", "range", "balloon"] as const;
const EGG_STORAGE_KEY = "personal-site:eggs-found";

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

// Exit-the-scene button shown on routes that render a full 3D
// interior (currently /jiu-jitsu and /chess). Navigates back to the
// plaza via plain anchor-style routing (Next.js intercepts it).
// The 3D scene flips back to the plaza on the route change.
function ExitSceneButton({ label }: { label: string }) {
  return (
    <a
      href="/"
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
    </a>
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

export default function GameShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const section = getSectionByPath(pathname ?? "/");
  // The jiu-jitsu and chess routes render their content as full 3D
  // scenes INSIDE the canvas (the academy interior / chess study),
  // not as 2D overlays. Skip the overlay container for them so
  // canvas clicks still pass through, and add an exit button.
  const isAcademy = pathname === "/jiu-jitsu";
  const isChess = pathname === "/chess";
  const isFullScene = isAcademy || isChess;
  const exitLabel = isAcademy ? "the academy" : "chess";

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#1a1a2e]">
      <GameWorld />
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
          <EasterEggTally />
          <ResetViewButton />
          <div className="hidden">{children}</div>
        </>
      )}
    </div>
  );
}
