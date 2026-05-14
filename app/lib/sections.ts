export type SectionId =
  | "jiu-jitsu"
  | "music"
  | "code"
  | "chess"
  | "personal-life";

export type Section = {
  id: SectionId;
  label: string;
  path: `/${SectionId}`;
  buildingColor: string;
  roofColor: string;
  doorColor: string;
  signColor: string;
  isHome?: boolean;
  // World position on the ground plane. Building faces the origin.
  x: number;
  z: number;
};

// Building dimensions (in world units, ~meters)
export const BUILDING_W = 2.8;
export const BUILDING_H = 2.4;
export const BUILDING_D = 2.2;
export const DOOR_CLEARANCE = 1.1; // distance from building front where char stands

export const SECTIONS: Section[] = [
  {
    id: "personal-life",
    label: "HOME",
    path: "/personal-life",
    buildingColor: "#c97f5a",
    roofColor: "#7a3f24",
    doorColor: "#3a1a0a",
    signColor: "#f4f1de",
    isHome: true,
    x: 0,
    z: -6,
  },
  {
    id: "jiu-jitsu",
    label: "JIU JITSU",
    path: "/jiu-jitsu",
    buildingColor: "#8b1e1e",
    roofColor: "#5a1414",
    doorColor: "#2a0808",
    signColor: "#f4f1de",
    x: -5.7,
    z: -1.85,
  },
  {
    id: "music",
    label: "MUSIC",
    path: "/music",
    buildingColor: "#3a4f8b",
    roofColor: "#26345a",
    doorColor: "#0d142a",
    signColor: "#f4f1de",
    x: 5.7,
    z: -1.85,
  },
  {
    id: "code",
    label: "CODE",
    path: "/code",
    buildingColor: "#2f6b3d",
    roofColor: "#1d4527",
    doorColor: "#0a1a10",
    signColor: "#f4f1de",
    x: -3.5,
    z: 5.5,
  },
  {
    id: "chess",
    label: "CHESS",
    path: "/chess",
    buildingColor: "#6b4a2a",
    roofColor: "#3d2916",
    doorColor: "#1a0f08",
    signColor: "#f4f1de",
    x: 3.5,
    z: 5.5,
  },
];

// Angle (around Y) for the building to face the origin.
export function buildingAngle(s: Section): number {
  return Math.atan2(-s.x, -s.z);
}

// Position on the ground in front of the building's door — where the
// character stands when entering the section.
export function doorTarget(s: Section): { x: number; z: number } {
  const r = Math.hypot(s.x, s.z);
  if (r === 0) return { x: 0, z: BUILDING_D / 2 + DOOR_CLEARANCE };
  const k = (r - BUILDING_D / 2 - DOOR_CLEARANCE) / r;
  return { x: s.x * k, z: s.z * k };
}

export function getSectionByPath(path: string): Section | undefined {
  return SECTIONS.find((s) => s.path === path);
}
