import SectionOverlay from "@/app/components/SectionOverlay";
import { SECTIONS } from "@/app/lib/sections";

const section = SECTIONS.find((s) => s.id === "chess")!;

export const metadata = { title: "Chess — Sonny Parlin" };

export default function ChessPage() {
  return (
    <SectionOverlay title={section.label} accent={section.buildingColor}>
      <p className="mb-4">
        chess.com stats and highlight checkmates.
      </p>
      <p className="text-white/60">[ Coming soon ]</p>
    </SectionOverlay>
  );
}
