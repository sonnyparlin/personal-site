"use client";

import { usePathname } from "next/navigation";
import GameWorld from "./GameWorld";
import { getSectionByPath } from "@/app/lib/sections";

// Custom event names CameraRig + the router listen for. Decoupling
// via window.dispatchEvent avoids prop-drilling a ref/callback from
// GameShell through GameWorld → Scene → CameraRig just for these
// little overlay buttons.
const RESET_CAMERA_EVENT = "reset-camera";

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
          <ResetViewButton />
          <div className="hidden">{children}</div>
        </>
      )}
    </div>
  );
}
