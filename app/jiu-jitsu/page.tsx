import SectionOverlay from "@/app/components/SectionOverlay";
import { SECTIONS } from "@/app/lib/sections";

const section = SECTIONS.find((s) => s.id === "jiu-jitsu")!;

export const metadata = { title: "Jiu Jitsu — Sonny Parlin" };

export default function JiuJitsuPage() {
  return (
    <SectionOverlay title={section.label} accent={section.buildingColor}>
      <p className="mb-4">
        Black belt. Lineage, years on the mats, competitions, and the gym I own
        with Kate — all going here soon.
      </p>
      <p className="text-white/60">[ Coming soon ]</p>
    </SectionOverlay>
  );
}
