import SectionOverlay from "@/app/components/SectionOverlay";
import { SECTIONS } from "@/app/lib/sections";

const section = SECTIONS.find((s) => s.id === "code")!;

export const metadata = { title: "Code — Sonny Parlin" };

export default function CodePage() {
  return (
    <SectionOverlay title={section.label} accent={section.buildingColor}>
      <p className="mb-4">
        Projects, GitHub, and the stuff I build for fun.
      </p>
      <p className="text-white/60">[ Coming soon ]</p>
    </SectionOverlay>
  );
}
