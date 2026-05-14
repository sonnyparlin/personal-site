"use client";

import { usePathname } from "next/navigation";
import GameWorld from "./GameWorld";
import { getSectionByPath } from "@/app/lib/sections";

export default function GameShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const section = getSectionByPath(pathname ?? "/");

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#1a1a2e]">
      <GameWorld />
      {section ? (
        <div className="absolute inset-0 z-10 pointer-events-auto">
          {children}
        </div>
      ) : (
        // children of "/" route render nothing meaningful, but mounting them
        // keeps Next.js happy.
        <div className="hidden">{children}</div>
      )}
    </div>
  );
}
