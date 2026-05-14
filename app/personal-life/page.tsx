import SectionOverlay from "@/app/components/SectionOverlay";
import { SECTIONS } from "@/app/lib/sections";

const section = SECTIONS.find((s) => s.id === "personal-life")!;

export const metadata = { title: "Personal Life — Sonny Parlin" };

export default function PersonalLifePage() {
  return (
    <SectionOverlay title="PERSONAL LIFE" accent={section.buildingColor}>
      <p className="mb-4">
        My wife, my son, hobbies, and the rest of life off the mats.
      </p>
      <p className="text-white/60">[ Coming soon ]</p>
    </SectionOverlay>
  );
}
