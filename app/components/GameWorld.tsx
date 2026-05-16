"use client";

import { forwardRef, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Text } from "@react-three/drei";
import { usePathname, useRouter } from "next/navigation";
import * as THREE from "three";
import {
  BUILDING_D,
  BUILDING_H,
  BUILDING_W,
  SECTIONS,
  buildingAngle,
  doorTarget,
  getSectionByPath,
  type Section,
  type SectionId,
} from "@/app/lib/sections";

// -------------------- shared state types --------------------

type CharMode = "idle" | "flee" | "riding" | "golfing";

type CharState = {
  x: number;
  z: number;
  y: number; // off-ground height (only non-zero during the coaster ride)
  angle: number; // facing angle (Y rotation, radians)
  walking: boolean;
  mode: CharMode;
  stepPhase: number; // 0..1
};

type DoorState = Record<SectionId, number>; // 0..1 (closed..open)

type GatorState = {
  x: number;
  z: number;
  angle: number;
  chasing: boolean;
};

type CoasterState = {
  t: number; // 0..1 position on track
  laps: number; // total laps completed this ride
  riding: boolean;
};

type FamilyState = {
  active: boolean;
  t: number; // 0..1 progress of the HOME-door easter-egg animation
};

type GolfState = {
  active: boolean;
  t: number; // 0..1 progress of the golf easter-egg animation
};

type SharedRefs = {
  char: React.MutableRefObject<CharState>;
  target: React.MutableRefObject<{
    x: number;
    z: number;
    sectionId: SectionId | null;
  } | null>;
  // Remaining waypoints to traverse before the *current* target's arrival
  // handlers fire. Each arrival pops the next waypoint and treats it as the
  // new target. Section / approach flags are deferred until the queue is empty.
  pathQueue: React.MutableRefObject<{ x: number; z: number }[]>;
  pendingNav: React.MutableRefObject<SectionId | null>;
  doors: React.MutableRefObject<DoorState>;
  gator: React.MutableRefObject<GatorState>;
  approachingGator: React.MutableRefObject<boolean>;
  coaster: React.MutableRefObject<CoasterState>;
  approachingPark: React.MutableRefObject<boolean>;
  family: React.MutableRefObject<FamilyState>;
  golf: React.MutableRefObject<GolfState>;
  approachingGolf: React.MutableRefObject<boolean>;
};

const WALK_SPEED = 2.5; // units/sec
const FLEE_SPEED = 5.8; // sprint speed when fleeing the gator
const GATOR_CHASE_SPEED = 2.2;
const GATOR_RETURN_SPEED = 1.4;
const ARRIVE_DIST = 0.18;
const DOOR_OPEN_SPEED = 3;
const DOOR_CLOSE_SPEED = 4;
const GATOR_HOME = { x: 11.5, z: -8, angle: 0.6 };
// Lake footprint (matches the Lake component in Environment). Used to
// auto-trigger the gator chase whenever the character wanders within
// striking distance of the water.
const LAKE_CENTER = { x: 11.5, z: -8 };
const LAKE_RADIUS = 2.8;
const WATER_TRIGGER_RADIUS = LAKE_RADIUS + 1.2; // shore + a small buffer
const CHAR_RADIUS = 0.32; // for building collision
const HOME_FAMILY_DURATION = 2.8; // seconds for the wife/son/dogs to come out

// Golf easter egg
const GOLF_POSITION = { x: -11.5, z: 9 };
const GOLF_TEE = { x: -6.5, z: 9 };
const GOLF_HOLE = { x: -15, z: 8.6 };
const GOLF_DURATION = 6.0; // total seconds of address → swing → flight → celebration

// Amusement park
const PARK = { x: -13, z: -9 };
const COASTER_RX = 3.6;
const COASTER_RZ = 2.7;
const COASTER_Y_BASE = 0.9;
const COASTER_AMP = 1.1;
const COASTER_HILLS = 2;
const RIDE_LAPS = 2;
const RIDE_LAP_SECONDS = 4.0; // per lap
const PARK_ENTRY_OFFSET = COASTER_RZ + 0.9; // walk to here to board
// Park ground patch dimensions (covers all rides)
const PARK_GROUND_W = 10;
const PARK_GROUND_D = 10;

// Closed roller-coaster curve, defined in park-local XYZ. Starts at the south
// (low) point so boarding lines up with the ticket-booth entrance. Two hills
// per lap with valleys between.
const COASTER_CURVE = (() => {
  const N = 32;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / N;
    const angle = Math.PI / 2 + t * 2 * Math.PI;
    const heightFactor = (1 - Math.cos(t * 2 * Math.PI * COASTER_HILLS)) / 2;
    pts.push(
      new THREE.Vector3(
        Math.cos(angle) * COASTER_RX,
        COASTER_Y_BASE + COASTER_AMP * heightFactor,
        Math.sin(angle) * COASTER_RZ
      )
    );
  }
  return new THREE.CatmullRomCurve3(pts, true, "catmullrom", 0.5);
})();

function coasterWorldAt(t: number): {
  x: number;
  y: number;
  z: number;
  angle: number;
} {
  const p = COASTER_CURVE.getPointAt(t);
  const tan = COASTER_CURVE.getTangentAt(t);
  return {
    x: PARK.x + p.x,
    y: p.y,
    z: PARK.z + p.z,
    // Direction of motion projected on the ground plane. The cart's "front"
    // is along +Z in local; we want that to face the tangent's XZ direction.
    angle: Math.atan2(tan.x, tan.z),
  };
}

// Resolve building collisions by pushing the character out of any
// building footprint (rotated rectangle inflated by CHAR_RADIUS).
function resolveCollisions(x: number, z: number): { x: number; z: number } {
  let nx = x;
  let nz = z;
  for (const s of SECTIONS) {
    const a = buildingAngle(s);
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const dx = nx - s.x;
    const dz = nz - s.z;
    // World → building-local (rotation by -a)
    const lx = cos * dx + sin * dz;
    const lz = -sin * dx + cos * dz;
    const halfW = BUILDING_W / 2 + CHAR_RADIUS;
    const halfD = BUILDING_D / 2 + CHAR_RADIUS;
    if (Math.abs(lx) < halfW && Math.abs(lz) < halfD) {
      // Penetration into each axis; push out along whichever axis we're
      // less embedded in (so we slide along the wall, not through it).
      const overX = halfW - Math.abs(lx);
      const overZ = halfD - Math.abs(lz);
      let pushLX = 0;
      let pushLZ = 0;
      if (overX < overZ) {
        pushLX = lx >= 0 ? overX : -overX;
      } else {
        pushLZ = lz >= 0 ? overZ : -overZ;
      }
      // Rotate the push back to world space
      nx += cos * pushLX - sin * pushLZ;
      nz += sin * pushLX + cos * pushLZ;
    }
  }
  return { x: nx, z: nz };
}

// Sample a straight line segment and report if it crosses any building's
// inflated footprint. Used to decide whether a walk needs an intermediate
// waypoint to avoid getting stuck on a corner.
function lineHitsAnyBuilding(
  x1: number,
  z1: number,
  x2: number,
  z2: number
): boolean {
  const halfW = BUILDING_W / 2 + CHAR_RADIUS + 0.05;
  const halfD = BUILDING_D / 2 + CHAR_RADIUS + 0.05;
  for (const s of SECTIONS) {
    const a = buildingAngle(s);
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const samples = 24;
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const wx = x1 + (x2 - x1) * t;
      const wz = z1 + (z2 - z1) * t;
      const dx = wx - s.x;
      const dz = wz - s.z;
      const lx = cos * dx + sin * dz;
      const lz = -sin * dx + cos * dz;
      if (Math.abs(lx) < halfW && Math.abs(lz) < halfD) return true;
    }
  }
  return false;
}

// Outer-ring waypoints used to bypass the building cluster. Picked so each
// one is clear of every building from the plaza's perspective.
const BYPASS_WAYPOINTS: { x: number; z: number }[] = [
  { x: -8, z: 4 },    // SW (between CODE and the golf course)
  { x: -8, z: -5 },   // NW (south-west of JIU JITSU, on the way to the park)
  { x: 8, z: 4 },     // SE
  { x: 8, z: -5 },    // NE
  { x: 0, z: 8 },     // S (between CODE and CHESS)
  { x: -8, z: 0 },    // W
  { x: 8, z: 0 },     // E
];

// Return the sequence of waypoints to walk through to get from (fromX, fromZ)
// to (toX, toZ) without clipping a building. The final entry is always the
// destination. If the direct line is clear, returns just [destination].
function routeTo(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number
): { x: number; z: number }[] {
  if (!lineHitsAnyBuilding(fromX, fromZ, toX, toZ)) {
    return [{ x: toX, z: toZ }];
  }
  // Pick the bypass waypoint that minimises total path length while keeping
  // both legs clear of buildings.
  let best: { x: number; z: number } | null = null;
  let bestCost = Infinity;
  for (const w of BYPASS_WAYPOINTS) {
    if (lineHitsAnyBuilding(fromX, fromZ, w.x, w.z)) continue;
    if (lineHitsAnyBuilding(w.x, w.z, toX, toZ)) continue;
    const cost =
      Math.hypot(w.x - fromX, w.z - fromZ) +
      Math.hypot(toX - w.x, toZ - w.z);
    if (cost < bestCost) {
      bestCost = cost;
      best = w;
    }
  }
  if (best) return [best, { x: toX, z: toZ }];
  // Fallback: walk straight and let collision push-out do its best.
  return [{ x: toX, z: toZ }];
}

// -------------------- entry point --------------------

export default function GameWorld() {
  const charRef = useRef<CharState>({
    x: 0,
    z: 0,
    y: 0,
    angle: 0,
    walking: false,
    mode: "idle",
    stepPhase: 0,
  });
  const targetRef = useRef<{
    x: number;
    z: number;
    sectionId: SectionId | null;
  } | null>(null);
  const pathQueueRef = useRef<{ x: number; z: number }[]>([]);
  const pendingNavRef = useRef<SectionId | null>(null);
  const doorsRef = useRef<DoorState>(
    Object.fromEntries(SECTIONS.map((s) => [s.id, 0])) as DoorState
  );
  const gatorRef = useRef<GatorState>({
    x: GATOR_HOME.x,
    z: GATOR_HOME.z,
    angle: GATOR_HOME.angle,
    chasing: false,
  });
  const approachingGatorRef = useRef(false);
  const coasterRef = useRef<CoasterState>({
    t: 0,
    laps: 0,
    riding: false,
  });
  const approachingParkRef = useRef(false);
  const familyRef = useRef<FamilyState>({ active: false, t: 0 });
  const golfRef = useRef<GolfState>({ active: false, t: 0 });
  const approachingGolfRef = useRef(false);

  const pathname = usePathname();
  const router = useRouter();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  // Route changes — snap character to door (deep link) or clear targets.
  useEffect(() => {
    const section = getSectionByPath(pathname ?? "/");
    if (section) {
      const t = doorTarget(section);
      charRef.current.x = t.x;
      charRef.current.z = t.z;
      // Face the building (away from origin)
      charRef.current.angle = Math.atan2(
        section.x - t.x,
        section.z - t.z
      );
      charRef.current.walking = false;
      charRef.current.mode = "idle";
      targetRef.current = null;
      pathQueueRef.current = [];
      pendingNavRef.current = null;
      approachingGatorRef.current = false;
      gatorRef.current.chasing = false;
      approachingParkRef.current = false;
      coasterRef.current.riding = false;
      coasterRef.current.t = 0;
      familyRef.current.active = false;
      familyRef.current.t = 0;
      golfRef.current.active = false;
      golfRef.current.t = 0;
      approachingGolfRef.current = false;
    } else {
      targetRef.current = null;
      pathQueueRef.current = [];
      pendingNavRef.current = null;
      familyRef.current.active = false;
      familyRef.current.t = 0;
      golfRef.current.active = false;
      golfRef.current.t = 0;
      approachingGolfRef.current = false;
    }
  }, [pathname]);

  const refs: SharedRefs = useMemo(
    () => ({
      char: charRef,
      target: targetRef,
      pathQueue: pathQueueRef,
      pendingNav: pendingNavRef,
      doors: doorsRef,
      gator: gatorRef,
      approachingGator: approachingGatorRef,
      coaster: coasterRef,
      approachingPark: approachingParkRef,
      family: familyRef,
      golf: golfRef,
      approachingGolf: approachingGolfRef,
    }),
    []
  );

  const isOnHome = (pathname ?? "/") === "/";

  return (
    <div className="w-full h-full">
      <Canvas
        shadows
        camera={{ position: [0, 11, 14], fov: 45, near: 0.1, far: 250 }}
        gl={{ antialias: true }}
      >

        <color attach="background" args={["#1a1a2e"]} />
        <fog attach="fog" args={["#7fa8c8", 45, 95]} />
        <Scene refs={refs} router={router} isOnHome={isOnHome} pathname={pathname ?? "/"} />
      </Canvas>
    </div>
  );
}

// -------------------- scene --------------------

type RouterLike = ReturnType<typeof useRouter>;

function Scene({
  refs,
  router,
  isOnHome,
  pathname,
}: {
  refs: SharedRefs;
  router: RouterLike;
  isOnHome: boolean;
  pathname: string;
}) {
  // Game tick — runs every frame
  useFrame((_, dt) => {
    const clampedDt = Math.min(0.1, dt);
    const char = refs.char.current;
    const target = refs.target.current;
    const gator = refs.gator.current;
    const coaster = refs.coaster.current;

    // ── 0a. Golf hole-in-one ──
    if (char.mode === "golfing") {
      refs.golf.current.t += clampedDt / GOLF_DURATION;
      const gt = refs.golf.current.t;
      // Pinned to the tee, facing south (sideways to the target line so
      // the swing happens across the body like a real RH golfer).
      char.x = GOLF_TEE.x;
      char.z = GOLF_TEE.z;
      char.angle = 0;
      // Celebration jumps after the ball lands
      if (gt > 0.55 && gt < 0.88) {
        const jumpT = (gt - 0.55) / 0.33;
        char.y = Math.max(0, Math.sin(jumpT * Math.PI * 4)) * 0.32;
      } else {
        char.y = 0;
      }
      if (gt >= 1) {
        refs.golf.current.t = 0;
        refs.golf.current.active = false;
        char.mode = "idle";
        char.y = 0;
        // Walk back to the plaza
        refs.target.current = { x: 0, z: 0, sectionId: null };
        char.walking = true;
      }
    }

    // ── 0. Coaster ride ──
    // Character is riding the cart: position is driven by the track parameter t.
    if (char.mode === "riding") {
      coaster.t += clampedDt / RIDE_LAP_SECONDS;
      if (coaster.t >= 1) {
        coaster.t = 0;
        coaster.laps += 1;
        if (coaster.laps >= RIDE_LAPS) {
          // Ride is over — step off the cart at the entry point and walk home
          coaster.laps = 0;
          coaster.riding = false;
          char.mode = "idle";
          char.y = 0;
          char.x = PARK.x;
          char.z = PARK.z + PARK_ENTRY_OFFSET;
          char.angle = Math.atan2(-char.x, -char.z); // face plaza
          refs.target.current = { x: 0, z: 0, sectionId: null };
          char.walking = true;
        }
      }
      if (coaster.riding) {
        const pos = coasterWorldAt(coaster.t);
        char.x = pos.x;
        char.z = pos.z;
        char.y = pos.y;
        char.angle = pos.angle;
      }
    }

    // ── 1. Character movement ──
    if (isOnHome && char.mode === "flee") {
      // Sprint back to the plaza
      const dx = 0 - char.x;
      const dz = 0 - char.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.7) {
        char.mode = "idle";
        char.walking = false;
        char.stepPhase = 0;
        gator.chasing = false;
      } else {
        const step = FLEE_SPEED * clampedDt;
        const proposed = resolveCollisions(
          char.x + (dx / dist) * step,
          char.z + (dz / dist) * step
        );
        char.x = proposed.x;
        char.z = proposed.z;
        char.angle = Math.atan2(dx, dz);
        char.walking = true;
        char.stepPhase = (char.stepPhase + clampedDt * 4.5) % 1;
      }
    } else if (isOnHome && target && char.walking) {
      const dx = target.x - char.x;
      const dz = target.z - char.z;
      const dist = Math.hypot(dx, dz);
      if (dist < ARRIVE_DIST) {
        char.x = target.x;
        char.z = target.z;
        // If there are more waypoints queued, the current "arrival" is just
        // a pass-through to the next leg. Don't fire any of the approach /
        // section handlers until the queue is empty.
        if (refs.pathQueue.current.length > 0) {
          // More waypoints queued — treat this arrival as a pass-through
          // and continue walking to the next leg. Approach / section
          // handlers stay deferred until the queue is empty.
          const next = refs.pathQueue.current.shift()!;
          refs.target.current = {
            x: next.x,
            z: next.z,
            sectionId: target.sectionId,
          };
        } else {
          char.walking = false;
          char.stepPhase = 0;
          if (target.sectionId) {
            const sec = SECTIONS.find((s) => s.id === target.sectionId);
            if (sec) {
              char.angle = Math.atan2(sec.x - char.x, sec.z - char.z);
            }
            refs.pendingNav.current = target.sectionId;
          } else if (refs.approachingGator.current) {
            refs.approachingGator.current = false;
            char.mode = "flee";
            char.walking = true;
            gator.chasing = true;
          } else if (refs.approachingPark.current) {
            // Board the coaster!
            refs.approachingPark.current = false;
            char.mode = "riding";
            char.walking = false;
            coaster.riding = true;
            coaster.t = 0;
            coaster.laps = 0;
          } else if (refs.approachingGolf.current) {
            // Address the ball — start the golf sequence. Face SOUTH so
            // the target line (west toward the hole) runs along the
            // character's LEFT side: a proper right-handed golfer stance.
            refs.approachingGolf.current = false;
            char.mode = "golfing";
            char.walking = false;
            char.angle = 0;
            refs.golf.current.active = true;
            refs.golf.current.t = 0;
          }
          refs.target.current = null;
        }
      } else {
        const step = WALK_SPEED * clampedDt;
        const proposed = resolveCollisions(
          char.x + (dx / dist) * step,
          char.z + (dz / dist) * step
        );
        char.x = proposed.x;
        char.z = proposed.z;
        char.angle = Math.atan2(dx, dz);
        char.stepPhase = (char.stepPhase + clampedDt * 2.2) % 1;
      }
    } else if (!char.walking) {
      char.stepPhase = 0;
    }

    // ── 1b. Water proximity → auto-trigger gator chase ──
    // If the character wanders within striking distance of the lake while
    // otherwise unbusy, the gator springs out and the chase begins. This
    // covers both deliberate gator clicks and incidental "I clicked too
    // close to the water" cases.
    if (
      isOnHome &&
      char.mode === "idle" &&
      !gator.chasing &&
      !coaster.riding &&
      !refs.golf.current.active &&
      !refs.family.current.active &&
      !refs.pendingNav.current
    ) {
      const ldx = char.x - LAKE_CENTER.x;
      const ldz = char.z - LAKE_CENTER.z;
      if (Math.hypot(ldx, ldz) < WATER_TRIGGER_RADIUS) {
        char.mode = "flee";
        char.walking = true;
        gator.chasing = true;
        refs.target.current = null;
        refs.pathQueue.current = [];
        refs.approachingGator.current = false;
      }
    }

    // ── 2. Gator movement ──
    // Gator model's head is at local -X. To make the head face direction
    // (dx, dz), we need atan2(dz, -dx).
    if (gator.chasing) {
      const dx = char.x - gator.x;
      const dz = char.z - gator.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.3) {
        const step = GATOR_CHASE_SPEED * clampedDt;
        gator.x += (dx / dist) * step;
        gator.z += (dz / dist) * step;
        gator.angle = Math.atan2(dz, -dx);
      }
    } else {
      const dx = GATOR_HOME.x - gator.x;
      const dz = GATOR_HOME.z - gator.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.05) {
        const step = GATOR_RETURN_SPEED * clampedDt;
        gator.x += (dx / dist) * Math.min(step, dist);
        gator.z += (dz / dist) * Math.min(step, dist);
        gator.angle = Math.atan2(dz, -dx);
      } else {
        // Drift back to resting angle
        let diff = GATOR_HOME.angle - gator.angle;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        gator.angle += diff * Math.min(1, clampedDt * 3);
      }
    }

    // Doors
    const targetingSection =
      refs.target.current?.sectionId ?? refs.pendingNav.current;
    for (const s of SECTIONS) {
      const cur = refs.doors.current[s.id];
      const open = s.id === targetingSection;
      refs.doors.current[s.id] = open
        ? Math.min(1, cur + DOOR_OPEN_SPEED * clampedDt)
        : Math.max(0, cur - DOOR_CLOSE_SPEED * clampedDt);
    }

    // Navigate when door fully open. EXCEPT for HOME — first the family
    // (wife, son, two dogs) jumps out and waves before the section opens.
    if (refs.pendingNav.current) {
      const openness = refs.doors.current[refs.pendingNav.current];
      if (openness >= 0.999) {
        const id = refs.pendingNav.current;
        if (id === "personal-life") {
          if (!refs.family.current.active) {
            refs.family.current.active = true;
            refs.family.current.t = 0;
          } else {
            refs.family.current.t += clampedDt / HOME_FAMILY_DURATION;
            if (refs.family.current.t >= 1) {
              refs.pendingNav.current = null;
              refs.family.current.active = false;
              refs.family.current.t = 0;
              queueMicrotask(() => {
                router.push("/personal-life");
              });
            }
          }
        } else {
          refs.pendingNav.current = null;
          queueMicrotask(() => {
            const sec = SECTIONS.find((s) => s.id === id);
            if (sec) router.push(sec.path);
          });
        }
      }
    }
  });

  function isBusy() {
    return (
      refs.char.current.mode === "flee" ||
      refs.char.current.mode === "riding" ||
      refs.char.current.mode === "golfing" ||
      refs.gator.current.chasing ||
      refs.coaster.current.riding ||
      refs.family.current.active ||
      refs.golf.current.active
    );
  }

  // Helper: set a target and pre-populate the path queue with any waypoints
  // needed to bypass building corners between here and there.
  function walkTo(
    destX: number,
    destZ: number,
    sectionId: SectionId | null
  ) {
    const c = refs.char.current;
    const path = routeTo(c.x, c.z, destX, destZ);
    const first = path[0];
    refs.target.current = { x: first.x, z: first.z, sectionId };
    refs.pathQueue.current = path.slice(1);
    refs.char.current.walking = true;
  }

  function handleBuildingClick(section: Section) {
    if (!isOnHome || isBusy()) return;
    const t = doorTarget(section);
    walkTo(t.x, t.z, section.id);
  }

  function handleGatorClick() {
    if (!isOnHome || isBusy()) return;
    // Walk to a spot just in front of the gator (on the line back to plaza)
    const g = refs.gator.current;
    const r = Math.hypot(g.x, g.z);
    const offset = 1.6; // stand this far from the gator before it pounces
    const k = (r - offset) / r;
    walkTo(g.x * k, g.z * k, null);
    refs.approachingGator.current = true;
  }

  function handleParkClick() {
    if (!isOnHome || isBusy()) return;
    // Walk to the park entrance (south of park, near the ticket booth)
    walkTo(PARK.x, PARK.z + PARK_ENTRY_OFFSET, null);
    refs.approachingPark.current = true;
  }

  function handleGolfClick() {
    if (!isOnHome || isBusy()) return;
    walkTo(GOLF_TEE.x, GOLF_TEE.z, null);
    refs.approachingGolf.current = true;
  }


  return (
    <>
      <Lights />
      <Sky />
      <Clouds />
      <Ground />
      <Plaza />
      <Environment
        gatorRef={refs.gator}
        onGatorClick={handleGatorClick}
        coasterRef={refs.coaster}
        onParkClick={handleParkClick}
        golfRef={refs.golf}
        onGolfClick={handleGolfClick}
      />
      {SECTIONS.map((s) => (
        <Building
          key={s.id}
          section={s}
          doorsRef={refs.doors}
          onSelect={() => handleBuildingClick(s)}
        />
      ))}
      <Character charRef={refs.char} golfRef={refs.golf} />
      <Family familyRef={refs.family} />
      <CameraRig charRef={refs.char} pathname={pathname} />
    </>
  );
}

// -------------------- lights / sky / ground --------------------

function Lights() {
  return (
    <>
      <ambientLight intensity={0.7} color="#dfe5ed" />
      <hemisphereLight args={["#c8d8e8", "#6a9a4a", 0.6]} />
      <directionalLight
        position={[8, 14, 6]}
        intensity={1.1}
        color="#fff4dc"
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-left={-15}
        shadow-camera-right={15}
        shadow-camera-top={15}
        shadow-camera-bottom={-15}
        shadow-camera-near={0.5}
        shadow-camera-far={40}
      />
      {/* Fill light from the opposite side so back-lit surfaces aren't pitch-black */}
      <directionalLight position={[-8, 6, -4]} intensity={0.35} color="#a8b8cc" />
    </>
  );
}

function Sky() {
  // Vertex-colored gradient sphere: bright at the horizon, deeper sky-blue overhead
  const geom = useMemo(() => {
    const g = new THREE.SphereGeometry(110, 32, 20);
    const colors: number[] = [];
    const top = new THREE.Color("#4a82bd");
    const horizon = new THREE.Color("#c8d8e8");
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 110; // -1..1
      const t = Math.max(0, y); // only above horizon
      const c = horizon.clone().lerp(top, t);
      colors.push(c.r, c.g, c.b);
    }
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    return g;
  }, []);
  return (
    <mesh geometry={geom}>
      <meshBasicMaterial vertexColors side={THREE.BackSide} />
    </mesh>
  );
}

function Ground() {
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0, 0]}
      receiveShadow
    >
      <planeGeometry args={[90, 90]} />
      <meshStandardMaterial color="#5a8a3a" />
    </mesh>
  );
}

// -------------------- environment decorations --------------------

function Environment({
  gatorRef,
  onGatorClick,
  coasterRef,
  onParkClick,
  golfRef,
  onGolfClick,
}: {
  gatorRef: React.MutableRefObject<GatorState>;
  onGatorClick: () => void;
  coasterRef: React.MutableRefObject<CoasterState>;
  onParkClick: () => void;
  golfRef: React.MutableRefObject<GolfState>;
  onGolfClick: () => void;
}) {
  return (
    <>
      {/* Lake to the northeast, with gator and surrounding palm trees */}
      <Lake position={[11.5, 0, -8]} radius={2.8} />
      <Alligator gatorRef={gatorRef} onSelect={onGatorClick} />
      <PalmTree position={[8.5, 0, -10.5]} />
      <PalmTree position={[14, 0, -10]} scale={1.15} />
      <PalmTree position={[9.5, 0, -5.2]} scale={0.9} />
      <PalmTree position={[14.5, 0, -6.3]} />

      {/* Golf course to the southwest */}
      <GolfCourse position={[-11.5, 0, 9]} onSelect={onGolfClick} />
      <GolfBall golfRef={golfRef} />

      {/* Amusement park to the northwest (opposite the golf course) */}
      <AmusementPark onSelect={onParkClick} />
      <CoasterCart coasterRef={coasterRef} />

      {/* Distant rolling hills at the far edges of the world */}
      <Hill position={[-28, 0, -26]} scale={1.4} color="#4a7a30" />
      <Hill position={[26, 0, -28]} scale={1.6} color="#3d6824" />
      <Hill position={[28, 0, 24]} scale={1.3} color="#4a7a30" />
      <Hill position={[-26, 0, 26]} scale={1.5} color="#3d6824" />
      <Hill position={[0, 0, -32]} scale={1.8} color="#446e2a" />
      <Hill position={[32, 0, -8]} scale={1.2} color="#3d6824" />

      {/* Mix of regular oaks and pine trees */}
      <Tree position={[15, 0, 1]} scale={1.1} />
      <Tree position={[-7, 0, 0]} />
      <Tree position={[9, 0, 13]} scale={1.2} />
      <Tree position={[-7, 0, 14]} />
      <Tree position={[2, 0, -16]} scale={1.05} />
      <Tree position={[18, 0, -2]} scale={0.95} />
      <Tree position={[-19, 0, 5]} />
      <Tree position={[-21, 0, -14]} scale={1.15} />
      <PineTree position={[-22, 0, -6]} scale={1.0} />
      <PineTree position={[-24, 0, 8]} scale={1.3} />
      <PineTree position={[22, 0, 10]} scale={1.1} />
      <PineTree position={[24, 0, -16]} scale={1.5} />
      <PineTree position={[12, 0, -19]} scale={1.0} />
      <PineTree position={[-12, 0, -20]} scale={1.2} />
      <PineTree position={[-3, 0, 20]} scale={1.1} />
      <PineTree position={[8, 0, 19]} scale={1.4} />

      {/* Bushes scattered around the perimeter for ground texture */}
      <Bush position={[6, 0, 4]} scale={1.0} />
      <Bush position={[-5, 0, 6]} scale={0.85} color="#356b30" />
      <Bush position={[10, 0, -6]} scale={0.9} />
      <Bush position={[-10, 0, -5]} scale={1.1} color="#446e2a" />
      <Bush position={[17, 0, 5]} scale={0.95} />
      <Bush position={[16, 0, -10]} scale={1.0} color="#356b30" />
      <Bush position={[-15, 0, 1]} scale={1.05} />
      <Bush position={[-16, 0, -8]} scale={0.9} />
      <Bush position={[-7, 0, -10]} scale={1.0} color="#446e2a" />
      <Bush position={[3, 0, 17]} scale={1.1} />
      <Bush position={[-1, 0, -19]} scale={0.95} color="#356b30" />
      <Bush position={[20, 0, 18]} scale={1.2} />
      <Bush position={[-20, 0, 16]} scale={1.0} />
      <Bush position={[19, 0, -18]} scale={0.9} color="#446e2a" />
      <Bush position={[-19, 0, -20]} scale={1.1} />

      {/* Birds drifting across the sky */}
      <Bird initialX={-20} y={10} z={-12} speed={1.8} size={1.0} flapPhase={0} />
      <Bird initialX={-12} y={11} z={-14} speed={1.8} size={0.95} flapPhase={0.4} />
      <Bird initialX={-4} y={10.4} z={-12.8} speed={1.8} size={0.9} flapPhase={0.8} />
      <Bird initialX={18} y={9} z={4} speed={-1.4} size={1.1} flapPhase={1.6} />
      <Bird initialX={6} y={12} z={16} speed={1.2} size={0.85} flapPhase={2.1} />
    </>
  );
}

function Clouds() {
  return (
    <>
      <DriftingCloud initialX={-15} y={22} z={-30} speed={0.18} size={0.65} />
      <DriftingCloud initialX={8} y={26} z={-34} speed={0.12} size={0.9} />
      <DriftingCloud initialX={-4} y={23} z={28} speed={0.22} size={0.55} />
      <DriftingCloud initialX={28} y={24} z={6} speed={0.15} size={0.75} />
      <DriftingCloud initialX={-28} y={28} z={14} speed={0.1} size={0.7} />
    </>
  );
}

function DriftingCloud({
  initialX,
  y,
  z,
  speed,
  size,
}: {
  initialX: number;
  y: number;
  z: number;
  speed: number;
  size: number;
}) {
  const ref = useRef<THREE.Group>(null);
  const startedRef = useRef(false);
  useFrame((_, dt) => {
    if (!ref.current) return;
    if (!startedRef.current) {
      ref.current.position.x = initialX;
      startedRef.current = true;
    }
    ref.current.position.x += speed * dt;
    if (ref.current.position.x > 35) ref.current.position.x = -35;
  });
  return (
    <group ref={ref} position={[initialX, y, z]}>
      <mesh>
        <sphereGeometry args={[1.2 * size, 10, 8]} />
        <meshStandardMaterial color="#ffffff" roughness={1} />
      </mesh>
      <mesh position={[1.1 * size, 0.05 * size, 0.1 * size]}>
        <sphereGeometry args={[0.9 * size, 10, 8]} />
        <meshStandardMaterial color="#ffffff" roughness={1} />
      </mesh>
      <mesh position={[-0.95 * size, -0.05 * size, 0.15 * size]}>
        <sphereGeometry args={[0.75 * size, 10, 8]} />
        <meshStandardMaterial color="#f4f6fa" roughness={1} />
      </mesh>
      <mesh position={[0.3 * size, 0.4 * size, -0.2 * size]}>
        <sphereGeometry args={[0.7 * size, 10, 8]} />
        <meshStandardMaterial color="#ffffff" roughness={1} />
      </mesh>
    </group>
  );
}

function Lake({
  position,
  radius,
}: {
  position: [number, number, number];
  radius: number;
}) {
  return (
    <group position={position}>
      {/* Sandy/muddy shore ring */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]} receiveShadow>
        <ringGeometry args={[radius, radius + 0.8, 36]} />
        <meshStandardMaterial color="#c5a368" />
      </mesh>
      {/* Water disc */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} receiveShadow>
        <circleGeometry args={[radius, 36]} />
        <meshStandardMaterial color="#3e7ba8" roughness={0.4} metalness={0.1} />
      </mesh>
      {/* Subtle ripple ring */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.025, 0]}>
        <ringGeometry args={[radius * 0.55, radius * 0.6, 36]} />
        <meshStandardMaterial
          color="#a8c4d8"
          transparent
          opacity={0.45}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

function Alligator({
  gatorRef,
  onSelect,
}: {
  gatorRef: React.MutableRefObject<GatorState>;
  onSelect: () => void;
}) {
  const GATOR = "#3a5a2c";
  const GATOR_DARK = "#243d1a";
  const MOUTH_INSIDE = "#5a2020";
  const TEETH = "#f0eadb";
  const rootRef = useRef<THREE.Group>(null);
  const tailRef = useRef<THREE.Group>(null);
  const jawRef = useRef<THREE.Group>(null);
  // Leg pivot refs: front-left, front-right, back-left, back-right
  const flRef = useRef<THREE.Group>(null);
  const frRef = useRef<THREE.Group>(null);
  const blRef = useRef<THREE.Group>(null);
  const brRef = useRef<THREE.Group>(null);

  useFrame((state) => {
    const g = gatorRef.current;
    const t = state.clock.elapsedTime;
    if (rootRef.current) {
      rootRef.current.position.x = g.x;
      rootRef.current.position.z = g.z;
      rootRef.current.position.y = 0.05;
      const cur = rootRef.current.rotation.y;
      let diff = g.angle - cur;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      rootRef.current.rotation.y = cur + diff * 0.18;
    }
    if (tailRef.current) {
      const speed = g.chasing ? 7 : 1.8;
      const amp = g.chasing ? 0.55 : 0.18;
      tailRef.current.rotation.y = Math.sin(t * speed) * amp;
    }
    // Jaw — open and snap while chasing
    if (jawRef.current) {
      const target = g.chasing
        ? 0.5 + Math.sin(t * 7) * 0.15
        : 0;
      // Negative Z rotation lifts the front of the snout (which points -X)
      const cur = jawRef.current.rotation.z;
      jawRef.current.rotation.z = cur + (-target - cur) * 0.25;
    }
    // Legs — running gait (FL+BR vs FR+BL alternating)
    const runT = t * 9;
    const runSwing = g.chasing ? Math.sin(runT) * 0.9 : 0;
    const runSwingOpp = g.chasing ? Math.sin(runT + Math.PI) * 0.9 : 0;
    if (flRef.current) flRef.current.rotation.z = runSwing;
    if (brRef.current) brRef.current.rotation.z = runSwing;
    if (frRef.current) frRef.current.rotation.z = runSwingOpp;
    if (blRef.current) blRef.current.rotation.z = runSwingOpp;
  });

  return (
    <group
      ref={rootRef}
      position={[GATOR_HOME.x, 0.05, GATOR_HOME.z]}
      rotation={[0, GATOR_HOME.angle, 0]}
    >
      {/* Main body — long and low (clickable hitbox) */}
      <mesh
        position={[0, 0.08, 0]}
        castShadow
        onClick={(e) => {
          onSelect();
          e.stopPropagation();
        }}
        onPointerOver={(e) => {
          document.body.style.cursor = "pointer";
          e.stopPropagation();
        }}
        onPointerOut={() => {
          document.body.style.cursor = "auto";
        }}
      >
        <boxGeometry args={[2.0, 0.18, 0.55]} />
        <meshStandardMaterial color={GATOR} />
      </mesh>
      {/* Back ridges (scutes) */}
      {[-0.7, -0.35, 0, 0.35].map((x, i) => (
        <mesh key={i} position={[x, 0.18, 0]} castShadow>
          <boxGeometry args={[0.16, 0.06, 0.45]} />
          <meshStandardMaterial color={GATOR_DARK} />
        </mesh>
      ))}
      {/* Tail — pivots from the body so it can swish. */}
      <group ref={tailRef} position={[0.8, 0.08, 0]}>
        <mesh position={[0.45, 0, 0]} castShadow>
          <boxGeometry args={[0.9, 0.14, 0.32]} />
          <meshStandardMaterial color={GATOR} />
        </mesh>
        <mesh position={[1.05, 0, 0]} castShadow>
          <boxGeometry args={[0.4, 0.1, 0.12]} />
          <meshStandardMaterial color={GATOR} />
        </mesh>
      </group>
      {/* Head — wide skull (no snout, snout is split into separate jaw parts) */}
      <mesh position={[-1.15, 0.1, 0]} castShadow>
        <boxGeometry args={[0.7, 0.18, 0.5]} />
        <meshStandardMaterial color={GATOR} />
      </mesh>
      {/* Eyes — bumps on top of head */}
      <mesh position={[-1.0, 0.22, 0.13]} castShadow>
        <sphereGeometry args={[0.06, 8, 6]} />
        <meshStandardMaterial color={GATOR_DARK} />
      </mesh>
      <mesh position={[-1.0, 0.22, -0.13]} castShadow>
        <sphereGeometry args={[0.06, 8, 6]} />
        <meshStandardMaterial color={GATOR_DARK} />
      </mesh>
      <mesh position={[-1.0, 0.25, 0.13]}>
        <sphereGeometry args={[0.02, 6, 6]} />
        <meshBasicMaterial color="#1a1a1a" />
      </mesh>
      <mesh position={[-1.0, 0.25, -0.13]}>
        <sphereGeometry args={[0.02, 6, 6]} />
        <meshBasicMaterial color="#1a1a1a" />
      </mesh>

      {/* Snout — split into upper (pivots) and lower (static).
          Pivot point is at the back of the snout where it meets the head. */}
      <group position={[-1.45, 0.1, 0]}>
        {/* Mouth interior — dark patch visible when jaw opens */}
        <mesh position={[-0.17, 0, 0]}>
          <boxGeometry args={[0.34, 0.05, 0.36]} />
          <meshStandardMaterial color={MOUTH_INSIDE} />
        </mesh>
        {/* Lower jaw — static, sits on the bottom */}
        <mesh position={[-0.17, -0.035, 0]} castShadow>
          <boxGeometry args={[0.35, 0.05, 0.38]} />
          <meshStandardMaterial color={GATOR} />
        </mesh>
        {/* Lower teeth */}
        <mesh position={[-0.33, -0.01, 0]}>
          <boxGeometry args={[0.04, 0.04, 0.32]} />
          <meshStandardMaterial color={TEETH} />
        </mesh>
        {/* Upper jaw — pivots around Z (back of snout) to open */}
        <group ref={jawRef}>
          <mesh position={[-0.17, 0.035, 0]} castShadow>
            <boxGeometry args={[0.35, 0.05, 0.38]} />
            <meshStandardMaterial color={GATOR} />
          </mesh>
          {/* Upper teeth — point downward, visible when mouth opens */}
          <mesh position={[-0.33, 0.01, 0]}>
            <boxGeometry args={[0.04, 0.04, 0.32]} />
            <meshStandardMaterial color={TEETH} />
          </mesh>
          {/* Nostrils on top of upper jaw */}
          <mesh position={[-0.3, 0.06, 0.05]}>
            <sphereGeometry args={[0.018, 6, 5]} />
            <meshBasicMaterial color="#1a1a1a" />
          </mesh>
          <mesh position={[-0.3, 0.06, -0.05]}>
            <sphereGeometry args={[0.018, 6, 5]} />
            <meshBasicMaterial color="#1a1a1a" />
          </mesh>
        </group>
      </group>

      {/* Legs — each in a pivot group at the top, so rotation around Z
          swings the leg forward/back. */}
      <Leg ref={flRef} x={-0.85} z={-0.32} color={GATOR_DARK} />
      <Leg ref={frRef} x={-0.85} z={0.32} color={GATOR_DARK} />
      <Leg ref={blRef} x={0.45} z={-0.32} color={GATOR_DARK} />
      <Leg ref={brRef} x={0.45} z={0.32} color={GATOR_DARK} />
    </group>
  );
}

const Leg = forwardRef<
  THREE.Group,
  { x: number; z: number; color: string }
>(function Leg({ x, z, color }, ref) {
  return (
    <group ref={ref} position={[x, 0.04, z]}>
      <mesh position={[0, -0.07, 0]} castShadow>
        <boxGeometry args={[0.18, 0.16, 0.16]} />
        <meshStandardMaterial color={color} />
      </mesh>
    </group>
  );
});

function PalmTree({
  position,
  scale = 1,
}: {
  position: [number, number, number];
  scale?: number;
}) {
  const trunkH = 3.8 * scale;
  const trunkR = 0.16 * scale;
  return (
    <group position={position}>
      {/* Trunk — slightly tapered */}
      <mesh position={[0, trunkH / 2, 0]} castShadow>
        <cylinderGeometry args={[trunkR * 0.7, trunkR, trunkH, 8]} />
        <meshStandardMaterial color="#8b6a3f" roughness={1} />
      </mesh>
      {/* Trunk rings for that palm-bark texture */}
      {[0.2, 0.4, 0.6, 0.8].map((t, i) => (
        <mesh key={i} position={[0, trunkH * t, 0]}>
          <torusGeometry args={[trunkR * 1.05, 0.02, 4, 12]} />
          <meshStandardMaterial color="#6b4e2a" />
        </mesh>
      ))}
      {/* Coconut cluster at top */}
      <mesh position={[0, trunkH + 0.05, 0]} castShadow>
        <sphereGeometry args={[0.22 * scale, 8, 6]} />
        <meshStandardMaterial color="#4a3722" />
      </mesh>
      {/* Fronds — 7 elongated leaf shapes radiating around the top */}
      {Array.from({ length: 7 }).map((_, i) => {
        const angle = (i / 7) * Math.PI * 2;
        const droop = -0.3 - (i % 2 ? 0.1 : 0);
        return (
          <group
            key={i}
            position={[0, trunkH + 0.15, 0]}
            rotation={[0, angle, 0]}
          >
            <group rotation={[droop, 0, 0]}>
              <mesh position={[0, 0.05, 0.9 * scale]} castShadow>
                <boxGeometry args={[0.55 * scale, 0.04, 1.8 * scale]} />
                <meshStandardMaterial color="#3d7a36" />
              </mesh>
              {/* spine of the frond */}
              <mesh position={[0, 0.08, 0.9 * scale]}>
                <boxGeometry args={[0.04, 0.04, 1.85 * scale]} />
                <meshStandardMaterial color="#2a5a24" />
              </mesh>
            </group>
          </group>
        );
      })}
    </group>
  );
}

function Tree({
  position,
  scale = 1,
}: {
  position: [number, number, number];
  scale?: number;
}) {
  const trunkH = 1.4 * scale;
  const trunkR = 0.18 * scale;
  const canopyR = 1.1 * scale;
  return (
    <group position={position}>
      <mesh position={[0, trunkH / 2, 0]} castShadow>
        <cylinderGeometry args={[trunkR * 0.85, trunkR, trunkH, 8]} />
        <meshStandardMaterial color="#6b4a2a" />
      </mesh>
      {/* Two slightly offset canopy spheres for that fluffier-than-a-ball look */}
      <mesh position={[0, trunkH + canopyR * 0.7, 0]} castShadow>
        <sphereGeometry args={[canopyR, 10, 8]} />
        <meshStandardMaterial color="#3d7a36" />
      </mesh>
      <mesh
        position={[canopyR * 0.4, trunkH + canopyR * 1.0, -canopyR * 0.2]}
        castShadow
      >
        <sphereGeometry args={[canopyR * 0.75, 10, 8]} />
        <meshStandardMaterial color="#4a8a3a" />
      </mesh>
      <mesh
        position={[-canopyR * 0.5, trunkH + canopyR * 0.85, canopyR * 0.3]}
        castShadow
      >
        <sphereGeometry args={[canopyR * 0.65, 10, 8]} />
        <meshStandardMaterial color="#356b30" />
      </mesh>
    </group>
  );
}

function GolfCourse({
  position,
  onSelect,
}: {
  position: [number, number, number];
  onSelect: () => void;
}) {
  return (
    <group position={position}>
      {/* Fairway — clickable target for the hole-in-one easter egg */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.011, 0]}
        receiveShadow
        onClick={(e) => {
          onSelect();
          e.stopPropagation();
        }}
        onPointerOver={(e) => {
          document.body.style.cursor = "pointer";
          e.stopPropagation();
        }}
        onPointerOut={() => {
          document.body.style.cursor = "auto";
        }}
      >
        <planeGeometry args={[10, 6]} />
        <meshStandardMaterial color="#7ab84a" />
      </mesh>
      {/* Putting green — slightly darker oval at one end */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[-3.5, 0.013, 0]}
        receiveShadow
      >
        <circleGeometry args={[1.6, 24]} />
        <meshStandardMaterial color="#5fa838" />
      </mesh>
      {/* The cup */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-3.5, 0.015, -0.4]}>
        <circleGeometry args={[0.12, 12]} />
        <meshBasicMaterial color="#0a0a0a" />
      </mesh>
      {/* Flag pole */}
      <mesh position={[-3.5, 0.85, -0.4]} castShadow>
        <cylinderGeometry args={[0.025, 0.025, 1.7, 6]} />
        <meshStandardMaterial color="#dcdce0" />
      </mesh>
      {/* Flag */}
      <mesh position={[-3.0, 1.55, -0.4]} castShadow>
        <planeGeometry args={[0.85, 0.45]} />
        <meshStandardMaterial color="#c83232" side={THREE.DoubleSide} />
      </mesh>
      {/* Flag pole tip */}
      <mesh position={[-3.5, 1.72, -0.4]}>
        <sphereGeometry args={[0.05, 8, 6]} />
        <meshStandardMaterial color="#d4a04a" metalness={0.6} roughness={0.3} />
      </mesh>
      {/* Sand bunker next to the green */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[-1.8, 0.013, 1.5]}
        scale={[1.6, 1, 1]}
        receiveShadow
      >
        <circleGeometry args={[1.0, 20]} />
        <meshStandardMaterial color="#e8d8a8" />
      </mesh>
    </group>
  );
}

// Golf ball, animated during the hole-in-one easter egg.
// Phases (gt = golf.t in [0,1]):
//   gt < 0.35  : ball at the tee
//   0.35..0.55 : flight from tee to hole along a parabolic arc
//   0.55..0.95 : ball sitting in the cup
//   >= 0.95    : hidden again
function GolfBall({
  golfRef,
}: {
  golfRef: React.MutableRefObject<GolfState>;
}) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const g = golfRef.current;
    if (!ref.current) return;
    if (!g.active) {
      ref.current.visible = false;
      return;
    }
    const gt = g.t;
    if (gt < 0.35) {
      ref.current.visible = true;
      ref.current.position.set(GOLF_TEE.x, 0.08, GOLF_TEE.z);
    } else if (gt < 0.55) {
      const p = (gt - 0.35) / 0.2;
      ref.current.visible = true;
      ref.current.position.x = GOLF_TEE.x + (GOLF_HOLE.x - GOLF_TEE.x) * p;
      ref.current.position.z = GOLF_TEE.z + (GOLF_HOLE.z - GOLF_TEE.z) * p;
      // Parabolic arc, peaks at ~2.2 units high
      ref.current.position.y = Math.sin(p * Math.PI) * 2.2 + 0.08;
    } else if (gt < 0.95) {
      ref.current.visible = true;
      ref.current.position.set(GOLF_HOLE.x, 0.02, GOLF_HOLE.z);
    } else {
      ref.current.visible = false;
    }
  });
  return (
    <mesh ref={ref} visible={false} castShadow>
      <sphereGeometry args={[0.08, 12, 8]} />
      <meshStandardMaterial color="#f8f6e8" roughness={0.6} />
    </mesh>
  );
}

function Hill({
  position,
  scale = 1,
  color = "#3d6824",
}: {
  position: [number, number, number];
  scale?: number;
  color?: string;
}) {
  // Wide, low dome — half-sphere with the bottom hemisphere chopped off.
  return (
    <mesh
      position={position}
      scale={[scale, scale * 0.55, scale]}
      castShadow
      receiveShadow
    >
      <sphereGeometry
        args={[3.5, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2]}
      />
      <meshStandardMaterial color={color} flatShading />
    </mesh>
  );
}

function PineTree({
  position,
  scale = 1,
}: {
  position: [number, number, number];
  scale?: number;
}) {
  const trunkH = 0.7 * scale;
  return (
    <group position={position}>
      {/* Bare trunk */}
      <mesh position={[0, trunkH / 2, 0]} castShadow>
        <cylinderGeometry args={[0.12, 0.16, trunkH, 6]} />
        <meshStandardMaterial color="#4a2c14" />
      </mesh>
      {/* Three stacked cone layers, narrowing toward the top */}
      {[0, 1, 2].map((i) => {
        const r = (1.0 - i * 0.18) * 0.85 * scale;
        const h = 1.05 * scale;
        const yPos = trunkH + 0.05 + i * (h * 0.6);
        const color = i === 0 ? "#2a5a30" : i === 1 ? "#326234" : "#3a7a3a";
        return (
          <mesh key={i} position={[0, yPos, 0]} castShadow>
            <coneGeometry args={[r, h, 10]} />
            <meshStandardMaterial color={color} flatShading />
          </mesh>
        );
      })}
    </group>
  );
}

function Bush({
  position,
  scale = 1,
  color = "#3d6824",
}: {
  position: [number, number, number];
  scale?: number;
  color?: string;
}) {
  return (
    <group position={position}>
      <mesh position={[0, 0.22 * scale, 0]} castShadow>
        <sphereGeometry args={[0.32 * scale, 8, 6]} />
        <meshStandardMaterial color={color} flatShading />
      </mesh>
      <mesh
        position={[0.22 * scale, 0.16 * scale, 0.1 * scale]}
        castShadow
      >
        <sphereGeometry args={[0.22 * scale, 8, 6]} />
        <meshStandardMaterial color={color} flatShading />
      </mesh>
      <mesh
        position={[-0.18 * scale, 0.18 * scale, -0.12 * scale]}
        castShadow
      >
        <sphereGeometry args={[0.24 * scale, 8, 6]} />
        <meshStandardMaterial color={color} flatShading />
      </mesh>
    </group>
  );
}

function Bird({
  initialX,
  y,
  z,
  speed,
  size = 1,
  flapPhase = 0,
}: {
  initialX: number;
  y: number;
  z: number;
  speed: number;
  size?: number;
  flapPhase?: number;
}) {
  const root = useRef<THREE.Group>(null);
  const leftWing = useRef<THREE.Group>(null);
  const rightWing = useRef<THREE.Group>(null);
  const startedRef = useRef(false);
  useFrame((state, dt) => {
    if (!root.current) return;
    if (!startedRef.current) {
      root.current.position.x = initialX;
      // Bird faces direction of motion: rotate around Y based on sign of speed
      root.current.rotation.y = speed > 0 ? -Math.PI / 2 : Math.PI / 2;
      startedRef.current = true;
    }
    root.current.position.x += speed * dt;
    // Wrap around the world so the birds keep cycling
    if (root.current.position.x > 38) root.current.position.x = -38;
    if (root.current.position.x < -38) root.current.position.x = 38;
    // A little vertical bob
    root.current.position.y =
      y + Math.sin(state.clock.elapsedTime * 1.8 + flapPhase) * 0.18;
    // Wings flap
    const flap = Math.sin(state.clock.elapsedTime * 9 + flapPhase) * 0.7;
    if (leftWing.current) leftWing.current.rotation.z = flap;
    if (rightWing.current) rightWing.current.rotation.z = -flap;
  });
  return (
    <group ref={root} position={[initialX, y, z]}>
      {/* Body */}
      <mesh>
        <boxGeometry args={[0.18 * size, 0.06 * size, 0.08 * size]} />
        <meshStandardMaterial color="#2a2a2a" />
      </mesh>
      {/* Left wing — pivot at body */}
      <group ref={leftWing}>
        <mesh position={[0, 0, 0.14 * size]} castShadow>
          <boxGeometry args={[0.12 * size, 0.02 * size, 0.28 * size]} />
          <meshStandardMaterial color="#2a2a2a" />
        </mesh>
      </group>
      {/* Right wing */}
      <group ref={rightWing}>
        <mesh position={[0, 0, -0.14 * size]} castShadow>
          <boxGeometry args={[0.12 * size, 0.02 * size, 0.28 * size]} />
          <meshStandardMaterial color="#2a2a2a" />
        </mesh>
      </group>
    </group>
  );
}

function AmusementPark({ onSelect }: { onSelect: () => void }) {
  // Support pillars under the coaster track, spaced every Nth control point.
  const supports = useMemo(() => {
    const out: { x: number; y: number; z: number; key: number }[] = [];
    const N = 14;
    for (let i = 0; i < N; i++) {
      const t = i / N;
      const p = COASTER_CURVE.getPointAt(t);
      out.push({ x: p.x, y: p.y, z: p.z, key: i });
    }
    return out;
  }, []);

  // Pre-built bunting positions (multicolored triangle flags around the ring)
  const bunting = useMemo(() => {
    const colors = ["#d83a3a", "#3a4f8b", "#ffd83a", "#3a8a4f", "#a83a8a"];
    return Array.from({ length: 20 }).map((_, i) => ({
      t: i / 20,
      color: colors[i % colors.length],
      key: i,
    }));
  }, []);

  return (
    <group position={[PARK.x, 0, PARK.z]}>
      {/* Park ground patch — sandy/dirt, makes the area read as a fairground */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.015, 0]}
        receiveShadow
      >
        <planeGeometry args={[PARK_GROUND_W, PARK_GROUND_D]} />
        <meshStandardMaterial color="#c8a878" />
      </mesh>

      {/* Ticket booth — clickable entrance, south of park */}
      <group position={[0, 0, PARK_ENTRY_OFFSET + 0.7]}>
        <mesh
          position={[0, 0.7, 0]}
          castShadow
          onClick={(e) => {
            onSelect();
            e.stopPropagation();
          }}
          onPointerOver={(e) => {
            document.body.style.cursor = "pointer";
            e.stopPropagation();
          }}
          onPointerOut={() => {
            document.body.style.cursor = "auto";
          }}
        >
          <boxGeometry args={[1.6, 1.4, 0.9]} />
          <meshStandardMaterial color="#d83a3a" />
        </mesh>
        {/* Striped roof — alternating red and white wedges */}
        {Array.from({ length: 8 }).map((_, i) => (
          <mesh
            key={i}
            position={[0, 1.55, 0]}
            rotation={[0, (i / 8) * Math.PI * 2, 0]}
            castShadow
          >
            <coneGeometry
              args={[1.25, 0.55, 8, 1, false, 0, Math.PI / 4]}
            />
            <meshStandardMaterial color={i % 2 === 0 ? "#d83a3a" : "#f4f1de"} />
          </mesh>
        ))}
        {/* Flag pole + flag on top */}
        <mesh position={[0, 2.0, 0]} castShadow>
          <cylinderGeometry args={[0.02, 0.02, 0.6, 6]} />
          <meshStandardMaterial color="#a0a0a0" />
        </mesh>
        <mesh position={[0.18, 2.18, 0]} castShadow>
          <planeGeometry args={[0.35, 0.2]} />
          <meshStandardMaterial color="#ffd83a" side={THREE.DoubleSide} />
        </mesh>
        {/* Booth window */}
        <mesh position={[0, 0.85, 0.46]}>
          <planeGeometry args={[0.8, 0.45]} />
          <meshStandardMaterial color="#1a1a1a" />
        </mesh>
        <Text
          position={[0, 1.25, 0.46]}
          fontSize={0.16}
          color="#f4f1de"
          anchorX="center"
          anchorY="middle"
          letterSpacing={0.05}
        >
          PARK
        </Text>
      </group>

      {/* Coaster track — TubeGeometry along the curve */}
      <mesh castShadow>
        <tubeGeometry args={[COASTER_CURVE, 96, 0.075, 8, true]} />
        <meshStandardMaterial color="#4a4f58" metalness={0.55} roughness={0.4} />
      </mesh>
      {/* Inner secondary rail for visual depth */}
      <mesh position={[0, -0.16, 0]} castShadow>
        <tubeGeometry args={[COASTER_CURVE, 64, 0.05, 6, true]} />
        <meshStandardMaterial color="#6a6f78" metalness={0.4} roughness={0.5} />
      </mesh>

      {/* Track supports — vertical pillars at each sample point */}
      {supports.map((s) => (
        <mesh
          key={s.key}
          position={[s.x, s.y / 2, s.z]}
          castShadow
        >
          <cylinderGeometry args={[0.05, 0.08, s.y, 6]} />
          <meshStandardMaterial color="#5a5f68" />
        </mesh>
      ))}

      {/* Bunting flags arching between two posts at the south entrance */}
      {bunting.map((b) => {
        const a = (b.t - 0.5) * Math.PI * 0.55;
        // Arch over the entry: x sweeps -2.5 to +2.5, dips in y
        const x = Math.sin(a) * 3.0;
        const y = 1.7 + Math.cos(a) * 0.6;
        const z = PARK_ENTRY_OFFSET + 0.7;
        return (
          <mesh key={b.key} position={[x, y, z]} rotation={[0, 0, -a]}>
            <coneGeometry args={[0.07, 0.18, 3]} />
            <meshStandardMaterial color={b.color} side={THREE.DoubleSide} />
          </mesh>
        );
      })}
      {/* Bunting poles */}
      {[-3.0, 3.0].map((x, i) => (
        <mesh
          key={`bp${i}`}
          position={[x, 1.1, PARK_ENTRY_OFFSET + 0.7]}
          castShadow
        >
          <cylinderGeometry args={[0.04, 0.04, 2.2, 6]} />
          <meshStandardMaterial color="#a0a0a0" />
        </mesh>
      ))}

      {/* Big rides inside the coaster ring */}
      <FerrisWheel position={[1.4, 0, -0.3]} />
      <Carousel position={[-1.5, 0, 0.3]} />

      {/* Snack carts on the south side, flanking the entrance */}
      <PopcornCart position={[-2.5, 0, PARK_ENTRY_OFFSET]} rotationY={0.4} />
      <IceCreamCart position={[2.4, 0, PARK_ENTRY_OFFSET]} rotationY={-0.3} />

      {/* Balloon cluster */}
      <BalloonBunch position={[-3.4, 0, PARK_ENTRY_OFFSET - 0.5]} />
    </group>
  );
}

function CoasterCart({
  coasterRef,
}: {
  coasterRef: React.MutableRefObject<CoasterState>;
}) {
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    const c = coasterRef.current;
    if (!ref.current) return;
    const pos = coasterWorldAt(c.t);
    ref.current.position.set(pos.x, pos.y, pos.z);
    ref.current.rotation.y = pos.angle;
  });
  return (
    <group ref={ref}>
      {/* Cart body */}
      <mesh position={[0, 0.18, 0]} castShadow>
        <boxGeometry args={[0.5, 0.36, 0.7]} />
        <meshStandardMaterial color="#cc2828" />
      </mesh>
      {/* Cart trim */}
      <mesh position={[0, 0.36, 0]}>
        <boxGeometry args={[0.52, 0.04, 0.72]} />
        <meshStandardMaterial color="#f4f1de" />
      </mesh>
      {/* Wheels */}
      {[-0.22, 0.22].map((zoff, i) => (
        <group key={i}>
          <mesh position={[-0.27, 0.08, zoff]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.07, 0.07, 0.04, 8]} />
            <meshStandardMaterial color="#1a1a1a" />
          </mesh>
          <mesh position={[0.27, 0.08, zoff]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.07, 0.07, 0.04, 8]} />
            <meshStandardMaterial color="#1a1a1a" />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function FerrisWheel({ position }: { position: [number, number, number] }) {
  const wheelRef = useRef<THREE.Group>(null);
  const cabinRefs = useRef<Array<THREE.Group | null>>([]);
  const COLORS = useMemo(
    () => ["#d83a3a", "#3a4f8b", "#ffd83a", "#3a8a4f", "#a83a8a", "#d8a04a"],
    []
  );
  const WHEEL_R = 1.55;
  const WHEEL_Y = 2.2;

  useFrame((_, dt) => {
    if (wheelRef.current) {
      wheelRef.current.rotation.z += dt * 0.38;
      // Keep each cabin upright by cancelling the wheel's rotation
      const wr = wheelRef.current.rotation.z;
      for (const c of cabinRefs.current) {
        if (c) c.rotation.z = -wr;
      }
    }
  });

  return (
    <group position={position}>
      {/* Two A-frame support legs */}
      {[-1, 1].map((side, i) => (
        <group key={i}>
          <mesh
            position={[side * 0.75, WHEEL_Y / 2, 0]}
            rotation={[0, 0, side * 0.18]}
            castShadow
          >
            <cylinderGeometry args={[0.05, 0.08, WHEEL_Y + 0.1, 8]} />
            <meshStandardMaterial color="#888c95" />
          </mesh>
        </group>
      ))}
      {/* Central axle hub */}
      <mesh
        position={[0, WHEEL_Y, 0]}
        rotation={[0, 0, Math.PI / 2]}
        castShadow
      >
        <cylinderGeometry args={[0.14, 0.14, 0.5, 12]} />
        <meshStandardMaterial color="#a83a3a" />
      </mesh>

      <group ref={wheelRef} position={[0, WHEEL_Y, 0]}>
        {/* Outer rim */}
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[WHEEL_R, 0.05, 6, 32]} />
          <meshStandardMaterial color="#d83a3a" />
        </mesh>
        {/* Inner support ring */}
        <mesh rotation={[Math.PI / 2, 0, 0]} scale={[0.55, 1, 0.55]}>
          <torusGeometry args={[WHEEL_R, 0.04, 6, 24]} />
          <meshStandardMaterial color="#a02828" />
        </mesh>
        {/* Spokes */}
        {Array.from({ length: 6 }).map((_, i) => {
          const a = (i / 6) * Math.PI * 2;
          return (
            <mesh
              key={`sp${i}`}
              position={[
                (Math.cos(a) * WHEEL_R) / 2,
                (Math.sin(a) * WHEEL_R) / 2,
                0,
              ]}
              rotation={[0, 0, a]}
              castShadow
            >
              <boxGeometry args={[WHEEL_R, 0.025, 0.025]} />
              <meshStandardMaterial color="#c8c8c8" />
            </mesh>
          );
        })}
        {/* Cabins on the rim */}
        {Array.from({ length: 6 }).map((_, i) => {
          const a = (i / 6) * Math.PI * 2;
          return (
            <group
              key={`c${i}`}
              position={[Math.cos(a) * WHEEL_R, Math.sin(a) * WHEEL_R, 0]}
              ref={(el) => {
                cabinRefs.current[i] = el;
              }}
            >
              {/* hanger */}
              <mesh position={[0, 0.06, 0]}>
                <boxGeometry args={[0.02, 0.12, 0.02]} />
                <meshStandardMaterial color="#666" />
              </mesh>
              {/* Cabin body */}
              <mesh position={[0, -0.15, 0]} castShadow>
                <boxGeometry args={[0.36, 0.28, 0.4]} />
                <meshStandardMaterial color={COLORS[i % COLORS.length]} />
              </mesh>
              {/* Roof */}
              <mesh position={[0, 0.02, 0]} castShadow>
                <boxGeometry args={[0.42, 0.04, 0.46]} />
                <meshStandardMaterial color="#f4f1de" />
              </mesh>
            </group>
          );
        })}
      </group>
    </group>
  );
}

function Carousel({ position }: { position: [number, number, number] }) {
  const platformRef = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (platformRef.current) platformRef.current.rotation.y += dt * 0.5;
  });
  const HORSE_COLORS = useMemo(
    () => ["#f4f1de", "#d8a8a8", "#a8c8e8", "#e8c8a8", "#c8a8d8", "#a8d8c8"],
    []
  );
  return (
    <group position={position}>
      {/* Base disc */}
      <mesh position={[0, 0.06, 0]} receiveShadow>
        <cylinderGeometry args={[1.0, 1.05, 0.12, 24]} />
        <meshStandardMaterial color="#d4a04a" />
      </mesh>
      {/* Center pole */}
      <mesh position={[0, 0.75, 0]}>
        <cylinderGeometry args={[0.07, 0.07, 1.2, 8]} />
        <meshStandardMaterial color="#a0a0a0" metalness={0.5} />
      </mesh>
      {/* Striped roof — alternating red/white wedges */}
      {Array.from({ length: 12 }).map((_, i) => (
        <mesh
          key={i}
          position={[0, 1.5, 0]}
          rotation={[0, (i / 12) * Math.PI * 2, 0]}
          castShadow
        >
          <coneGeometry
            args={[1.1, 0.55, 12, 1, false, 0, Math.PI / 6]}
          />
          <meshStandardMaterial color={i % 2 === 0 ? "#d83a3a" : "#f4f1de"} />
        </mesh>
      ))}
      {/* Top finial */}
      <mesh position={[0, 1.85, 0]} castShadow>
        <sphereGeometry args={[0.08, 8, 6]} />
        <meshStandardMaterial color="#d4a04a" metalness={0.5} />
      </mesh>

      {/* Rotating ring of horses */}
      <group ref={platformRef} position={[0, 0.12, 0]}>
        {Array.from({ length: 6 }).map((_, i) => {
          const a = (i / 6) * Math.PI * 2;
          const r = 0.72;
          const x = Math.cos(a) * r;
          const z = Math.sin(a) * r;
          const color = HORSE_COLORS[i % HORSE_COLORS.length];
          return (
            <group
              key={i}
              position={[x, 0, z]}
              rotation={[0, -a + Math.PI / 2, 0]}
            >
              {/* Vertical pole */}
              <mesh position={[0, 0.7, 0]}>
                <cylinderGeometry args={[0.018, 0.018, 1.3, 6]} />
                <meshStandardMaterial color="#d4a04a" metalness={0.5} />
              </mesh>
              {/* Horse body */}
              <mesh position={[0, 0.45, 0]} castShadow>
                <boxGeometry args={[0.34, 0.18, 0.13]} />
                <meshStandardMaterial color={color} />
              </mesh>
              {/* Horse neck + head */}
              <mesh
                position={[0.16, 0.55, 0]}
                rotation={[0, 0, 0.5]}
                castShadow
              >
                <boxGeometry args={[0.16, 0.13, 0.1]} />
                <meshStandardMaterial color={color} />
              </mesh>
              <mesh
                position={[0.22, 0.62, 0]}
                rotation={[0, 0, 0.5]}
                castShadow
              >
                <boxGeometry args={[0.1, 0.08, 0.09]} />
                <meshStandardMaterial color={color} />
              </mesh>
              {/* Mane */}
              <mesh position={[0.1, 0.6, 0]} rotation={[0, 0, 0.3]}>
                <boxGeometry args={[0.05, 0.13, 0.13]} />
                <meshStandardMaterial color="#5a3a2a" />
              </mesh>
              {/* Legs */}
              {[[-0.1, 0.04], [0.1, 0.04], [-0.1, -0.04], [0.1, -0.04]].map(
                ([lx, lz], j) => (
                  <mesh key={j} position={[lx, 0.28, lz]} castShadow>
                    <boxGeometry args={[0.04, 0.18, 0.04]} />
                    <meshStandardMaterial color={color} />
                  </mesh>
                )
              )}
            </group>
          );
        })}
      </group>
    </group>
  );
}

function PopcornCart({
  position,
  rotationY = 0,
}: {
  position: [number, number, number];
  rotationY?: number;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* Cart base */}
      <mesh position={[0, 0.35, 0]} castShadow>
        <boxGeometry args={[0.55, 0.5, 0.4]} />
        <meshStandardMaterial color="#d83a3a" />
      </mesh>
      {/* Striped roof */}
      <mesh position={[0, 0.85, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <coneGeometry args={[0.45, 0.3, 4]} />
        <meshStandardMaterial color="#f4f1de" />
      </mesh>
      {/* Popcorn pile inside */}
      <mesh position={[0, 0.65, 0.05]}>
        <sphereGeometry args={[0.12, 8, 6]} />
        <meshStandardMaterial color="#f8e8a0" />
      </mesh>
      {/* Wheels */}
      {[-0.18, 0.18].map((x, i) => (
        <mesh
          key={i}
          position={[x, 0.1, 0]}
          rotation={[Math.PI / 2, 0, 0]}
          castShadow
        >
          <cylinderGeometry args={[0.1, 0.1, 0.04, 10]} />
          <meshStandardMaterial color="#2a2a2a" />
        </mesh>
      ))}
      {/* Sign */}
      <Text
        position={[0, 0.42, 0.21]}
        fontSize={0.07}
        color="#f4f1de"
        anchorX="center"
        anchorY="middle"
      >
        POPCORN
      </Text>
    </group>
  );
}

function IceCreamCart({
  position,
  rotationY = 0,
}: {
  position: [number, number, number];
  rotationY?: number;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh position={[0, 0.35, 0]} castShadow>
        <boxGeometry args={[0.55, 0.5, 0.4]} />
        <meshStandardMaterial color="#f4b5d3" />
      </mesh>
      {/* Big ice cream cone on top */}
      <mesh position={[0, 0.85, 0]} rotation={[Math.PI, 0, 0]} castShadow>
        <coneGeometry args={[0.15, 0.3, 8]} />
        <meshStandardMaterial color="#d4a878" />
      </mesh>
      <mesh position={[0, 0.78, 0]} castShadow>
        <sphereGeometry args={[0.13, 10, 8]} />
        <meshStandardMaterial color="#f4f1de" />
      </mesh>
      {[-0.18, 0.18].map((x, i) => (
        <mesh
          key={i}
          position={[x, 0.1, 0]}
          rotation={[Math.PI / 2, 0, 0]}
          castShadow
        >
          <cylinderGeometry args={[0.1, 0.1, 0.04, 10]} />
          <meshStandardMaterial color="#2a2a2a" />
        </mesh>
      ))}
      <Text
        position={[0, 0.42, 0.21]}
        fontSize={0.07}
        color="#a83a8a"
        anchorX="center"
        anchorY="middle"
      >
        ICE CREAM
      </Text>
    </group>
  );
}

function BalloonBunch({
  position,
}: {
  position: [number, number, number];
}) {
  const COLORS = ["#d83a3a", "#3a4f8b", "#ffd83a", "#3a8a4f", "#a83a8a"];
  const balloonRef = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (balloonRef.current) {
      balloonRef.current.rotation.y =
        Math.sin(state.clock.elapsedTime * 0.6) * 0.1;
      balloonRef.current.position.y = Math.sin(state.clock.elapsedTime * 1.2) * 0.04;
    }
  });
  return (
    <group position={position}>
      {/* Anchor (small box, like a vendor table) */}
      <mesh position={[0, 0.2, 0]} castShadow>
        <boxGeometry args={[0.18, 0.4, 0.18]} />
        <meshStandardMaterial color="#a04a30" />
      </mesh>
      <group ref={balloonRef} position={[0, 0.5, 0]}>
        {COLORS.map((color, i) => {
          const ang = (i / COLORS.length) * Math.PI * 2;
          const r = 0.12;
          const xo = Math.cos(ang) * r;
          const zo = Math.sin(ang) * r;
          const h = 0.95 + (i % 2) * 0.15;
          return (
            <group key={i} position={[xo, 0, zo]}>
              {/* String */}
              <mesh position={[0, h / 2, 0]}>
                <cylinderGeometry args={[0.005, 0.005, h, 4]} />
                <meshStandardMaterial color="#cccccc" />
              </mesh>
              {/* Balloon */}
              <mesh position={[0, h + 0.16, 0]} castShadow>
                <sphereGeometry args={[0.13, 10, 8]} />
                <meshStandardMaterial color={color} />
              </mesh>
            </group>
          );
        })}
      </group>
    </group>
  );
}

function Plaza() {
  return (
    <>
      {/* Central dirt circle */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]} receiveShadow>
        <circleGeometry args={[1.2, 24]} />
        <meshStandardMaterial color="#b89968" />
      </mesh>
      {/* Paths radiating out to each building */}
      {SECTIONS.map((s) => {
        const t = doorTarget(s);
        const midX = t.x / 2;
        const midZ = t.z / 2;
        const len = Math.hypot(t.x, t.z);
        const angle = Math.atan2(t.x, t.z);
        return (
          <mesh
            key={s.id}
            position={[midX, 0.004, midZ]}
            rotation={[-Math.PI / 2, 0, angle]}
            receiveShadow
          >
            <planeGeometry args={[0.9, len]} />
            <meshStandardMaterial color="#b89968" />
          </mesh>
        );
      })}
    </>
  );
}

// -------------------- buildings --------------------

function Building({
  section,
  doorsRef,
  onSelect,
}: {
  section: Section;
  doorsRef: React.MutableRefObject<DoorState>;
  onSelect: () => void;
}) {
  const doorPivotRef = useRef<THREE.Group>(null);
  const smokeRef = useRef<THREE.Group>(null);
  const angle = useMemo(() => buildingAngle(section), [section]);

  useFrame((_, dt) => {
    if (doorPivotRef.current) {
      const target = -doorsRef.current[section.id] * (Math.PI / 2); // swing inward
      const cur = doorPivotRef.current.rotation.y;
      doorPivotRef.current.rotation.y = cur + (target - cur) * Math.min(1, dt * 8);
    }
    if (smokeRef.current && section.isHome) {
      smokeRef.current.children.forEach((puff, i) => {
        const p = puff as THREE.Mesh;
        p.position.y += dt * 0.4;
        if (p.position.y > 1.6) p.position.y = 0.1 + (i * 0.05);
        const fade = 1 - p.position.y / 1.6;
        const mat = p.material as THREE.MeshStandardMaterial;
        mat.opacity = Math.max(0.05, fade * 0.7);
      });
    }
  });

  const DOOR_W = 0.7;
  const DOOR_H = 1.5;
  const wallY = BUILDING_H / 2;

  // Internal room (visible when door open) — slightly inset, dark
  return (
    <group position={[section.x, 0, section.z]} rotation={[0, angle, 0]}>
      {/* Building walls */}
      <mesh
        position={[0, wallY, 0]}
        castShadow
        receiveShadow
        onClick={(e) => {
          onSelect();
          e.stopPropagation();
        }}
        onPointerOver={(e) => {
          document.body.style.cursor = "pointer";
          e.stopPropagation();
        }}
        onPointerOut={() => {
          document.body.style.cursor = "auto";
        }}
      >
        <boxGeometry args={[BUILDING_W, BUILDING_H, BUILDING_D]} />
        <meshStandardMaterial color={section.buildingColor} />
      </mesh>

      {/* Wall trim at bottom */}
      <mesh position={[0, 0.08, 0]} receiveShadow>
        <boxGeometry args={[BUILDING_W + 0.01, 0.16, BUILDING_D + 0.01]} />
        <meshStandardMaterial color={section.roofColor} />
      </mesh>

      {/* Roof — a pyramid (cone with 4 segments) */}
      <mesh
        position={[0, BUILDING_H + 0.5, 0]}
        castShadow
        rotation={[0, Math.PI / 4, 0]}
      >
        <coneGeometry args={[BUILDING_W * 0.78, 1.0, 4]} />
        <meshStandardMaterial color={section.roofColor} flatShading />
      </mesh>

      {/* Chimney + smoke for home */}
      {section.isHome && (
        <>
          <mesh
            position={[BUILDING_W * 0.32, BUILDING_H + 0.7, -BUILDING_D * 0.18]}
            castShadow
          >
            <boxGeometry args={[0.25, 0.7, 0.25]} />
            <meshStandardMaterial color={section.roofColor} />
          </mesh>
          <mesh
            position={[BUILDING_W * 0.32, BUILDING_H + 1.05, -BUILDING_D * 0.18]}
          >
            <boxGeometry args={[0.28, 0.05, 0.28]} />
            <meshStandardMaterial color="#1a0f08" />
          </mesh>
          <group
            ref={smokeRef}
            position={[BUILDING_W * 0.32, BUILDING_H + 1.15, -BUILDING_D * 0.18]}
          >
            {[0, 1, 2, 3].map((i) => (
              <mesh key={i} position={[0, 0.1 + i * 0.4, 0]}>
                <sphereGeometry args={[0.15 + i * 0.04, 8, 8]} />
                <meshStandardMaterial
                  color="#dcd5c5"
                  transparent
                  opacity={0.5}
                  depthWrite={false}
                />
              </mesh>
            ))}
          </group>
        </>
      )}

      {/* Windows — front (flanking the door), back, and both sides */}
      <Window position={[-BUILDING_W * 0.32, BUILDING_H * 0.55, BUILDING_D / 2 + 0.001]} />
      <Window position={[BUILDING_W * 0.32, BUILDING_H * 0.55, BUILDING_D / 2 + 0.001]} />
      <Window
        position={[-BUILDING_W * 0.22, BUILDING_H * 0.55, -BUILDING_D / 2 - 0.001]}
        rotationY={Math.PI}
      />
      <Window
        position={[BUILDING_W * 0.22, BUILDING_H * 0.55, -BUILDING_D / 2 - 0.001]}
        rotationY={Math.PI}
      />
      <Window
        position={[-BUILDING_W / 2 - 0.001, BUILDING_H * 0.55, 0]}
        rotationY={-Math.PI / 2}
      />
      <Window
        position={[BUILDING_W / 2 + 0.001, BUILDING_H * 0.55, 0]}
        rotationY={Math.PI / 2}
      />

      {/* Doorway dark interior (behind door, visible when door swings open) */}
      <mesh position={[0, DOOR_H / 2 + 0.05, BUILDING_D / 2 - 0.02]}>
        <boxGeometry args={[DOOR_W + 0.05, DOOR_H + 0.05, 0.01]} />
        <meshStandardMaterial color="#1a0d05" />
      </mesh>

      {/* Door — pivots from its left edge (in this rotated frame) */}
      <group
        ref={doorPivotRef}
        position={[-DOOR_W / 2, 0.05, BUILDING_D / 2 + 0.01]}
      >
        <mesh
          position={[DOOR_W / 2, DOOR_H / 2, 0]}
          castShadow
          onClick={(e) => {
            onSelect();
            e.stopPropagation();
          }}
        >
          <boxGeometry args={[DOOR_W, DOOR_H, 0.06]} />
          <meshStandardMaterial color={section.doorColor} />
        </mesh>
        {/* Door knob */}
        <mesh position={[DOOR_W - 0.08, DOOR_H / 2 - 0.02, 0.04]}>
          <sphereGeometry args={[0.04, 8, 6]} />
          <meshStandardMaterial color="#d4a04a" metalness={0.6} roughness={0.4} />
        </mesh>
      </group>

      {/* Sign above door */}
      <group position={[0, DOOR_H + 0.2, BUILDING_D / 2 + 0.04]}>
        <mesh castShadow>
          <boxGeometry args={[Math.max(0.6, section.label.length * 0.13 + 0.2), 0.28, 0.05]} />
          <meshStandardMaterial color="#2a1810" />
        </mesh>
        <Text
          position={[0, 0, 0.04]}
          fontSize={0.16}
          color={section.signColor}
          anchorX="center"
          anchorY="middle"
          letterSpacing={0.08}
        >
          {section.label}
        </Text>
      </group>
    </group>
  );
}

function Window({
  position,
  rotationY = 0,
}: {
  position: [number, number, number];
  rotationY?: number;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh>
        <planeGeometry args={[0.5, 0.45]} />
        <meshStandardMaterial
          color="#f7e98e"
          emissive="#f7e98e"
          emissiveIntensity={0.5}
        />
      </mesh>
      {/* mullions */}
      <mesh position={[0, 0, 0.005]}>
        <planeGeometry args={[0.06, 0.45]} />
        <meshStandardMaterial color="#2a1810" />
      </mesh>
      <mesh position={[0, 0, 0.005]}>
        <planeGeometry args={[0.5, 0.06]} />
        <meshStandardMaterial color="#2a1810" />
      </mesh>
    </group>
  );
}

// -------------------- character --------------------

// Palette
const SKIN = "#dca37e";
const BEARD = "#1f140d";
const TATTOO = "#0a1838";
const GI = "#f4f1de";
const GI_SHADE = "#d6cfb0";
const BELT = "#0a0a0a";
const FOOT = "#1a1a1a";
const EYE = "#1a1a1a";

function Character({
  charRef,
  golfRef,
}: {
  charRef: React.MutableRefObject<CharState>;
  golfRef: React.MutableRefObject<GolfState>;
}) {
  const rootRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Group>(null);
  const leftShoulderRef = useRef<THREE.Group>(null);
  const rightShoulderRef = useRef<THREE.Group>(null);
  const leftHipRef = useRef<THREE.Group>(null);
  const rightHipRef = useRef<THREE.Group>(null);
  const clubRef = useRef<THREE.Group>(null);
  // Pivot at body-center, same Y as the shoulders. The club is parented here
  // (not the right shoulder) so both hands appear to grip a centered club.
  // Rotates in sync with the shoulders during the golf swing.
  const clubHolderRef = useRef<THREE.Group>(null);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const c = charRef.current;
    // Show the golf club only while addressing / swinging.
    if (clubRef.current) {
      clubRef.current.visible = c.mode === "golfing";
    }
    if (rootRef.current) {
      rootRef.current.position.x = c.x;
      rootRef.current.position.z = c.z;
      // y is driven by the game tick for ride (track height) and golf
      // (celebration jumps); zero on foot otherwise.
      // While riding, lower the character so the hips (at body-local y=0.66)
      // sit on the cart's top surface (cart-local y=0.36). Otherwise the
      // character would stand on top of the cart instead of sitting in it.
      rootRef.current.position.y =
        c.mode === "riding" ? c.y - 0.30 : c.mode === "golfing" ? c.y : 0;
      // Smoothly rotate to face direction. Snap during ride / golf so we
      // always match the expected heading.
      const cur = rootRef.current.rotation.y;
      let diff = c.angle - cur;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      rootRef.current.rotation.y =
        c.mode === "riding" || c.mode === "golfing"
          ? c.angle
          : cur + diff * 0.2;
    }

    if (c.mode === "riding") {
      // Arms way up — riding thrill — plus a little oscillation
      const wave = Math.sin(t * 5) * 0.15;
      const armsUp = -Math.PI * 0.85 + wave;
      if (leftShoulderRef.current) leftShoulderRef.current.rotation.x = armsUp;
      if (rightShoulderRef.current)
        rightShoulderRef.current.rotation.x = armsUp;
      // Seated pose — legs bend forward at the hip so they stick out in
      // front of the body (toward the cart's nose), feet up off the floor.
      if (leftHipRef.current) leftHipRef.current.rotation.x = -Math.PI / 2;
      if (rightHipRef.current) rightHipRef.current.rotation.x = -Math.PI / 2;
      if (bodyRef.current) {
        // Subtle vertical bounce as the cart goes over track joints
        bodyRef.current.position.y = Math.abs(Math.sin(t * 9)) * 0.03;
      }
      return;
    }

    if (c.mode === "golfing") {
      const gt = golfRef.current.t;
      // Right-handed golf swing as an ACROSS-THE-BODY motion (rotation.z
      // around the spine axis). Positive z swings the arm to the RIGHT
      // (over the trail shoulder, i.e. backswing); negative z swings it
      // LEFT toward the target (follow-through). Impact passes through 0.
      //   address  (0..0.18): hands together slightly toward target (-0.3)
      //   backswing(0.18..0.32): swing up over trail shoulder (+2.5)
      //   downswing(0.32..0.36): whip down through impact (0) to follow-through (-2.5)
      //   follow   (0.36..0.55): hold over lead shoulder
      //   celebrate(0.55..0.88): arms thrown up with a "yes!" wave
      //   relax    (0.88..1.00): drop arms back to sides
      let swingZ = 0;
      if (gt < 0.18) {
        swingZ = -0.3; // address — hands just left of body center
      } else if (gt < 0.32) {
        const p = (gt - 0.18) / 0.14;
        swingZ = -0.3 + p * 2.8; // up to top of backswing (+2.5)
      } else if (gt < 0.36) {
        const p = (gt - 0.32) / 0.04;
        // Downswing: whip from +2.5 through impact (~0 at p≈0.5) to
        // follow-through (-2.5). Ball-flight starts at gt=0.35 (p=0.75)
        // which is just past impact — perfect.
        swingZ = 2.5 - p * 5.0;
      } else if (gt < 0.55) {
        swingZ = -2.5; // follow-through hold over lead shoulder
      } else if (gt < 0.88) {
        const wave = Math.sin(t * 9) * 0.25;
        swingZ = -Math.PI * 0.8 + wave; // celebrate
      } else {
        const p = (gt - 0.88) / 0.12;
        swingZ = -Math.PI * 0.8 + p * Math.PI * 0.8; // ease back to 0
      }
      if (leftShoulderRef.current) {
        leftShoulderRef.current.rotation.x = 0;
        leftShoulderRef.current.rotation.z = swingZ;
      }
      if (rightShoulderRef.current) {
        rightShoulderRef.current.rotation.x = 0;
        rightShoulderRef.current.rotation.z = swingZ;
      }
      if (clubHolderRef.current) {
        clubHolderRef.current.rotation.x = 0;
        clubHolderRef.current.rotation.z = swingZ;
      }
      if (leftHipRef.current) leftHipRef.current.rotation.x = 0;
      if (rightHipRef.current) rightHipRef.current.rotation.x = 0;
      // Slight forward bend at the hips while addressing/swinging — a
      // golfer hinges forward over the ball.
      if (bodyRef.current) {
        if (gt < 0.4) bodyRef.current.rotation.x = 0.25;
        else if (gt < 0.55) bodyRef.current.rotation.x = 0.1;
        else bodyRef.current.rotation.x = 0;
        bodyRef.current.position.y = 0;
      }
      return;
    }
    if (bodyRef.current) {
      // Clear any leftover lean when leaving golf mode
      bodyRef.current.rotation.x = 0;
    }
    // Clear the golf-only rotations so the character walks normally
    // outside of golf mode.
    if (leftShoulderRef.current) leftShoulderRef.current.rotation.z = 0;
    if (rightShoulderRef.current) rightShoulderRef.current.rotation.z = 0;
    if (clubHolderRef.current) {
      clubHolderRef.current.rotation.x = 0;
      clubHolderRef.current.rotation.z = 0;
    }

    // Limb swing (walking)
    const swing = c.walking ? Math.sin(c.stepPhase * Math.PI * 2) * 0.7 : 0;
    if (leftShoulderRef.current)
      leftShoulderRef.current.rotation.x = swing;
    if (rightShoulderRef.current)
      rightShoulderRef.current.rotation.x = -swing;
    if (leftHipRef.current) leftHipRef.current.rotation.x = -swing;
    if (rightHipRef.current) rightHipRef.current.rotation.x = swing;

    // Body bounce / breathing
    if (bodyRef.current) {
      if (c.walking) {
        bodyRef.current.position.y =
          Math.abs(Math.sin(c.stepPhase * Math.PI * 2)) * 0.07;
      } else {
        bodyRef.current.position.y = Math.sin(t * 1.6) * 0.02;
      }
    }
  });

  return (
    <group ref={rootRef} position={[0, 0, 0]}>
      <group ref={bodyRef}>
        {/* Torso (gi top) */}
        <mesh position={[0, 1.0, 0]} castShadow>
          <boxGeometry args={[0.55, 0.55, 0.32]} />
          <meshStandardMaterial color={GI} />
        </mesh>
        {/* Lapel V */}
        <mesh position={[0, 1.05, 0.165]}>
          <planeGeometry args={[0.18, 0.4]} />
          <meshStandardMaterial color={GI_SHADE} />
        </mesh>

        {/* Belt */}
        <mesh position={[0, 0.71, 0]} castShadow>
          <boxGeometry args={[0.58, 0.1, 0.34]} />
          <meshStandardMaterial color={BELT} />
        </mesh>

        {/* Head (bald, slightly egg-shaped) */}
        <mesh position={[0, 1.5, 0]} castShadow>
          <sphereGeometry args={[0.22, 16, 14]} />
          <meshStandardMaterial color={SKIN} />
        </mesh>

        {/* Beard — full bushy beard that wraps the jaw from cheek to chin,
            then a second "goatee drop" that extends below the jawline.
            Together they read as a thick well-groomed beard from any angle. */}
        <mesh position={[0, 1.34, 0.005]} scale={[1.28, 1.0, 1.28]} castShadow>
          <sphereGeometry args={[0.2, 16, 14]} />
          <meshStandardMaterial color={BEARD} />
        </mesh>
        {/* Goatee drop — extends past the chin */}
        <mesh position={[0, 1.18, 0.05]} scale={[0.9, 1.2, 0.85]} castShadow>
          <sphereGeometry args={[0.13, 14, 12]} />
          <meshStandardMaterial color={BEARD} />
        </mesh>
        {/* Sideburn fill — bridges the beard up to the head on each side */}
        <mesh position={[-0.18, 1.46, 0.0]} scale={[0.6, 0.9, 0.9]} castShadow>
          <sphereGeometry args={[0.1, 10, 8]} />
          <meshStandardMaterial color={BEARD} />
        </mesh>
        <mesh position={[0.18, 1.46, 0.0]} scale={[0.6, 0.9, 0.9]} castShadow>
          <sphereGeometry args={[0.1, 10, 8]} />
          <meshStandardMaterial color={BEARD} />
        </mesh>
        {/* Mustache — wider patch above the lip that visually merges into
            the beard at the corners of the mouth */}
        <mesh position={[0, 1.47, 0.19]} rotation={[0.15, 0, 0]}>
          <boxGeometry args={[0.17, 0.05, 0.04]} />
          <meshStandardMaterial color={BEARD} />
        </mesh>

        {/* Eyes */}
        <mesh position={[-0.07, 1.52, 0.19]}>
          <sphereGeometry args={[0.022, 8, 6]} />
          <meshBasicMaterial color={EYE} />
        </mesh>
        <mesh position={[0.07, 1.52, 0.19]}>
          <sphereGeometry args={[0.022, 8, 6]} />
          <meshBasicMaterial color={EYE} />
        </mesh>

        {/* Neck tattoo */}
        <mesh position={[0, 1.28, 0.14]}>
          <boxGeometry args={[0.1, 0.04, 0.02]} />
          <meshBasicMaterial color={TATTOO} />
        </mesh>

        {/* Arms — pivot at shoulder for swinging */}
        <group ref={leftShoulderRef} position={[-0.33, 1.22, 0]}>
          {/* Sleeve (gi) */}
          <mesh position={[0, -0.2, 0]} castShadow>
            <boxGeometry args={[0.16, 0.4, 0.18]} />
            <meshStandardMaterial color={GI} />
          </mesh>
          {/* Forearm (skin) */}
          <mesh position={[0, -0.5, 0]} castShadow>
            <boxGeometry args={[0.13, 0.25, 0.15]} />
            <meshStandardMaterial color={SKIN} />
          </mesh>
          {/* Tattoo bands */}
          <mesh position={[0, -0.42, 0]}>
            <boxGeometry args={[0.14, 0.04, 0.16]} />
            <meshBasicMaterial color={TATTOO} />
          </mesh>
          <mesh position={[0, -0.55, 0]}>
            <boxGeometry args={[0.14, 0.025, 0.16]} />
            <meshBasicMaterial color={TATTOO} />
          </mesh>
        </group>

        <group ref={rightShoulderRef} position={[0.33, 1.22, 0]}>
          <mesh position={[0, -0.2, 0]} castShadow>
            <boxGeometry args={[0.16, 0.4, 0.18]} />
            <meshStandardMaterial color={GI} />
          </mesh>
          <mesh position={[0, -0.5, 0]} castShadow>
            <boxGeometry args={[0.13, 0.25, 0.15]} />
            <meshStandardMaterial color={SKIN} />
          </mesh>
          <mesh position={[0, -0.4, 0]}>
            <boxGeometry args={[0.14, 0.035, 0.16]} />
            <meshBasicMaterial color={TATTOO} />
          </mesh>
          <mesh position={[0, -0.52, 0]}>
            <boxGeometry args={[0.14, 0.025, 0.16]} />
            <meshBasicMaterial color={TATTOO} />
          </mesh>

        </group>

        {/* Golf club — child of a body-centered pivot so it appears to be
            gripped by BOTH hands meeting in front of the body (the shoulders
            tilt inward during golf so the hands meet near x=0). The pivot
            rotates in sync with the arm swing. Hidden outside golf mode. */}
        <group ref={clubHolderRef} position={[0, 1.22, 0.05]}>
          <group ref={clubRef} visible={false} position={[0, -0.62, 0.08]} rotation={[0.35, 0, 0]}>
            {/* Grip (rubber wrap, at the hands) */}
            <mesh position={[0, -0.06, 0]} castShadow>
              <cylinderGeometry args={[0.025, 0.025, 0.22, 10]} />
              <meshStandardMaterial color="#1a1a1a" />
            </mesh>
            {/* Shaft (steel, extends past the hands toward the ball) */}
            <mesh position={[0, -0.58, 0]} castShadow>
              <cylinderGeometry args={[0.013, 0.013, 0.82, 10]} />
              <meshStandardMaterial color="#cfd2d4" metalness={0.6} roughness={0.3} />
            </mesh>
            {/* Hosel (where shaft meets head) */}
            <mesh position={[0, -1.0, 0.01]} castShadow>
              <cylinderGeometry args={[0.018, 0.014, 0.06, 8]} />
              <meshStandardMaterial color="#9aa0a4" metalness={0.7} roughness={0.35} />
            </mesh>
            {/* Club head (iron) — wide flat face addressing the ball */}
            <group position={[0.02, -1.04, 0.06]}>
              <mesh castShadow>
                <boxGeometry args={[0.18, 0.09, 0.06]} />
                <meshStandardMaterial color="#9aa0a4" metalness={0.7} roughness={0.35} />
              </mesh>
              {/* Sole */}
              <mesh position={[0, -0.05, 0.005]}>
                <boxGeometry args={[0.18, 0.014, 0.07]} />
                <meshStandardMaterial color="#6a6f72" metalness={0.6} roughness={0.4} />
              </mesh>
            </group>
          </group>
        </group>

        {/* Legs — pivot at hip */}
        <group ref={leftHipRef} position={[-0.13, 0.66, 0]}>
          <mesh position={[0, -0.32, 0]} castShadow>
            <boxGeometry args={[0.22, 0.6, 0.24]} />
            <meshStandardMaterial color={GI} />
          </mesh>
          <mesh position={[0, -0.66, 0.02]} castShadow>
            <boxGeometry args={[0.24, 0.08, 0.3]} />
            <meshStandardMaterial color={FOOT} />
          </mesh>
        </group>
        <group ref={rightHipRef} position={[0.13, 0.66, 0]}>
          <mesh position={[0, -0.32, 0]} castShadow>
            <boxGeometry args={[0.22, 0.6, 0.24]} />
            <meshStandardMaterial color={GI} />
          </mesh>
          <mesh position={[0, -0.66, 0.02]} castShadow>
            <boxGeometry args={[0.24, 0.08, 0.3]} />
            <meshStandardMaterial color={FOOT} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

// -------------------- camera --------------------

// Default plaza vantage — matches the Canvas's initial camera position so the
// "glide back" after a cinematic mode lands exactly where the user expects.
const CAM_DEFAULT = { x: 0, y: 11, z: 14 };

// Midpoint between tee and hole — the focal point during the golf swing so
// both the character (right of frame) and the cup (left of frame) are visible
// while the ball flies between them.
const GOLF_MIDPOINT = {
  x: (GOLF_TEE.x + GOLF_HOLE.x) / 2,
  z: (GOLF_TEE.z + GOLF_HOLE.z) / 2,
};

function CameraRig({
  charRef,
  pathname,
}: {
  charRef: React.MutableRefObject<CharState>;
  pathname: string;
}) {
  const targetVec = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const controlsRef = useRef<React.ComponentRef<typeof OrbitControls>>(null);
  // Tracks whether a special mode has hijacked the camera position. Set on
  // entry to riding/golfing; cleared once the camera has glided back close
  // to CAM_DEFAULT. Used so the post-ride walk-back gets a camera return.
  const camHijackedRef = useRef(false);

  useFrame((state, dt) => {
    const c = charRef.current;

    // ── Target ────────────────────────────────────────────────────────────
    // OrbitControls .target lerps toward the character whenever they're
    // moving or locked in a special mode. For golfing we instead focus on
    // the midpoint between the tee and the hole so the ball flight stays
    // framed. Otherwise the target glides back to the plaza.
    let wantTX = 0;
    let wantTZ = 0;
    let wantTY = 1;
    if (c.mode === "golfing") {
      wantTX = GOLF_MIDPOINT.x;
      wantTZ = GOLF_MIDPOINT.z;
      wantTY = 1;
    } else if (
      c.walking ||
      c.mode === "riding" ||
      c.mode === "flee"
    ) {
      wantTX = c.x;
      wantTZ = c.z;
      wantTY = 1 + c.y * 0.5;
    }
    targetVec.x += (wantTX - targetVec.x) * Math.min(1, dt * 2.5);
    targetVec.y += (wantTY - targetVec.y) * Math.min(1, dt * 2.5);
    targetVec.z += (wantTZ - targetVec.z) * Math.min(1, dt * 2.5);

    // ── Position ──────────────────────────────────────────────────────────
    // For special modes, lerp the camera position toward a cinematic vantage
    // so the action is clearly framed. After the mode ends, glide back to
    // CAM_DEFAULT so the post-ride walk back to the plaza stays in view.
    let wantCam: { x: number; y: number; z: number } | null = null;
    let camLerpSpeed = 2.0;
    if (c.mode === "golfing") {
      // Down-the-line shot from behind-and-trail-side of the character —
      // similar to a golf TV camera. The character faces west toward the
      // hole, so "behind" = east, and a right-handed golfer's trail side
      // is south (+Z). Offset south so we see his profile + the club
      // (otherwise his body blocks the swing entirely).
      wantCam = {
        x: GOLF_TEE.x + 4.5,
        y: 3,
        z: GOLF_TEE.z + 3.5,
      };
      camHijackedRef.current = true;
    } else if (c.mode === "riding") {
      // Cinematic chase-cam following the cart from behind-and-above.
      wantCam = { x: c.x + 4.5, y: c.y + 3.2, z: c.z + 4.5 };
      camHijackedRef.current = true;
    } else if (c.mode === "flee") {
      // Chase-cam IN FRONT of the runner: positioned ahead along the
      // chase direction (which always points toward the plaza/origin)
      // so the character sprints TOWARD the camera with the gator
      // chasing him behind. y=6 keeps the line of sight above the
      // MUSIC building roof when the chase passes near it.
      const mag = Math.hypot(c.x, c.z);
      const ux = mag > 0.5 ? c.x / mag : 1;
      const uz = mag > 0.5 ? c.z / mag : 0;
      wantCam = {
        x: c.x - ux * 5,
        y: 6,
        z: c.z - uz * 5,
      };
      camHijackedRef.current = true;
    } else if (camHijackedRef.current) {
      // Special mode just ended — glide the camera back to the default
      // plaza vantage. Once close enough, stop overriding so the user can
      // freely orbit again.
      wantCam = CAM_DEFAULT;
      camLerpSpeed = 1.4;
      const cam = state.camera;
      const dx = cam.position.x - CAM_DEFAULT.x;
      const dy = cam.position.y - CAM_DEFAULT.y;
      const dz = cam.position.z - CAM_DEFAULT.z;
      if (Math.hypot(dx, dy, dz) < 0.5) {
        camHijackedRef.current = false;
      }
    }
    if (wantCam) {
      const cam = state.camera;
      const k = Math.min(1, dt * camLerpSpeed);
      cam.position.x += (wantCam.x - cam.position.x) * k;
      cam.position.y += (wantCam.y - cam.position.y) * k;
      cam.position.z += (wantCam.z - cam.position.z) * k;
    }

    if (controlsRef.current) {
      controlsRef.current.target.copy(targetVec);
      controlsRef.current.update();
    }
  });

  // Suppress unused warning for prop kept for potential future use
  void pathname;

  return (
    <OrbitControls
      ref={controlsRef}
      enableDamping
      dampingFactor={0.08}
      minDistance={4}
      maxDistance={45}
      minPolarAngle={Math.PI * 0.12}
      maxPolarAngle={Math.PI * 0.48}
      target={[0, 1, 0]}
    />
  );
}

// -------------------- family easter egg --------------------

// HOME building's door is at (0, 0, -BUILDING_D/2 + s.z) ≈ (0, 0, -4.9).
// Family members spawn at the door and spread out south (toward the plaza).
const HOME_DOOR = { x: 0, z: -4.9 };
type FamilyMember = {
  x: number;
  z: number;
  kind: "wife" | "son" | "dog";
  color: string;
  // Per-member bounce params so they don't all jump in lockstep.
  bouncePhase: number; // radians offset into the sin wave
  bounceFreq: number; // angular frequency (radians per unit-t)
  bounceHeight: number; // peak Y in world units
};

const FAMILY_TARGETS: FamilyMember[] = [
  // Wife — measured, lighter bounce
  {
    x: -1.4,
    z: -3.6,
    kind: "wife",
    color: "#c95e8a",
    bouncePhase: 0.0,
    bounceFreq: 18.0,
    bounceHeight: 0.26,
  },
  // Son — slightly higher, slower
  {
    x: 1.2,
    z: -3.4,
    kind: "son",
    color: "#4a5a32",
    bouncePhase: 2.1,
    bounceFreq: 16.5,
    bounceHeight: 0.32,
  },
  // Dog 1 — fast & high
  {
    x: -0.6,
    z: -2.9,
    kind: "dog",
    color: "#8b6a3f",
    bouncePhase: 0.9,
    bounceFreq: 23.0,
    bounceHeight: 0.42,
  },
  // Dog 2 — even faster, different rhythm
  {
    x: 0.6,
    z: -2.8,
    kind: "dog",
    color: "#3a2a1a",
    bouncePhase: 3.4,
    bounceFreq: 25.5,
    bounceHeight: 0.46,
  },
];

function familyMemberPos(t: number, m: FamilyMember) {
  // Phase split: emerge (0..0.22), play (0.22..0.85), retreat (0.85..1)
  const door = HOME_DOOR;
  let lerp = 0;
  if (t < 0.22) {
    lerp = t / 0.22;
  } else if (t < 0.85) {
    lerp = 1;
  } else {
    lerp = 1 - (t - 0.85) / 0.15;
  }
  const x = door.x + (m.x - door.x) * lerp;
  const z = door.z + (m.z - door.z) * lerp;
  // Jumping: only during the play phase; per-member phase, frequency, height
  let y = 0;
  if (t > 0.22 && t < 0.85) {
    const phase = (t - 0.22) * m.bounceFreq + m.bouncePhase;
    y = Math.max(0, Math.sin(phase)) * m.bounceHeight;
  }
  return { x, y, z };
}

function Family({
  familyRef,
}: {
  familyRef: React.MutableRefObject<FamilyState>;
}) {
  const rootRefs = useRef<Array<THREE.Group | null>>([]);
  const armRefs = useRef<Array<THREE.Group | null>>([]);
  const tailRefs = useRef<Array<THREE.Group | null>>([]);

  useFrame((state) => {
    const f = familyRef.current;
    const tNow = state.clock.elapsedTime;

    if (!f.active) {
      // Hide everyone
      for (const r of rootRefs.current) {
        if (r) r.visible = false;
      }
      return;
    }

    FAMILY_TARGETS.forEach((m, i) => {
      const root = rootRefs.current[i];
      if (!root) return;
      root.visible = true;
      const pos = familyMemberPos(f.t, m);
      root.position.set(pos.x, pos.y, pos.z);
      // Face south (+Z) toward the camera-default-facing area
      root.rotation.y = Math.PI;

      // Person: wave the waving arm at a per-member frequency and phase
      if (m.kind !== "dog") {
        const arm = armRefs.current[i];
        if (arm) {
          const freq = m.kind === "wife" ? 7.5 : 9.5;
          const wave =
            -Math.PI * 0.85 + Math.sin(tNow * freq + m.bouncePhase * 1.7) * 0.45;
          arm.rotation.z = wave;
        }
      }

      // Dog: wag tail (different speed per dog)
      if (m.kind === "dog") {
        const tail = tailRefs.current[i];
        if (tail) {
          tail.rotation.y =
            Math.sin(tNow * (12 + i * 2.5) + m.bouncePhase) * 0.75;
        }
      }
    });
  });

  return (
    <>
      {FAMILY_TARGETS.map((m, i) => (
        <group
          key={i}
          ref={(el) => {
            rootRefs.current[i] = el;
          }}
          visible={false}
        >
          {m.kind === "wife" ? (
            <Wife
              shirtColor={m.color}
              armRef={(el) => {
                armRefs.current[i] = el;
              }}
            />
          ) : m.kind === "son" ? (
            <Son
              shirtColor={m.color}
              armRef={(el) => {
                armRefs.current[i] = el;
              }}
            />
          ) : (
            <Dog
              furColor={m.color}
              tailRef={(el) => {
                tailRefs.current[i] = el;
              }}
            />
          )}
        </group>
      ))}
    </>
  );
}

const SKIN_FAMILY = "#e5b896";
const HAIR_RED = "#b94e22"; // wife — red head
const HAIR_BUZZED = "#3a2820"; // son — military buzzcut, dark
const FATIGUE_BASE = "#4a5a32"; // olive drab
const FATIGUE_DARK = "#36422a"; // shadowed patches
const BOOTS = "#1f1a14";

function Wife({
  shirtColor,
  armRef,
}: {
  shirtColor: string;
  armRef: (el: THREE.Group | null) => void;
}) {
  return (
    <group>
      {/* Pants */}
      <mesh position={[0, 0.32, 0]} castShadow>
        <boxGeometry args={[0.34, 0.5, 0.24]} />
        <meshStandardMaterial color="#2a3a5a" />
      </mesh>
      {/* Shoes */}
      <mesh position={[-0.1, 0.06, 0.02]} castShadow>
        <boxGeometry args={[0.13, 0.08, 0.18]} />
        <meshStandardMaterial color="#1a1a1a" />
      </mesh>
      <mesh position={[0.1, 0.06, 0.02]} castShadow>
        <boxGeometry args={[0.13, 0.08, 0.18]} />
        <meshStandardMaterial color="#1a1a1a" />
      </mesh>
      {/* Shirt / top */}
      <mesh position={[0, 0.85, 0]} castShadow>
        <boxGeometry args={[0.45, 0.6, 0.26]} />
        <meshStandardMaterial color={shirtColor} />
      </mesh>
      {/* Head */}
      <mesh position={[0, 1.3, 0]} castShadow>
        <sphereGeometry args={[0.18, 12, 10]} />
        <meshStandardMaterial color={SKIN_FAMILY} />
      </mesh>
      {/* Hair — back + sides */}
      <mesh position={[0, 1.34, -0.04]} castShadow>
        <boxGeometry args={[0.36, 0.34, 0.34]} />
        <meshStandardMaterial color={HAIR_RED} />
      </mesh>
      {/* Hair falls past shoulders */}
      <mesh position={[0, 1.0, -0.13]} castShadow>
        <boxGeometry args={[0.34, 0.4, 0.06]} />
        <meshStandardMaterial color={HAIR_RED} />
      </mesh>
      {/* Face (slightly forward so it covers the hair on the front) */}
      <mesh position={[0, 1.3, 0.08]}>
        <boxGeometry args={[0.26, 0.22, 0.15]} />
        <meshStandardMaterial color={SKIN_FAMILY} />
      </mesh>
      {/* Eyes */}
      <mesh position={[-0.07, 1.32, 0.16]}>
        <sphereGeometry args={[0.022, 8, 6]} />
        <meshBasicMaterial color="#1a1a1a" />
      </mesh>
      <mesh position={[0.07, 1.32, 0.16]}>
        <sphereGeometry args={[0.022, 8, 6]} />
        <meshBasicMaterial color="#1a1a1a" />
      </mesh>
      {/* Smile */}
      <mesh position={[0, 1.22, 0.16]}>
        <boxGeometry args={[0.07, 0.015, 0.005]} />
        <meshBasicMaterial color="#a82838" />
      </mesh>
      {/* Static left arm (down at side) */}
      <mesh position={[-0.27, 0.85, 0]} castShadow>
        <boxGeometry args={[0.1, 0.55, 0.12]} />
        <meshStandardMaterial color={shirtColor} />
      </mesh>
      {/* Right arm — pivoted at shoulder so it can wave */}
      <group position={[0.25, 1.08, 0]} ref={armRef}>
        <mesh position={[0.0, -0.22, 0]} castShadow>
          <boxGeometry args={[0.1, 0.45, 0.12]} />
          <meshStandardMaterial color={shirtColor} />
        </mesh>
        {/* Forearm + hand */}
        <mesh position={[0.0, -0.5, 0]} castShadow>
          <boxGeometry args={[0.09, 0.18, 0.1]} />
          <meshStandardMaterial color={SKIN_FAMILY} />
        </mesh>
      </group>
    </group>
  );
}

function Son({
  shirtColor,
  armRef,
}: {
  shirtColor: string;
  armRef: (el: THREE.Group | null) => void;
}) {
  // 21-year-old, U.S. Army. Olive-drab fatigues, dark buzzcut, black boots,
  // small flag patch on the right shoulder.
  void shirtColor; // overridden by the fatigue palette below
  const fatigues = FATIGUE_BASE;
  const fatigueDark = FATIGUE_DARK;
  return (
    <group scale={0.96}>
      {/* Fatigue pants */}
      <mesh position={[0, 0.36, 0]} castShadow>
        <boxGeometry args={[0.34, 0.6, 0.24]} />
        <meshStandardMaterial color={fatigues} />
      </mesh>
      {/* Camo patches on pants for texture */}
      <mesh position={[-0.08, 0.42, 0.121]}>
        <boxGeometry args={[0.08, 0.12, 0.005]} />
        <meshStandardMaterial color={fatigueDark} />
      </mesh>
      <mesh position={[0.1, 0.22, 0.121]}>
        <boxGeometry args={[0.1, 0.08, 0.005]} />
        <meshStandardMaterial color={fatigueDark} />
      </mesh>
      {/* Combat boots */}
      <mesh position={[-0.09, 0.08, 0.03]} castShadow>
        <boxGeometry args={[0.14, 0.16, 0.2]} />
        <meshStandardMaterial color={BOOTS} />
      </mesh>
      <mesh position={[0.09, 0.08, 0.03]} castShadow>
        <boxGeometry args={[0.14, 0.16, 0.2]} />
        <meshStandardMaterial color={BOOTS} />
      </mesh>
      {/* Belt */}
      <mesh position={[0, 0.66, 0]}>
        <boxGeometry args={[0.36, 0.06, 0.26]} />
        <meshStandardMaterial color={BOOTS} />
      </mesh>
      {/* Belt buckle */}
      <mesh position={[0, 0.66, 0.13]}>
        <boxGeometry args={[0.06, 0.04, 0.01]} />
        <meshStandardMaterial color="#c8b06a" metalness={0.6} roughness={0.4} />
      </mesh>
      {/* Fatigue jacket / shirt */}
      <mesh position={[0, 0.96, 0]} castShadow>
        <boxGeometry args={[0.44, 0.58, 0.26]} />
        <meshStandardMaterial color={fatigues} />
      </mesh>
      {/* Camo patches on shirt */}
      <mesh position={[-0.12, 1.08, 0.131]}>
        <boxGeometry args={[0.08, 0.1, 0.005]} />
        <meshStandardMaterial color={fatigueDark} />
      </mesh>
      <mesh position={[0.12, 0.86, 0.131]}>
        <boxGeometry args={[0.08, 0.08, 0.005]} />
        <meshStandardMaterial color={fatigueDark} />
      </mesh>
      {/* US flag patch on right sleeve (worn backward as in real uniform) */}
      <mesh position={[0.215, 1.04, 0.07]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[0.06, 0.04]} />
        <meshStandardMaterial color="#b22234" side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0.215, 1.06, 0.05]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[0.025, 0.02]} />
        <meshStandardMaterial color="#3c3b6e" side={THREE.DoubleSide} />
      </mesh>
      {/* Name tape on chest */}
      <mesh position={[-0.08, 1.06, 0.131]}>
        <boxGeometry args={[0.12, 0.04, 0.004]} />
        <meshStandardMaterial color={fatigueDark} />
      </mesh>
      {/* Head */}
      <mesh position={[0, 1.36, 0]} castShadow>
        <sphereGeometry args={[0.18, 12, 10]} />
        <meshStandardMaterial color={SKIN_FAMILY} />
      </mesh>
      {/* Buzzcut — thin cap, very close to scalp */}
      <mesh position={[0, 1.45, -0.01]} castShadow>
        <sphereGeometry args={[0.185, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2.4]} />
        <meshStandardMaterial color={HAIR_BUZZED} />
      </mesh>
      {/* Eyes */}
      <mesh position={[-0.07, 1.38, 0.16]}>
        <sphereGeometry args={[0.022, 8, 6]} />
        <meshBasicMaterial color="#1a1a1a" />
      </mesh>
      <mesh position={[0.07, 1.38, 0.16]}>
        <sphereGeometry args={[0.022, 8, 6]} />
        <meshBasicMaterial color="#1a1a1a" />
      </mesh>
      {/* Grin */}
      <mesh position={[0, 1.28, 0.17]}>
        <boxGeometry args={[0.09, 0.02, 0.005]} />
        <meshBasicMaterial color="#a82838" />
      </mesh>
      {/* Static left arm */}
      <mesh position={[-0.27, 0.96, 0]} castShadow>
        <boxGeometry args={[0.11, 0.52, 0.12]} />
        <meshStandardMaterial color={fatigues} />
      </mesh>
      {/* Right arm — pivots at shoulder, waves */}
      <group position={[0.25, 1.18, 0]} ref={armRef}>
        <mesh position={[0.0, -0.22, 0]} castShadow>
          <boxGeometry args={[0.11, 0.44, 0.12]} />
          <meshStandardMaterial color={fatigues} />
        </mesh>
        <mesh position={[0.0, -0.48, 0]} castShadow>
          <boxGeometry args={[0.1, 0.18, 0.11]} />
          <meshStandardMaterial color={SKIN_FAMILY} />
        </mesh>
      </group>
    </group>
  );
}

function Dog({
  furColor,
  tailRef,
}: {
  furColor: string;
  tailRef: (el: THREE.Group | null) => void;
}) {
  const FUR_DARK = "#2a1a0d";
  return (
    <group scale={0.95}>
      {/* Body */}
      <mesh position={[0, 0.28, 0]} castShadow>
        <boxGeometry args={[0.32, 0.22, 0.55]} />
        <meshStandardMaterial color={furColor} />
      </mesh>
      {/* Belly highlight */}
      <mesh position={[0, 0.18, 0]}>
        <boxGeometry args={[0.3, 0.04, 0.5]} />
        <meshStandardMaterial color="#f4e6d0" />
      </mesh>
      {/* Head — front of body (+Z direction since model faces +Z) */}
      <mesh position={[0, 0.36, 0.34]} castShadow>
        <boxGeometry args={[0.28, 0.24, 0.24]} />
        <meshStandardMaterial color={furColor} />
      </mesh>
      {/* Snout */}
      <mesh position={[0, 0.28, 0.5]} castShadow>
        <boxGeometry args={[0.16, 0.14, 0.16]} />
        <meshStandardMaterial color={furColor} />
      </mesh>
      {/* Nose */}
      <mesh position={[0, 0.32, 0.59]}>
        <sphereGeometry args={[0.04, 8, 6]} />
        <meshStandardMaterial color={FUR_DARK} />
      </mesh>
      {/* Eyes */}
      <mesh position={[-0.07, 0.42, 0.45]}>
        <sphereGeometry args={[0.025, 8, 6]} />
        <meshBasicMaterial color="#1a1a1a" />
      </mesh>
      <mesh position={[0.07, 0.42, 0.45]}>
        <sphereGeometry args={[0.025, 8, 6]} />
        <meshBasicMaterial color="#1a1a1a" />
      </mesh>
      {/* Floppy ears */}
      <mesh position={[-0.14, 0.46, 0.28]} rotation={[0.3, 0, -0.4]} castShadow>
        <boxGeometry args={[0.04, 0.18, 0.12]} />
        <meshStandardMaterial color={FUR_DARK} />
      </mesh>
      <mesh position={[0.14, 0.46, 0.28]} rotation={[0.3, 0, 0.4]} castShadow>
        <boxGeometry args={[0.04, 0.18, 0.12]} />
        <meshStandardMaterial color={FUR_DARK} />
      </mesh>
      {/* Tongue */}
      <mesh position={[0, 0.24, 0.58]}>
        <boxGeometry args={[0.07, 0.02, 0.07]} />
        <meshStandardMaterial color="#d83a3a" />
      </mesh>
      {/* Tail — pivot at back of body, points up and back */}
      <group position={[0, 0.38, -0.28]} ref={tailRef}>
        <mesh
          position={[0, 0.08, -0.1]}
          rotation={[-0.5, 0, 0]}
          castShadow
        >
          <boxGeometry args={[0.06, 0.06, 0.24]} />
          <meshStandardMaterial color={furColor} />
        </mesh>
      </group>
      {/* Legs */}
      {[
        [-0.11, 0.21],
        [0.11, 0.21],
        [-0.11, -0.21],
        [0.11, -0.21],
      ].map(([x, z], i) => (
        <mesh key={i} position={[x, 0.1, z]} castShadow>
          <boxGeometry args={[0.08, 0.2, 0.1]} />
          <meshStandardMaterial color={furColor} />
        </mesh>
      ))}
    </group>
  );
}
