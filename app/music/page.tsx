import SectionOverlay from "@/app/components/SectionOverlay";
import MusicSequencer from "@/app/components/MusicSequencer";
import { SECTIONS } from "@/app/lib/sections";

const section = SECTIONS.find((s) => s.id === "music")!;

export const metadata = { title: "Music — Sonny Parlin" };

export default function MusicPage() {
  return (
    <SectionOverlay title={section.label} accent={section.buildingColor}>
      <MusicSequencer />
    </SectionOverlay>
  );
}
