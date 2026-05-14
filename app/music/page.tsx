import SectionOverlay from "@/app/components/SectionOverlay";
import { SECTIONS } from "@/app/lib/sections";

const section = SECTIONS.find((s) => s.id === "music")!;

export const metadata = { title: "Music — Sonny Parlin" };

export default function MusicPage() {
  return (
    <SectionOverlay title={section.label} accent={section.buildingColor}>
      <p className="mb-4">
        My music, background as a musician, and links to where you can hear it.
      </p>
      <p className="text-white/60">[ Coming soon ]</p>
    </SectionOverlay>
  );
}
