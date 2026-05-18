"use client";

import { forwardRef, Suspense, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Text, useTexture } from "@react-three/drei";
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

type CharMode = "idle" | "flee" | "riding" | "golfing" | "ballooning";

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

type BalloonState = {
  active: boolean;
  // Multi-phase: rising (balloon takes off w/ Sonny inside) → scared
  // (brief panic at altitude) → jumping (Sonny leaps out, parabolic
  // fall) → rolling (forward roll on the ground to break the fall).
  // After rolling, char.mode flips back to idle and walks to startX/Z.
  phase: "rising" | "scared" | "jumping" | "rolling";
  t: number; // 0..1 phase-local progress
  height: number; // current Y of the balloon group (lifts during rising)
  startX: number; // plaza spot to return to once the roll finishes
  startZ: number;
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
  balloon: React.MutableRefObject<BalloonState>;
  approachingBalloon: React.MutableRefObject<boolean>;
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
// Golf course centre. The course now extends south from the play
// area toward the farm, with multiple holes laid out as a small
// course rather than a single fairway. GOLF_TEE/GOLF_HOLE refer to
// the interactive hole used by the easter egg (Hole 1 — the
// northern-most hole, closest to the plaza). The other holes are
// decorative. The easter egg is a PUTT, not a full swing, so
// GOLF_TEE sits on the green itself just east of the cup — the
// character walks all the way onto the green and putts a short
// distance to drop the ball in the hole.
//
// GOLF_TEE is where the CHARACTER stands; GOLF_BALL_START is where
// the BALL sits at address (offset slightly west + north of the
// character so the character isn't standing directly on top of the
// ball and hiding it from the camera).
const GOLF_POSITION = { x: -14, z: 17 };
const GOLF_TEE = { x: -16.5, z: 9 };
const GOLF_BALL_START = { x: -17.0, z: 8.7 };
const GOLF_HOLE = { x: -18, z: 8.6 };
const GOLF_DURATION = 6.0; // total seconds of address → swing → flight → celebration

// Hot-air balloon easter egg (SE quadrant — south of the gator, right
// of the golf course, away from the building cluster).
const BALLOON_POSITION = { x: 10, z: 6 };
// Walk to this spot to board (slight south offset from the balloon so
// the character isn't trying to stand inside the basket geometry).
const BALLOON_ENTRY = { x: 10, z: 7.5 };
const BALLOON_RISE_HEIGHT = 6; // how high the balloon lifts off the ground
const BALLOON_RISE_DURATION = 3.5; // seconds of ascent
const BALLOON_SCARE_DURATION = 0.45; // "uh-oh I'm too high" beat
const BALLOON_JUMP_DURATION = 0.55; // seconds airborne from the basket to the ground
const BALLOON_ROLL_DURATION = 0.9; // seconds of forward roll to break the fall

// Amusement park
const PARK = { x: -17, z: -19 };
// Visual scale applied to the entire AmusementPark group + the
// CoasterCart so the character (~2 units tall) reads as a normal
// rider rather than dwarfing the cart and rides. Local geometry
// stays the same; everything that needs to talk to world space
// (coaster curve sampling, character walk targets, park entry
// offset) multiplies through PARK_SCALE. Park width is constrained
// horizontally by the road (x≈-27.5) on the west and JIU JITSU
// (x≈-7.1) on the east, so growth happens mostly in the z direction.
const PARK_SCALE = 2.5;
const COASTER_RX = 3.5;
const COASTER_RZ = 4;
const COASTER_Y_BASE = 1.5;
const COASTER_AMP = 3.5;
const COASTER_HILLS = 2;
const RIDE_LAPS = 1;
const RIDE_LAP_SECONDS = 4.0; // per lap
// Walk-to-board target: south of the park's centre, just outside
// the ride boundary in local park units (then multiplied by scale
// at the world-coord callsites).
const PARK_ENTRY_OFFSET = COASTER_RZ + 0.9; // walk to here to board (local units)
const PARK_ENTRY_WORLD = PARK_ENTRY_OFFSET * PARK_SCALE; // same thing, scaled
// Park ground patch dimensions (covers all rides)
const PARK_GROUND_W = 8;
const PARK_GROUND_D = 12;

// Closed roller-coaster curve, defined in park-local XYZ. Starts at the south
// (low) point so boarding lines up with the ticket-booth entrance. Two hills
// per lap with valleys between.
// Smooth oval coaster curve with multiple hills + one vertical
// loop spliced in. The track never crosses itself in the XZ plane
// (no 90° angles like the previous figure-8); instead the loop
// rises out of the oval, twists through 360° in the YZ plane, and
// rejoins the oval where it left off.
//
// Loop math: between t=LOOP_T0 and t=LOOP_T1 the cart departs from
// the regular ellipse, runs vertically around a circle in the YZ
// plane centred above the anchor point, and returns to the same
// XZ position. The anchor point is the ellipse's location at the
// midpoint of the loop window so the entry and exit positions
// coincide — that way there's no jump in the cart's XZ.
const LOOP_T0 = 0.42;
const LOOP_T1 = 0.58;
const LOOP_RADIUS = 2.4;

const COASTER_CURVE = (() => {
  const N = 128;
  const pts: THREE.Vector3[] = [];

  const ellipseAngle = (t: number) => Math.PI / 2 + t * 2 * Math.PI;
  const ellipseY = (t: number) =>
    COASTER_Y_BASE +
    COASTER_AMP * (1 - Math.cos(t * 2 * Math.PI * COASTER_HILLS)) / 2;
  const ellipsePos = (t: number) => {
    const a = ellipseAngle(t);
    return new THREE.Vector3(
      Math.cos(a) * COASTER_RX,
      ellipseY(t),
      Math.sin(a) * COASTER_RZ
    );
  };

  // Loop entry and exit on the ellipse. The vertical loop sits on
  // a LINEAR INTERP between these two points, so the curve is
  // continuous with the ellipse at both LOOP_T0 and LOOP_T1 (the
  // previous anchor-based approach jumped the position to the
  // ellipse midpoint, which created a sharp visual kink at the
  // loop entry — CatmullRom couldn't smooth out that big a
  // position jump).
  const loopEntry = ellipsePos(LOOP_T0);
  const loopExit = ellipsePos(LOOP_T1);

  for (let i = 0; i < N; i++) {
    const t = i / N;
    if (t >= LOOP_T0 && t <= LOOP_T1) {
      const tLoop = (t - LOOP_T0) / (LOOP_T1 - LOOP_T0);
      const loopA = 2 * Math.PI * tLoop;
      // Linear path from entry → exit acts as the loop's "axis";
      // the loop overlay then rises out of it in y and oscillates
      // around it in z.
      const baseX = loopEntry.x + (loopExit.x - loopEntry.x) * tLoop;
      const baseY = loopEntry.y + (loopExit.y - loopEntry.y) * tLoop;
      const baseZ = loopEntry.z + (loopExit.z - loopEntry.z) * tLoop;
      // Standard "vertical loop entering from bottom" parametric
      // overlaid on the linear path:
      //   z_overlay = R * sin(angle)
      //   y_overlay = R - R * cos(angle)
      // At loopA=0: overlay = (0, 0, 0) → position = loopEntry.
      // At loopA=π: overlay = (0, 2R, 0) → top of loop.
      // At loopA=2π: overlay = (0, 0, 0) → position = loopExit.
      pts.push(
        new THREE.Vector3(
          baseX,
          baseY + LOOP_RADIUS * (1 - Math.cos(loopA)),
          baseZ + LOOP_RADIUS * Math.sin(loopA)
        )
      );
    } else {
      pts.push(ellipsePos(t));
    }
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
  // The visual AmusementPark group applies PARK_SCALE to its
  // children, so multiply the local curve sample through to get
  // the cart's actual world position.
  return {
    x: PARK.x + p.x * PARK_SCALE,
    y: p.y * PARK_SCALE,
    z: PARK.z + p.z * PARK_SCALE,
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
// one is clear of every building from the plaza's perspective. The
// inner "corridor" waypoints (3, -4) / (-3, -4) thread between HOME and
// MUSIC / JIU JITSU so the gator and the coaster-walk-back take a near-
// direct path instead of swinging way out east or west.
const BYPASS_WAYPOINTS: { x: number; z: number }[] = [
  { x: -8, z: 4 },    // SW (between CODE and the golf course)
  { x: -8, z: -5 },   // NW (south-west of JIU JITSU, on the way to the park)
  { x: 8, z: 4 },     // SE
  { x: 8, z: -5 },    // NE
  { x: 0, z: 8 },     // S (between CODE and CHESS)
  { x: -8, z: 0 },    // W
  { x: 8, z: 0 },     // E
  { x: 3, z: -4 },    // NE corridor between HOME and MUSIC (toward the gator)
  { x: -3, z: -4 },   // NW corridor between HOME and JIU JITSU (toward the park)
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
  const balloonRef = useRef<BalloonState>({
    active: false,
    phase: "rising",
    t: 0,
    height: 0,
    startX: 0,
    startZ: 0,
  });
  const approachingBalloonRef = useRef(false);

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
      // HOME is special — Sonny just waved with the family at the
      // doorstep, so leave him facing south (+Z, toward the camera)
      // to match the family. Other sections snap him to face the
      // building (away from origin) since the overlay covers most
      // of the scene and there's no family in the foreground.
      charRef.current.angle =
        section.id === "personal-life"
          ? 0
          : Math.atan2(section.x - t.x, section.z - t.z);
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
      balloonRef.current.active = false;
      balloonRef.current.t = 0;
      balloonRef.current.height = 0;
      approachingBalloonRef.current = false;
    } else {
      targetRef.current = null;
      pathQueueRef.current = [];
      pendingNavRef.current = null;
      familyRef.current.active = false;
      familyRef.current.t = 0;
      golfRef.current.active = false;
      golfRef.current.t = 0;
      approachingGolfRef.current = false;
      balloonRef.current.active = false;
      balloonRef.current.t = 0;
      balloonRef.current.height = 0;
      approachingBalloonRef.current = false;
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
      balloon: balloonRef,
      approachingBalloon: approachingBalloonRef,
    }),
    []
  );

  const isOnHome = (pathname ?? "/") === "/";

  return (
    <div className="w-full h-full">
      <Canvas
        shadows
        camera={{ position: [0, 20, 25], fov: 45, near: 0.1, far: 250 }}
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

    // ── 0aa. Hot-air balloon ride (with chicken-out + roll) ──
    if (char.mode === "ballooning") {
      const b = refs.balloon.current;
      const phaseDur =
        b.phase === "rising"
          ? BALLOON_RISE_DURATION
          : b.phase === "scared"
          ? BALLOON_SCARE_DURATION
          : b.phase === "jumping"
          ? BALLOON_JUMP_DURATION
          : BALLOON_ROLL_DURATION;
      b.t += clampedDt / phaseDur;

      if (b.phase === "rising") {
        // Balloon lifts off; character rides along INSIDE the basket
        // (low enough that legs are tucked behind basket walls, so the
        // upper body + face are the prominent visible features).
        b.height = b.t * BALLOON_RISE_HEIGHT;
        char.x = BALLOON_POSITION.x;
        char.z = BALLOON_POSITION.z;
        char.y = b.height + 0.28; // feet at basket-floor level
        char.angle = 0;
        if (b.t >= 1) {
          b.phase = "scared";
          b.t = 0;
        }
      } else if (b.phase === "scared") {
        // Brief beat at altitude — "uh oh".
        char.x = BALLOON_POSITION.x;
        char.z = BALLOON_POSITION.z;
        char.y = b.height + 0.28;
        char.angle = 0;
        if (b.t >= 1) {
          b.phase = "jumping";
          b.t = 0;
        }
      } else if (b.phase === "jumping") {
        // Parabolic-ish fall from the basket to the ground; nudges
        // forward (south, toward the camera) so he lands clear.
        const startY = b.height + 0.28;
        char.x = BALLOON_POSITION.x;
        char.z = BALLOON_POSITION.z + b.t * 1.5;
        char.y = Math.max(0, startY * (1 - b.t * b.t));
        char.angle = 0;
        if (b.t >= 1) {
          b.phase = "rolling";
          b.t = 0;
          char.y = 0;
        }
      } else if (b.phase === "rolling") {
        // Forward roll to absorb the impact — keeps moving forward
        // (south) along the ground. Visual roll is done by the
        // Character component reading b.phase + b.t.
        //
        // Lift the character ROOT during the tucked middle of the
        // roll so the rotation pivot (at the root's origin = the
        // feet) ends up roughly at the body's tucked-ball centre.
        // Without this, the rotation axis is at the feet and the
        // head/body swings *below* the ground at the 180° point.
        // Match the body-bend ramp (0..0.18 ramps in, 0.82..1
        // ramps out) so the lift eases in and out, not snaps.
        const TUCK_LIFT = 0.7;
        let charY = 0;
        if (b.t < 0.18) charY = (b.t / 0.18) * TUCK_LIFT;
        else if (b.t < 0.82) charY = TUCK_LIFT;
        else charY = ((1 - b.t) / 0.18) * TUCK_LIFT;
        char.x = BALLOON_POSITION.x;
        // Distance bumped to ~3.5 so the rolling distance roughly
        // matches the circumference of the ball (2π·R ≈ 4.4 for
        // R=0.7), giving the tumble a "ball rolling" cadence
        // instead of looking like it's sliding.
        char.z = BALLOON_POSITION.z + 1.5 + b.t * 3.5;
        char.y = charY;
        char.angle = 0;
        if (b.t >= 1) {
          // Done! End ballooning mode and walk back to the start spot.
          b.active = false;
          b.t = 0;
          b.phase = "rising";
          char.mode = "idle";
          char.y = 0;
          const path = routeTo(char.x, char.z, b.startX, b.startZ);
          const first = path[0];
          refs.target.current = {
            x: first.x,
            z: first.z,
            sectionId: null,
          };
          refs.pathQueue.current = path.slice(1);
          char.walking = true;
        }
      }
    }

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
        // Walk back to the plaza — route via bypass waypoints so the
        // path doesn't clip the CODE building between the tee and the
        // plaza.
        const path = routeTo(char.x, char.z, 0, 0);
        const first = path[0];
        refs.target.current = { x: first.x, z: first.z, sectionId: null };
        refs.pathQueue.current = path.slice(1);
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
          char.z = PARK.z + PARK_ENTRY_WORLD;
          char.angle = Math.atan2(-char.x, -char.z); // face plaza
          // Walk back to the plaza — route via bypass waypoints so the
          // path doesn't clip the JIU JITSU building.
          const path = routeTo(char.x, char.z, 0, 0);
          const first = path[0];
          refs.target.current = { x: first.x, z: first.z, sectionId: null };
          refs.pathQueue.current = path.slice(1);
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
        // Face the camera (looking at the plaza from +Z) when arriving back
        char.angle = 0;
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
          } else if (refs.approachingBalloon.current) {
            // Climb in! Balloon starts its ascent.
            refs.approachingBalloon.current = false;
            char.mode = "ballooning";
            char.walking = false;
            char.angle = 0;
            refs.balloon.current.active = true;
            refs.balloon.current.phase = "rising";
            refs.balloon.current.t = 0;
            refs.balloon.current.height = 0;
          } else {
            // Plain arrival with no section / approach flag — this is the
            // walk-back to the plaza after an activity ends. Face the
            // camera (which looks at the plaza from +Z).
            char.angle = 0;
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
      !refs.balloon.current.active &&
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
            // Sonny just arrived at the door facing north (-Z, into
            // HOME). Spin him around to face south (+Z, toward the
            // camera) so he matches the family who all face +Z. The
            // Character's rotation lerps toward char.angle at 20%
            // per frame, so this becomes a smooth U-turn over ~0.5s.
            refs.char.current.angle = 0;
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
      refs.char.current.mode === "ballooning" ||
      refs.gator.current.chasing ||
      refs.coaster.current.riding ||
      refs.family.current.active ||
      refs.golf.current.active ||
      refs.balloon.current.active
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
    walkTo(PARK.x, PARK.z + PARK_ENTRY_WORLD, null);
    refs.approachingPark.current = true;
  }

  function handleGolfClick() {
    if (!isOnHome || isBusy()) return;
    walkTo(GOLF_TEE.x, GOLF_TEE.z, null);
    refs.approachingGolf.current = true;
  }

  function handleBalloonClick() {
    if (!isOnHome || isBusy()) return;
    // Remember where the character was standing so he can run back to
    // the same spot after rolling out of the failed balloon ride.
    const c = refs.char.current;
    refs.balloon.current.startX = c.x;
    refs.balloon.current.startZ = c.z;
    walkTo(BALLOON_ENTRY.x, BALLOON_ENTRY.z, null);
    refs.approachingBalloon.current = true;
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
        balloonRef={refs.balloon}
        onBalloonClick={handleBalloonClick}
      />
      {SECTIONS.map((s) => (
        <Building
          key={s.id}
          section={s}
          doorsRef={refs.doors}
          onSelect={() => handleBuildingClick(s)}
        />
      ))}
      <Suspense fallback={null}>
        <Character
          charRef={refs.char}
          golfRef={refs.golf}
          balloonRef={refs.balloon}
        />
      </Suspense>
      <Family familyRef={refs.family} />
      <CameraRig charRef={refs.char} gatorRef={refs.gator} pathname={pathname} />
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
  // Extended west (x to ~-65) so the cityscape silhouette opposite
  // the beach has grass outskirts behind it rather than sitting flush
  // against the world's edge. Also extended north (z=-95) so the
  // mountain ridge bases stay on grass, and extended south (z=85) so
  // there's room behind the farm for a distant horizon backdrop.
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[-10, 0, -5]}
      receiveShadow
    >
      <planeGeometry args={[110, 180]} />
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
  balloonRef,
  onBalloonClick,
}: {
  gatorRef: React.MutableRefObject<GatorState>;
  onGatorClick: () => void;
  coasterRef: React.MutableRefObject<CoasterState>;
  onParkClick: () => void;
  golfRef: React.MutableRefObject<GolfState>;
  onGolfClick: () => void;
  balloonRef: React.MutableRefObject<BalloonState>;
  onBalloonClick: () => void;
}) {
  return (
    <>
      {/* Ocean + beach along the entire eastern edge of the world. */}
      <Ocean />
      <Beach />

      {/* Distant downtown skyline along the western horizon, plus
          a two-lane road in front of it with parked + driving cars. */}
      <Cityscape />
      <Road />

      {/* Driving cars — two each direction, varied speeds + colors */}
      <DrivingCar x={NB_LANE_X} initialZ={-40} speed={5.2} color="#c44a4a" />
      <DrivingCar x={NB_LANE_X} initialZ={15} speed={6.0} color="#3a6ab0" />
      <DrivingCar x={SB_LANE_X} initialZ={-10} speed={-4.8} color="#e8c84a" roofColor="#33301a" />
      <DrivingCar x={SB_LANE_X} initialZ={42} speed={-5.6} color="#4a8a4a" />

      {/* Parked cars on the east shoulder, mixed orientations */}
      <ParkedCar z={-50} color="#7a3a6a" />
      <ParkedCar z={-32} color="#3a3a3a" flipped />
      <ParkedCar z={-18} color="#a8b0b8" />
      <ParkedCar z={0} color="#704a30" flipped />
      <ParkedCar z={18} color="#c8a070" />
      <ParkedCar z={36} color="#506478" flipped />
      <ParkedCar z={52} color="#9a4040" />
      {/* Palms scattered along the beach for that coastal feel. */}
      <PalmTree position={[19.5, 0, -28]} scale={1.1} />
      <PalmTree position={[20.2, 0, -14]} scale={1.0} />
      <PalmTree position={[19.8, 0, 0]} scale={1.2} />
      <PalmTree position={[20.4, 0, 18]} scale={1.05} />
      <PalmTree position={[19.6, 0, 32]} scale={1.15} />

      {/* Lake to the northeast, with gator and surrounding palm trees */}
      <Lake position={[11.5, 0, -8]} radius={2.8} />
      <Alligator gatorRef={gatorRef} onSelect={onGatorClick} />
      <PalmTree position={[8.5, 0, -10.5]} />
      <PalmTree position={[14, 0, -10]} scale={1.15} />
      <PalmTree position={[9.5, 0, -5.2]} scale={0.9} />
      <PalmTree position={[14.5, 0, -6.3]} />

      {/* Golf course to the southwest */}
      <GolfCourse
        position={[GOLF_POSITION.x, 0, GOLF_POSITION.z]}
        onSelect={onGolfClick}
      />
      <GolfBall golfRef={golfRef} />

      {/* Hot-air balloon to the south-east (clickable easter egg) */}
      <Balloon balloonRef={balloonRef} onSelect={onBalloonClick} />

      {/* Amusement park to the northwest (opposite the golf course) */}
      <AmusementPark onSelect={onParkClick} />
      <CoasterCart coasterRef={coasterRef} />

      {/* Distant rolling hills at the far edges of the world. East
          is ocean, west is cityscape — only north and south hills
          remain so each cardinal direction has its own backdrop. */}
      <Hill position={[-22, 0, -28]} scale={1.4} color="#4a7a30" />
      <Hill position={[-22, 0, 28]} scale={1.5} color="#3d6824" />
      <Hill position={[0, 0, -32]} scale={1.8} color="#446e2a" />
      <Hill position={[0, 0, 32]} scale={1.4} color="#446e2a" />
      <Hill position={[-12, 0, -34]} scale={1.3} color="#4a7a30" />
      <Hill position={[10, 0, 30]} scale={1.3} color="#3d6824" />

      {/* Northern mountain ridge — two broad snow-capped peaks
          positioned with the smaller front peak overlapping the
          larger back peak so the silhouette reads as layered depth.
          Back peak is taller, wider, and further north; front peak
          partially occludes its lower-right slope. Both peaks are
          kept west of x≈14 so neither base spills onto the beach
          (which starts at x=18). */}
      <Mountain x={-5} z={-68} height={28} baseRadius={15} snow color="#42523f" />
      <Mountain x={4} z={-58} height={20} baseRadius={10} snow color="#4a5a48" />

      {/* Farmland to the south — crop fields, a barn + silo +
          farmhouse, plus a few hay bales. Sits behind the south
          hills so the visual progression is plaza → hills → fields
          → farm buildings when looking south. */}
      <CropField x={-12} z={45} w={11} d={9} color="#c8a64a" rowColor="#a8862a" />
      <CropField x={3} z={47} w={11} d={11} color="#7aa84a" rowColor="#5a8838" />
      <CropField x={12} z={38} w={5} d={4} color="#6e4830" />
      <Farmhouse x={-22} z={60} rotation={-Math.PI * 0.05} />
      <Barn x={-12} z={59} />
      <Silo x={-5} z={58} />
      <HayBale x={-9} z={53} rotation={0.4} />
      <HayBale x={-7} z={54} rotation={-0.2} />
      <HayBale x={-11} z={52} />

      {/* Red tractor parked east of the barn */}
      <Tractor x={-4} z={56} rotation={-Math.PI * 0.15} />

      {/* Fenced animal pen east of the barn — three cows, a goat, a
          pig. Fence runs around the south + east edges. */}
      <Cow x={1} z={48} rotation={-Math.PI * 0.6} />
      <Cow x={4} z={50} rotation={Math.PI * 0.2} />
      <Cow x={2} z={52} rotation={Math.PI * 0.9} />
      <Goat x={6} z={48} rotation={Math.PI * 0.4} />
      <Goat x={7} z={52} rotation={-Math.PI * 0.3} />
      <Pig x={-1} z={50} rotation={Math.PI * 1.2} />
      {/* Pen fences — south side then east side */}
      <FenceSection x={2} z={54.5} length={6} />
      <FenceSection x={5} z={54.5} length={6} />
      <FenceSection x={8.3} z={51} rotation={Math.PI / 2} length={6} />
      <FenceSection x={8.3} z={47} rotation={Math.PI / 2} length={4} />

      {/* Chickens scattered near the farmhouse / barn */}
      <Chicken x={-17} z={56} rotation={Math.PI * 0.4} />
      <Chicken x={-15} z={55} rotation={Math.PI * 1.1} color="#3a2a1a" />
      <Chicken x={-19} z={54} rotation={-Math.PI * 0.5} color="#c8a878" />
      <Chicken x={-16} z={58} rotation={Math.PI * 0.8} />
      <Chicken x={-13} z={56} rotation={Math.PI * 1.5} color="#3a2a1a" />

      {/* Two turkeys near the chickens — bigger and fancier */}
      <Turkey x={-18} z={57} rotation={Math.PI * 0.6} />
      <Turkey x={-15} z={59} rotation={-Math.PI * 0.4} />

      {/* Tall corn stalks scattered across the green cornfield at
          (3, 47). Adds vertical texture so the field reads as
          actual corn rather than just a green patch. */}
      <CornStalk x={-1} z={43} scale={1.0} />
      <CornStalk x={1} z={44} scale={1.05} />
      <CornStalk x={3} z={43} scale={0.95} />
      <CornStalk x={5} z={44} scale={1.0} />
      <CornStalk x={7} z={43} scale={1.05} />
      <CornStalk x={-1} z={46} scale={1.0} />
      <CornStalk x={1} z={47} scale={1.1} />
      <CornStalk x={3} z={46} scale={1.0} />
      <CornStalk x={5} z={47} scale={1.05} />
      <CornStalk x={7} z={46} scale={0.95} />
      <CornStalk x={-1} z={49} scale={1.0} />
      <CornStalk x={1} z={50} scale={1.05} />
      <CornStalk x={3} z={49} scale={1.0} />
      <CornStalk x={5} z={50} scale={1.05} />
      <CornStalk x={7} z={49} scale={1.0} />

      {/* Scarecrow in the middle of the cornfield */}
      <Scarecrow x={3} z={47} rotation={Math.PI * 0.1} />

      {/* Windmill — tall well-pump style with rotating blades. Sits
          on the empty grass east of the farm, between the farm and
          the lake/play area. */}
      <Windmill x={11} z={55} />

      {/* Distant farm backdrop — additional buildings, fields, hills,
          and pines south of the main farm so the world doesn't end at
          a grass edge when the camera looks south. */}
      <Farmhouse x={-20} z={78} rotation={Math.PI * 0.1} />
      <Barn x={-8} z={77} rotation={Math.PI} />
      <Silo x={0} z={78} />
      <Silo x={3} z={79} scale={0.85} />
      <Barn x={10} z={76} rotation={Math.PI * 0.85} />
      <CropField x={-12} z={68} w={14} d={6} color="#8aa83a" rowColor="#6a8a28" />
      <CropField x={6} z={70} w={10} d={7} color="#c8a64a" rowColor="#a8862a" />
      <CropField x={-15} z={75} w={6} d={3} color="#6e4830" />
      <Hill position={[-22, 0, 72]} scale={1.4} color="#3d6824" />
      <Hill position={[14, 0, 73]} scale={1.5} color="#446e2a" />
      <Hill position={[-3, 0, 84]} scale={1.6} color="#4a7a30" />
      <PineTree position={[-26, 0, 70]} scale={1.5} />
      <PineTree position={[-18, 0, 73]} scale={1.6} />
      <PineTree position={[-5, 0, 72]} scale={1.4} />
      <PineTree position={[7, 0, 73]} scale={1.5} />
      <PineTree position={[15, 0, 70]} scale={1.4} />
      <PineTree position={[-20, 0, 82]} scale={1.5} />
      <PineTree position={[-8, 0, 83]} scale={1.6} />
      <PineTree position={[5, 0, 82]} scale={1.4} />

      {/* Atmospheric haze wall at the southern ground edge so the
          drone-tour farm vantage fades into a soft horizon instead of
          showing the abrupt line where the grass plane ends. */}
      <FarmMist z={85} />

      {/* Pine forest in the valley between the hills and the
          mountain ridge — softens the transition from the play area
          to the towering peaks. */}
      <PineTree position={[-35, 0, -38]} scale={1.4} />
      <PineTree position={[-25, 0, -42]} scale={1.6} />
      <PineTree position={[-18, 0, -45]} scale={1.5} />
      <PineTree position={[-10, 0, -40]} scale={1.3} />
      <PineTree position={[-3, 0, -43]} scale={1.55} />
      <PineTree position={[5, 0, -38]} scale={1.7} />
      <PineTree position={[10, 0, -42]} scale={1.4} />
      <PineTree position={[16, 0, -39]} scale={1.3} />
      <PineTree position={[-30, 0, -48]} scale={1.5} />
      <PineTree position={[-15, 0, -48]} scale={1.65} />
      <PineTree position={[0, 0, -47]} scale={1.45} />
      <PineTree position={[13, 0, -47]} scale={1.5} />

      {/* Mix of regular oaks and pine trees */}
      <Tree position={[15, 0, 1]} scale={1.1} />
      <Tree position={[-7, 0, 0]} />
      <Tree position={[9, 0, 13]} scale={1.2} />
      <Tree position={[-7, 0, 14]} />
      <Tree position={[2, 0, -16]} scale={1.05} />
      <Tree position={[16, 0, -2]} scale={0.95} />
      <Tree position={[-19, 0, 5]} />
      <Tree position={[-21, 0, -14]} scale={1.15} />
      <PineTree position={[-22, 0, -6]} scale={1.0} />
      <PineTree position={[-24, 0, 8]} scale={1.3} />
      <PineTree position={[16, 0, 10]} scale={1.1} />
      <PineTree position={[17, 0, -16]} scale={1.5} />
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

// Eastern shoreline + ocean. The beach is a sandy strip running roughly
// N-S along x≈18-22; the ocean stretches east from x=22 toward the
// horizon. Both planes sit just above the grass (y=0.01) to avoid
// z-fighting with the underlying ground plane. The two animated foam
// strips sweep inland with slightly different speeds for life.
function Ocean() {
  const foam1Ref = useRef<THREE.Mesh>(null);
  const foam2Ref = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    // Each foam strip oscillates back and forth across a ~1.5-unit band
    // just east of the shoreline. Different periods so they don't move
    // in lockstep.
    if (foam1Ref.current) {
      foam1Ref.current.position.x = 22.6 + Math.sin(t * 0.6) * 0.35;
    }
    if (foam2Ref.current) {
      foam2Ref.current.position.x = 23.4 + Math.sin(t * 0.45 + 1.2) * 0.5;
    }
  });
  return (
    <group>
      {/* Main water plane — wide and long so the ocean fills the
          horizon when the camera is spun to face east. Extends past
          the green ground plane on the N/S sides so the horizon line
          between water and sky is continuous. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[64, 0.01, 0]}
        receiveShadow
      >
        <planeGeometry args={[84, 160]} />
        <meshStandardMaterial color="#3e7ba8" roughness={0.4} metalness={0.1} />
      </mesh>
      {/* Foam line right at the shore — a brighter strip that visually
          separates beach from open water. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[22.3, 0.013, 0]}
      >
        <planeGeometry args={[0.6, 120]} />
        <meshStandardMaterial
          color="#dfe8ee"
          transparent
          opacity={0.75}
          depthWrite={false}
        />
      </mesh>
      {/* Two animated foam strips sweeping inland — gives the ocean
          motion without the cost of a real wave shader. */}
      <mesh
        ref={foam1Ref}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[22.6, 0.014, 0]}
      >
        <planeGeometry args={[0.35, 110]} />
        <meshStandardMaterial
          color="#ffffff"
          transparent
          opacity={0.35}
          depthWrite={false}
        />
      </mesh>
      <mesh
        ref={foam2Ref}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[23.4, 0.014, 0]}
      >
        <planeGeometry args={[0.25, 100]} />
        <meshStandardMaterial
          color="#ffffff"
          transparent
          opacity={0.25}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

function Beach() {
  return (
    <group>
      {/* Main sandy strip along the eastern shore. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[20, 0.011, 0]}
        receiveShadow
      >
        <planeGeometry args={[4, 130]} />
        <meshStandardMaterial color="#e8d4a0" roughness={1} />
      </mesh>
      {/* A few darker wet-sand patches near the waterline. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[21.5, 0.012, 0]}
      >
        <planeGeometry args={[1.1, 130]} />
        <meshStandardMaterial color="#c8b078" roughness={1} />
      </mesh>
      {/* Small grey rocks dotting the sand. */}
      <mesh position={[19.6, 0.12, -22]} castShadow>
        <sphereGeometry args={[0.22, 8, 6]} />
        <meshStandardMaterial color="#9a9a96" roughness={1} />
      </mesh>
      <mesh position={[20.4, 0.1, 4]} castShadow>
        <sphereGeometry args={[0.18, 8, 6]} />
        <meshStandardMaterial color="#8a8a86" roughness={1} />
      </mesh>
      <mesh position={[19.4, 0.14, 14]} castShadow>
        <sphereGeometry args={[0.26, 8, 6]} />
        <meshStandardMaterial color="#a5a5a0" roughness={1} />
      </mesh>
      <mesh position={[20.6, 0.12, 22]} castShadow>
        <sphereGeometry args={[0.2, 8, 6]} />
        <meshStandardMaterial color="#9a9a96" roughness={1} />
      </mesh>
    </group>
  );
}

// One downtown building. In its local frame the front-facing wall is
// the -z face — optional warm-yellow window strips on that face make
// the skyline read as inhabited rather than blank boxes. `rotation`
// rotates the whole building around Y so the same data can be reused
// for cities on any side of the world (the windows' material is
// DoubleSide so they stay visible after rotation).
function SkylineBox({
  x,
  z,
  w,
  d,
  h,
  color,
  lit = false,
  rotation = 0,
}: {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  color: string;
  lit?: boolean;
  rotation?: number;
}) {
  const floors = Math.max(0, Math.floor((h - 1.0) / 1.5));
  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      <mesh position={[0, h / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={color} />
      </mesh>
      {lit &&
        Array.from({ length: floors }).map((_, i) => {
          const wy = 1.0 + i * 1.5;
          return (
            <mesh
              key={i}
              position={[0, wy, -d / 2 - 0.005]}
            >
              <planeGeometry args={[w * 0.7, 0.22]} />
              <meshStandardMaterial
                color="#f4d97a"
                emissive="#f4d97a"
                emissiveIntensity={0.35}
                side={THREE.DoubleSide}
              />
            </mesh>
          );
        })}
    </group>
  );
}

// Downtown silhouette running along the entire western edge of the
// world (z=-65..65), opposite the beach. Three rows of buildings
// stacked away from the play area (front at x≈-33, mid at x≈-38,
// back at x≈-43) so the camera orbiting west sees layered depth
// instead of a flat wall. Each box is rotated -π/2 around Y so its
// window-strip face ends up pointing east toward the plaza.
//
// Buildings are generated deterministically at import time from a
// seeded PRNG, so the layout is stable across reloads but doesn't
// require hand-placing ~75 boxes.
type CityBuilding = {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  color: string;
  lit: boolean;
};

const CITY_BUILDINGS: CityBuilding[] = (() => {
  let seed = 1234;
  const r = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const colors = [
    "#3a4048",
    "#4a505a",
    "#5e6470",
    "#6e7480",
    "#7a8090",
    "#3e4a5a",
    "#5a4a3e",
    "#2e3540",
  ];
  // baseX values keep the closest row well west of the road's west
  // edge (x=-32.5) so the buildings don't sit on the asphalt — the
  // gap between road and front row reads as a grass setback /
  // sidewalk strip.
  const rows = [
    { baseX: -36, baseH: 4.5, hVar: 2.5, litChance: 0.6 }, // closest, shortest
    { baseX: -41, baseH: 7, hVar: 3, litChance: 0.65 }, // mid
    { baseX: -46, baseH: 10, hVar: 4.5, litChance: 0.55 }, // back, tallest
  ];
  const buildings: CityBuilding[] = [];
  for (const row of rows) {
    let z = -64;
    while (z < 65) {
      const xJ = (r() - 0.5) * 1.6;
      const zJ = (r() - 0.5) * 0.5;
      const w = 2.4 + r() * 1.4;
      const d = 2.2 + r() * 0.8;
      const h = row.baseH + r() * row.hVar;
      const color = colors[Math.floor(r() * colors.length)];
      const lit = r() < row.litChance;
      buildings.push({ x: row.baseX + xJ, z: z + zJ, w, d, h, color, lit });
      z += 3.6 + r() * 1.3;
    }
  }
  return buildings;
})();

// Pick the five tallest back-row buildings for antennae so the
// horizon has a few clear spikes.
const CITY_ANTENNAE = CITY_BUILDINGS.filter((b) => b.x < -43)
  .sort((a, b) => b.h - a.h)
  .slice(0, 5)
  .map((b) => ({ x: b.x, y: b.h, z: b.z }));

function Cityscape() {
  const R = -Math.PI / 2;
  return (
    <group>
      {CITY_BUILDINGS.map((b, i) => (
        <SkylineBox
          key={i}
          x={b.x}
          z={b.z}
          w={b.w}
          d={b.d}
          h={b.h}
          color={b.color}
          lit={b.lit}
          rotation={R}
        />
      ))}
      {CITY_ANTENNAE.map((a, i) => (
        <mesh key={i} position={[a.x, a.y + 0.6, a.z]} castShadow>
          <cylinderGeometry args={[0.04, 0.04, 1.2, 6]} />
          <meshStandardMaterial color="#2a2e35" />
        </mesh>
      ))}
    </group>
  );
}

// Two-lane road running in front of the cityscape (x≈-30) for the
// full N-S length. Asphalt plane + dashed yellow centre line +
// continuous white side lines. Sits at y=0.012 so it covers the
// underlying grass without z-fighting.
const ROAD_CENTER_X = -30;
const ROAD_WIDTH = 5;
const ROAD_LENGTH = 180; // extended to span the full ground (z=-95..85)
const ROAD_CENTER_Z = -5; // shifted south to match the ground's centre
const ROAD_DASH_COUNT = Math.floor(ROAD_LENGTH / 6);
const NB_LANE_X = ROAD_CENTER_X + 1.0; // northbound (+z) cars
const SB_LANE_X = ROAD_CENTER_X - 1.0; // southbound (-z) cars
const PARK_LANE_X = ROAD_CENTER_X + 2.0; // parked cars on the east shoulder

// Wall of mist that hides where the road runs off the edge of the
// map. Several stacked semi-transparent planes give a layered
// "fade into the distance" look from any reasonable viewing angle.
// `direction = +1` for the south end (mist stacks toward +z),
// `-1` for the north end.
// Atmospheric mist wall standing at the southern ground edge so the
// camera looking south at the farm waypoint sees a hazy fade-to-sky
// horizon instead of the abrupt line where the grass plane ends.
// Four stacked semi-transparent planes (sky horizon color) build up
// a soft gradient — the near plane is sparse, the far one is nearly
// opaque so anything past the edge is fully hidden.
function FarmMist({ z }: { z: number }) {
  return (
    <group position={[-10, 0, z]}>
      {[
        { dz: 0, op: 0.25 },
        { dz: 0.8, op: 0.45 },
        { dz: 1.6, op: 0.65 },
        { dz: 2.4, op: 0.85 },
      ].map(({ dz, op }, i) => (
        <mesh key={i} position={[0, 5, dz]}>
          <planeGeometry args={[100, 12]} />
          <meshBasicMaterial
            color="#c8d8e8"
            transparent
            opacity={op}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}

function RoadMist({
  z,
  direction = 1,
}: {
  z: number;
  direction?: number;
}) {
  return (
    <group position={[ROAD_CENTER_X, 0, z]}>
      {[
        { dz: 0, op: 0.25 },
        { dz: 0.8, op: 0.45 },
        { dz: 1.6, op: 0.65 },
        { dz: 2.4, op: 0.85 },
      ].map(({ dz, op }, i) => (
        <mesh key={i} position={[0, 4.5, dz * direction]}>
          <planeGeometry args={[ROAD_WIDTH + 6, 11]} />
          <meshBasicMaterial
            color="#c8d8e8"
            transparent
            opacity={op}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}

function Road() {
  // Edge-of-map positions for the mist walls (just inside the road's
  // ends so the densest planes line up with the ground edge).
  const SOUTH_END = ROAD_CENTER_Z + ROAD_LENGTH / 2 - 4;
  const NORTH_END = ROAD_CENTER_Z - ROAD_LENGTH / 2 + 4;
  return (
    <group>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[ROAD_CENTER_X, 0.012, ROAD_CENTER_Z]}
        receiveShadow
      >
        <planeGeometry args={[ROAD_WIDTH, ROAD_LENGTH]} />
        <meshStandardMaterial color="#2e2e30" roughness={1} />
      </mesh>
      {/* Dashed yellow centre line */}
      {Array.from({ length: ROAD_DASH_COUNT }).map((_, i) => (
        <mesh
          key={`cl${i}`}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[
            ROAD_CENTER_X,
            0.014,
            ROAD_CENTER_Z - ROAD_LENGTH / 2 + 3 + i * 6,
          ]}
        >
          <planeGeometry args={[0.15, 3]} />
          <meshStandardMaterial color="#e8c84a" />
        </mesh>
      ))}
      {/* Solid white edge lines */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[ROAD_CENTER_X + ROAD_WIDTH / 2 - 0.15, 0.014, ROAD_CENTER_Z]}
      >
        <planeGeometry args={[0.12, ROAD_LENGTH]} />
        <meshStandardMaterial color="#dde0e3" />
      </mesh>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[ROAD_CENTER_X - ROAD_WIDTH / 2 + 0.15, 0.014, ROAD_CENTER_Z]}
      >
        <planeGeometry args={[0.12, ROAD_LENGTH]} />
        <meshStandardMaterial color="#dde0e3" />
      </mesh>
      {/* Mist walls at both road ends — hide where the road runs
          off the edge of the map. */}
      <RoadMist z={SOUTH_END} direction={1} />
      <RoadMist z={NORTH_END} direction={-1} />
    </group>
  );
}

// Single car. Geometry-only — the car points +z by default, set
// `flipped` to rotate it 180° so it points -z. Wrapped by ParkedCar
// (static position) or DrivingCar (animated along z).
function Car({
  color,
  roofColor = "#1d1d20",
  flipped = false,
}: {
  color: string;
  roofColor?: string;
  flipped?: boolean;
}) {
  return (
    <group rotation={[0, flipped ? Math.PI : 0, 0]}>
      {/* Body */}
      <mesh position={[0, 0.3, 0]} castShadow>
        <boxGeometry args={[0.78, 0.36, 1.55]} />
        <meshStandardMaterial color={color} />
      </mesh>
      {/* Roof / cabin */}
      <mesh position={[0, 0.58, -0.05]} castShadow>
        <boxGeometry args={[0.68, 0.3, 0.85]} />
        <meshStandardMaterial color={roofColor} />
      </mesh>
      {/* Windshield front (tinted blue-grey) */}
      <mesh position={[0, 0.55, 0.4]} rotation={[Math.PI * 0.12, 0, 0]}>
        <planeGeometry args={[0.58, 0.3]} />
        <meshStandardMaterial color="#5a6a78" side={THREE.DoubleSide} />
      </mesh>
      {/* Rear windshield */}
      <mesh position={[0, 0.55, -0.5]} rotation={[-Math.PI * 0.12, 0, 0]}>
        <planeGeometry args={[0.58, 0.28]} />
        <meshStandardMaterial color="#5a6a78" side={THREE.DoubleSide} />
      </mesh>
      {/* Four wheels — cylinder axis rotated to X */}
      {(
        [
          [-0.42, 0.55],
          [0.42, 0.55],
          [-0.42, -0.55],
          [0.42, -0.55],
        ] as [number, number][]
      ).map(([wx, wz], i) => (
        <mesh
          key={i}
          position={[wx, 0.15, wz]}
          rotation={[0, 0, Math.PI / 2]}
          castShadow
        >
          <cylinderGeometry args={[0.15, 0.15, 0.1, 10]} />
          <meshStandardMaterial color="#1a1a1a" />
        </mesh>
      ))}
      {/* Headlights (front) */}
      <mesh position={[-0.24, 0.32, 0.78]}>
        <sphereGeometry args={[0.07, 8, 6]} />
        <meshStandardMaterial
          color="#fff4c0"
          emissive="#fff4c0"
          emissiveIntensity={0.5}
        />
      </mesh>
      <mesh position={[0.24, 0.32, 0.78]}>
        <sphereGeometry args={[0.07, 8, 6]} />
        <meshStandardMaterial
          color="#fff4c0"
          emissive="#fff4c0"
          emissiveIntensity={0.5}
        />
      </mesh>
      {/* Taillights (back) */}
      <mesh position={[-0.24, 0.32, -0.78]}>
        <sphereGeometry args={[0.06, 8, 6]} />
        <meshStandardMaterial
          color="#cc2020"
          emissive="#cc2020"
          emissiveIntensity={0.4}
        />
      </mesh>
      <mesh position={[0.24, 0.32, -0.78]}>
        <sphereGeometry args={[0.06, 8, 6]} />
        <meshStandardMaterial
          color="#cc2020"
          emissive="#cc2020"
          emissiveIntensity={0.4}
        />
      </mesh>
    </group>
  );
}

// Static car parked on the east shoulder of the road.
function ParkedCar({
  z,
  color,
  roofColor,
  flipped,
}: {
  z: number;
  color: string;
  roofColor?: string;
  flipped?: boolean;
}) {
  return (
    <group position={[PARK_LANE_X, 0, z]}>
      <Car color={color} roofColor={roofColor} flipped={flipped} />
    </group>
  );
}

// Animated car cruising the road. Speed sign determines direction:
// positive = northbound (+z), negative = southbound (-z). When the
// car reaches ±68 it wraps to the opposite end so the road never
// looks empty.
function DrivingCar({
  x,
  initialZ,
  speed,
  color,
  roofColor,
}: {
  x: number;
  initialZ: number;
  speed: number;
  color: string;
  roofColor?: string;
}) {
  const ref = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (!ref.current) return;
    ref.current.position.z += speed * dt;
    // Wrap just before the mist wall hides the road ends, so cars
    // disappear visually inside the mist rather than at a hard pop.
    if (speed > 0 && ref.current.position.z > 80) {
      ref.current.position.z = -90;
    } else if (speed < 0 && ref.current.position.z < -90) {
      ref.current.position.z = 80;
    }
  });
  return (
    <group ref={ref} position={[x, 0, initialZ]}>
      <Car color={color} roofColor={roofColor} flipped={speed < 0} />
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

// One green + cup + flag + tee marker for a single hole. Local
// positions are relative to the GolfCourse group. `greenRadius`
// defaults to a normal-sized green; Hole 1 (the interactive putt)
// uses a much larger green so the putt has visible space to roll.
function GolfHole({
  greenLocal,
  teeLocal,
  greenRadius = 1.8,
}: {
  greenLocal: [number, number];
  teeLocal: [number, number];
  greenRadius?: number;
}) {
  const [gx, gz] = greenLocal;
  const [tx, tz] = teeLocal;
  return (
    <group>
      {/* Putting green */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[gx, 0.013, gz]}
        receiveShadow
      >
        <circleGeometry args={[greenRadius, 32]} />
        <meshStandardMaterial color="#5fa838" />
      </mesh>
      {/* The cup */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[gx, 0.015, gz]}>
        <circleGeometry args={[0.12, 12]} />
        <meshBasicMaterial color="#0a0a0a" />
      </mesh>
      {/* Flag pole */}
      <mesh position={[gx, 0.85, gz]} castShadow>
        <cylinderGeometry args={[0.025, 0.025, 1.7, 6]} />
        <meshStandardMaterial color="#dcdce0" />
      </mesh>
      {/* Flag */}
      <mesh position={[gx + 0.5, 1.55, gz]} castShadow>
        <planeGeometry args={[0.85, 0.45]} />
        <meshStandardMaterial color="#c83232" side={THREE.DoubleSide} />
      </mesh>
      {/* Flag pole tip */}
      <mesh position={[gx, 1.72, gz]}>
        <sphereGeometry args={[0.05, 8, 6]} />
        <meshStandardMaterial color="#d4a04a" metalness={0.6} roughness={0.3} />
      </mesh>
      {/* Tee marker */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[tx, 0.014, tz]}
        receiveShadow
      >
        <planeGeometry args={[1.2, 1.2]} />
        <meshStandardMaterial color="#3e5a30" />
      </mesh>
    </group>
  );
}

// Simple low-poly golf cart — white body, red striped roof, four
// wheels, blue windshield, dark steering wheel.
function GolfCart({
  position,
  rotation = 0,
}: {
  position: [number, number, number];
  rotation?: number;
}) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {/* Body */}
      <mesh position={[0, 0.4, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.9, 0.45, 1.5]} />
        <meshStandardMaterial color="#f4f1de" />
      </mesh>
      {/* Roof */}
      <mesh position={[0, 1.25, 0]} castShadow>
        <boxGeometry args={[1.0, 0.08, 1.6]} />
        <meshStandardMaterial color="#cc2828" />
      </mesh>
      {/* Four roof supports */}
      {(
        [
          [-0.42, -0.7],
          [0.42, -0.7],
          [-0.42, 0.7],
          [0.42, 0.7],
        ] as [number, number][]
      ).map(([px, pz], i) => (
        <mesh key={i} position={[px, 0.85, pz]}>
          <cylinderGeometry args={[0.03, 0.03, 0.85, 6]} />
          <meshStandardMaterial color="#888c95" />
        </mesh>
      ))}
      {/* Windshield (front) */}
      <mesh position={[0, 0.85, 0.78]} rotation={[Math.PI * 0.06, 0, 0]}>
        <planeGeometry args={[0.78, 0.55]} />
        <meshStandardMaterial
          color="#9ab4c8"
          transparent
          opacity={0.7}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Seat back */}
      <mesh position={[0, 0.78, -0.2]}>
        <boxGeometry args={[0.78, 0.36, 0.06]} />
        <meshStandardMaterial color="#3a3a3a" />
      </mesh>
      {/* Steering wheel */}
      <mesh position={[-0.18, 0.7, 0.5]} rotation={[Math.PI / 2 - 0.4, 0, 0]}>
        <torusGeometry args={[0.1, 0.02, 6, 12]} />
        <meshStandardMaterial color="#1a1a1a" />
      </mesh>
      {/* Four wheels */}
      {(
        [
          [-0.45, 0.55],
          [0.45, 0.55],
          [-0.45, -0.55],
          [0.45, -0.55],
        ] as [number, number][]
      ).map(([wx, wz], i) => (
        <mesh
          key={`w${i}`}
          position={[wx, 0.18, wz]}
          rotation={[0, 0, Math.PI / 2]}
          castShadow
        >
          <cylinderGeometry args={[0.18, 0.18, 0.1, 10]} />
          <meshStandardMaterial color="#1a1a1a" />
        </mesh>
      ))}
      {/* Golf bag on the back */}
      <mesh position={[0.25, 0.95, -0.7]} rotation={[0.2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.12, 0.1, 0.55, 8]} />
        <meshStandardMaterial color="#3a4f8b" />
      </mesh>
      {/* Two club heads poking out of the bag */}
      <mesh position={[0.25, 1.32, -0.78]} rotation={[0.3, 0, 0.2]}>
        <boxGeometry args={[0.04, 0.18, 0.04]} />
        <meshStandardMaterial color="#dcdce0" metalness={0.6} />
      </mesh>
      <mesh position={[0.32, 1.34, -0.74]} rotation={[0.3, 0, -0.15]}>
        <boxGeometry args={[0.04, 0.18, 0.04]} />
        <meshStandardMaterial color="#dcdce0" metalness={0.6} />
      </mesh>
    </group>
  );
}

// Low, wide green mound used for the rolling-hills feel on the
// fairway. Smaller than `Hill` (which is the world-perimeter
// backdrop) and uses the same flat-shaded half-sphere look.
function FairwayMound({
  position,
  scale = 1,
  color = "#6aab38",
}: {
  position: [number, number, number];
  scale?: number;
  color?: string;
}) {
  return (
    <mesh
      position={position}
      scale={[scale, scale * 0.35, scale]}
      castShadow
      receiveShadow
    >
      <sphereGeometry args={[2.2, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
      <meshStandardMaterial color={color} flatShading />
    </mesh>
  );
}

function GolfCourse({
  position,
  onSelect,
}: {
  position: [number, number, number];
  onSelect: () => void;
}) {
  // GolfCourse group is positioned at GOLF_POSITION = (-14, 0, 17).
  // Local +x is east, local +z is south. The course extends from
  // about local x=-9..+7 (world x=-23..-7, safely west of CODE at
  // x=-4.9) and local z=-15..+15 (world z=2..32, reaching toward
  // the south farm without overlapping it).
  //
  // Hole 1 (the interactive easter egg): tee at local (7, -8) =
  // world GOLF_TEE (-7, 9), green at local (-4, -8.4) = world
  // GOLF_HOLE (-18, 8.6). The other two holes are decorative.
  return (
    <group position={position}>
      {/* Rough — darker green border behind everything else */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[-1, 0.010, 0]}
        receiveShadow
      >
        <planeGeometry args={[16, 32]} />
        <meshStandardMaterial color="#558a36" />
      </mesh>
      {/* Main fairway covering the whole playable area — clickable
          target for the hole-in-one easter egg. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[-1, 0.011, 0]}
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
        <planeGeometry args={[14, 30]} />
        <meshStandardMaterial color="#7ab84a" />
      </mesh>

      {/* Cart path — light grey strip winding south through the
          course. Stays inside the rough boundary. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[5, 0.012, -2]}
        receiveShadow
      >
        <planeGeometry args={[0.9, 20]} />
        <meshStandardMaterial color="#c8c4b8" />
      </mesh>

      {/* Hole 1 (easter egg) — north end. Local (7, -8) tee →
          local (-4, -8.4) green. Larger green than the other holes
          so the rolling ball has visible space to travel during
          the putt easter egg. */}
      <GolfHole
        greenLocal={[-4, -8.4]}
        teeLocal={[7, -8]}
        greenRadius={3.6}
      />

      {/* Hole 2 — middle of the course, dog-legs back the other way */}
      <GolfHole greenLocal={[5, 2]} teeLocal={[-5, -2]} />

      {/* Hole 3 — south end, closest to the farm */}
      <GolfHole greenLocal={[-5, 12]} teeLocal={[3, 8]} />

      {/* Sand bunkers scattered across the course. Each is positioned
          so its ellipse doesn't overlap any green or the water
          hazard (otherwise the overlapping discs z-fight). */}
      {/* Guarding Hole 1's east approach (the line from tee to
          green). Moved out from inside the green to clear the new
          bigger 3.6-radius Hole 1 green. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[2, 0.013, -7]}
        scale={[1.8, 1, 1]}
        receiveShadow
      >
        <circleGeometry args={[1.0, 20]} />
        <meshStandardMaterial color="#e8d8a8" />
      </mesh>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[2, 0.013, -10]}
        scale={[1.5, 1, 1]}
        receiveShadow
      >
        <circleGeometry args={[0.9, 20]} />
        <meshStandardMaterial color="#e8d8a8" />
      </mesh>
      {/* Sand pit east of the water hazard. Moved further east so
          its disc doesn't overlap the water hazard's disc. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[4, 0.013, 6]}
        scale={[1.4, 1, 1]}
        receiveShadow
      >
        <circleGeometry args={[1.0, 20]} />
        <meshStandardMaterial color="#e8d8a8" />
      </mesh>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[-3, 0.013, 9]}
        scale={[1.6, 1, 1]}
        receiveShadow
      >
        <circleGeometry args={[0.85, 20]} />
        <meshStandardMaterial color="#e8d8a8" />
      </mesh>

      {/* Water hazard between holes 2 and 3 */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.013, 5.5]}
        receiveShadow
      >
        <circleGeometry args={[1.6, 24]} />
        <meshStandardMaterial color="#3e7ba8" roughness={0.4} metalness={0.1} />
      </mesh>

      {/* Rolling fairway mounds — give the course some terrain
          variation instead of a flat plane */}
      <FairwayMound position={[-5, 0, -3]} scale={0.9} />
      <FairwayMound position={[4, 0, 0]} scale={1.0} color="#5fa838" />
      <FairwayMound position={[-4, 0, 4]} scale={1.1} />
      <FairwayMound position={[5, 0, 11]} scale={0.85} color="#5fa838" />
      <FairwayMound position={[-6, 0, 13]} scale={1.0} />

      {/* Parked golf cart on the cart path, between holes 1 and 2 */}
      <GolfCart position={[5, 0, -4]} rotation={Math.PI * 0.1} />
    </group>
  );
}

// Golf ball, animated during the putt easter egg.
// Phases (gt = golf.t in [0,1]):
//   gt < 0.35  : ball at the tee (on the green near the cup)
//   0.35..0.55 : ball rolls along the green from tee to cup (no arc)
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
      ref.current.position.set(GOLF_BALL_START.x, 0.08, GOLF_BALL_START.z);
    } else if (gt < 0.55) {
      // Ease-out roll: ball decelerates as it nears the cup like a
      // putt losing speed on the green.
      const p = (gt - 0.35) / 0.2;
      const eased = 1 - Math.pow(1 - p, 2);
      ref.current.visible = true;
      ref.current.position.x =
        GOLF_BALL_START.x + (GOLF_HOLE.x - GOLF_BALL_START.x) * eased;
      ref.current.position.z =
        GOLF_BALL_START.z + (GOLF_HOLE.z - GOLF_BALL_START.z) * eased;
      ref.current.position.y = 0.08; // rolls along the ground
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
      <meshStandardMaterial
        color="#ffffff"
        emissive="#fff8e0"
        emissiveIntensity={0.4}
        roughness={0.55}
      />
    </mesh>
  );
}

// Hot-air balloon — envelope (sphere) + basket (box) + suspension ropes
// + a tiny burner. Clickable; rises off the ground during the easter egg
// driven by balloonRef.height.
function Balloon({
  balloonRef,
  onSelect,
}: {
  balloonRef: React.MutableRefObject<BalloonState>;
  onSelect: () => void;
}) {
  const huggyTex = useTexture("/huggy.png");
  const groupRef = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!groupRef.current) return;
    const b = balloonRef.current;
    // Active: track the rise height. Inactive: smoothly settle to ground.
    if (b.active) {
      groupRef.current.position.y = b.height;
    } else if (groupRef.current.position.y > 0.001) {
      groupRef.current.position.y *= 0.92;
    } else {
      groupRef.current.position.y = 0;
    }
  });
  // Geometry: envelope sits far enough above the basket that the
  // rider's head fits in the gap (basket top → envelope bottom).
  // Sized so the character (body width ~0.78) fits cleanly inside
  // the basket with shoulders + head poking out the top.
  const BASKET_W = 1.5;
  const BASKET_H = 0.9;
  const BASKET_Y = 0.7;
  const ENV_R = 2.6;
  const ENV_Y = 5.9;
  // Derived: basket top and envelope bottom (used to size the ropes
  // exactly between them).
  const BASKET_TOP = BASKET_Y + BASKET_H / 2;
  const ENV_BOTTOM = ENV_Y - ENV_R * 1.25; // sphere vertical scale = 1.25
  const ROPE_OFFSET = BASKET_W / 2 - 0.15;
  return (
    <group ref={groupRef} position={[BALLOON_POSITION.x, 0, BALLOON_POSITION.z]}>
      {/* Envelope — slightly elongated red/yellow striped sphere. The
          whole envelope is clickable so a click anywhere on the balloon
          sends the character over. */}
      <mesh
        position={[0, ENV_Y, 0]}
        scale={[1, 1.25, 1]}
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
        <sphereGeometry args={[ENV_R, 20, 16]} />
        <meshStandardMaterial color="#d83a3a" />
      </mesh>
      {/* Yellow accent stripe around the envelope's equator */}
      <mesh position={[0, ENV_Y, 0]} scale={[1.01, 1.25, 1.01]}>
        <sphereGeometry
          args={[ENV_R * 0.998, 20, 4, 0, Math.PI * 2, Math.PI * 0.42, Math.PI * 0.16]}
        />
        <meshStandardMaterial color="#ffd83a" />
      </mesh>
      {/* Huggy patch — "sewn on" to the front-facing side of the envelope.
          Positioned at the envelope's surface along the camera direction
          during the balloon cinematic (~SE of the balloon), rotated to
          face that camera so the bear reads straight-on during the ride.
          Pushed 0.04 units along the surface normal to clear z-fighting
          with the envelope sphere. Sized to fit inside the yellow
          stripe — the stripe height in local units is
          `2 * R * 1.25 * cos(π*0.42) ≈ 1.613`, but the bear extends
          a hair past that, so HUGGY_SIZE is dialed slightly under and
          the center is bumped up by HUGGY_Y_BIAS to keep the cap on
          the top edge and pull the paws inside the bottom edge. */}
      {(() => {
        const HUGGY_DIR_X = 0.196;
        const HUGGY_DIR_Z = 0.98;
        const HUGGY_R = ENV_R + 0.04;
        const HUGGY_SIZE = 1.6;
        const HUGGY_Y_BIAS = 0.042;
        const px = HUGGY_DIR_X * HUGGY_R;
        const pz = HUGGY_DIR_Z * HUGGY_R;
        const ry = Math.atan2(HUGGY_DIR_X, HUGGY_DIR_Z);
        return (
          <mesh
            position={[px, ENV_Y + HUGGY_Y_BIAS, pz]}
            rotation={[0, ry, 0]}
          >
            <planeGeometry args={[HUGGY_SIZE, HUGGY_SIZE]} />
            <meshBasicMaterial
              map={huggyTex}
              transparent
              toneMapped={false}
              side={THREE.DoubleSide}
            />
          </mesh>
        );
      })()}
      {/* Suspension ropes — four thin cylinders running exactly from
          the basket top to the envelope bottom. */}
      {[
        [-ROPE_OFFSET, -ROPE_OFFSET],
        [-ROPE_OFFSET, ROPE_OFFSET],
        [ROPE_OFFSET, -ROPE_OFFSET],
        [ROPE_OFFSET, ROPE_OFFSET],
      ].map(([x, z], i) => (
        <mesh
          key={i}
          position={[x, (BASKET_TOP + ENV_BOTTOM) / 2, z]}
        >
          <cylinderGeometry
            args={[0.018, 0.018, ENV_BOTTOM - BASKET_TOP, 6]}
          />
          <meshStandardMaterial color="#3a2a18" />
        </mesh>
      ))}
      {/* Burner — small grey cylinder just above the basket */}
      <mesh position={[0, BASKET_TOP + 0.15, 0]}>
        <cylinderGeometry args={[0.15, 0.15, 0.3, 8]} />
        <meshStandardMaterial color="#5a5a5a" metalness={0.5} roughness={0.4} />
      </mesh>
      {/* Basket — wicker box */}
      <mesh position={[0, BASKET_Y, 0]} castShadow receiveShadow>
        <boxGeometry args={[BASKET_W, BASKET_H, BASKET_W]} />
        <meshStandardMaterial color="#8b6a3f" roughness={1} />
      </mesh>
      {/* Basket rim (darker) */}
      <mesh position={[0, BASKET_TOP - 0.04, 0]}>
        <boxGeometry args={[BASKET_W + 0.08, 0.08, BASKET_W + 0.08]} />
        <meshStandardMaterial color="#5b4423" roughness={1} />
      </mesh>
    </group>
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

// Classic red barn — boxy body with a gabled roof, white door,
// hay-loft window, and white eave trim. Roof slopes use rotated
// box slabs (rotation = ±atan(rise/run) around z so the slab's
// normal aligns with the slope).
function Barn({
  x,
  z,
  rotation = 0,
}: {
  x: number;
  z: number;
  rotation?: number;
}) {
  // Body: 4 wide × 3 tall × 5 deep. Roof rises 1.5 above the walls
  // to a ridge running along the z axis.
  const RISE = 1.5;
  const RUN = 2;
  const SLOPE_LEN = Math.sqrt(RISE * RISE + RUN * RUN); // 2.5
  const SLOPE_ANGLE = Math.atan(RISE / RUN); // ~36.87°
  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      {/* Main wall body */}
      <mesh position={[0, 1.5, 0]} castShadow receiveShadow>
        <boxGeometry args={[4, 3, 5]} />
        <meshStandardMaterial color="#a73a2a" />
      </mesh>
      {/* Roof — gabled, made of two rotated slabs meeting at the ridge */}
      <mesh
        position={[1, 3 + RISE / 2, 0]}
        rotation={[0, 0, -SLOPE_ANGLE]}
        castShadow
      >
        <boxGeometry args={[SLOPE_LEN, 0.15, 5.2]} />
        <meshStandardMaterial color="#5a2a20" />
      </mesh>
      <mesh
        position={[-1, 3 + RISE / 2, 0]}
        rotation={[0, 0, SLOPE_ANGLE]}
        castShadow
      >
        <boxGeometry args={[SLOPE_LEN, 0.15, 5.2]} />
        <meshStandardMaterial color="#5a2a20" />
      </mesh>
      {/* Gable triangle fills (the triangular wall at each end under the
          roof). Just two flat-shaded triangles via plane geometry won't
          be triangular — use a coneGeometry with 3 segments would also
          be wrong. Instead use a small triangular `Shape`? Simpler:
          stack two thin angled boxes that emulate a triangle. For the
          first pass, leave the gable ends open — at this distance the
          eye reads the barn shape from the roof + body alone. */}
      {/* White door (sliding-barn style) */}
      <mesh position={[0, 0.95, 2.51]}>
        <boxGeometry args={[1.4, 1.9, 0.04]} />
        <meshStandardMaterial color="#e8e0d0" />
      </mesh>
      {/* Door X-cross trim — two thin diagonals */}
      <mesh
        position={[0, 0.95, 2.53]}
        rotation={[0, 0, Math.atan2(1.9, 1.4)]}
      >
        <boxGeometry args={[Math.hypot(1.4, 1.9), 0.06, 0.01]} />
        <meshStandardMaterial color="#5a4030" />
      </mesh>
      <mesh
        position={[0, 0.95, 2.53]}
        rotation={[0, 0, -Math.atan2(1.9, 1.4)]}
      >
        <boxGeometry args={[Math.hypot(1.4, 1.9), 0.06, 0.01]} />
        <meshStandardMaterial color="#5a4030" />
      </mesh>
      {/* Hay-loft window above the door */}
      <mesh position={[0, 2.55, 2.51]}>
        <boxGeometry args={[0.7, 0.55, 0.04]} />
        <meshStandardMaterial color="#e8e0d0" />
      </mesh>
      {/* White eave trim along the front and back */}
      <mesh position={[0, 3, 2.55]}>
        <boxGeometry args={[4.05, 0.18, 0.05]} />
        <meshStandardMaterial color="#e8e0d0" />
      </mesh>
      <mesh position={[0, 3, -2.55]}>
        <boxGeometry args={[4.05, 0.18, 0.05]} />
        <meshStandardMaterial color="#e8e0d0" />
      </mesh>
    </group>
  );
}

// Tall grain silo — light-grey cylinder with a darker conical cap.
function Silo({ x, z, scale = 1 }: { x: number; z: number; scale?: number }) {
  return (
    <group position={[x, 0, z]} scale={scale}>
      <mesh position={[0, 2.5, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[1.2, 1.2, 5, 14]} />
        <meshStandardMaterial color="#b8b6a8" />
      </mesh>
      {/* Cap */}
      <mesh position={[0, 5.4, 0]} castShadow>
        <coneGeometry args={[1.25, 0.9, 14]} />
        <meshStandardMaterial color="#6a6458" />
      </mesh>
      {/* Horizontal band partway up — gives the silo some detail */}
      <mesh position={[0, 3.6, 0]}>
        <cylinderGeometry args={[1.22, 1.22, 0.12, 14]} />
        <meshStandardMaterial color="#7a7468" />
      </mesh>
    </group>
  );
}

// Small cream farmhouse with a red pyramid roof and a dark door.
function Farmhouse({
  x,
  z,
  rotation = 0,
}: {
  x: number;
  z: number;
  rotation?: number;
}) {
  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      <mesh position={[0, 1.25, 0]} castShadow receiveShadow>
        <boxGeometry args={[3, 2.5, 3]} />
        <meshStandardMaterial color="#eee0c8" />
      </mesh>
      <mesh position={[0, 3.0, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <coneGeometry args={[2.3, 1.5, 4]} />
        <meshStandardMaterial color="#a64b3a" />
      </mesh>
      <mesh position={[0, 0.75, 1.51]}>
        <boxGeometry args={[0.55, 1.1, 0.04]} />
        <meshStandardMaterial color="#4a3220" />
      </mesh>
      {/* Two tiny windows flanking the door */}
      <mesh position={[-0.95, 1.3, 1.51]}>
        <boxGeometry args={[0.45, 0.45, 0.04]} />
        <meshStandardMaterial color="#9ab4c8" />
      </mesh>
      <mesh position={[0.95, 1.3, 1.51]}>
        <boxGeometry args={[0.45, 0.45, 0.04]} />
        <meshStandardMaterial color="#9ab4c8" />
      </mesh>
    </group>
  );
}

// Crop field — a flat colored plane laid over the grass. Row stripes
// add a hint of tilled rows without modeling individual plants.
function CropField({
  x,
  z,
  w,
  d,
  color,
  rowColor,
}: {
  x: number;
  z: number;
  w: number;
  d: number;
  color: string;
  rowColor?: string;
}) {
  return (
    <group>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[x, 0.013, z]}
        receiveShadow
      >
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial color={color} />
      </mesh>
      {/* Row stripes running along z — thin slightly-darker strips */}
      {rowColor &&
        Array.from({ length: Math.floor(w / 0.8) }).map((_, i) => (
          <mesh
            key={i}
            rotation={[-Math.PI / 2, 0, 0]}
            position={[
              x - w / 2 + 0.4 + i * 0.8,
              0.014,
              z,
            ]}
          >
            <planeGeometry args={[0.08, d * 0.95]} />
            <meshStandardMaterial color={rowColor} />
          </mesh>
        ))}
    </group>
  );
}

// Round hay bale lying on its side — short cylinder rotated so its
// axis runs horizontally.
function HayBale({
  x,
  z,
  rotation = 0,
}: {
  x: number;
  z: number;
  rotation?: number;
}) {
  return (
    <mesh
      position={[x, 0.4, z]}
      rotation={[Math.PI / 2, 0, rotation]}
      castShadow
      receiveShadow
    >
      <cylinderGeometry args={[0.42, 0.42, 0.8, 12]} />
      <meshStandardMaterial color="#d4b878" />
    </mesh>
  );
}

// Classic red farm tractor — boxy body, big rear wheels, smaller
// front wheels, exhaust pipe, sloped hood. Faces +x by default;
// rotate via `rotation` prop.
function Tractor({
  x,
  z,
  rotation = 0,
}: {
  x: number;
  z: number;
  rotation?: number;
}) {
  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      {/* Hood / engine — sloped front, narrow */}
      <mesh position={[0.5, 0.55, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.7, 0.45, 0.7]} />
        <meshStandardMaterial color="#b8302a" />
      </mesh>
      {/* Cab / seat area — taller boxy section behind hood */}
      <mesh position={[-0.15, 0.75, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.6, 0.6, 0.8]} />
        <meshStandardMaterial color="#b8302a" />
      </mesh>
      {/* Roll cage roof — small rectangle on top */}
      <mesh position={[-0.15, 1.15, 0]} castShadow>
        <boxGeometry args={[0.65, 0.08, 0.85]} />
        <meshStandardMaterial color="#2a2a2a" />
      </mesh>
      {/* Steering wheel — small ring up front of the cab */}
      <mesh position={[0.15, 0.95, 0]} rotation={[Math.PI / 2 - 0.3, 0, 0]}>
        <torusGeometry args={[0.08, 0.012, 6, 12]} />
        <meshStandardMaterial color="#1a1a1a" />
      </mesh>
      {/* Exhaust pipe — vertical chimney on the hood */}
      <mesh position={[0.55, 1.05, 0.15]} castShadow>
        <cylinderGeometry args={[0.04, 0.04, 0.5, 8]} />
        <meshStandardMaterial color="#3a3a3a" metalness={0.5} />
      </mesh>
      {/* Big rear wheels */}
      {[-0.45, 0.45].map((zoff, i) => (
        <mesh
          key={`rw${i}`}
          position={[-0.35, 0.4, zoff]}
          rotation={[0, 0, Math.PI / 2]}
          castShadow
        >
          <cylinderGeometry args={[0.4, 0.4, 0.16, 14]} />
          <meshStandardMaterial color="#1a1a1a" />
        </mesh>
      ))}
      {/* Smaller front wheels */}
      {[-0.4, 0.4].map((zoff, i) => (
        <mesh
          key={`fw${i}`}
          position={[0.55, 0.25, zoff]}
          rotation={[0, 0, Math.PI / 2]}
          castShadow
        >
          <cylinderGeometry args={[0.22, 0.22, 0.12, 12]} />
          <meshStandardMaterial color="#1a1a1a" />
        </mesh>
      ))}
      {/* Headlights — small yellow blocks on the front */}
      <mesh position={[0.86, 0.6, -0.22]}>
        <boxGeometry args={[0.04, 0.08, 0.08]} />
        <meshStandardMaterial color="#fff4c0" emissive="#fff4c0" emissiveIntensity={0.4} />
      </mesh>
      <mesh position={[0.86, 0.6, 0.22]}>
        <boxGeometry args={[0.04, 0.08, 0.08]} />
        <meshStandardMaterial color="#fff4c0" emissive="#fff4c0" emissiveIntensity={0.4} />
      </mesh>
    </group>
  );
}

// Cow — boxy white body with black patches, head with small horns,
// four short legs, tail.
function Cow({
  x,
  z,
  rotation = 0,
}: {
  x: number;
  z: number;
  rotation?: number;
}) {
  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      {/* Body */}
      <mesh position={[0, 0.55, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.95, 0.55, 0.45]} />
        <meshStandardMaterial color="#f4f1de" />
      </mesh>
      {/* Black patches — two darker boxes overlaid on the body */}
      <mesh position={[0.15, 0.6, 0.226]}>
        <boxGeometry args={[0.28, 0.30, 0.01]} />
        <meshStandardMaterial color="#1a1a1a" />
      </mesh>
      <mesh position={[-0.3, 0.5, -0.226]}>
        <boxGeometry args={[0.32, 0.32, 0.01]} />
        <meshStandardMaterial color="#1a1a1a" />
      </mesh>
      {/* Head */}
      <mesh position={[0.55, 0.65, 0]} castShadow>
        <boxGeometry args={[0.3, 0.32, 0.35]} />
        <meshStandardMaterial color="#f4f1de" />
      </mesh>
      {/* Snout — slightly pink */}
      <mesh position={[0.72, 0.6, 0]}>
        <boxGeometry args={[0.06, 0.18, 0.22]} />
        <meshStandardMaterial color="#e8b8b0" />
      </mesh>
      {/* Eyes */}
      <mesh position={[0.71, 0.74, 0.11]}>
        <sphereGeometry args={[0.03, 6, 6]} />
        <meshBasicMaterial color="#1a1a1a" />
      </mesh>
      <mesh position={[0.71, 0.74, -0.11]}>
        <sphereGeometry args={[0.03, 6, 6]} />
        <meshBasicMaterial color="#1a1a1a" />
      </mesh>
      {/* Ears */}
      <mesh position={[0.55, 0.85, 0.18]} rotation={[0.3, 0, 0]}>
        <boxGeometry args={[0.08, 0.08, 0.04]} />
        <meshStandardMaterial color="#f4f1de" />
      </mesh>
      <mesh position={[0.55, 0.85, -0.18]} rotation={[-0.3, 0, 0]}>
        <boxGeometry args={[0.08, 0.08, 0.04]} />
        <meshStandardMaterial color="#f4f1de" />
      </mesh>
      {/* Horns — small white nubs */}
      <mesh position={[0.5, 0.92, 0.10]}>
        <coneGeometry args={[0.025, 0.10, 5]} />
        <meshStandardMaterial color="#dcd0a8" />
      </mesh>
      <mesh position={[0.5, 0.92, -0.10]}>
        <coneGeometry args={[0.025, 0.10, 5]} />
        <meshStandardMaterial color="#dcd0a8" />
      </mesh>
      {/* Four legs */}
      {[
        [-0.35, 0.18],
        [-0.35, -0.18],
        [0.30, 0.18],
        [0.30, -0.18],
      ].map(([lx, lz], i) => (
        <mesh key={i} position={[lx, 0.15, lz]} castShadow>
          <boxGeometry args={[0.12, 0.30, 0.12]} />
          <meshStandardMaterial color="#1a1a1a" />
        </mesh>
      ))}
      {/* Tail */}
      <mesh position={[-0.5, 0.55, 0]} rotation={[0, 0, -0.3]}>
        <boxGeometry args={[0.05, 0.32, 0.05]} />
        <meshStandardMaterial color="#f4f1de" />
      </mesh>
      <mesh position={[-0.58, 0.38, 0]}>
        <sphereGeometry args={[0.04, 6, 6]} />
        <meshStandardMaterial color="#1a1a1a" />
      </mesh>
    </group>
  );
}

// Chicken — small body, red comb, beak, two legs.
function Chicken({
  x,
  z,
  rotation = 0,
  color = "#f4f1de",
}: {
  x: number;
  z: number;
  rotation?: number;
  color?: string;
}) {
  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      {/* Body */}
      <mesh position={[0, 0.22, 0]} castShadow>
        <sphereGeometry args={[0.16, 10, 8]} />
        <meshStandardMaterial color={color} />
      </mesh>
      {/* Tail feathers */}
      <mesh position={[-0.15, 0.28, 0]} rotation={[0, 0, 0.5]}>
        <coneGeometry args={[0.08, 0.16, 6]} />
        <meshStandardMaterial color={color} />
      </mesh>
      {/* Head */}
      <mesh position={[0.13, 0.35, 0]} castShadow>
        <sphereGeometry args={[0.09, 8, 6]} />
        <meshStandardMaterial color={color} />
      </mesh>
      {/* Comb — red ridges on top */}
      <mesh position={[0.13, 0.44, 0]}>
        <boxGeometry args={[0.06, 0.05, 0.03]} />
        <meshStandardMaterial color="#d83a3a" />
      </mesh>
      {/* Beak */}
      <mesh position={[0.21, 0.34, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[0.022, 0.06, 6]} />
        <meshStandardMaterial color="#e8a050" />
      </mesh>
      {/* Wattle — small red dangle under beak */}
      <mesh position={[0.20, 0.27, 0]}>
        <sphereGeometry args={[0.025, 6, 6]} />
        <meshStandardMaterial color="#d83a3a" />
      </mesh>
      {/* Eye */}
      <mesh position={[0.16, 0.38, 0.07]}>
        <sphereGeometry args={[0.012, 5, 5]} />
        <meshBasicMaterial color="#1a1a1a" />
      </mesh>
      <mesh position={[0.16, 0.38, -0.07]}>
        <sphereGeometry args={[0.012, 5, 5]} />
        <meshBasicMaterial color="#1a1a1a" />
      </mesh>
      {/* Legs */}
      <mesh position={[0.02, 0.06, 0.05]}>
        <cylinderGeometry args={[0.015, 0.015, 0.12, 5]} />
        <meshStandardMaterial color="#e8a050" />
      </mesh>
      <mesh position={[0.02, 0.06, -0.05]}>
        <cylinderGeometry args={[0.015, 0.015, 0.12, 5]} />
        <meshStandardMaterial color="#e8a050" />
      </mesh>
    </group>
  );
}

// Turkey — bigger than chicken, with a tan body and a fanned tail
// of darker brown feathers.
function Turkey({
  x,
  z,
  rotation = 0,
}: {
  x: number;
  z: number;
  rotation?: number;
}) {
  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      {/* Body */}
      <mesh position={[0, 0.3, 0]} castShadow>
        <sphereGeometry args={[0.22, 10, 8]} />
        <meshStandardMaterial color="#7a4a2a" />
      </mesh>
      {/* Fanned tail — large flat fan behind the body */}
      <mesh position={[-0.2, 0.4, 0]} rotation={[0, 0, 0.3]}>
        <cylinderGeometry args={[0.32, 0.32, 0.04, 14, 1, false, -Math.PI / 2, Math.PI]} />
        <meshStandardMaterial color="#5a3a18" side={THREE.DoubleSide} />
      </mesh>
      {/* Tail feather ribs — lighter colour stripes */}
      {[-0.5, -0.2, 0.1, 0.4, 0.7].map((a, i) => (
        <mesh
          key={i}
          position={[-0.2 + Math.cos(Math.PI + a) * 0.18, 0.4 + Math.sin(Math.PI + a) * 0.18, 0]}
          rotation={[0, 0, Math.PI + a]}
        >
          <boxGeometry args={[0.18, 0.02, 0.03]} />
          <meshStandardMaterial color="#a8783a" />
        </mesh>
      ))}
      {/* Neck */}
      <mesh position={[0.15, 0.42, 0]} rotation={[0, 0, -0.4]}>
        <cylinderGeometry args={[0.05, 0.07, 0.18, 8]} />
        <meshStandardMaterial color="#7a4a2a" />
      </mesh>
      {/* Head */}
      <mesh position={[0.27, 0.50, 0]} castShadow>
        <sphereGeometry args={[0.08, 8, 6]} />
        <meshStandardMaterial color="#9a5a3a" />
      </mesh>
      {/* Beak */}
      <mesh position={[0.36, 0.49, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[0.022, 0.06, 6]} />
        <meshStandardMaterial color="#e8c050" />
      </mesh>
      {/* Snood — red dangle on the head */}
      <mesh position={[0.34, 0.44, 0]}>
        <sphereGeometry args={[0.025, 6, 6]} />
        <meshStandardMaterial color="#d83a3a" />
      </mesh>
      {/* Eyes */}
      <mesh position={[0.30, 0.53, 0.06]}>
        <sphereGeometry args={[0.012, 5, 5]} />
        <meshBasicMaterial color="#1a1a1a" />
      </mesh>
      <mesh position={[0.30, 0.53, -0.06]}>
        <sphereGeometry args={[0.012, 5, 5]} />
        <meshBasicMaterial color="#1a1a1a" />
      </mesh>
      {/* Legs */}
      <mesh position={[0, 0.07, 0.06]}>
        <cylinderGeometry args={[0.02, 0.02, 0.14, 5]} />
        <meshStandardMaterial color="#e8a050" />
      </mesh>
      <mesh position={[0, 0.07, -0.06]}>
        <cylinderGeometry args={[0.02, 0.02, 0.14, 5]} />
        <meshStandardMaterial color="#e8a050" />
      </mesh>
    </group>
  );
}

// Goat — smaller than cow, light-grey body, horns, beard.
function Goat({
  x,
  z,
  rotation = 0,
}: {
  x: number;
  z: number;
  rotation?: number;
}) {
  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      {/* Body */}
      <mesh position={[0, 0.42, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.6, 0.36, 0.3]} />
        <meshStandardMaterial color="#c8c0b0" />
      </mesh>
      {/* Head */}
      <mesh position={[0.35, 0.55, 0]} castShadow>
        <boxGeometry args={[0.22, 0.24, 0.22]} />
        <meshStandardMaterial color="#c8c0b0" />
      </mesh>
      {/* Snout */}
      <mesh position={[0.48, 0.5, 0]}>
        <boxGeometry args={[0.06, 0.10, 0.14]} />
        <meshStandardMaterial color="#a8a090" />
      </mesh>
      {/* Beard — small dangle below chin */}
      <mesh position={[0.48, 0.41, 0]}>
        <boxGeometry args={[0.03, 0.08, 0.04]} />
        <meshStandardMaterial color="#f4f1de" />
      </mesh>
      {/* Horns — curved back */}
      <mesh position={[0.32, 0.72, 0.08]} rotation={[0, 0, -0.5]}>
        <coneGeometry args={[0.025, 0.16, 6]} />
        <meshStandardMaterial color="#3a2a18" />
      </mesh>
      <mesh position={[0.32, 0.72, -0.08]} rotation={[0, 0, -0.5]}>
        <coneGeometry args={[0.025, 0.16, 6]} />
        <meshStandardMaterial color="#3a2a18" />
      </mesh>
      {/* Ears */}
      <mesh position={[0.30, 0.68, 0.14]} rotation={[0, 0, 0.2]}>
        <boxGeometry args={[0.04, 0.08, 0.03]} />
        <meshStandardMaterial color="#c8c0b0" />
      </mesh>
      <mesh position={[0.30, 0.68, -0.14]} rotation={[0, 0, 0.2]}>
        <boxGeometry args={[0.04, 0.08, 0.03]} />
        <meshStandardMaterial color="#c8c0b0" />
      </mesh>
      {/* Eyes */}
      <mesh position={[0.42, 0.59, 0.075]}>
        <sphereGeometry args={[0.018, 5, 5]} />
        <meshBasicMaterial color="#1a1a1a" />
      </mesh>
      <mesh position={[0.42, 0.59, -0.075]}>
        <sphereGeometry args={[0.018, 5, 5]} />
        <meshBasicMaterial color="#1a1a1a" />
      </mesh>
      {/* Four legs */}
      {[
        [-0.20, 0.12],
        [-0.20, -0.12],
        [0.20, 0.12],
        [0.20, -0.12],
      ].map(([lx, lz], i) => (
        <mesh key={i} position={[lx, 0.12, lz]} castShadow>
          <boxGeometry args={[0.07, 0.24, 0.07]} />
          <meshStandardMaterial color="#3a2a18" />
        </mesh>
      ))}
      {/* Short tail */}
      <mesh position={[-0.34, 0.46, 0]} rotation={[0, 0, 0.3]}>
        <boxGeometry args={[0.05, 0.08, 0.05]} />
        <meshStandardMaterial color="#c8c0b0" />
      </mesh>
    </group>
  );
}

// Pig — pink body, four short legs, curly tail, big snout.
function Pig({
  x,
  z,
  rotation = 0,
}: {
  x: number;
  z: number;
  rotation?: number;
}) {
  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      {/* Body */}
      <mesh position={[0, 0.32, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.7, 0.4, 0.4]} />
        <meshStandardMaterial color="#e8a090" />
      </mesh>
      {/* Head */}
      <mesh position={[0.40, 0.36, 0]} castShadow>
        <boxGeometry args={[0.22, 0.30, 0.32]} />
        <meshStandardMaterial color="#e8a090" />
      </mesh>
      {/* Snout — flat pink disc */}
      <mesh position={[0.52, 0.32, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.09, 0.08, 0.05, 10]} />
        <meshStandardMaterial color="#d88078" />
      </mesh>
      {/* Snout nostrils — two small dark dots */}
      <mesh position={[0.555, 0.33, 0.04]}>
        <sphereGeometry args={[0.013, 5, 5]} />
        <meshBasicMaterial color="#5a3030" />
      </mesh>
      <mesh position={[0.555, 0.33, -0.04]}>
        <sphereGeometry args={[0.013, 5, 5]} />
        <meshBasicMaterial color="#5a3030" />
      </mesh>
      {/* Ears */}
      <mesh position={[0.36, 0.52, 0.14]} rotation={[0, 0, 0.3]}>
        <boxGeometry args={[0.04, 0.10, 0.05]} />
        <meshStandardMaterial color="#d88078" />
      </mesh>
      <mesh position={[0.36, 0.52, -0.14]} rotation={[0, 0, 0.3]}>
        <boxGeometry args={[0.04, 0.10, 0.05]} />
        <meshStandardMaterial color="#d88078" />
      </mesh>
      {/* Eyes */}
      <mesh position={[0.48, 0.42, 0.08]}>
        <sphereGeometry args={[0.018, 5, 5]} />
        <meshBasicMaterial color="#1a1a1a" />
      </mesh>
      <mesh position={[0.48, 0.42, -0.08]}>
        <sphereGeometry args={[0.018, 5, 5]} />
        <meshBasicMaterial color="#1a1a1a" />
      </mesh>
      {/* Four short legs */}
      {[
        [-0.22, 0.14],
        [-0.22, -0.14],
        [0.20, 0.14],
        [0.20, -0.14],
      ].map(([lx, lz], i) => (
        <mesh key={i} position={[lx, 0.08, lz]} castShadow>
          <boxGeometry args={[0.08, 0.16, 0.08]} />
          <meshStandardMaterial color="#d88078" />
        </mesh>
      ))}
      {/* Curly tail */}
      <mesh position={[-0.38, 0.42, 0]} rotation={[0, 0, 1.2]}>
        <torusGeometry args={[0.05, 0.018, 5, 10]} />
        <meshStandardMaterial color="#d88078" />
      </mesh>
    </group>
  );
}

// Scarecrow — cross-shaped wooden post with straw-stuffed clothes
// and a wide hat. Belongs in the cornfield.
function Scarecrow({
  x,
  z,
  rotation = 0,
}: {
  x: number;
  z: number;
  rotation?: number;
}) {
  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      {/* Vertical post */}
      <mesh position={[0, 0.9, 0]} castShadow>
        <boxGeometry args={[0.06, 1.8, 0.06]} />
        <meshStandardMaterial color="#6b4a2a" />
      </mesh>
      {/* Horizontal cross-arm */}
      <mesh position={[0, 1.2, 0]} castShadow>
        <boxGeometry args={[1.0, 0.05, 0.05]} />
        <meshStandardMaterial color="#6b4a2a" />
      </mesh>
      {/* Shirt — plaid (use a dull red) */}
      <mesh position={[0, 1.15, 0]} castShadow>
        <boxGeometry args={[0.9, 0.45, 0.18]} />
        <meshStandardMaterial color="#a83a3a" />
      </mesh>
      {/* Pants */}
      <mesh position={[0, 0.78, 0]} castShadow>
        <boxGeometry args={[0.35, 0.45, 0.18]} />
        <meshStandardMaterial color="#5a4a2a" />
      </mesh>
      {/* Straw hands poking out the ends of the cross-arm */}
      <mesh position={[-0.5, 1.20, 0]}>
        <sphereGeometry args={[0.07, 8, 6]} />
        <meshStandardMaterial color="#d4b878" />
      </mesh>
      <mesh position={[0.5, 1.20, 0]}>
        <sphereGeometry args={[0.07, 8, 6]} />
        <meshStandardMaterial color="#d4b878" />
      </mesh>
      {/* Head — burlap sack */}
      <mesh position={[0, 1.55, 0]} castShadow>
        <sphereGeometry args={[0.16, 10, 8]} />
        <meshStandardMaterial color="#d4b878" />
      </mesh>
      {/* Face — two button eyes + stitched mouth */}
      <mesh position={[-0.05, 1.58, 0.14]}>
        <boxGeometry args={[0.025, 0.025, 0.01]} />
        <meshBasicMaterial color="#1a1a1a" />
      </mesh>
      <mesh position={[0.05, 1.58, 0.14]}>
        <boxGeometry args={[0.025, 0.025, 0.01]} />
        <meshBasicMaterial color="#1a1a1a" />
      </mesh>
      <mesh position={[0, 1.48, 0.14]}>
        <boxGeometry args={[0.06, 0.012, 0.01]} />
        <meshBasicMaterial color="#1a1a1a" />
      </mesh>
      {/* Hat — wide brim + crown (straw colour) */}
      <mesh position={[0, 1.75, 0]} castShadow>
        <cylinderGeometry args={[0.30, 0.30, 0.025, 12]} />
        <meshStandardMaterial color="#b89060" />
      </mesh>
      <mesh position={[0, 1.83, 0]} castShadow>
        <cylinderGeometry args={[0.13, 0.16, 0.14, 12]} />
        <meshStandardMaterial color="#b89060" />
      </mesh>
      {/* Hat band */}
      <mesh position={[0, 1.78, 0]}>
        <cylinderGeometry args={[0.165, 0.165, 0.025, 12]} />
        <meshStandardMaterial color="#3a2a18" />
      </mesh>
    </group>
  );
}

// Corn stalk — vertical stick with leaves and a yellow cob.
// Cheap to draw, used many times in the corn field.
function CornStalk({
  x,
  z,
  scale = 1,
}: {
  x: number;
  z: number;
  scale?: number;
}) {
  return (
    <group position={[x, 0, z]} scale={scale}>
      {/* Stalk */}
      <mesh position={[0, 0.55, 0]} castShadow>
        <cylinderGeometry args={[0.03, 0.035, 1.1, 5]} />
        <meshStandardMaterial color="#5fa838" />
      </mesh>
      {/* Two leaves */}
      <mesh position={[0.10, 0.7, 0]} rotation={[0, 0, -0.5]}>
        <boxGeometry args={[0.22, 0.05, 0.03]} />
        <meshStandardMaterial color="#5fa838" />
      </mesh>
      <mesh position={[-0.10, 0.5, 0.05]} rotation={[0.3, 0, 0.6]}>
        <boxGeometry args={[0.20, 0.04, 0.03]} />
        <meshStandardMaterial color="#5fa838" />
      </mesh>
      {/* Corn cob — bright yellow at the top */}
      <mesh position={[0.06, 0.85, 0]} rotation={[0, 0, -0.3]}>
        <cylinderGeometry args={[0.04, 0.05, 0.16, 6]} />
        <meshStandardMaterial color="#f4d83a" />
      </mesh>
      {/* Tassel — small spike on top */}
      <mesh position={[0, 1.14, 0]} castShadow>
        <coneGeometry args={[0.03, 0.12, 5]} />
        <meshStandardMaterial color="#c8b878" />
      </mesh>
    </group>
  );
}

// Small windmill (well-pump style) — tall tower + rotating blades.
function Windmill({
  x,
  z,
  rotation = 0,
}: {
  x: number;
  z: number;
  rotation?: number;
}) {
  const bladesRef = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (bladesRef.current) bladesRef.current.rotation.z += dt * 0.6;
  });
  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      {/* Tower — four-legged steel frame, drawn as a tapered cone */}
      <mesh position={[0, 1.6, 0]} castShadow>
        <cylinderGeometry args={[0.05, 0.32, 3.2, 4]} />
        <meshStandardMaterial color="#6e6a5e" wireframe />
      </mesh>
      {/* Solid centre pole for the rotor to mount on */}
      <mesh position={[0, 1.6, 0]} castShadow>
        <cylinderGeometry args={[0.04, 0.04, 3.2, 6]} />
        <meshStandardMaterial color="#6e6a5e" />
      </mesh>
      {/* Hub — the rotor body at the top */}
      <mesh position={[0, 3.3, 0]} castShadow>
        <cylinderGeometry args={[0.08, 0.08, 0.2, 12]} />
        <meshStandardMaterial color="#3e3a30" />
      </mesh>
      {/* Tail vane — points to wind direction */}
      <mesh position={[-0.4, 3.3, 0]}>
        <boxGeometry args={[0.45, 0.25, 0.02]} />
        <meshStandardMaterial color="#a83a3a" side={THREE.DoubleSide} />
      </mesh>
      {/* Rotating blade assembly */}
      <group ref={bladesRef} position={[0, 3.3, 0.12]}>
        {Array.from({ length: 8 }).map((_, i) => {
          const a = (i / 8) * Math.PI * 2;
          return (
            <mesh
              key={i}
              position={[Math.cos(a) * 0.24, Math.sin(a) * 0.24, 0]}
              rotation={[0, 0, a + Math.PI / 2]}
              castShadow
            >
              <boxGeometry args={[0.10, 0.42, 0.02]} />
              <meshStandardMaterial color="#dcd0a8" />
            </mesh>
          );
        })}
      </group>
    </group>
  );
}

// Single rail-fence section — two horizontal rails on two posts.
// Length is along x; rotate via prop to lay it east-west, etc.
function FenceSection({
  x,
  z,
  rotation = 0,
  length = 2,
}: {
  x: number;
  z: number;
  rotation?: number;
  length?: number;
}) {
  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      {/* Two posts at the ends */}
      <mesh position={[-length / 2, 0.36, 0]} castShadow>
        <boxGeometry args={[0.07, 0.72, 0.07]} />
        <meshStandardMaterial color="#6b4a2a" />
      </mesh>
      <mesh position={[length / 2, 0.36, 0]} castShadow>
        <boxGeometry args={[0.07, 0.72, 0.07]} />
        <meshStandardMaterial color="#6b4a2a" />
      </mesh>
      {/* Two rails between them */}
      <mesh position={[0, 0.55, 0]} castShadow>
        <boxGeometry args={[length, 0.05, 0.04]} />
        <meshStandardMaterial color="#8a6a3a" />
      </mesh>
      <mesh position={[0, 0.28, 0]} castShadow>
        <boxGeometry args={[length, 0.05, 0.04]} />
        <meshStandardMaterial color="#8a6a3a" />
      </mesh>
    </group>
  );
}

// Single low-poly mountain — a flat-shaded cone with an optional
// snow cap. The snow cap covers the top ~35% of the peak and
// slightly bulges past the cone's slope so it reads as a layer of
// snow sitting on the rock rather than the cone narrowing to a
// white tip. Bigger / wider than `Hill`; used to form the northern
// ridge.
function Mountain({
  x,
  z,
  height,
  baseRadius,
  color = "#4a5a48",
  snow = false,
  segments = 8,
}: {
  x: number;
  z: number;
  height: number;
  baseRadius: number;
  color?: string;
  snow?: boolean;
  segments?: number;
}) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, height / 2, 0]} castShadow receiveShadow>
        <coneGeometry args={[baseRadius, height, segments]} />
        <meshStandardMaterial color={color} flatShading />
      </mesh>
      {snow && (
        <mesh position={[0, height * 0.825, 0]} castShadow>
          <coneGeometry
            args={[baseRadius * 0.4, height * 0.35, segments]}
          />
          <meshStandardMaterial color="#f4f6f8" flatShading />
        </mesh>
      )}
    </group>
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
      // The body geometry is elongated along local +X, so the bird
      // naturally "faces" +X. Flip 180° for birds moving the other
      // way so the head stays at the leading edge.
      root.current.rotation.y = speed > 0 ? 0 : Math.PI;
      startedRef.current = true;
    }
    root.current.position.x += speed * dt;
    // Wrap around the world so the birds keep cycling
    if (root.current.position.x > 38) root.current.position.x = -38;
    if (root.current.position.x < -38) root.current.position.x = 38;
    // A little vertical bob
    root.current.position.y =
      y + Math.sin(state.clock.elapsedTime * 1.8 + flapPhase) * 0.18;
    // Wings flap — rotate around the BODY's long axis (local X) so
    // the wing tips trace an up/down arc. Rotating around Z (the
    // wing's length axis) was the previous bug, which just spun the
    // wings around their own length without ever flapping them.
    const flap = Math.sin(state.clock.elapsedTime * 9 + flapPhase) * 0.9;
    if (leftWing.current) leftWing.current.rotation.x = flap;
    if (rightWing.current) rightWing.current.rotation.x = -flap;
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
    <group position={[PARK.x, 0, PARK.z]} scale={PARK_SCALE}>
      {/* Park ground patch — sandy/dirt, makes the area read as a fairground.
          The whole patch is clickable so the user can click anywhere on the
          park to send the character over (not just the ticket booth). */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.015, 0]}
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
    <group ref={ref} scale={PARK_SCALE}>
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

// FaceBillboard — a textured plane displaying Sonny's actual face photo.
//
// Two rotation modes, switched per frame based on c.mode:
//   * default: BILLBOARD — the plane is rotated so its front (+Z) faces
//     the camera, no matter which way the body is turned. Walking adds a
//     side-to-side bobblehead tilt synced to the step cycle.
//   * riding:  LOCKED — the local rotation is cleared so the face plane
//     inherits the body's rotation. Since the body's angle on the
//     coaster matches the cart's tangent direction, the face ends up
//     pointing in the direction the cart is moving (instead of staring
//     at the camera through the back of the cart's seat).
function FaceBillboard({
  charRef,
  balloonRef,
}: {
  charRef: React.MutableRefObject<CharState>;
  balloonRef: React.MutableRefObject<BalloonState>;
}) {
  // Three face textures swapped per frame based on game state:
  //   * front  — default
  //   * back   — when walking away from the camera (camera mostly
  //              behind the character; e.g., the follow cam during
  //              a click-driven walk to a building)
  //   * scared — full balloon-ride sequence + the gator chase
  const [texFront, texBack, texScared] = useTexture([
    "/face.png",
    "/face-back.png",
    "/face-scared.png",
  ]);
  // The back/scared photos came in less saturated than the
  // photo-edited front face. Punch up contrast + saturation once
  // via a canvas filter so all three textures read with similar
  // vibrance on the billboard. Done as a load-time effect so we
  // don't pay a per-frame cost.
  useEffect(() => {
    for (const tex of [texBack, texScared]) {
      const img = tex.image as HTMLImageElement | undefined;
      if (!img || !img.width || !img.height) continue;
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.filter = "saturate(1.2) contrast(1.18) brightness(1.04)";
      ctx.drawImage(img, 0, 0);
      tex.image = canvas;
      tex.needsUpdate = true;
    }
  }, [texBack, texScared]);
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  // Scratch vectors so we don't allocate every frame.
  const meshWorld = useMemo(() => new THREE.Vector3(), []);
  const lookTarget = useMemo(() => new THREE.Vector3(), []);

  useFrame((state) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const c = charRef.current;

    // Pick which face texture to show this frame.
    let wantTex: THREE.Texture = texFront;
    if (c.mode === "ballooning" || c.mode === "flee") {
      // Scared face through the full balloon sequence (rising →
      // scared → jumping → rolling) and the entire gator chase.
      wantTex = texScared;
    } else if (c.walking) {
      // Back of head when the character is walking AWAY from the
      // camera. "Away" = the character's facing direction has a
      // strong positive component along the camera→character vector
      // (i.e., the camera is roughly behind them). Threshold of
      // 0.25 keeps the back-of-head only when clearly facing away,
      // so mostly-sideways angles still show the front face.
      const camToCharX = c.x - state.camera.position.x;
      const camToCharZ = c.z - state.camera.position.z;
      const ccLen = Math.hypot(camToCharX, camToCharZ);
      if (ccLen > 0.001) {
        const dot =
          (Math.sin(c.angle) * camToCharX +
            Math.cos(c.angle) * camToCharZ) /
          ccLen;
        if (dot > 0.25) wantTex = texBack;
      }
    }
    if (matRef.current && matRef.current.map !== wantTex) {
      matRef.current.map = wantTex;
      matRef.current.needsUpdate = true;
    }

    if (c.mode === "riding") {
      // Locked to body rotation — clear local rotation so the face
      // inherits whatever direction the body is facing (= cart tangent).
      mesh.rotation.set(0, 0, 0);
    } else {
      // Billboard behavior: aim the plane's local -Z away from the
      // camera so its +Z (the textured front face) ends up pointing
      // at the camera.
      mesh.getWorldPosition(meshWorld);
      lookTarget.copy(meshWorld).multiplyScalar(2).sub(state.camera.position);
      mesh.lookAt(lookTarget);

      // Bobblehead rock — side-to-side tilt synced to the step cycle.
      // Layered on top of the billboard rotation as a local Z roll.
      if (c.walking) {
        mesh.rotation.z += Math.sin(c.stepPhase * Math.PI * 2) * 0.22;
      }

      // Scared shake during the balloon ride's scared phase — quick
      // side-to-side tremor of the head to read as panic.
      const b = balloonRef.current;
      if (c.mode === "ballooning" && b.phase === "scared") {
        mesh.rotation.z += Math.sin(state.clock.elapsedTime * 36) * 0.08;
      }
    }
  });

  return (
    <mesh ref={meshRef}>
      <planeGeometry args={[0.85, 0.9]} />
      <meshBasicMaterial
        ref={matRef}
        map={texFront}
        transparent
        toneMapped={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function Character({
  charRef,
  golfRef,
  balloonRef,
}: {
  charRef: React.MutableRefObject<CharState>;
  golfRef: React.MutableRefObject<GolfState>;
  balloonRef: React.MutableRefObject<BalloonState>;
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
      // y is driven by the game tick for ride (track height), golf
      // (celebration jumps), and ballooning (rising / falling); zero on
      // foot otherwise. While riding, lower the character so the hips
      // (at body-local y=0.66) sit on the cart's top surface
      // (cart-local y=0.36 × PARK_SCALE) rather than standing on top.
      rootRef.current.position.y =
        c.mode === "riding"
          ? c.y + 0.36 * PARK_SCALE - 0.66
          : c.mode === "golfing" || c.mode === "ballooning"
          ? c.y
          : 0;
      // Smoothly rotate to face direction. Snap during ride / golf /
      // ballooning so we always match the expected heading.
      const cur = rootRef.current.rotation.y;
      let diff = c.angle - cur;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      rootRef.current.rotation.y =
        c.mode === "riding" ||
        c.mode === "golfing" ||
        c.mode === "ballooning"
          ? c.angle
          : cur + diff * 0.2;
      // Forward roll: during the rolling phase of the balloon easter
      // egg, tumble the entire character around its local X axis
      // (head-over-heels in the direction of motion). Otherwise clear
      // any leftover rotation.x.
      const b = balloonRef.current;
      if (c.mode === "ballooning" && b.phase === "rolling") {
        rootRef.current.rotation.x = b.t * Math.PI * 2; // one full rev
      } else {
        rootRef.current.rotation.x = 0;
      }
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

    if (c.mode === "ballooning") {
      const b = balloonRef.current;
      // Arms react to the phase: gripping the basket while rising,
      // flailing during the scared/jump beats, tucked during the roll.
      let armX = 0;
      if (b.phase === "rising") {
        // Light grip on the basket — arms slightly forward & down.
        armX = -0.35;
      } else if (b.phase === "scared") {
        // Both hands fly UP — "uh oh I'm too high".
        armX = -Math.PI * 0.7;
      } else if (b.phase === "jumping") {
        // Mid-air flail — arms out for balance.
        armX = -Math.PI * 0.5;
      } else if (b.phase === "rolling") {
        // Tucked in for the roll.
        armX = -2.2;
      }
      if (leftShoulderRef.current) {
        leftShoulderRef.current.rotation.x = armX;
        leftShoulderRef.current.rotation.z = 0;
      }
      if (rightShoulderRef.current) {
        rightShoulderRef.current.rotation.x = armX;
        rightShoulderRef.current.rotation.z = 0;
      }
      // Legs: tuck the knees up during the roll (curls body into ball);
      // otherwise standing.
      let hipX = 0;
      if (b.phase === "rolling") {
        // Knees up tight to chest. -π/2 = legs out front (sitting); we
        // want even more, like -2.2 (knees in toward chest).
        hipX = -2.2;
      }
      if (leftHipRef.current) leftHipRef.current.rotation.x = hipX;
      if (rightHipRef.current) rightHipRef.current.rotation.x = hipX;
      // Body bend: during the roll, the body tucks forward (bending at
      // the waist) so the character rolls AS A BALL instead of rotating
      // rigidly. Ramp into the tuck at the start of the roll and
      // straighten back up at the end.
      if (bodyRef.current) {
        let bend = 0;
        if (b.phase === "rolling") {
          if (b.t < 0.18) bend = (b.t / 0.18) * (Math.PI / 2); // ramp to π/2
          else if (b.t < 0.82) bend = Math.PI / 2; // hold tucked
          else bend = ((1 - b.t) / 0.18) * (Math.PI / 2); // unbend
        }
        bodyRef.current.rotation.x = bend;
        bodyRef.current.position.y = 0;
      }
      return;
    }

    if (c.mode === "golfing") {
      const gt = golfRef.current.t;
      // PUTT (not a full swing): small, controlled back-and-forth
      // around the spine axis. rotation.z positive = backswing (small
      // tap back); negative = forward stroke through impact. The
      // celebration phase still throws the arms way up.
      //   address  (0..0.18): hands centred over the ball (0)
      //   backswing(0.18..0.30): small tap back (+0.55)
      //   stroke   (0.30..0.36): forward putt to follow-through (-0.45)
      //   follow   (0.36..0.55): hold the follow-through
      //   celebrate(0.55..0.88): arms thrown up — ball dropped
      //   relax    (0.88..1.00): drop arms back to sides
      let swingZ = 0;
      if (gt < 0.18) {
        swingZ = 0; // address — hands centred over the ball
      } else if (gt < 0.30) {
        const p = (gt - 0.18) / 0.12;
        swingZ = p * 0.55; // small back-tap
      } else if (gt < 0.36) {
        const p = (gt - 0.30) / 0.06;
        // Forward stroke: from +0.55 through impact (0 at p≈0.55)
        // to -0.45 follow-through. Ball roll starts at gt=0.35
        // (p≈0.83) which is just past impact.
        swingZ = 0.55 - p * 1.0;
      } else if (gt < 0.55) {
        swingZ = -0.45; // hold follow-through
      } else if (gt < 0.88) {
        const wave = Math.sin(t * 9) * 0.25;
        swingZ = -Math.PI * 0.8 + wave; // celebrate
      } else {
        const p = (gt - 0.88) / 0.12;
        swingZ = -Math.PI * 0.8 + p * Math.PI * 0.8; // ease back to 0
      }
      // Two-handed grip (same as before) — hands stay near the
      // centreline of the body while putting.
      const INWARD = 0.42;
      if (leftShoulderRef.current) {
        leftShoulderRef.current.rotation.x = 0;
        leftShoulderRef.current.rotation.z = swingZ + INWARD;
      }
      if (rightShoulderRef.current) {
        rightShoulderRef.current.rotation.x = 0;
        rightShoulderRef.current.rotation.z = swingZ - INWARD;
      }
      if (clubHolderRef.current) {
        clubHolderRef.current.rotation.x = 0;
        clubHolderRef.current.rotation.z = swingZ;
      }
      if (leftHipRef.current) leftHipRef.current.rotation.x = 0;
      if (rightHipRef.current) rightHipRef.current.rotation.x = 0;
      // Deeper forward bend over the ball — putters hunch over more
      // than a full-swing golfer.
      if (bodyRef.current) {
        if (gt < 0.4) bodyRef.current.rotation.x = 0.45;
        else if (gt < 0.55) bodyRef.current.rotation.x = 0.35;
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

        {/* Chest V — visible skin in the kimono's neckline opening,
            framed by the two crossed lapels below. */}
        <mesh position={[0, 1.18, 0.162]}>
          <planeGeometry args={[0.14, 0.20]} />
          <meshStandardMaterial color={SKIN} />
        </mesh>

        {/* Left lapel — angled from upper-left collar down toward
            the centre of the waist (where the right lapel meets it,
            forming the kimono's classic V). Slightly darker than
            the gi body + raised forward so the lapel reads as a
            separate piece of fabric. */}
        <mesh position={[-0.11, 1.04, 0.169]} rotation={[0, 0, 0.4]}>
          <boxGeometry args={[0.11, 0.46, 0.025]} />
          <meshStandardMaterial color={GI_SHADE} />
        </mesh>
        {/* Right lapel — mirrored, slightly more forward in z so it
            visibly overlaps the left lapel at the bottom (kimono's
            "left over right" close at the waist). */}
        <mesh position={[0.11, 1.04, 0.172]} rotation={[0, 0, -0.4]}>
          <boxGeometry args={[0.11, 0.46, 0.025]} />
          <meshStandardMaterial color={GI_SHADE} />
        </mesh>

        {/* Dark piping along the inner edge of each lapel — reads as
            stitched lapel trim, helps separate the lapels from the
            gi body. */}
        <mesh position={[-0.06, 1.06, 0.185]} rotation={[0, 0, 0.4]}>
          <boxGeometry args={[0.018, 0.46, 0.005]} />
          <meshStandardMaterial color="#9c9580" />
        </mesh>
        <mesh position={[0.06, 1.06, 0.187]} rotation={[0, 0, -0.4]}>
          <boxGeometry args={[0.018, 0.46, 0.005]} />
          <meshStandardMaterial color="#9c9580" />
        </mesh>

        {/* Belt */}
        <mesh position={[0, 0.71, 0]} castShadow>
          <boxGeometry args={[0.58, 0.10, 0.34]} />
          <meshStandardMaterial color={BELT} />
        </mesh>
        {/* Belt knot — slightly raised square at the front centre */}
        <mesh position={[0, 0.71, 0.18]} castShadow>
          <boxGeometry args={[0.10, 0.13, 0.05]} />
          <meshStandardMaterial color={BELT} />
        </mesh>
        {/* Belt ends — two short strips hanging from the knot, one
            angled so it doesn't sit perfectly straight (looks tied
            rather than glued on). */}
        <mesh position={[-0.025, 0.55, 0.195]} rotation={[0, 0, 0.08]}>
          <boxGeometry args={[0.045, 0.20, 0.02]} />
          <meshStandardMaterial color={BELT} />
        </mesh>
        <mesh position={[0.04, 0.56, 0.195]} rotation={[0, 0, -0.15]}>
          <boxGeometry args={[0.045, 0.18, 0.02]} />
          <meshStandardMaterial color={BELT} />
        </mesh>

        {/* Face — Sonny's actual photo on a plane positioned where the
            old bald head was. FaceBillboard manages its own rotation
            internally: billboards to the camera most of the time, but
            locks to body rotation while riding the coaster so the face
            points down the track. */}
        <group position={[0, 1.45, 0]}>
          <FaceBillboard charRef={charRef} balloonRef={balloonRef} />
        </group>

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
            {/* Putter head — long, low blade with a flat face. */}
            <group position={[0.02, -1.05, 0.04]}>
              <mesh castShadow>
                <boxGeometry args={[0.22, 0.04, 0.08]} />
                <meshStandardMaterial color="#9aa0a4" metalness={0.7} roughness={0.35} />
              </mesh>
              {/* Sole — thin darker strip along the bottom */}
              <mesh position={[0, -0.025, 0]}>
                <boxGeometry args={[0.22, 0.01, 0.09]} />
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
const CAM_DEFAULT = { x: 0, y: 20, z: 25 };

// ── Drone tour ─────────────────────────────────────────────────────
// When the user is idle for a moment, the camera flies between named
// "waypoints" around the world, dwelling on each long enough for a
// slow rotation before quickly transitioning to the next. Each
// waypoint has a `target` (what the camera looks at) and a
// `camOffset` (initial position relative to target — the rotation
// during dwell sweeps this offset around the target's Y axis).
const DRONE_TRANSITION_S = 2.5;
const DRONE_DWELL_S = 7.0;
const DRONE_DWELL_ROT_SPEED = 0.18; // radians per second
// Any pointer/wheel/touch input pauses the drone for this long, so
// the user can take over the camera and look around freely.
const DRONE_INPUT_PAUSE_S = 10;
// When the drone resumes (or enters a fresh dwell phase), the rotation
// speed eases from 0 up to DRONE_DWELL_ROT_SPEED over this duration —
// no sudden snap into motion after the pause.
const DRONE_DWELL_RAMP_S = 1.5;
const DRONE_TOUR: { name: string; target: THREE.Vector3; camOffset: THREE.Vector3 }[] = [
  // Plaza overview — buildings + character on the central plaza
  { name: "plaza", target: new THREE.Vector3(0, 2, 0), camOffset: new THREE.Vector3(0, 12, 16) },
  // Amusement park — coaster + carousel + ferris wheel
  { name: "park", target: new THREE.Vector3(-17, 5, -19), camOffset: new THREE.Vector3(22, 16, 20) },
  // Lake & alligator
  { name: "lake", target: new THREE.Vector3(11.5, 1, -8), camOffset: new THREE.Vector3(8, 6, 9) },
  // Hot-air balloon
  { name: "balloon", target: new THREE.Vector3(10, 4, 6), camOffset: new THREE.Vector3(7, 5, 8) },
  // Farm — animals + corn + tractor. Vantage matches the angle
  // a rider on the coaster (north-west, elevated) would have when
  // looking south at the farm: camera sits north + slightly west
  // of the farm, ~12 units up, peering down the long axis toward
  // the farmhouse cluster.
  { name: "farm", target: new THREE.Vector3(-6, 4, 48), camOffset: new THREE.Vector3(-5, 20, -30) },
  // Golf course
  { name: "golf", target: new THREE.Vector3(-14, 2, 17), camOffset: new THREE.Vector3(10, 8, 12) },
];

// Midpoint between tee and hole — the focal point during the golf swing so
// both the character (right of frame) and the cup (left of frame) are visible
// while the ball flies between them.
// Midpoint of the BALL's roll (not the character's stance) — the
// camera target follows this so the ball stays in frame as it rolls.
const GOLF_MIDPOINT = {
  x: (GOLF_BALL_START.x + GOLF_HOLE.x) / 2,
  z: (GOLF_BALL_START.z + GOLF_HOLE.z) / 2,
};

function CameraRig({
  charRef,
  gatorRef,
  pathname,
}: {
  charRef: React.MutableRefObject<CharState>;
  gatorRef: React.MutableRefObject<GatorState>;
  pathname: string;
}) {
  const targetVec = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const controlsRef = useRef<React.ComponentRef<typeof OrbitControls>>(null);
  // Tracks whether a special mode has hijacked the camera position. Set on
  // entry to riding/golfing; cleared once the camera has glided back close
  // to CAM_DEFAULT. Used so the post-ride walk-back gets a camera return.
  const camHijackedRef = useRef(false);

  // Drone tour state (idle waypoint-by-waypoint world tour).
  const droneActiveRef = useRef(false);
  const droneStateRef = useRef<"transitioning" | "dwelling">("transitioning");
  const droneIdxRef = useRef(0);
  const dronePhaseStartRef = useRef(0);
  const dronePrevPosRef = useRef(new THREE.Vector3());
  const dronePrevTargetRef = useRef(new THREE.Vector3());
  // Accumulated dwell-rotation angle. Integrated from a speed that
  // eases up from 0 to DRONE_DWELL_ROT_SPEED, so the rotation never
  // snaps into full speed (especially noticeable when resuming after
  // a user-input pause).
  const dwellAngleRef = useRef(0);
  // Wall-clock timestamp (seconds) of the last user input. The drone
  // tour stays paused until DRONE_INPUT_PAUSE_S have elapsed since
  // this — meaning any click, drag, or wheel hands control back to
  // the user for at least 10s before the drone resumes.
  const lastInputTimeRef = useRef(0);

  useEffect(() => {
    const bump = () => {
      lastInputTimeRef.current = performance.now() / 1000;
    };
    window.addEventListener("pointerdown", bump);
    window.addEventListener("wheel", bump, { passive: true });
    window.addEventListener("touchstart", bump, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", bump);
      window.removeEventListener("wheel", bump);
      window.removeEventListener("touchstart", bump);
    };
  }, []);

  useFrame((state, dt) => {
    const c = charRef.current;

    // ── Target ────────────────────────────────────────────────────────────
    // OrbitControls .target lerps toward the character whenever they're
    // moving or locked in a special mode. For golfing we instead focus on
    // the midpoint between the tee and the hole so the ball flight stays
    // framed. Otherwise the target glides back to the plaza.
    const isIdleForTarget =
      c.mode === "idle" && !c.walking && !camHijackedRef.current;
    let wantTX = 0;
    let wantTZ = 0;
    let wantTY = 1;
    if (c.mode === "golfing") {
      wantTX = GOLF_MIDPOINT.x;
      wantTZ = GOLF_MIDPOINT.z;
      wantTY = 1;
    } else if (c.mode === "riding") {
      // Lock the target to the park centre (slightly elevated to
      // include the loop) so the fixed cinematic vantage frames the
      // whole coaster instead of panning around with the cart.
      wantTX = PARK.x;
      wantTZ = PARK.z;
      wantTY = 5;
    } else if (
      c.walking ||
      c.mode === "flee" ||
      c.mode === "ballooning"
    ) {
      wantTX = c.x;
      wantTZ = c.z;
      // Ballooning tracks the rider's height 1:1 so the face stays
      // dead-center as the balloon rises (vs. only halfway for other
      // modes where the character barely leaves the ground).
      wantTY = c.mode === "ballooning" ? 1 + c.y : 1 + c.y * 0.5;
    }
    // Note: when idle, the drone-tour state machine below
    // overrides controls.target directly, so wantT* defaults to
    // origin here are fine — they don't end up affecting the
    // camera during the tour.
    void isIdleForTarget;
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
      // Side-on TV-style camera looking north at the putt. The
      // camera sits south of the ball's roll line so the character
      // (slightly east of the ball) appears to the right of frame,
      // the ball rolls left-to-right through the centre of frame,
      // and the cup is on the left edge — character never crosses
      // in front of the ball.
      wantCam = {
        x: GOLF_MIDPOINT.x + 0.5,
        y: 2.5,
        z: GOLF_MIDPOINT.z + 3.2,
      };
      camHijackedRef.current = true;
    } else if (c.mode === "riding") {
      // Fixed wide vantage south-east of the park, framing the
      // entire coaster (including the vertical loop) so the viewer
      // sees the whole ride rather than just the cart's immediate
      // surroundings.
      wantCam = {
        x: PARK.x + 24,
        y: 14,
        z: PARK.z + 24,
      };
      camHijackedRef.current = true;
    } else if (c.mode === "ballooning") {
      // Track the balloon's rise — camera y lifts 1:1 with the
      // character so Sonny's face stays in frame at every altitude.
      // Pulled back (z=10) so even the 6-unit rise + the ground
      // can both fit in the portrait viewport.
      wantCam = {
        x: BALLOON_POSITION.x + 2,
        y: 2.5 + c.y,
        z: BALLOON_POSITION.z + 10,
      };
      camHijackedRef.current = true;
    } else if (c.mode === "flee") {
      // Chase-cam IN FRONT of the runner — but specifically on the side
      // OPPOSITE the gator, so the gator stays behind the character in
      // the frame throughout the chase (instead of dropping off the
      // edge as the character nears the plaza and the chase axis
      // collapses to zero length).
      const g = gatorRef.current;
      const gx = c.x - g.x;
      const gz = c.z - g.z;
      const gDist = Math.hypot(gx, gz);
      // Unit vector pointing FROM gator TO char. Camera sits 5.5 units
      // further along this line so the optical axis runs camera→char→gator.
      const ux = gDist > 0.5 ? gx / gDist : 0.7;
      const uz = gDist > 0.5 ? gz / gDist : 0.7;
      wantCam = {
        // y=4 keeps the line of sight low enough that the gator (at
        // y≈1) doesn't drop off the bottom of the frame near the end
        // of the chase, while still high enough to clear the MUSIC
        // building roof when the chase passes by it.
        x: c.x + ux * 5.5,
        y: 4,
        z: c.z + uz * 5.5,
      };
      camHijackedRef.current = true;
    } else if (c.walking) {
      // Close-follow cam while the user walks to a clickable event
      // (building, gator, park, golf, balloon). Camera sits a few
      // units behind the character relative to their walking
      // direction, slightly above so the viewer sees the approach
      // up-close. When the character arrives, one of the cinematic
      // branches above takes over (gator/park/golf/balloon) or
      // wantCam goes null and the camera holds at the doorway
      // (buildings). Intentionally does NOT set camHijackedRef —
      // walking is its own gate, separate from the post-event
      // glide-back.
      wantCam = {
        x: c.x - Math.sin(c.angle) * 5.5,
        y: 4,
        z: c.z - Math.cos(c.angle) * 5.5,
      };
      camLerpSpeed = 3.5;
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
      const nowSec = performance.now() / 1000;
      const userIdle =
        !lastInputTimeRef.current ||
        nowSec - lastInputTimeRef.current > DRONE_INPUT_PAUSE_S;
      const isIdle =
        c.mode === "idle" &&
        !c.walking &&
        !camHijackedRef.current &&
        userIdle;
      controlsRef.current.autoRotate = false;
      if (isIdle) {
        // ── Drone tour: fly between waypoints around the world ──
        // State machine alternates between two phases:
        //   transitioning: quickly lerp camera + target from the
        //                  previous waypoint vantage to the next.
        //   dwelling:      slowly rotate the camera around the
        //                  current waypoint's target, holding the
        //                  target steady.
        // On first idle frame after a non-idle period (e.g. after
        // a cinematic ended), seed the "previous" position from
        // wherever the camera was so the transition eases in.
        if (!droneActiveRef.current) {
          droneActiveRef.current = true;
          droneStateRef.current = "transitioning";
          dronePhaseStartRef.current = state.clock.elapsedTime;
          dronePrevPosRef.current.copy(state.camera.position);
          dronePrevTargetRef.current.copy(controlsRef.current.target);
        }
        const now = state.clock.elapsedTime;
        const elapsed = now - dronePhaseStartRef.current;
        const wp = DRONE_TOUR[droneIdxRef.current];
        if (droneStateRef.current === "transitioning") {
          const progress = Math.min(1, elapsed / DRONE_TRANSITION_S);
          // Cubic smoothstep — fast in the middle, soft at the ends.
          const eased = progress * progress * (3 - 2 * progress);
          const targetCamPos = wp.target.clone().add(wp.camOffset);
          state.camera.position
            .copy(dronePrevPosRef.current)
            .lerp(targetCamPos, eased);
          controlsRef.current.target
            .copy(dronePrevTargetRef.current)
            .lerp(wp.target, eased);
          if (progress >= 1) {
            droneStateRef.current = "dwelling";
            dronePhaseStartRef.current = now;
            dwellAngleRef.current = 0;
          }
        } else {
          // Dwelling — slowly rotate the camera offset around the
          // target's Y axis. Keeps target steady so the section
          // stays centred in frame. Rotation speed eases from 0
          // up to DRONE_DWELL_ROT_SPEED over DRONE_DWELL_RAMP_S so
          // the motion never snaps in (matters especially when the
          // drone resumes after the user-input pause).
          const rampT = Math.min(1, elapsed / DRONE_DWELL_RAMP_S);
          const eased = rampT * rampT * (3 - 2 * rampT);
          dwellAngleRef.current += DRONE_DWELL_ROT_SPEED * eased * dt;
          const angle = dwellAngleRef.current;
          const ox = wp.camOffset.x;
          const oy = wp.camOffset.y;
          const oz = wp.camOffset.z;
          const rotX = ox * Math.cos(angle) - oz * Math.sin(angle);
          const rotZ = ox * Math.sin(angle) + oz * Math.cos(angle);
          state.camera.position.set(
            wp.target.x + rotX,
            wp.target.y + oy,
            wp.target.z + rotZ
          );
          controlsRef.current.target.copy(wp.target);
          if (elapsed > DRONE_DWELL_S) {
            // End of dwell — seed prev for the next transition and
            // advance to the next waypoint (wrap around the loop).
            dronePrevPosRef.current.copy(state.camera.position);
            dronePrevTargetRef.current.copy(wp.target);
            droneIdxRef.current =
              (droneIdxRef.current + 1) % DRONE_TOUR.length;
            droneStateRef.current = "transitioning";
            dronePhaseStartRef.current = now;
          }
        }
      } else {
        // The drone just released the camera (user clicked, or a
        // cinematic mode kicked in). Two cases:
        //   1. A walk was kicked off (the click hit a clickable mesh)
        //      → snap the camera to the follow-cam position so the
        //      user sees the character immediately instead of waiting
        //      ~1s for the lerp to drag the camera across the map.
        //   2. No walk started (the click missed any clickable mesh,
        //      which is easy to do from the drone's unusual vantage)
        //      → trigger the existing camHijacked glide-back so the
        //      camera returns to CAM_DEFAULT, giving the user the
        //      familiar plaza overview they can click from reliably.
        if (droneActiveRef.current) {
          if (c.walking) {
            state.camera.position.set(
              c.x - Math.sin(c.angle) * 5.5,
              4,
              c.z - Math.cos(c.angle) * 5.5
            );
            targetVec.set(c.x, 1, c.z);
            controlsRef.current.target.copy(targetVec);
          } else {
            camHijackedRef.current = true;
          }
        }
        droneActiveRef.current = false;
      }
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
      maxDistance={70}
      minPolarAngle={Math.PI * 0.12}
      maxPolarAngle={Math.PI * 0.48}
      target={[0, 1, 0]}
      autoRotateSpeed={0.4}
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
      // Face south (+Z) toward the camera. Wife/Son/Dog meshes all
      // default-face +Z (see e.g. Dog's "model faces +Z" comment), so
      // a rotation of 0 already points them at the camera vantage at
      // (0, 20, 25). A previous Math.PI here spun them around to face
      // away from the viewer.
      root.rotation.y = 0;

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
