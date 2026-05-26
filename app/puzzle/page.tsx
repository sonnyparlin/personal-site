import SectionOverlay from "@/app/components/SectionOverlay";
import { SECTIONS } from "@/app/lib/sections";

const section = SECTIONS.find((s) => s.id === "puzzle")!;

export const metadata = { title: "Puzzle House — Sonny Parlin" };

export default function PuzzlePage() {
  return (
    <SectionOverlay title={section.label} accent={section.buildingColor}>
      <p className="mb-4">
        Level 2 unlocked. Step inside to take on the puzzles.
      </p>
      <p className="text-white/60">[ Coming soon ]</p>
    </SectionOverlay>
  );
}
