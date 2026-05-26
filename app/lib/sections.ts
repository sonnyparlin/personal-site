export type SectionId =
  | "jiu-jitsu"
  | "music"
  | "puzzle"
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
  // Level required to see this building. Defaults to 1.
  // Buildings with minLevel > the current unlocked level are
  // omitted from the plaza (no building mesh, no path radiating
  // out to it). Unlocked level is read from localStorage flags
  // set by the level-complete celebrations in GameShell:
  //   - level 2 unlocks after winning chess (LEVEL2_UNLOCK_*)
  //   - higher levels TBD as the game grows
  minLevel?: number;
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
    minLevel: 4,
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
    minLevel: 3,
    x: 5.7,
    z: -1.85,
  },
  {
    id: "puzzle",
    label: "PUZZLE HOUSE",
    path: "/puzzle",
    buildingColor: "#5a3a8b",
    roofColor: "#392356",
    doorColor: "#160a26",
    signColor: "#f4f1de",
    minLevel: 2,
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

// ── Level-unlock plumbing ──────────────────────────────────────────
// Buildings are gated by `minLevel`. We persist one localStorage flag
// per level (`"personal-site:level<N>-unlocked" = "1"`) on the matching
// `level-complete` celebration. `getUnlockedLevel()` reads those flags
// and returns the highest contiguous unlocked level (defaults to 1).
// `useUnlockedLevel()` is a small React hook that re-reads after
// `level-complete` window events so freshly-unlocked buildings appear
// without a reload.

export const LEVEL_STORAGE_PREFIX = "personal-site:level";
export const LEVEL_STORAGE_SUFFIX = "-unlocked";

export function levelStorageKey(level: number): string {
  return `${LEVEL_STORAGE_PREFIX}${level}${LEVEL_STORAGE_SUFFIX}`;
}

// Maximum level we'll probe for in localStorage. Buildings with a
// higher `minLevel` than the max we check stay hidden by definition.
const MAX_PROBE_LEVEL = 10;

export function getUnlockedLevel(): number {
  if (typeof window === "undefined") return 1;
  let unlocked = 1;
  // Probe every key up to MAX_PROBE_LEVEL and take the HIGHEST one
  // that's set. Gaps are tolerated — if a future feature unlocks
  // level N without setting N-1 (or storage gets manually edited),
  // we still surface the highest reached level.
  for (let lvl = 2; lvl <= MAX_PROBE_LEVEL; lvl++) {
    try {
      if (window.localStorage.getItem(levelStorageKey(lvl)) === "1") {
        unlocked = lvl;
      }
    } catch {
      break;
    }
  }
  return unlocked;
}

export function isSectionUnlocked(s: Section, unlockedLevel: number): boolean {
  return (s.minLevel ?? 1) <= unlockedLevel;
}
