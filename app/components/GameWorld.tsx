"use client";

import { forwardRef, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import {
  Billboard,
  OrbitControls,
  Text,
  useTexture,
} from "@react-three/drei";
import { usePathname, useRouter } from "next/navigation";
import * as THREE from "three";
import { Chess, type Square } from "chess.js";
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

type CharMode = "idle" | "flee" | "riding" | "golfing" | "ballooning" | "tubing" | "putting";

type CharState = {
  x: number;
  z: number;
  y: number; // off-ground height (coaster ride, balloon, jump in play mode)
  angle: number; // facing angle (Y rotation, radians)
  walking: boolean;
  mode: CharMode;
  stepPhase: number; // 0..1
  // Play-mode jump physics. Driven only by the play-mode WASD/jump
  // tick; portfolio mode leaves these alone (y is driven by the
  // coaster / balloon / golf state machines instead).
  vy: number;
  grounded: boolean;
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

// Play-mode interactive putt at the golf green. Aim with A/D (rotates
// the kid's body angle), hold Space to charge a power meter, release
// to launch the ball. Ball decelerates from friction; if it reaches
// the cup at low speed it sinks. Missed putts respawn at the tee for
// another try. Exit via the DONE overlay button.
type PuttingState = {
  active: boolean;
  // Held-key state for the Space-charge → release flow. `charging`
  // is true while Space is down; `power` builds up to 1 over
  // PUTT_CHARGE_TIME seconds.
  charging: boolean;
  power: number; // 0..1, normalised
  // Ball physics — world XZ position and per-frame velocity vector.
  // y is fixed at GOLF_BALL_Y (slightly above the green) since the
  // putt is a flat surface roll.
  ballX: number;
  ballZ: number;
  ballVx: number;
  ballVz: number;
  // Phase: 'idle' (tee, awaiting aim/charge), 'rolling' (ball in
  // motion), 'sunk' (in cup, celebrating), 'missed' (stopped, brief
  // beat before respawn).
  phase: "idle" | "rolling" | "sunk" | "missed";
  phaseT: number; // seconds since phase entry (for sunk/missed beats)
  attempts: number; // total putts this session (just for HUD)
  sinks: number; // total sinks this session
};

// Lazy-river ride. The tube auto-floats along RIVER_CURVE at a
// constant slow current; A/D (play mode) or touch ←/→ drifts the
// tube sideways within the river width. Easter-egg mode auto-exits
// after one full loop; play mode rides indefinitely until the EXIT
// button is tapped.
type RiverState = {
  active: boolean;
  riding: boolean;
  // 0..1 position around the river loop (CatmullRomCurve3 parameter).
  t: number;
  // Sideways drift within the river width, -1 = left edge, +1 = right edge.
  offset: number;
  // How many full loops the rider has done this ride. Easter-egg
  // mode auto-exits at >= 1; play mode keeps going.
  laps: number;
  // 'play' = ride forever (until EXIT button); 'egg' = auto-exit after one loop.
  mode: "play" | "egg";
  // Flips true when EXIT is requested via the river-exit window event.
  exitPending: boolean;
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

// State machine for the new balloon adventure: Travis + Kate ride
// the balloon up high, jump out, parachute down, walk back. Sonny
// is a spectator (stays on the plaza, camera pans away to the
// balloon and back).
type BalloonAdventurePhase =
  | "kateWalking"   // Kate walks from academy to her boarding spot
  | "boarding"      // both characters move into the basket
  | "rising"        // balloon ascends with both inside
  | "atTop"         // brief beat at peak altitude
  | "jumping"       // both leap out
  | "parachuting"   // parachutes deployed, slow descent
  | "landing"       // touchdown
  | "kiss"          // Kate steps over and kisses Travis before they head home
  | "returning";    // both walk back to their home spots

type BalloonAdventureState = {
  active: boolean;
  phase: BalloonAdventurePhase;
  t: number;          // 0..1 progress within the current phase
  balloonY: number;   // world Y of the balloon group (basket floor)
  // Y-altitude of the "action" the camera should frame each phase.
  // - boarding/landing/returning: 0 (characters on ground)
  // - rising/atTop: same as balloonY (characters in basket)
  // - jumping/parachuting: average of Travis + Kate Y (mid-air)
  // Decoupled from balloonY so the balloon can stay at peak after
  // the jump (out-of-frame above) while the camera follows the
  // parachuters down — keeps the balloon from cluttering the
  // descent shot.
  riderY: number;
};

// Position + pose for a non-player avatar (Travis, Kate). Drives
// dynamic placement and walking animation when the adventure is
// active. When idle, ref holds the home position (Travis next to
// the balloon; Kate hidden / inside the academy).
type AvatarState = {
  x: number;
  z: number;
  y: number;
  angle: number;     // facing direction (atan2(dx, dz) convention)
  walking: boolean;  // drives the walk-cycle limb swing
  stepPhase: number; // 0..1 step cycle
  visible: boolean;  // hide outside the adventure (used for Kate)
};

type SharedRefs = {
  char: React.MutableRefObject<CharState>;
  target: React.MutableRefObject<{
    x: number;
    z: number;
    sectionId: SectionId | null;
    sprint?: boolean;
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
  river: React.MutableRefObject<RiverState>;
  approachingRiver: React.MutableRefObject<boolean>;
  putting: React.MutableRefObject<PuttingState>;
  balloon: React.MutableRefObject<BalloonState>;
  approachingBalloon: React.MutableRefObject<boolean>;
  balloonAdventure: React.MutableRefObject<BalloonAdventureState>;
  travis: React.MutableRefObject<AvatarState>;
  kate: React.MutableRefObject<AvatarState>;
};

const WALK_SPEED = 2.5; // units/sec
const SPRINT_SPEED = 5.0; // jog to/from far destinations (lazy river)
const FLEE_SPEED = 5.8; // sprint speed when fleeing the gator
const GATOR_CHASE_SPEED = 2.2;
const GATOR_RETURN_SPEED = 1.4;
const ARRIVE_DIST = 0.18;
const DOOR_OPEN_SPEED = 3;
const DOOR_CLOSE_SPEED = 4;
const GATOR_HOME = { x: 9, z: -8, angle: 0.6 };
// Lake footprint (matches the Lake component in Environment). Used to
// auto-trigger the gator chase whenever the character wanders within
// striking distance of the water.
const LAKE_CENTER = { x: 9, z: -8 };
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
// the BALL sits at address (offset slightly west + south of the
// character so the character isn't standing directly on top of the
// ball, and so the forward body-bend tilts toward the ball).
const GOLF_POSITION = { x: -14, z: 17 };
// Char stands NORTH of the ball so the forward body-bend during the
// swing tilts the torso SOUTH toward the ball. If the char were south
// of the ball, the body would lean away from the ball and the swing
// would appear to come from behind the back.
const GOLF_TEE = { x: -16.5, z: 8.3 };
const GOLF_BALL_START = { x: -17.0, z: 8.7 };
const GOLF_HOLE = { x: -18, z: 8.6 };
const GOLF_DURATION = 6.0; // total seconds of address → swing → flight → celebration

// Play-mode interactive putt — separate from the easter-egg
// choreography above. When the kid walks within PUTT_TRIGGER_RADIUS
// of GOLF_TEE in play mode, they auto-board into putting mode and
// can aim + charge + putt with A/D + Space. Tuned so a full-power
// shot at the cup (distance ≈ 1.5u from tee → ball start) gives the
// kid a decent chance of sinking but isn't trivial.
const PUTT_TRIGGER_RADIUS = 2.5;
// Max launch speed (units/sec) at full power. Distance to cup from
// ball start is ~1.0u; with friction 4.0 a 3.5u/s launch travels
// roughly 1.5u before stopping (s = v²/(2·a) = 12.25/8 ≈ 1.5).
const PUTT_MAX_LAUNCH_SPEED = 4.5;
const PUTT_FRICTION = 4.0; // units/sec² deceleration
const PUTT_CHARGE_TIME = 1.0; // seconds Space-held to reach full power
// Aim rotation rate while putting (radians/sec). Slower than the
// tank turn rate on land so fine aiming is comfortable.
const PUTT_AIM_TURN_RATE = 1.2;
// Cup geometry — proximity to the cup centre that counts as a sink,
// and the max ball speed at which the cup edge "captures" the ball
// (too fast → ball rolls over the lip instead of dropping in).
const PUTT_CUP_RADIUS = 0.32;
const PUTT_SINK_SPEED_MAX = 2.0;
// Stop threshold — below this speed the ball is considered stopped
// (transitions to missed/sunk phase). Avoids the asymptotic
// never-quite-zero tail of friction decay.
const PUTT_STOP_SPEED = 0.08;
const PUTT_SUNK_BEAT = 1.4; // sec of celebration before respawn
const PUTT_MISSED_BEAT = 0.6; // sec of pause before ball respawns at tee
const PUTT_BALL_Y = 0.08; // ball sits a hair above the green

// Lazy-river easter egg — a huge loop that spans the whole map and
// encircles the plaza + buildings + lake + balloon + golf course.
// Carnival sits in the NW corner just outside the loop (between the
// river outer west and the road). The character walks to the
// boarding deck on the south inner bank near the plaza, climbs
// into a Gracie-red inner tube, and floats around. Steering is
// sideways drift via A/D in play mode or the touch arrows.
//
// Centre of the river loop in world coords. The curve is defined
// in local units (relative to this centre) and translated through
// at render / sample time, matching the convention used by the
// amusement-park coaster.
const RIVER_CENTER = { x: -3, z: 5 };
// Boarding spot — south side of the inner bank, just north of the
// plaza. The kid walks south a few units and auto-boards.
const RIVER_ENTRY = { x: -3, z: 30 };
// Ride physics. Current speed is in "parameter units" per second
// (t advances by RIVER_CURRENT_SPEED * dt). 0.06/sec → ~17 sec per
// lap on the big-loop perimeter — challenging enough that the kid
// has to actively steer to catch each belt before it floats past.
const RIVER_CURRENT_SPEED = 0.06;
// Sideways drift rate when the kid holds A/D — in offset units per
// second. Clamped to [-1, +1] (river half-width). Bumped from 0.9
// to keep steering responsive at the higher current speed.
const RIVER_DRIFT_SPEED = 1.2;
// Visual half-width of the river channel (how far the tube can drift
// before clamping). World units.
const RIVER_HALF_WIDTH = 3;

// Tiny play-mode demo: 5 plaza-area black belts scattered around
// the world at ground level, plus 3 more that float in the lazy
// river (RIVER_BELT_PICKUPS below) — total 8, matching PLAY_BELT_TOTAL
// in GameShell. Plaza belts are findable just by wandering; the
// river belts require actively boarding the tube and steering to
// the right offset to grab them mid-float.
const BELT_PICKUPS: { x: number; z: number; label: string }[] = [
  { x:  6,  z:  2,  label: "near-music" },     // plaza edge, MUSIC side
  { x: -6,  z:  6,  label: "near-code" },      // plaza edge, CODE side
  { x:  9,  z: -6,  label: "lake-shore" },     // near the gator / lake corner
  { x: -3,  z: 20,  label: "south-meadow" },   // between plaza and the river
  { x: 15,  z:  8,  label: "east-beach" },     // east near the beach
];
const BELT_BOB_AMP = 0.15;    // vertical wobble amplitude
const BELT_BOB_FREQ = 1.8;    // wobbles/sec
const BELT_SPIN_FREQ = 1.4;   // rotations/sec

// Character selection — the kid picks who they want to play as by
// clicking a character on the dojo mat. Selection persists to
// localStorage so it survives reloads. `sonny` is the default. The
// player Character (rendered above the route conditional in Scene)
// reads the selected id and swaps face texture + belt color
// accordingly.
type CharacterId = "sonny" | "kate" | "travis";
const ALL_CHARACTERS: CharacterId[] = ["sonny", "kate", "travis"];
const CHARACTER_STORAGE_KEY = "personal-site:character";
// Visual data for each option. `face` is the PNG that goes on the
// billboard plane; for non-Sonny characters we reuse the same image
// for the front + back-of-head + scared slots (Sonny is the only
// one with all three textures hand-edited). `belt` matches their
// in-academy rank — Sonny: black, Kate: brown, Travis: black.
// `faceScale` multiplies the rendered face plane size to compensate
// for differences in how much of each PNG canvas the face fills —
// Travis's photo is cropped tight with almost no padding, so his
// face would render about 30% larger than Sonny/Kate's if it shared
// the same plane size. Scaling his plane down brings the apparent
// head size in line with the rest of the lineup.
type CharacterMeta = {
  face: string;
  belt: string;
  faceScale: number;
  // World-Y position of the face plane center on a TrainingPartner.
  // Tighter-cropped photos (Travis fills 100% of his canvas, no
  // transparent padding around the chin) need the plane lifted so
  // the chin clears the torso top — otherwise the bottom of the
  // face renders inside the body.
  faceY: number;
};
const CHARACTER_DATA: Record<CharacterId, CharacterMeta> = {
  // faceScale > 1.0 for Sonny + Kate because their PNGs have a lot
  // of transparent padding above + below the face content (~50% of
  // each canvas) — at scale 1.0 the rendered face read as smaller
  // than Travis's tight-cropped photo. Bumping to 1.5 brings the
  // apparent head size in line with Travis. faceY is the world-Y
  // of the plane center; Travis's plane sits SLIGHTLY higher than
  // the others so his chin clears the torso (his face fills 100% of
  // his canvas with no padding to absorb the lower portion).
  sonny:  { face: "/face.png",   belt: "#0a0a0a", faceScale: 1.3,  faceY: 1.58 },
  kate:   { face: "/kate.png",   belt: "#6b4226", faceScale: 1.05, faceY: 1.50 },
  travis: { face: "/travis.png", belt: "#0a0a0a", faceScale: 0.85, faceY: 1.62 },
};
// Lazy-river loop. Defined in LOCAL units relative to RIVER_CENTER;
// renderers and samplers translate into world space. Oval shape
// (wider east-west than north-south) so the river footprint covers
// the same southern area the gun range used to. Sampled at N points
// and fed into a closed CatmullRomCurve3 so the tube can move along
// it smoothly.
const RIVER_RX = 22; // x half-width (oval east-west extent)
const RIVER_RZ = 30; // z half-depth (oval north-south extent)
const RIVER_CURVE = (() => {
  const N = 96;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / N;
    // Start at the south side so t=0 is opposite the boarding spot
    // — the tube enters the river heading east and loops around.
    // angle 0 = south; advance CCW so we head east first.
    const a = Math.PI / 2 + t * Math.PI * 2;
    pts.push(
      new THREE.Vector3(
        Math.cos(a) * RIVER_RX,
        0.04, // sit on the water plane
        Math.sin(a) * RIVER_RZ
      )
    );
  }
  return new THREE.CatmullRomCurve3(pts, true, "catmullrom", 0.5);
})();

// 8 black belts floating in the river, staggered across the channel
// width and spread evenly around the full loop. Kid has to actively
// steer to catch each one before it drifts past — the bigger loop
// + faster current means belts come up quickly, so the offsets
// alternate sides so consecutive belts force back-and-forth steering.
// Belt sample t + offset are paired so the pickup geometry's world
// position can be computed from the curve sample without remounting
// the meshes each frame.
const RIVER_BELT_PICKUPS: { t: number; offset: number; label: string }[] = [
  { t: 0.05, offset:  0.6, label: "river-1" },
  { t: 0.18, offset: -0.7, label: "river-2" },
  { t: 0.30, offset:  0.5, label: "river-3" },
  { t: 0.42, offset: -0.5, label: "river-4" },
  { t: 0.55, offset:  0.7, label: "river-5" },
  { t: 0.68, offset: -0.6, label: "river-6" },
  { t: 0.80, offset:  0.4, label: "river-7" },
  { t: 0.92, offset: -0.3, label: "river-8" },
];

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

// ── New balloon-adventure choreography (Travis + Kate ride up high,
// jump out, parachute down, walk back). Sonny stays on the plaza.
const ADV_KATE_SPAWN = { x: -5.7, z: 0.2 }; // exterior of JIU JITSU door
const ADV_KATE_BOARDING = {            // walking destination by the basket
  x: BALLOON_POSITION.x + 0.6,
  z: BALLOON_POSITION.z + 0.4,
};
const ADV_TRAVIS_BOARDING = {          // Travis steps in from his standing spot
  x: BALLOON_POSITION.x + 0.3,
  z: BALLOON_POSITION.z,
};
const ADV_KATE_BASKET = { x: BALLOON_POSITION.x + 0.28, z: BALLOON_POSITION.z };
const ADV_TRAVIS_BASKET = { x: BALLOON_POSITION.x - 0.28, z: BALLOON_POSITION.z };
const ADV_RISE_HEIGHT = 28;            // taller than before so the leap reads as a real altitude
const ADV_KATE_WALK_DURATION = 5.5;    // sec for Kate's walk from academy
const ADV_BOARDING_DURATION = 1.4;     // sec to climb in
const ADV_RISE_DURATION = 5.0;
const ADV_AT_TOP_DURATION = 0.9;
const ADV_JUMP_DURATION = 0.55;        // brief free-fall before chutes open
const ADV_PARACHUTE_DURATION = 5.5;    // slow descent
const ADV_LANDING_DURATION = 0.5;
const ADV_KISS_DURATION = 1.6;         // Kate steps in + holds the kiss + steps back
// Where Kate stands relative to Travis during the kiss — just east
// of him, face-to-face. Travis stays put; Kate is the one who moves.
const ADV_KISS_KATE_OFFSET_X = 0.55;
// During returning, the balloon descends from ADV_RISE_HEIGHT down
// to 0 while Kate walks back to the academy. Kate's walk is the
// "slowest" return path, so balloon descent rate is sized to land
// roughly when Kate gets home (uses the full walk-back time).
const ADV_BALLOON_DESCENT_RATE = 4.0;  // units/sec during returning
const ADV_RETURN_TRAVIS = { x: BALLOON_POSITION.x + 1.7, z: BALLOON_POSITION.z + 0.4 };

// Amusement park
const PARK = { x: -21, z: -38 };
// Visual scale applied to the entire AmusementPark group + the
// CoasterCart so the character (~2 units tall) reads as a normal
// rider rather than dwarfing the cart and rides. Local geometry
// stays the same; everything that needs to talk to world space
// (coaster curve sampling, character walk targets, park entry
// offset) multiplies through PARK_SCALE. Park width is constrained
// horizontally by the road (x≈-27.5) on the west and JIU JITSU
// (x≈-7.1) on the east, so growth happens mostly in the z direction.
const PARK_SCALE = 1.4;
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

// Sample the lazy-river curve at a normalised position `t ∈ [0, 1]`
// with a sideways drift `offset ∈ [-1, +1]`. Returns the tube's world
// position + the curve tangent angle (used to orient the tube along
// the direction of flow). The offset is applied perpendicular to the
// tangent in the XZ plane, scaled by RIVER_HALF_WIDTH.
function riverWorldAt(t: number, offset: number): {
  x: number;
  z: number;
  angle: number;
  tangentX: number;
  tangentZ: number;
} {
  const p = RIVER_CURVE.getPointAt(t);
  const tan = RIVER_CURVE.getTangentAt(t);
  // Perpendicular to the tangent in the XZ plane. The chase cam sits
  // BEHIND the rider along the negative tangent, so camera-right (= the
  // rider's visual right when looking forward) is `(-tan.z, +tan.x)`
  // — derived from forward × up. We define +offset as CAMERA-RIGHT so
  // pressing D / → drifts the tube right on screen, A / ← drifts left.
  const perpX = -tan.z;
  const perpZ = tan.x;
  const o = offset * RIVER_HALF_WIDTH;
  return {
    x: RIVER_CENTER.x + p.x + perpX * o,
    z: RIVER_CENTER.z + p.z + perpZ * o,
    angle: Math.atan2(tan.x, tan.z),
    tangentX: tan.x,
    tangentZ: tan.z,
  };
}

// Decorative obstacles (currently the hills) that the character should
// neither walk through nor route a path through. Treated as ground
// circles. Keep the (x, z, r) entries in sync with the `<Hill>` JSX
// inside Environment — each Hill's footprint radius is `3.5 * scale`
// (the half-sphere has unscaled radius 3.5, and only Y is squashed).
const OBSTACLES: { x: number; z: number; r: number }[] = [
  { x: -22, z:  72, r: 3.5 * 1.4 },
  { x:  14, z:  73, r: 3.5 * 1.5 },
  { x:  -3, z:  84, r: 3.5 * 1.6 },
];

// Wooden bridges across the lazy river. Each bridge is a rectangle
// aligned with one axis — `axis: "x"` means the long side runs in the
// x direction (east-west), so the bridge spans the channel where the
// channel runs north-south (east + west sides of the loop). `axis:
// "z"` is the perpendicular case (bridge runs north-south across the
// channel on the north + south sides of the loop).
//
// The character can ONLY cross the river by walking on a bridge — the
// inRiverChannel + onBridge tests in resolveCollisions push the
// character out of the water everywhere else.
//
// Bridge centres are placed so the rectangle covers the full channel
// width (RIVER_HALF_WIDTH * 2 = 6u between inner + outer ring) plus a
// little overhang on each side so the kid can step onto / off the
// bridge from grass without an awkward zero-gap.
type Bridge = {
  x: number;
  z: number;
  axis: "x" | "z";
  length: number; // along the long axis (= crosses the channel)
  width: number;  // along the short axis (= along the channel)
};
const RIVER_BRIDGES: Bridge[] = [
  // North bridge — direct path from plaza to the NW carnival.
  { x: -3, z: -25, axis: "z", length: 8, width: 3 },
  // East bridge — onto the beach + ocean side.
  { x: 19, z: 5, axis: "x", length: 8, width: 3 },
  // West bridge — onto the road + cityscape side.
  { x: -25, z: 5, axis: "x", length: 8, width: 3 },
];
const BRIDGE_DECK_Y = 0.6; // top of the plank (clears tube top at y=0.38)
const BRIDGE_DECK_THICKNESS = 0.18;

// Returns true if (x, z) is inside the lazy-river water channel (the
// annulus between the inner and outer rings of the oval).
function inRiverChannel(x: number, z: number): boolean {
  const dx = x - RIVER_CENTER.x;
  const dz = z - RIVER_CENTER.z;
  const Rxi = RIVER_RX - RIVER_HALF_WIDTH;
  const Rzi = RIVER_RZ - RIVER_HALF_WIDTH;
  const Rxo = RIVER_RX + RIVER_HALF_WIDTH;
  const Rzo = RIVER_RZ + RIVER_HALF_WIDTH;
  const innerSum = (dx / Rxi) ** 2 + (dz / Rzi) ** 2;
  const outerSum = (dx / Rxo) ** 2 + (dz / Rzo) ** 2;
  return outerSum <= 1 && innerSum >= 1;
}

// Returns true if (x, z) falls within any bridge's rectangular
// footprint. Bridges cross the channel at fixed spots — when the
// character is on one of them the water-push collision is skipped.
function onBridge(x: number, z: number): boolean {
  for (const b of RIVER_BRIDGES) {
    const dx = Math.abs(x - b.x);
    const dz = Math.abs(z - b.z);
    if (b.axis === "z") {
      if (dz < b.length / 2 && dx < b.width / 2) return true;
    } else {
      if (dx < b.length / 2 && dz < b.width / 2) return true;
    }
  }
  return false;
}

// Push (x, z) out of the lazy-river channel toward the nearer ring
// boundary, with a CHAR_RADIUS buffer so the character doesn't
// immediately re-trigger on the next frame. Bridges punch holes — if
// (x, z) is on a bridge the position passes through unchanged.
function resolveRiverCollision(x: number, z: number): { x: number; z: number } {
  if (!inRiverChannel(x, z) || onBridge(x, z)) return { x, z };
  const dx = x - RIVER_CENTER.x;
  const dz = z - RIVER_CENTER.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.0001) return { x, z };
  const Rxi = RIVER_RX - RIVER_HALF_WIDTH;
  const Rzi = RIVER_RZ - RIVER_HALF_WIDTH;
  const Rxo = RIVER_RX + RIVER_HALF_WIDTH;
  const Rzo = RIVER_RZ + RIVER_HALF_WIDTH;
  const innerSum = (dx / Rxi) ** 2 + (dz / Rzi) ** 2;
  const outerSum = (dx / Rxo) ** 2 + (dz / Rzo) ** 2;
  // Scale that projects (dx, dz) onto the inner / outer rings.
  const sInner = 1 / Math.sqrt(innerSum); // < 1, pulls toward centre
  const sOuter = 1 / Math.sqrt(outerSum); // > 1, pushes away from centre
  // Distance from current position to each projection.
  const innerDist = len * (1 - sInner);
  const outerDist = len * (sOuter - 1);
  const buffer = CHAR_RADIUS / len;
  if (innerDist < outerDist) {
    // Push toward island (inward).
    const s = sInner - buffer;
    return { x: RIVER_CENTER.x + dx * s, z: RIVER_CENTER.z + dz * s };
  }
  // Push toward outer grass (outward).
  const s = sOuter + buffer;
  return { x: RIVER_CENTER.x + dx * s, z: RIVER_CENTER.z + dz * s };
}

// Resolve building collisions by pushing the character out of any
// building footprint (rotated rectangle inflated by CHAR_RADIUS), and
// out of any obstacle circle (hills).
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
  // Hill circles — push radially outward to the boundary.
  for (const o of OBSTACLES) {
    const dx = nx - o.x;
    const dz = nz - o.z;
    const d = Math.hypot(dx, dz);
    const minD = o.r + CHAR_RADIUS;
    if (d < minD) {
      if (d < 1e-4) {
        // Degenerate: shove +x by minD so we don't divide by zero.
        nx = o.x + minD;
      } else {
        nx = o.x + (dx / d) * minD;
        nz = o.z + (dz / d) * minD;
      }
    }
  }
  // Lazy-river water — push the character out of the channel toward
  // the nearer ring boundary UNLESS they're standing on a bridge.
  // Done last so it overrides any earlier push that would have
  // dropped them into the water.
  const r = resolveRiverCollision(nx, nz);
  nx = r.x;
  nz = r.z;
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

// Closest-point-on-segment-to-circle-center check for the hill
// obstacles. Cheaper and more accurate than sample-based.
function lineHitsAnyObstacle(
  x1: number,
  z1: number,
  x2: number,
  z2: number
): boolean {
  const lx = x2 - x1;
  const lz = z2 - z1;
  const len2 = lx * lx + lz * lz || 1;
  for (const o of OBSTACLES) {
    let t = ((o.x - x1) * lx + (o.z - z1) * lz) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const cx = x1 + lx * t;
    const cz = z1 + lz * t;
    if (Math.hypot(o.x - cx, o.z - cz) < o.r + CHAR_RADIUS + 0.05) return true;
  }
  return false;
}

// Does a straight line segment cross the lazy-river channel at a
// point that isn't on a bridge? Sample-based; 32 samples is enough
// granularity for the big oval (~165u perimeter, so each sample
// covers ~5u).
function lineHitsRiver(
  x1: number,
  z1: number,
  x2: number,
  z2: number
): boolean {
  const SAMPLES = 32;
  for (let i = 1; i < SAMPLES; i++) {
    const t = i / SAMPLES;
    const sx = x1 + (x2 - x1) * t;
    const sz = z1 + (z2 - z1) * t;
    if (inRiverChannel(sx, sz) && !onBridge(sx, sz)) return true;
  }
  return false;
}

// Combined route-blocking check: a line is blocked if it crosses a
// building footprint, a hill circle, or the river channel without a
// bridge. All three are obstacles routeTo must navigate around.
function lineIsBlocked(
  x1: number,
  z1: number,
  x2: number,
  z2: number
): boolean {
  return (
    lineHitsAnyBuilding(x1, z1, x2, z2) ||
    lineHitsAnyObstacle(x1, z1, x2, z2) ||
    lineHitsRiver(x1, z1, x2, z2)
  );
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
  // Southern hills corridor — threads east of the SW hill (-22, 28)
  // so the walk to the lazy river (z=40+) routes around it if needed.
  { x: -9, z: 26 },
  // Bridge waypoints — each bridge has an INNER (island-side) and
  // OUTER (outer-grass-side) entry point. routeTo's two-waypoint
  // fallback walks through both to cross a bridge cleanly. Without
  // these the path planner would slip diagonally off the bridge
  // mid-cross and lineHitsRiver would block the route.
  { x: -3, z: -22 },  // N bridge — island side
  { x: -3, z: -28 },  // N bridge — outer side (toward carnival)
  { x:  16, z: 5 },   // E bridge — island side
  { x:  22, z: 5 },   // E bridge — outer side (toward beach)
  { x: -22, z: 5 },   // W bridge — island side
  { x: -28, z: 5 },   // W bridge — outer side (toward road)
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
  if (!lineIsBlocked(fromX, fromZ, toX, toZ)) {
    return [{ x: toX, z: toZ }];
  }
  // Pick the bypass waypoint that minimises total path length while keeping
  // both legs clear of buildings AND hills.
  let best: { x: number; z: number } | null = null;
  let bestCost = Infinity;
  for (const w of BYPASS_WAYPOINTS) {
    if (lineIsBlocked(fromX, fromZ, w.x, w.z)) continue;
    if (lineIsBlocked(w.x, w.z, toX, toZ)) continue;
    const cost =
      Math.hypot(w.x - fromX, w.z - fromZ) +
      Math.hypot(toX - w.x, toZ - w.z);
    if (cost < bestCost) {
      bestCost = cost;
      best = w;
    }
  }
  if (best) return [best, { x: toX, z: toZ }];

  // Single-bypass failed — try a TWO-bypass path. Mainly used for
  // river crossings: the kid needs to walk through the inner entry,
  // then along the bridge to the outer entry, before heading off
  // toward the destination. Pure O(N²) over waypoints, but N is
  // ~15 so it's fine.
  let bestPair: [{ x: number; z: number }, { x: number; z: number }] | null = null;
  let bestPairCost = Infinity;
  for (const w1 of BYPASS_WAYPOINTS) {
    if (lineIsBlocked(fromX, fromZ, w1.x, w1.z)) continue;
    for (const w2 of BYPASS_WAYPOINTS) {
      if (w2 === w1) continue;
      if (lineIsBlocked(w1.x, w1.z, w2.x, w2.z)) continue;
      if (lineIsBlocked(w2.x, w2.z, toX, toZ)) continue;
      const cost =
        Math.hypot(w1.x - fromX, w1.z - fromZ) +
        Math.hypot(w2.x - w1.x, w2.z - w1.z) +
        Math.hypot(toX - w2.x, toZ - w2.z);
      if (cost < bestPairCost) {
        bestPairCost = cost;
        bestPair = [w1, w2];
      }
    }
  }
  if (bestPair) return [...bestPair, { x: toX, z: toZ }];

  // Fallback: walk straight and let collision push-out do its best.
  return [{ x: toX, z: toZ }];
}

// -------------------- entry point --------------------

export default function GameWorld({ playMode = false }: { playMode?: boolean } = {}) {
  const charRef = useRef<CharState>({
    x: 0,
    z: 0,
    y: 0,
    angle: 0,
    walking: false,
    mode: "idle",
    stepPhase: 0,
    vy: 0,
    grounded: true,
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
  const riverRef = useRef<RiverState>({
    active: false,
    riding: false,
    t: 0,
    offset: 0,
    laps: 0,
    mode: "egg",
    exitPending: false,
  });
  const approachingRiverRef = useRef(false);
  const puttingRef = useRef<PuttingState>({
    active: false,
    charging: false,
    power: 0,
    ballX: GOLF_BALL_START.x,
    ballZ: GOLF_BALL_START.z,
    ballVx: 0,
    ballVz: 0,
    phase: "idle",
    phaseT: 0,
    attempts: 0,
    sinks: 0,
  });
  const balloonRef = useRef<BalloonState>({
    active: false,
    phase: "rising",
    t: 0,
    height: 0,
    startX: 0,
    startZ: 0,
  });
  const approachingBalloonRef = useRef(false);
  const balloonAdventureRef = useRef<BalloonAdventureState>({
    active: false,
    phase: "kateWalking",
    t: 0,
    balloonY: 0,
    riderY: 0,
  });
  // Travis's "home" position is the same spot the static Travis figure
  // stood at — south-east of the basket. He starts visible there and
  // moves into / out of the basket during the adventure.
  const travisRef = useRef<AvatarState>({
    x: BALLOON_POSITION.x + 1.7,
    z: BALLOON_POSITION.z + 0.4,
    y: 0,
    angle: 0, // face south (toward camera)
    walking: false,
    stepPhase: 0,
    visible: true,
  });
  // Kate is hidden by default — she only appears outside the academy
  // when the balloon adventure is triggered. Her "spawn" point is the
  // south-facing exterior door of the JIU JITSU building.
  const kateRef = useRef<AvatarState>({
    x: -5.7,
    z: 0.2, // just south of the academy building (door side)
    y: 0,
    angle: 0,
    walking: false,
    stepPhase: 0,
    visible: false,
  });

  const pathname = usePathname();
  const router = useRouter();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  // Route changes — snap character to door (deep link) or clear targets.
  useEffect(() => {
    const section = getSectionByPath(pathname ?? "/");
    if (section) {
      // JIU JITSU is unique — the route enters a separate 3D scene
      // (the academy interior), so snap the character to the room's
      // entrance instead of the exterior building's doorstep. The
      // academy interior is centred at the world origin so its
      // local coords are the same as the global ones; entry is at
      // (0, z=-9) facing north into the room.
      let t = doorTarget(section);
      let faceAngle = Math.atan2(section.x - t.x, section.z - t.z);
      if (section.id === "jiu-jitsu") {
        // Spawn at the centre of the mat so the straight-on south
        // camera frames the character + banner wall together.
        t = { x: 0, z: 0 };
        // angle = π faces -Z (toward the south/door side of the
        // room, which is where the camera sits). The body's
        // V-lapel and belt knot then point at the viewer so we
        // see Sonny's FRONT, not his back.
        faceAngle = Math.PI;
      } else if (section.id === "chess") {
        // Stand Sonny at the OPPONENT seat — well past the north
        // edge of the chess table (table ends at z=+1.5, he's at
        // z=2.2 so his body is fully behind it, not poking through
        // it) facing south toward the player camera. angle=π faces
        // -Z (south, toward the camera at (0, 4.5, -3)). The
        // camera's wantTY is bumped on this route so his head still
        // frames cleanly even though he's further out.
        t = { x: 0, z: 2.2 };
        faceAngle = Math.PI;
      }
      charRef.current.x = t.x;
      charRef.current.z = t.z;
      // HOME is special — Sonny just waved with the family at the
      // doorstep, so leave him facing south (+Z, toward the camera)
      // to match the family. JIU JITSU and CHESS both reuse the
      // `faceAngle` set above (= π so Sonny faces the camera across
      // the mat / chess table) — without that, both routes would
      // fall to the default and Sonny's body would twist to point
      // at the exterior building on the plaza while his face
      // billboards toward the camera. Other sections snap him to
      // face the building (away from origin) since the overlay
      // covers most of the scene and there's no figure in the
      // foreground.
      charRef.current.angle =
        section.id === "personal-life"
          ? 0
          : section.id === "jiu-jitsu" || section.id === "chess"
          ? faceAngle
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
      riverRef.current.active = false;
      riverRef.current.riding = false;
      riverRef.current.t = 0;
      riverRef.current.offset = 0;
      riverRef.current.laps = 0;
      riverRef.current.exitPending = false;
      approachingRiverRef.current = false;
      puttingRef.current.active = false;
      puttingRef.current.charging = false;
      puttingRef.current.power = 0;
      puttingRef.current.phase = "idle";
      puttingRef.current.phaseT = 0;
      puttingRef.current.ballX = GOLF_BALL_START.x;
      puttingRef.current.ballZ = GOLF_BALL_START.z;
      puttingRef.current.ballVx = 0;
      puttingRef.current.ballVz = 0;
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
      riverRef.current.active = false;
      riverRef.current.riding = false;
      riverRef.current.t = 0;
      riverRef.current.offset = 0;
      riverRef.current.laps = 0;
      riverRef.current.exitPending = false;
      approachingRiverRef.current = false;
      puttingRef.current.active = false;
      puttingRef.current.charging = false;
      puttingRef.current.power = 0;
      puttingRef.current.phase = "idle";
      puttingRef.current.phaseT = 0;
      puttingRef.current.ballX = GOLF_BALL_START.x;
      puttingRef.current.ballZ = GOLF_BALL_START.z;
      puttingRef.current.ballVx = 0;
      puttingRef.current.ballVz = 0;
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
      river: riverRef,
      approachingRiver: approachingRiverRef,
      putting: puttingRef,
      balloon: balloonRef,
      approachingBalloon: approachingBalloonRef,
      balloonAdventure: balloonAdventureRef,
      travis: travisRef,
      kate: kateRef,
    }),
    []
  );

  const isOnHome = (pathname ?? "/") === "/";

  // Selected playable character. Loaded from localStorage on mount;
  // updated via the `select-character` window event dispatched from
  // the academy's clickable TrainingPartners + the player Character.
  const [characterId, setCharacterId] = useState<CharacterId>("sonny");
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(CHARACTER_STORAGE_KEY);
      if (stored && (ALL_CHARACTERS as string[]).includes(stored)) {
        setCharacterId(stored as CharacterId);
      }
    } catch {
      // Storage might be disabled — defaults to "sonny".
    }
  }, []);
  useEffect(() => {
    function onSelect(e: Event) {
      const id = (e as CustomEvent<string>).detail;
      if (id && (ALL_CHARACTERS as string[]).includes(id)) {
        setCharacterId(id as CharacterId);
        try {
          window.localStorage.setItem(CHARACTER_STORAGE_KEY, id);
        } catch {
          // Storage disabled — selection still applies for the session.
        }
      }
    }
    window.addEventListener("select-character", onSelect);
    return () => window.removeEventListener("select-character", onSelect);
  }, []);

  // Mobile detection — coarse pointer is the cleanest "this is a
  // touch device" check; matches phones and most tablets, doesn't
  // misfire on touch-screen laptops with a mouse plugged in. SSR-safe
  // because the initial render uses `false` and the effect upgrades
  // to the real value once the window is available.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(pointer: coarse)");
    setIsMobile(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Default vantage. Selected per-pathname AND per-device:
  //   * Plaza route (/): mobile pulls back ~30% so the world fits a
  //     narrow portrait viewport, desktop keeps the original framing.
  //   * Academy route (/jiu-jitsu): corner-inside vantage so the
  //     whole room is in frame from a natural sparring-spectator
  //     angle. The glide-back logic in CameraRig pulls the camera
  //     to this point when the user enters the route or taps the
  //     reset-view button while inside the academy.
  const camDefault = useMemo(() => {
    if (pathname === "/jiu-jitsu") {
      // Straight-on view from just inside the south wall, looking
      // north across the wide mat at the character + banner wall.
      // Centred on the x axis so the framing is symmetrical, like
      // a TV broadcast vantage of the academy.
      return { x: 0, y: 3.5, z: -9 };
    }
    if (pathname === "/chess") {
      // Player's-seat vantage in the chess study: high enough above
      // the board that the squares read top-down (camera looks ~50°
      // downward), but still tilted forward so the pieces are seen
      // in profile, not as flat circles. South of the board so the
      // player's pieces are nearest.
      return { x: 0, y: 4.5, z: -3.0 };
    }
    return isMobile
      ? { x: 0, y: 26, z: 32 }
      : { x: 0, y: 20, z: 25 };
  }, [pathname, isMobile]);

  return (
    <div className="w-full h-full">
      <Canvas
        shadows
        camera={{
          position: [camDefault.x, camDefault.y, camDefault.z],
          fov: 45,
          near: 0.1,
          far: 250,
        }}
        // Cap device pixel ratio on mobile — phones often report DPR=3,
        // which triples the pixels GL has to fill for the same visual
        // size. Clamping to 1.5 is invisible on small screens but
        // doubles real framerate on weaker GPUs.
        dpr={isMobile ? [1, 1.5] : [1, 2]}
        gl={{ antialias: true }}
      >

        <color attach="background" args={["#1a1a2e"]} />
        <fog attach="fog" args={["#7fa8c8", 45, 95]} />
        <Scene
          refs={refs}
          router={router}
          isOnHome={isOnHome}
          pathname={pathname ?? "/"}
          camDefault={camDefault}
          playMode={playMode}
          characterId={characterId}
        />
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
  camDefault,
  playMode,
  characterId,
}: {
  refs: SharedRefs;
  router: RouterLike;
  isOnHome: boolean;
  pathname: string;
  camDefault: { x: number; y: number; z: number };
  playMode: boolean;
  characterId: CharacterId;
}) {
  // Mirror playMode into a ref so the per-frame physics / camera /
  // input branches can read it without closing over a stale state.
  const playModeRef = useRef(playMode);
  playModeRef.current = playMode;
  // Small helper to notify the EasterEggMenu overlay that the user
  // has completed an easter egg. The menu listens for this on
  // window and stores discovery state in localStorage. Each
  // completion site fires this exactly once (the surrounding
  // `if (rt >= 1)` / `if (gt >= 1)` / `if (laps >= ...)` etc.
  // guards reset the relevant state, so subsequent frames don't
  // re-enter the branch).
  function dispatchFound(id: "gator" | "coaster" | "golf" | "river" | "balloon") {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("easter-egg-found", { detail: id }));
  }

  // ── Play-mode input + physics constants ──
  // Tuned for "fun for a 6-year-old," not realistic. Sonny moves
  // about 1.4x his portfolio sprint speed and jumps roughly his own
  // height. Numbers feel right in dev; React strict mode runs the
  // tick 2-3x so production may feel slightly slower (acceptable).
  const PLAY_MOVE_SPEED = 6.5;       // units/sec horizontal
  const PLAY_JUMP_VELOCITY = 8.0;    // initial upward velocity
  const PLAY_GRAVITY = 22.0;         // units/sec² downward
  // Tank-style turn rate (radians/sec). Brief key taps produce
  // small turns (~5° for a 50ms tap); held keys rotate at ~100°/sec.
  // A press = turn LEFT (CCW from above, the character's own left);
  // D press = turn RIGHT (CW). W/S translate in the body's facing
  // direction. This replaced an earlier camera-relative strafe
  // model that mapped left arrow to a 90° CW rotation per press
  // ("left turns the character right, and too much per press").
  const PLAY_TURN_RATE = 1.8;
  const BELT_PICKUP_RADIUS = 1.1;  // distance from char to belt to grab it

  // Key-tracking refs. Refilled by window keydown/keyup listeners in
  // the effect below. We track WASD + arrows + space; everything
  // else is ignored so the page's normal hotkeys (cmd+R etc.) still
  // work. Keys are kept active while pressed even if the user
  // alt-tabs — that's a minor wart but acceptable.
  const keysRef = useRef({
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false, // edge-triggered: set true on keydown, cleared after consumed
  });
  useEffect(() => {
    function isJumpKey(e: KeyboardEvent) {
      return e.code === "Space" || e.key === " ";
    }
    function onKeyDown(e: KeyboardEvent) {
      if (!playModeRef.current) return;
      // Don't swallow keystrokes from typing fields (none in play
      // mode today, but cheap insurance).
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      switch (e.key.toLowerCase()) {
        case "w": case "arrowup":    keysRef.current.forward = true; e.preventDefault(); return;
        case "s": case "arrowdown":  keysRef.current.back = true;    e.preventDefault(); return;
        case "a": case "arrowleft":  keysRef.current.left = true;    e.preventDefault(); return;
        case "d": case "arrowright": keysRef.current.right = true;   e.preventDefault(); return;
      }
      if (isJumpKey(e)) {
        keysRef.current.jump = true; // consumed by useFrame when grounded
        e.preventDefault();
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      switch (e.key.toLowerCase()) {
        case "w": case "arrowup":    keysRef.current.forward = false; return;
        case "s": case "arrowdown":  keysRef.current.back = false;    return;
        case "a": case "arrowleft":  keysRef.current.left = false;    return;
        case "d": case "arrowright": keysRef.current.right = false;   return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // Reset held-key state + character position on every play-mode
  // toggle. Without the key reset, a key pressed during the
  // transition can stay "down" in the ref (no keyup fires after the
  // listener stops being relevant). Without the position reset,
  // entering play mode would drop the kid wherever Sonny happened
  // to be (often miles from the plaza after a previous session).
  useEffect(() => {
    function onReset() {
      const k = keysRef.current;
      k.forward = k.back = k.left = k.right = k.jump = false;
      const c = refs.char.current;
      c.x = 0;
      c.z = 0;
      c.y = 0;
      c.vy = 0;
      c.grounded = true;
      c.angle = 0;
      c.walking = false;
      c.stepPhase = 0;
      c.mode = "idle";
      // Clear any in-progress mode states so the next session starts clean.
      const p = refs.putting.current;
      if (p.active) {
        p.active = false;
        p.charging = false;
        p.power = 0;
        p.phase = "idle";
        p.phaseT = 0;
        p.ballVx = 0;
        p.ballVz = 0;
        p.ballX = GOLF_BALL_START.x;
        p.ballZ = GOLF_BALL_START.z;
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("putting-active", { detail: false })
          );
        }
      }
      const r = refs.river.current;
      if (r.active) {
        r.active = false;
        r.riding = false;
        r.t = 0;
        r.offset = 0;
        r.laps = 0;
        r.exitPending = false;
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("river-active", { detail: false })
          );
        }
      }
      // Signal the play-mode camera branch to snap directly to the
      // follow position on the next frame instead of lerping in
      // from wherever the camera happened to be. Without this, the
      // entry feels like a confusing 2-second pan across the world.
      playCamSnapRef.current = true;
    }
    window.addEventListener("play-mode-reset", onReset);
    return () => window.removeEventListener("play-mode-reset", onReset);
  }, [refs.char]);
  // Set on every play-mode-reset event; consumed (cleared) on the
  // first play-mode camera tick after a reset.
  const playCamSnapRef = useRef(false);

  // Belts — 5 collectibles scattered around the world for the
  // tiny play-mode demo. Positions are deliberately *ground-level*
  // (no platforms to land on yet) but spread far enough apart that
  // the kid has to actually run around to find them. `BELT_PICKUPS` is
  // a module-level constant; `beltCollectedRef` mirrors its
  // collected state per-belt so the meshes can hide themselves
  // and the per-frame distance check can skip already-grabbed ones.
  const beltCollectedRef = useRef<boolean[]>(BELT_PICKUPS.map(() => false));
  // GameShell tells us to reset (entering or exiting play mode).
  useEffect(() => {
    function onReset() {
      for (let i = 0; i < beltCollectedRef.current.length; i++) {
        beltCollectedRef.current[i] = false;
      }
      // Trigger a re-render of the BeltPickup meshes via the version bump.
      setBeltVersion((v) => v + 1);
    }
    window.addEventListener("play-mode-reset", onReset);
    return () => window.removeEventListener("play-mode-reset", onReset);
  }, []);
  // Bump this state every time the collected set changes so the
  // BeltPickup meshes (which read the ref) actually re-render to
  // hide the picked-up ones.
  const [beltVersion, setBeltVersion] = useState(0);

  // Lazy-river belts — same tally / dispatch pattern as the plaza
  // belts. Tracked separately so they can persist across plaza belt
  // resets (river belts are mounted in BOTH play and portfolio mode
  // since the river is also a portfolio easter egg).
  const riverBeltCollectedRef = useRef<boolean[]>(
    RIVER_BELT_PICKUPS.map(() => false)
  );
  const [riverBeltVersion, setRiverBeltVersion] = useState(0);
  useEffect(() => {
    function onReset() {
      for (let i = 0; i < riverBeltCollectedRef.current.length; i++) {
        riverBeltCollectedRef.current[i] = false;
      }
      setRiverBeltVersion((v) => v + 1);
    }
    window.addEventListener("play-mode-reset", onReset);
    return () => window.removeEventListener("play-mode-reset", onReset);
  }, []);

  // EXIT-the-ride request from GameShell's overlay button. Pause-
  // sets exitPending; the tubing tick consumes it on the next frame
  // and runs the exit path (walk back to plaza, etc.).
  useEffect(() => {
    function onExit() {
      const r = refs.river.current;
      if (r.active) r.exitPending = true;
    }
    window.addEventListener("river-exit", onExit);
    return () => window.removeEventListener("river-exit", onExit);
  }, [refs.river]);

  // DONE-with-putt request from the GameShell overlay button. Exits
  // putting mode and snaps the kid 3u north of the tee so they're
  // back on grass (outside the auto-board trigger) when control
  // returns. Mirrors the river exit pattern.
  useEffect(() => {
    function onDone() {
      const p = refs.putting.current;
      if (!p.active) return;
      const c = refs.char.current;
      p.active = false;
      p.charging = false;
      p.power = 0;
      p.phase = "idle";
      p.phaseT = 0;
      p.ballVx = 0;
      p.ballVz = 0;
      p.ballX = GOLF_BALL_START.x;
      p.ballZ = GOLF_BALL_START.z;
      // Snap NORTH of the green so the next play-mode tick doesn't
      // immediately re-trigger the proximity auto-board.
      c.x = GOLF_TEE.x;
      c.z = GOLF_TEE.z - 4;
      c.mode = "idle";
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("putting-active", { detail: false })
        );
      }
    }
    window.addEventListener("putt-done", onDone);
    return () => window.removeEventListener("putt-done", onDone);
  }, [refs.putting, refs.char]);

  // Space-key tracking for putt power-charge. The main keysRef
  // already has `jump` (Space) as an edge-triggered key, but the
  // putting tick needs to know whether Space is CURRENTLY HELD
  // (continuous, not edge), so we track that separately with its
  // own listeners. Active only on coarse-pointer + play-mode
  // sessions so the listeners don't fire constantly elsewhere.
  const spaceHeldRef = useRef(false);
  useEffect(() => {
    function isSpace(e: KeyboardEvent) {
      return e.code === "Space" || e.key === " ";
    }
    function onDown(e: KeyboardEvent) {
      if (!playModeRef.current) return;
      if (isSpace(e)) {
        spaceHeldRef.current = true;
        e.preventDefault();
      }
    }
    function onUp(e: KeyboardEvent) {
      if (isSpace(e)) {
        spaceHeldRef.current = false;
      }
    }
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, []);



  // Game tick — runs every frame
  useFrame((state, dt) => {
    const clampedDt = Math.min(0.1, dt);
    const char = refs.char.current;
    const target = refs.target.current;
    const gator = refs.gator.current;
    const coaster = refs.coaster.current;

    // ── PLAY MODE TICK ──
    // When play mode is active, skip the entire portfolio tick
    // (easter eggs, walk-to-target, gator chase, etc.) and run the
    // tiny Mario-style platformer instead: WASD/arrow movement,
    // gravity + jump, and belt pickup detection. Click-to-walk
    // and easter eggs are gated off by the playMode checks in the
    // handle*Click functions, so the only thing controlling Sonny
    // is the keyboard.
    if (playModeRef.current && isOnHome) {
      // If the kid is already on the lazy-river tube (entered by
      // walking onto the boarding platform below) OR addressing a
      // play-mode putt at the green, skip the play-mode movement /
      // gravity / pickup code and let the portfolio tubing or
      // putting branch drive char this frame. Both branches re-read
      // keysRef each frame so the tank-control keys map naturally:
      // tubing → A/D drift, putting → A/D aim + Space charge.
      if (char.mode === "tubing" || char.mode === "putting") {
        // fall through to the portfolio tick below
      } else {
      const keys = keysRef.current;
      // Tank controls: A/D rotate the body in place (LEFT = CCW from
      // above, which is the character's own LEFT; RIGHT = CW). W/S
      // translate along the body's facing direction. Turn rate is
      // small per frame so brief taps produce small rotations
      // (~5° per 50ms tap), while held keys give a continuous
      // ~100°/sec turn. Earlier this branch was camera-relative
      // strafe, which read as "left arrow turns the character
      // right" (the strafe vector pointed world-left but the body
      // had to rotate 90° CW to face that direction) — fixed by
      // making A/D do explicit rotation instead.
      if (keys.left)  char.angle += PLAY_TURN_RATE * clampedDt;
      if (keys.right) char.angle -= PLAY_TURN_RATE * clampedDt;
      // Forward / back along the body's facing direction. Press W
      // to walk forward in whichever way Sonny is currently looking;
      // press S to back up.
      let mz = 0;
      if (keys.forward) mz = 1;
      if (keys.back) mz = -1;
      if (mz !== 0) {
        const dirX = Math.sin(char.angle) * mz;
        const dirZ = Math.cos(char.angle) * mz;
        const step = PLAY_MOVE_SPEED * clampedDt;
        const proposed = resolveCollisions(
          char.x + dirX * step,
          char.z + dirZ * step
        );
        char.x = proposed.x;
        char.z = proposed.z;
        char.walking = true;
        char.stepPhase = (char.stepPhase + clampedDt * 4.5) % 1;
      } else {
        char.walking = false;
        char.stepPhase = 0;
      }
      // Gravity + jump. char.y is the vertical position above the
      // ground (y=0 is grounded). Jump key is edge-triggered — set
      // by keydown, consumed and cleared here so a held SPACE only
      // fires one jump per landing.
      if (char.grounded && keys.jump) {
        char.vy = PLAY_JUMP_VELOCITY;
        char.grounded = false;
      }
      keys.jump = false;
      char.vy -= PLAY_GRAVITY * clampedDt;
      char.y += char.vy * clampedDt;
      if (char.y <= 0) {
        char.y = 0;
        char.vy = 0;
        char.grounded = true;
      }
      // Belt pickup — radial distance check (ignores height so
      // jumping into a floating belt also counts).
      for (let i = 0; i < BELT_PICKUPS.length; i++) {
        if (beltCollectedRef.current[i]) continue;
        const s = BELT_PICKUPS[i];
        const dx = char.x - s.x;
        const dz = char.z - s.z;
        if (Math.hypot(dx, dz) < BELT_PICKUP_RADIUS) {
          beltCollectedRef.current[i] = true;
          setBeltVersion((v) => v + 1);
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("belt-collected", { detail: i })
            );
          }
        }
      }
      // Make sure the play-mode tick fully owns char state — no
      // portfolio targets / approaches dribble in from a previous
      // session. Clear them once on entry; the useEffect on the
      // GameShell side fires play-mode-reset on toggle.
      // (Done lazily: if any of these are non-null while playMode
      // is true, zero them out.)
      if (refs.target.current) refs.target.current = null;
      if (refs.pathQueue.current.length) refs.pathQueue.current = [];

      // Auto-board the lazy-river tube — if the kid walks anywhere
      // near the river footprint (within ~4 units of the boarding
      // deck, which covers most of the north bank of the loop), hop
      // in the tube and start floating. Easter-egg-mode-style click
      // boarding is still available in portfolio mode; play mode has
      // no clicks so proximity is the trigger. r.mode = "play" →
      // ride forever until the EXIT button is tapped.
      if (
        !refs.river.current.active &&
        Math.hypot(char.x - RIVER_ENTRY.x, char.z - RIVER_ENTRY.z) < 4.0
      ) {
        const r = refs.river.current;
        r.active = true;
        r.riding = true;
        r.mode = "play";
        r.t = 0;
        r.offset = 0;
        r.laps = 0;
        r.exitPending = false;
        char.mode = "tubing";
        char.walking = false;
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("river-active", { detail: true })
          );
        }
      } else if (
        // Auto-board into the play-mode putt — same proximity
        // pattern as the river. Pins the kid at the tee, faces
        // them south by default (toward the cup), and resets the
        // ball + putting state. The portfolio putting branch below
        // drives aim/charge/release from keysRef each frame.
        !refs.putting.current.active &&
        Math.hypot(char.x - GOLF_TEE.x, char.z - GOLF_TEE.z) < PUTT_TRIGGER_RADIUS
      ) {
        const p = refs.putting.current;
        p.active = true;
        p.charging = false;
        p.power = 0;
        p.phase = "idle";
        p.phaseT = 0;
        p.ballX = GOLF_BALL_START.x;
        p.ballZ = GOLF_BALL_START.z;
        p.ballVx = 0;
        p.ballVz = 0;
        char.x = GOLF_TEE.x;
        char.z = GOLF_TEE.z;
        char.angle = 0; // face south toward the cup
        char.mode = "putting";
        char.walking = false;
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("putting-active", { detail: true })
          );
        }
      } else {
        char.mode = "idle";
      }
      return; // skip the entire portfolio tick below
      }
    }

    // ── 0ab. Travis + Kate balloon adventure ──
    // Multi-phase state machine that runs independently of Sonny.
    // Sonny stays on the plaza; Travis and Kate are the riders.
    if (refs.balloonAdventure.current.active) {
      const adv = refs.balloonAdventure.current;
      const trav = refs.travis.current;
      const k = refs.kate.current;

      if (adv.phase === "kateWalking") {
        // Kate walks from the academy spawn to her boarding spot.
        const dx = ADV_KATE_BOARDING.x - k.x;
        const dz = ADV_KATE_BOARDING.z - k.z;
        const dist = Math.hypot(dx, dz);
        const step = WALK_SPEED * clampedDt;
        if (dist <= step) {
          k.x = ADV_KATE_BOARDING.x;
          k.z = ADV_KATE_BOARDING.z;
          k.walking = false;
          k.stepPhase = 0;
          // Face the basket so the next phase's "climb in" looks
          // natural (she pivots into the basket from behind).
          k.angle = Math.atan2(
            BALLOON_POSITION.x - k.x,
            BALLOON_POSITION.z - k.z
          );
          adv.phase = "boarding";
          adv.t = 0;
        } else {
          k.x += (dx / dist) * step;
          k.z += (dz / dist) * step;
          k.angle = Math.atan2(dx, dz);
          k.walking = true;
          k.stepPhase = (k.stepPhase + clampedDt * 4.5) % 1;
        }
        // Sanity guard: if she somehow gets stuck (shouldn't), still
        // advance after a generous timeout so the adventure isn't
        // soft-locked.
        adv.t += clampedDt / ADV_KATE_WALK_DURATION;
        if (adv.t > 1.4 && dist > 0.1) {
          // Snap her to the boarding spot and proceed
          k.x = ADV_KATE_BOARDING.x;
          k.z = ADV_KATE_BOARDING.z;
          k.walking = false;
          adv.phase = "boarding";
          adv.t = 0;
        }
      } else if (adv.phase === "boarding") {
        // Climb in: lerp both characters from their waiting spots
        // to their basket positions over a short beat. Faces look
        // toward the camera (south, angle=0) — keeps the photos
        // billboarded clearly during the ride.
        adv.t += clampedDt / ADV_BOARDING_DURATION;
        const p = Math.min(1, adv.t);
        // Smoothstep for an eased climb-in (no abrupt start/stop).
        const e = p * p * (3 - 2 * p);
        // Travis from his home to his basket spot.
        trav.x = ADV_RETURN_TRAVIS.x + (ADV_TRAVIS_BASKET.x - ADV_RETURN_TRAVIS.x) * e;
        trav.z = ADV_RETURN_TRAVIS.z + (ADV_TRAVIS_BASKET.z - ADV_RETURN_TRAVIS.z) * e;
        trav.angle = 0;
        trav.walking = false;
        // Kate from her boarding spot to her basket spot.
        k.x = ADV_KATE_BOARDING.x + (ADV_KATE_BASKET.x - ADV_KATE_BOARDING.x) * e;
        k.z = ADV_KATE_BOARDING.z + (ADV_KATE_BASKET.z - ADV_KATE_BOARDING.z) * e;
        k.angle = 0;
        k.walking = false;
        if (adv.t >= 1) {
          adv.phase = "rising";
          adv.t = 0;
        }
      } else if (adv.phase === "rising") {
        // Balloon lifts off carrying both characters in the basket.
        adv.t += clampedDt / ADV_RISE_DURATION;
        const p = Math.min(1, adv.t);
        // Ease the rise (slow start, slow end) for a "majestic
        // balloon takeoff" feel rather than a uniform crank.
        const e = p * p * (3 - 2 * p);
        adv.balloonY = e * ADV_RISE_HEIGHT;
        // Riders track the basket — y = balloon height + small
        // offset so feet sit on the basket floor.
        trav.x = ADV_TRAVIS_BASKET.x;
        trav.z = ADV_TRAVIS_BASKET.z;
        trav.y = adv.balloonY + 0.28;
        trav.angle = 0;
        k.x = ADV_KATE_BASKET.x;
        k.z = ADV_KATE_BASKET.z;
        k.y = adv.balloonY + 0.28;
        k.angle = 0;
        if (adv.t >= 1) {
          adv.phase = "atTop";
          adv.t = 0;
          adv.balloonY = ADV_RISE_HEIGHT;
        }
      } else if (adv.phase === "atTop") {
        // Brief pause at the peak. Pretty much same as the end of
        // rising — characters in basket, balloon at full height.
        adv.t += clampedDt / ADV_AT_TOP_DURATION;
        trav.y = adv.balloonY + 0.28;
        k.y = adv.balloonY + 0.28;
        if (adv.t >= 1) {
          adv.phase = "jumping";
          adv.t = 0;
        }
      } else if (adv.phase === "jumping") {
        // Both leap out of the basket — small forward arc into a
        // brief free-fall. Mostly drops a short distance before
        // chutes deploy. Travis nudges -x (west), Kate +x (east)
        // so they spread out and don't overlap during the chute.
        // Balloon STAYS at peak — gives the characters a clean
        // mid-air silhouette without the balloon backdrop.
        adv.t += clampedDt / ADV_JUMP_DURATION;
        const p = Math.min(1, adv.t);
        const drop = p * 2.5;
        trav.x = ADV_TRAVIS_BASKET.x - p * 0.6;
        trav.z = ADV_TRAVIS_BASKET.z + p * 0.4;
        trav.y = ADV_RISE_HEIGHT + 0.28 - drop;
        k.x = ADV_KATE_BASKET.x + p * 0.6;
        k.z = ADV_KATE_BASKET.z + p * 0.4;
        k.y = ADV_RISE_HEIGHT + 0.28 - drop;
        adv.balloonY = ADV_RISE_HEIGHT;
        if (adv.t >= 1) {
          adv.phase = "parachuting";
          adv.t = 0;
        }
      } else if (adv.phase === "parachuting") {
        // Slow descent with parachutes deployed. Linear fall plus a
        // gentle horizontal sway so the chutes don't drop in a
        // perfectly straight line. Balloon STAYS at peak (above the
        // chutes) so the camera (which now follows the chutes) can
        // frame the descent without the balloon cluttering the
        // background. The balloon's own descent happens during the
        // returning phase, after the characters have landed.
        adv.t += clampedDt / ADV_PARACHUTE_DURATION;
        const p = Math.min(1, adv.t);
        const startY = ADV_RISE_HEIGHT - 2.5 + 0.28;
        const fallY = startY * (1 - p);
        const swayT = Math.sin(adv.t * Math.PI * 3) * 0.18;
        trav.x = ADV_TRAVIS_BASKET.x - 0.6 + swayT;
        trav.z = ADV_TRAVIS_BASKET.z + 0.4;
        trav.y = Math.max(0, fallY);
        k.x = ADV_KATE_BASKET.x + 0.6 - swayT;
        k.z = ADV_KATE_BASKET.z + 0.4;
        k.y = Math.max(0, fallY);
        adv.balloonY = ADV_RISE_HEIGHT;
        if (adv.t >= 1) {
          adv.phase = "landing";
          adv.t = 0;
        }
      } else if (adv.phase === "landing") {
        // Touchdown beat — both on the ground, parachutes vanish
        // (handled by phase-aware visibility in Parachute component).
        // Balloon STILL at peak; it descends during returning.
        adv.t += clampedDt / ADV_LANDING_DURATION;
        trav.y = 0;
        k.y = 0;
        adv.balloonY = ADV_RISE_HEIGHT;
        if (adv.t >= 1) {
          adv.phase = "kiss";
          adv.t = 0;
        }
      } else if (adv.phase === "kiss") {
        // Kate steps over to Travis and gives him a kiss before they
        // both head home. Three sub-phases:
        //   0.00..0.30 — Kate slides over to Travis's east side
        //   0.30..0.85 — both turn to face each other, hold close
        //                (the photo billboards always face the
        //                 camera so we see both their faces in
        //                 profile-distance, like a "smooch shot")
        //   0.85..1.00 — Kate eases back slightly so it doesn't snap
        adv.t += clampedDt / ADV_KISS_DURATION;
        const p = Math.min(1, adv.t);
        adv.balloonY = ADV_RISE_HEIGHT;
        trav.y = 0;
        k.y = 0;
        // Travis stays put + turns east to face Kate.
        const travKissAngle = Math.PI / 2; // face east (+X)
        const kateKissAngle = -Math.PI / 2; // face west (-X), at Travis
        trav.angle = travKissAngle;
        // Kate's X — lerp from her landing spot (east of basket) in
        // to right next to Travis on his east side.
        const kateLandingX = ADV_KATE_BASKET.x + 0.6;
        const kateKissX = trav.x + ADV_KISS_KATE_OFFSET_X;
        // Slide-in 0..0.3 with smoothstep, hold 0.3..0.85, ease
        // back 0.85..1.0 just barely (so the transition to walking
        // away doesn't snap).
        let slideP = 0;
        if (p < 0.3) {
          const sp = p / 0.3;
          slideP = sp * sp * (3 - 2 * sp);
        } else if (p < 0.85) {
          slideP = 1;
        } else {
          const sp = (1 - p) / 0.15;
          slideP = 0.85 + (sp * sp * (3 - 2 * sp)) * 0.15;
        }
        k.x = kateLandingX + (kateKissX - kateLandingX) * slideP;
        k.z = trav.z;
        k.angle = kateKissAngle;
        k.walking = false;
        if (adv.t >= 1) {
          adv.phase = "returning";
          adv.t = 0;
        }
      } else if (adv.phase === "returning") {
        // Balloon descends from peak to ground while the characters
        // walk back home. Kate's walk-back is the longest path, so
        // by the time she reaches the academy the balloon should be
        // settled — both end at roughly the same moment.
        adv.balloonY = Math.max(0, adv.balloonY - ADV_BALLOON_DESCENT_RATE * clampedDt);
        // Advance t as elapsed-seconds-in-phase so the Heart
        // component (and anything else that needs a returning-
        // local clock) can use it directly — without it, t stays
        // pinned at 0 the whole walk-back and consumers can't
        // tell how far through the phase we are.
        adv.t += clampedDt;
        // Both walk back to their home spots — Travis to his stand-
        // beside-the-balloon spot, Kate to the academy door (where
        // she'll go back inside / disappear). Easter egg ends when
        // BOTH have arrived.
        const step = WALK_SPEED * clampedDt;
        // Travis returns to his home spot.
        const tdx = ADV_RETURN_TRAVIS.x - trav.x;
        const tdz = ADV_RETURN_TRAVIS.z - trav.z;
        const tdist = Math.hypot(tdx, tdz);
        let travArrived = false;
        if (tdist <= step) {
          trav.x = ADV_RETURN_TRAVIS.x;
          trav.z = ADV_RETURN_TRAVIS.z;
          trav.angle = 0; // face camera at home spot
          trav.walking = false;
          trav.stepPhase = 0;
          travArrived = true;
        } else {
          trav.x += (tdx / tdist) * step;
          trav.z += (tdz / tdist) * step;
          trav.angle = Math.atan2(tdx, tdz);
          trav.walking = true;
          trav.stepPhase = (trav.stepPhase + clampedDt * 4.5) % 1;
        }
        // Kate returns to the academy door.
        const kdx = ADV_KATE_SPAWN.x - k.x;
        const kdz = ADV_KATE_SPAWN.z - k.z;
        const kdist = Math.hypot(kdx, kdz);
        let kateArrived = false;
        if (kdist <= step) {
          k.x = ADV_KATE_SPAWN.x;
          k.z = ADV_KATE_SPAWN.z;
          k.walking = false;
          k.stepPhase = 0;
          kateArrived = true;
        } else {
          k.x += (kdx / kdist) * step;
          k.z += (kdz / kdist) * step;
          k.angle = Math.atan2(kdx, kdz);
          k.walking = true;
          k.stepPhase = (k.stepPhase + clampedDt * 4.5) % 1;
        }
        if (travArrived && kateArrived) {
          // Both home — end the adventure. Kate disappears (she's
          // back inside the academy); Travis stays standing at his
          // spot. Easter egg is now replayable.
          adv.active = false;
          adv.t = 0;
          adv.phase = "kateWalking";
          adv.balloonY = 0;
          k.visible = false;
          dispatchFound("balloon");
        }
      }
      // Compute the "action" Y the camera should frame this phase.
      // - boarding / kateWalking / landing / returning: ground (0)
      // - rising / atTop: tied to the balloon (characters in basket)
      // - jumping / parachuting: average of Travis + Kate Y (mid-air)
      // The camera reads adv.riderY (NOT balloonY) for its target/
      // position so the balloon can stay at peak while the camera
      // follows the parachuters down.
      if (adv.phase === "rising" || adv.phase === "atTop") {
        adv.riderY = adv.balloonY;
      } else if (adv.phase === "jumping" || adv.phase === "parachuting") {
        adv.riderY = (trav.y + k.y) / 2;
      } else {
        adv.riderY = 0;
      }
      // Mirror the adventure's balloonY onto the legacy balloonRef
      // so the Balloon component (which reads balloonRef.height)
      // visually rises in sync with the adventure. We also flag
      // balloonRef.active so it stays at height instead of lerping
      // back to 0 each frame. Cleared when adventure ends.
      if (adv.active) {
        refs.balloon.current.active = true;
        refs.balloon.current.height = adv.balloonY;
      } else {
        refs.balloon.current.active = false;
        refs.balloon.current.height = 0;
      }
    }

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

    // ── 0aa. Lazy river — float along the loop in a Gracie-red tube ──
    // Tube advances along RIVER_CURVE at RIVER_CURRENT_SPEED. In play
    // mode the kid steers sideways via the same A/D keys used for
    // tank-turning on land — they're parked in keysRef regardless of
    // mode so we just read them. In easter-egg mode the offset stays
    // at 0 (centre channel) and the ride auto-exits after one loop.
    if (char.mode === "tubing") {
      const r = refs.river.current;
      // Advance around the loop. Wrap t into [0, 1) and bump the lap
      // count whenever we cross t=0 going forward.
      const prevT = r.t;
      r.t = (r.t + RIVER_CURRENT_SPEED * clampedDt) % 1;
      if (r.t < prevT) r.laps += 1;
      // Steering — only in play mode. left key = drift left (-offset),
      // right key = drift right (+offset). Clamped to [-1, +1].
      if (r.mode === "play") {
        const k = keysRef.current;
        const dir = (k.right ? 1 : 0) + (k.left ? -1 : 0);
        if (dir !== 0) {
          r.offset = Math.max(
            -1,
            Math.min(1, r.offset + dir * RIVER_DRIFT_SPEED * clampedDt)
          );
        }
      }
      // Sample the curve and position the character. char.y is set
      // so the hips (body-local y=0.66) sit on the tube's top
      // surface (tube center y=0.16, radius 0.22 → top y=0.38).
      // The Character useFrame reads c.y straight into root.y for
      // tubing mode, so the kid's torso lands inside the donut.
      const pos = riverWorldAt(r.t, r.offset);
      char.x = pos.x;
      char.z = pos.z;
      char.y = -0.28;
      char.angle = pos.angle;
      // Belt pickup while floating — staggered across the channel
      // width so the kid has to actively steer. Same window event
      // as the plaza belts so the HUD tally counts them uniformly.
      for (let i = 0; i < RIVER_BELT_PICKUPS.length; i++) {
        if (riverBeltCollectedRef.current[i]) continue;
        const b = RIVER_BELT_PICKUPS[i];
        const bp = riverWorldAt(b.t, b.offset);
        const dx = char.x - bp.x;
        const dz = char.z - bp.z;
        if (Math.hypot(dx, dz) < 1.0) {
          riverBeltCollectedRef.current[i] = true;
          setRiverBeltVersion((v) => v + 1);
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("belt-collected", { detail: `river-${i}` })
            );
          }
        }
      }
      // Exit conditions: easter-egg auto-exits after 1 lap; play mode
      // exits when the EXIT overlay button dispatches river-exit.
      const shouldExit =
        r.exitPending || (r.mode === "egg" && r.laps >= 1);
      if (shouldExit) {
        const finishedEggRide = r.mode === "egg" && !r.exitPending;
        r.active = false;
        r.riding = false;
        r.exitPending = false;
        r.laps = 0;
        r.t = 0;
        r.offset = 0;
        char.mode = "idle";
        char.y = 0;
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("river-active", { detail: false })
          );
        }
        if (finishedEggRide) dispatchFound("river");
        // Snap onto grass just NORTH of the boarding deck so the
        // walk home doesn't start with the character standing on
        // the water plane. Pulled north of the 4u auto-board zone
        // so a play-mode exit doesn't instantly re-board the kid
        // before they get to walk anywhere.
        char.x = RIVER_ENTRY.x;
        char.z = RIVER_ENTRY.z - 5;
        // Walk back to the plaza — route via bypass waypoints so the
        // path home doesn't clip the southern hill cluster. Sprint
        // home so the long return doesn't feel like a slog.
        const path = routeTo(char.x, char.z, 0, 0);
        const first = path[0];
        refs.target.current = { x: first.x, z: first.z, sectionId: null, sprint: true };
        refs.pathQueue.current = path.slice(1);
        char.walking = true;
      }
    }

    // ── 0ab. Play-mode interactive putt at the golf green ──
    // Pinned at GOLF_TEE. A/D rotates the body angle (= aim
    // direction). Holding Space charges power; releasing fires the
    // ball along the body's facing direction at PUTT_MAX_LAUNCH_SPEED
    // × power. Ball decelerates from friction; if it stops near the
    // cup at low speed → sunk. Otherwise → missed; ball respawns at
    // the tee after a short beat.
    if (char.mode === "putting") {
      const p = refs.putting.current;
      const k = keysRef.current;
      // Hard-pin the character at the tee — the auto-board snapped
      // them here, and the play-mode tick has been short-circuited
      // for putting so nothing else can move them off the spot.
      char.x = GOLF_TEE.x;
      char.z = GOLF_TEE.z;
      char.y = 0;
      char.walking = false;

      if (p.phase === "idle") {
        // Aim — A turns CCW (player-relative LEFT), D turns CW.
        // Same sign convention as the on-land tank controls so the
        // muscle memory carries over.
        if (k.left)  char.angle += PUTT_AIM_TURN_RATE * clampedDt;
        if (k.right) char.angle -= PUTT_AIM_TURN_RATE * clampedDt;
        // Power charge — Space-down builds power up to 1, Space-up
        // releases the putt. The Space key in keysRef is edge-
        // triggered (set on keydown, NOT cleared on keyup), so we
        // mirror its current pressed state via a separate
        // `spaceHeldRef`. (Tracked below via an effect to keep this
        // useFrame branch simple — see the spaceHeldRef setup.)
        if (spaceHeldRef.current) {
          if (!p.charging) {
            // rising edge — start charging
            p.charging = true;
            p.power = 0;
          }
          p.power = Math.min(1, p.power + clampedDt / PUTT_CHARGE_TIME);
        } else if (p.charging) {
          // falling edge — release the putt
          p.charging = false;
          const speed = PUTT_MAX_LAUNCH_SPEED * Math.max(0.15, p.power);
          // Launch direction = body facing (atan2(sin, cos) lives in
          // char.angle already). Body angle 0 = +Z (south), positive
          // = CCW from above.
          p.ballVx = speed * Math.sin(char.angle);
          p.ballVz = speed * Math.cos(char.angle);
          p.phase = "rolling";
          p.phaseT = 0;
          p.power = 0;
          p.attempts += 1;
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("putt-stats", {
                detail: { attempts: p.attempts, sinks: p.sinks, power: 0 },
              })
            );
          }
        } else {
          // Live-update the HUD with the charging power so the
          // meter fills smoothly. (Only dispatch when there's
          // visible change to avoid spamming.)
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("putt-stats", {
                detail: { attempts: p.attempts, sinks: p.sinks, power: 0 },
              })
            );
          }
        }
        // Continuously broadcast power for the HUD when charging.
        if (p.charging && typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("putt-stats", {
              detail: { attempts: p.attempts, sinks: p.sinks, power: p.power },
            })
          );
        }
      } else if (p.phase === "rolling") {
        // Integrate position + apply friction.
        const speed = Math.hypot(p.ballVx, p.ballVz);
        if (speed > 0) {
          const decel = PUTT_FRICTION * clampedDt;
          const newSpeed = Math.max(0, speed - decel);
          const f = newSpeed / speed;
          p.ballVx *= f;
          p.ballVz *= f;
        }
        p.ballX += p.ballVx * clampedDt;
        p.ballZ += p.ballVz * clampedDt;
        // Cup proximity — sink if close enough AND moving slowly
        // enough to drop in (fast balls roll over the lip).
        const dCup = Math.hypot(p.ballX - GOLF_HOLE.x, p.ballZ - GOLF_HOLE.z);
        const curSpeed = Math.hypot(p.ballVx, p.ballVz);
        if (dCup < PUTT_CUP_RADIUS && curSpeed < PUTT_SINK_SPEED_MAX) {
          // SUNK
          p.ballX = GOLF_HOLE.x;
          p.ballZ = GOLF_HOLE.z;
          p.ballVx = 0;
          p.ballVz = 0;
          p.phase = "sunk";
          p.phaseT = 0;
          p.sinks += 1;
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("putt-stats", {
                detail: { attempts: p.attempts, sinks: p.sinks, power: 0 },
              })
            );
            // Each sink earns another belt — golf is the only
            // belt-generator the kid can repeat indefinitely.
            // The plaza + river belts are finite (5 + 3 = 8); putts
            // can push the BeltHUD above 8 as a high-score effect.
            window.dispatchEvent(
              new CustomEvent("belt-collected", {
                detail: `putt-${p.sinks}`,
              })
            );
          }
        } else if (curSpeed < PUTT_STOP_SPEED) {
          // Ball stopped without sinking — MISS
          p.ballVx = 0;
          p.ballVz = 0;
          p.phase = "missed";
          p.phaseT = 0;
        }
      } else if (p.phase === "sunk") {
        p.phaseT += clampedDt;
        if (p.phaseT >= PUTT_SUNK_BEAT) {
          // Reset for the next attempt — ball back at the tee.
          p.ballX = GOLF_BALL_START.x;
          p.ballZ = GOLF_BALL_START.z;
          p.phase = "idle";
          p.phaseT = 0;
        }
      } else if (p.phase === "missed") {
        p.phaseT += clampedDt;
        if (p.phaseT >= PUTT_MISSED_BEAT) {
          // Respawn the ball at the tee for another try.
          p.ballX = GOLF_BALL_START.x;
          p.ballZ = GOLF_BALL_START.z;
          p.phase = "idle";
          p.phaseT = 0;
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
        dispatchFound("golf");
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
          dispatchFound("coaster");
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
        dispatchFound("gator");
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
            sprint: target.sprint,
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
          } else if (refs.approachingRiver.current) {
            // Climb into the tube — start the lazy-river ride in
            // easter-egg mode (one loop then auto-exit). The tubing
            // state machine drives char position from here on out.
            refs.approachingRiver.current = false;
            char.mode = "tubing";
            char.walking = false;
            const r = refs.river.current;
            r.active = true;
            r.riding = true;
            r.mode = "egg";
            r.t = 0;
            r.offset = 0;
            r.laps = 0;
            r.exitPending = false;
            if (typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent("river-active", { detail: true })
              );
            }
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
        const sprinting = !!target.sprint;
        const speed = sprinting ? SPRINT_SPEED : WALK_SPEED;
        // Step cadence: sprint matches the flee gait (4.5 cycles/sec)
        // so the legs visibly run instead of doing a fast moonwalk.
        const stepRate = sprinting ? 4.5 : 2.2;
        const step = speed * clampedDt;
        const proposed = resolveCollisions(
          char.x + (dx / dist) * step,
          char.z + (dz / dist) * step
        );
        char.x = proposed.x;
        char.z = proposed.z;
        char.angle = Math.atan2(dx, dz);
        char.stepPhase = (char.stepPhase + clampedDt * stepRate) % 1;
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
      refs.char.current.mode === "tubing" ||
      refs.char.current.mode === "putting" ||
      refs.gator.current.chasing ||
      refs.coaster.current.riding ||
      refs.family.current.active ||
      refs.golf.current.active ||
      refs.river.current.active ||
      refs.putting.current.active ||
      refs.balloon.current.active ||
      refs.balloonAdventure.current.active
    );
  }

  // Helper: set a target and pre-populate the path queue with any waypoints
  // needed to bypass building corners between here and there. The optional
  // `sprint` flag plumbs through every waypoint, so the character jogs at
  // SPRINT_SPEED for the whole route — used for the far-away lazy river so
  // it doesn't feel like a slog to get there.
  function walkTo(
    destX: number,
    destZ: number,
    sectionId: SectionId | null,
    sprint = false
  ) {
    const c = refs.char.current;
    const path = routeTo(c.x, c.z, destX, destZ);
    const first = path[0];
    refs.target.current = { x: first.x, z: first.z, sectionId, sprint };
    refs.pathQueue.current = path.slice(1);
    refs.char.current.walking = true;
  }

  // All click handlers no-op during play mode so the kid can run
  // around without accidentally triggering an easter egg or
  // navigating into a section.
  function handleBuildingClick(section: Section) {
    if (!isOnHome || isBusy() || playModeRef.current) return;
    const t = doorTarget(section);
    walkTo(t.x, t.z, section.id);
  }

  function handleGatorClick() {
    if (!isOnHome || isBusy() || playModeRef.current) return;
    // Walk to a spot just in front of the gator (on the line back to plaza)
    const g = refs.gator.current;
    const r = Math.hypot(g.x, g.z);
    const offset = 1.6; // stand this far from the gator before it pounces
    const k = (r - offset) / r;
    walkTo(g.x * k, g.z * k, null);
    refs.approachingGator.current = true;
  }

  function handleParkClick() {
    if (!isOnHome || isBusy() || playModeRef.current) return;
    // Walk to the park entrance (south of park, near the ticket booth)
    walkTo(PARK.x, PARK.z + PARK_ENTRY_WORLD, null);
    refs.approachingPark.current = true;
  }

  function handleGolfClick() {
    if (!isOnHome || isBusy() || playModeRef.current) return;
    walkTo(GOLF_TEE.x, GOLF_TEE.z, null);
    refs.approachingGolf.current = true;
  }

  function handleRiverClick() {
    if (!isOnHome || isBusy() || playModeRef.current) return;
    // River is ~40u south — sprint there so the walk doesn't feel
    // like a slog. Easter-egg mode rides one full loop then exits.
    walkTo(RIVER_ENTRY.x, RIVER_ENTRY.z, null, true);
    refs.approachingRiver.current = true;
  }

  function handleBalloonClick() {
    if (!isOnHome || isBusy() || playModeRef.current) return;
    // NEW BEHAVIOUR: Sonny does NOT walk to the balloon. He stays on
    // the plaza as a spectator. Trigger the Travis+Kate adventure:
    //   - Kate spawns at the academy door
    //   - Kate walks to the balloon
    //   - Both board, balloon rises high
    //   - Both jump out, parachutes deploy
    //   - Both walk back to home positions
    // The camera pans to the balloon vantage while the adventure runs.
    refs.kate.current.x = ADV_KATE_SPAWN.x;
    refs.kate.current.z = ADV_KATE_SPAWN.z;
    refs.kate.current.y = 0;
    refs.kate.current.angle = 0;
    refs.kate.current.walking = true;
    refs.kate.current.stepPhase = 0;
    refs.kate.current.visible = true;
    refs.balloonAdventure.current.active = true;
    refs.balloonAdventure.current.phase = "kateWalking";
    refs.balloonAdventure.current.t = 0;
    refs.balloonAdventure.current.balloonY = 0;
  }

  // The jiu-jitsu and chess sections are rendered as separate 3D
  // scenes (interior of the academy / chess study) instead of
  // overlays. When pathname matches we swap the entire scene graph
  // — the plaza meshes unmount, the room meshes mount, the
  // Character + CameraRig are shared between them.
  const isAcademy = pathname === "/jiu-jitsu";
  const isChess = pathname === "/chess";

  return (
    <>
      {isAcademy ? (
        <Suspense fallback={null}>
          <Academy onExit={() => router.push("/")} characterId={characterId} />
        </Suspense>
      ) : isChess ? (
        <Suspense fallback={null}>
          <ChessRoom onExit={() => router.push("/")} />
        </Suspense>
      ) : (
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
            riverRef={refs.river}
            riverBeltCollectedRef={riverBeltCollectedRef}
            riverBeltVersion={riverBeltVersion}
            onRiverClick={handleRiverClick}
            puttingRef={refs.putting}
            charRef={refs.char}
            balloonRef={refs.balloon}
            onBalloonClick={handleBalloonClick}
            travisRef={refs.travis}
            kateRef={refs.kate}
            balloonAdventureRef={refs.balloonAdventure}
          />
          {SECTIONS.map((s) => (
            <Building
              key={s.id}
              section={s}
              doorsRef={refs.doors}
              onSelect={() => handleBuildingClick(s)}
            />
          ))}
          <Family familyRef={refs.family} />
          {/* Black-belt collectibles for the tiny play-mode demo.
              Mounted only when playMode is on so they don't clutter
              portfolio mode. beltVersion bumps when any are
              collected, forcing a re-render so the visibility flag
              on each BeltPickup updates. */}
          {playMode &&
            BELT_PICKUPS.map((s, i) => (
              <BeltPickup
                key={`belt-${i}-${beltVersion}`}
                position={s}
                index={i}
                collectedRef={beltCollectedRef}
              />
            ))}
        </>
      )}
      <Suspense fallback={null}>
        <Character
          charRef={refs.char}
          golfRef={refs.golf}
          balloonRef={refs.balloon}
          characterId={
            // In the chess study Sonny is the visible opponent — he's
            // baked into the scene framing, so we always render him as
            // Sonny regardless of the user's selection.
            isChess ? "sonny" : characterId
          }
          visible={true}
          // Center character is the ALREADY-SELECTED one — no
          // re-selection needed. Click target is only on the OTHER
          // two characters (rendered as TrainingPartners on the
          // sides), which trigger the swap. Leaving Character
          // unclickable also prevents accidental clicks while
          // playing on the plaza.
          onSelect={undefined}
        />
      </Suspense>
      <CameraRig
        charRef={refs.char}
        gatorRef={refs.gator}
        balloonAdventureRef={refs.balloonAdventure}
        pathname={pathname}
        camDefault={camDefault}
        playMode={playMode}
        playCamSnapRef={playCamSnapRef}
      />
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
  riverRef,
  riverBeltCollectedRef,
  riverBeltVersion,
  onRiverClick,
  puttingRef,
  charRef,
  balloonRef,
  onBalloonClick,
  travisRef,
  kateRef,
  balloonAdventureRef,
}: {
  gatorRef: React.MutableRefObject<GatorState>;
  onGatorClick: () => void;
  coasterRef: React.MutableRefObject<CoasterState>;
  onParkClick: () => void;
  golfRef: React.MutableRefObject<GolfState>;
  onGolfClick: () => void;
  riverRef: React.MutableRefObject<RiverState>;
  riverBeltCollectedRef: React.MutableRefObject<boolean[]>;
  riverBeltVersion: number;
  onRiverClick: () => void;
  puttingRef: React.MutableRefObject<PuttingState>;
  charRef: React.MutableRefObject<CharState>;
  balloonRef: React.MutableRefObject<BalloonState>;
  onBalloonClick: () => void;
  travisRef: React.MutableRefObject<AvatarState>;
  kateRef: React.MutableRefObject<AvatarState>;
  balloonAdventureRef: React.MutableRefObject<BalloonAdventureState>;
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
      <PalmTree position={[24.5, 0, -28]} scale={1.1} />
      <PalmTree position={[25.2, 0, -14]} scale={1.0} />
      <PalmTree position={[24.8, 0, 0]} scale={1.2} />
      <PalmTree position={[25.4, 0, 18]} scale={1.05} />
      <PalmTree position={[24.6, 0, 32]} scale={1.15} />

      {/* Lake to the northeast, with gator and surrounding palm trees */}
      <Lake position={[9, 0, -8]} radius={2.8} />
      <Alligator gatorRef={gatorRef} onSelect={onGatorClick} />
      <PalmTree position={[6, 0, -10.5]} />
      <PalmTree position={[11.5, 0, -10]} scale={1.15} />
      <PalmTree position={[7, 0, -5.2]} scale={0.9} />
      <PalmTree position={[12, 0, -6.3]} />

      {/* Golf course to the southwest */}
      <GolfCourse
        position={[GOLF_POSITION.x, 0, GOLF_POSITION.z]}
        onSelect={onGolfClick}
      />
      <GolfBall golfRef={golfRef} />
      {/* Interactive play-mode putt visuals — the ball that follows
          puttingRef physics, plus an aim arrow that rotates with the
          kid's body angle while addressing the ball. Both hidden
          outside play-mode putting. */}
      <PuttBall puttingRef={puttingRef} />
      <AimArrow puttingRef={puttingRef} charRef={charRef} />

      {/* Hot-air balloon to the south-east (clickable easter egg) */}
      <Balloon balloonRef={balloonRef} onSelect={onBalloonClick} />
      {/* Travis — black-belt friend stationed by the balloon. Position,
          facing, and walking are driven by travisRef so the same figure
          can stand idle, walk into the basket, ride up, parachute down,
          and walk back. Initial ref position is set to the home spot. */}
      <Travis avatarRef={travisRef} />
      {/* Kate-outside — only visible during the balloon adventure (her
          static academy instance keeps rendering on /jiu-jitsu). Walks
          from the academy door to the balloon, rides up, parachutes
          down, walks back. */}
      <KateOutside avatarRef={kateRef} />
      {/* Parachutes — one per character, only visible during the
          parachuting phase. They follow each character down. Red
          for Travis (matches the balloon), cream for Kate (matches
          her gi accent). */}
      <Parachute
        avatarRef={travisRef}
        adventureRef={balloonAdventureRef}
        color="#d94a4a"
        altColor="#f4f1de"
      />
      <Parachute
        avatarRef={kateRef}
        adventureRef={balloonAdventureRef}
        color="#3a6ab0"
        altColor="#f4f1de"
      />
      {/* Love heart that pops above the kiss + floats away as
          Kate walks back home. */}
      <Heart
        adventureRef={balloonAdventureRef}
        travisRef={travisRef}
        kateRef={kateRef}
      />

      {/* Amusement park to the northwest (opposite the golf course) */}
      <AmusementPark onSelect={onParkClick} />
      <CoasterCart coasterRef={coasterRef} />

      {/* Distant rolling hills at the far edges of the world. East
          is ocean, west is cityscape. All near-river hills were
          removed so the river banks stay clean; only the southern
          backdrop pines + hills (z>=72) remain. */}

      {/* Northern mountain ridge — two broad snow-capped peaks
          positioned with the smaller front peak overlapping the
          larger back peak so the silhouette reads as layered depth.
          Back peak is taller, wider, and further north; front peak
          partially occludes its lower-right slope. Both peaks are
          kept west of x≈14 so neither base spills onto the beach
          (which starts at x=18). */}
      <Mountain x={-5} z={-68} height={28} baseRadius={15} snow color="#42523f" />
      <Mountain x={4} z={-58} height={20} baseRadius={10} snow color="#4a5a48" />

      {/* Outdoor lazy river to the south — curved oval water loop,
          sandy beach edges, palm trees + bushes for flavor. Click
          anywhere on the water to send the character to the boarding
          spot and start a one-loop tubing ride. Replaces the gun
          range (which replaced the old farm). */}
      <LazyRiver onSelect={onRiverClick} />
      {/* Wooden bridges across the river channel — N, E, W. The
          character must use one to cross; everywhere else the
          water-collision pushes them back onto the nearest bank. */}
      {RIVER_BRIDGES.map((b, i) => (
        <RiverBridge key={`bridge-${i}`} bridge={b} />
      ))}
      {/* Tube — visible only while the character is riding. Sized
          like a Gracie-red inner tube; child Character is drawn at
          the right XYZ by the tubing state machine. */}
      <Tube riverRef={riverRef} />
      {/* 3 floating belts in the river — staggered across the
          channel width so the kid has to actively steer with
          A/D to grab each one. Rendered in both portfolio + play
          modes so the easter-egg ride is also belt-collecting. */}
      {RIVER_BELT_PICKUPS.map((b, i) => (
        <RiverBeltPickup
          key={`river-belt-${i}-${riverBeltVersion}`}
          index={i}
          spec={b}
          collectedRef={riverBeltCollectedRef}
        />
      ))}

      {/* Distant pine backdrop south of the river — softens the
          horizon so the world doesn't end at a grass edge when the
          camera looks south past the river. */}
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
          drone-tour range vantage fades into a soft horizon instead of
          showing the abrupt line where the grass plane ends. */}
      <FarmMist z={85} />

      {/* Pine forest in the valley between the hills and the
          mountain ridge — softens the transition from the play area
          to the towering peaks. */}
      {/* Pine forest backdrop — kept on the OUTER ring around the
          carnival but cleared from inside the carnival's footprint
          and the lanes directly adjacent to it. Trees too close to
          the carnival meshes clipped through the coaster track and
          the carousel canopy. */}
      <PineTree position={[-35, 0, -38]} scale={1.4} />
      <PineTree position={[-3, 0, -43]} scale={1.55} />
      <PineTree position={[5, 0, -38]} scale={1.7} />
      <PineTree position={[10, 0, -42]} scale={1.4} />
      <PineTree position={[16, 0, -39]} scale={1.3} />
      <PineTree position={[-30, 0, -48]} scale={1.5} />
      <PineTree position={[0, 0, -47]} scale={1.45} />
      <PineTree position={[13, 0, -47]} scale={1.5} />

      {/* Mix of regular oaks and pine trees */}
      <Tree position={[15, 0, 1]} scale={1.1} />
      <Tree position={[-7, 0, 0]} />
      <Tree position={[9, 0, 13]} scale={1.2} />
      <Tree position={[-7, 0, 14]} />
      <Tree position={[2, 0, -16]} scale={1.05} />
      <Tree position={[-19, 0, 5]} />
      <PineTree position={[17, 0, -16]} scale={1.5} />

      {/* Bushes scattered around the perimeter for ground texture */}
      <Bush position={[6, 0, 4]} scale={1.0} />
      <Bush position={[-5, 0, 6]} scale={0.85} color="#356b30" />
      <Bush position={[10, 0, -6]} scale={0.9} />
      <Bush position={[-10, 0, -5]} scale={1.1} color="#446e2a" />
      <Bush position={[-15, 0, 1]} scale={1.05} />
      <Bush position={[-16, 0, -8]} scale={0.9} />
      <Bush position={[-7, 0, -10]} scale={1.0} color="#446e2a" />
      <Bush position={[3, 0, 17]} scale={1.1} />
      <Bush position={[-1, 0, -19]} scale={0.95} color="#356b30" />
      <Bush position={[-20, 0, 16]} scale={1.0} />
      <Bush position={[19, 0, -18]} scale={0.9} color="#446e2a" />

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
      foam1Ref.current.position.x = 27.6 + Math.sin(t * 0.6) * 0.35;
    }
    if (foam2Ref.current) {
      foam2Ref.current.position.x = 28.4 + Math.sin(t * 0.45 + 1.2) * 0.5;
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
        position={[69, 0.01, 0]}
        receiveShadow
      >
        <planeGeometry args={[84, 160]} />
        <meshStandardMaterial color="#3e7ba8" roughness={0.4} metalness={0.1} />
      </mesh>
      {/* Foam line right at the shore — a brighter strip that visually
          separates beach from open water. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[27.3, 0.013, 0]}
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
        position={[27.6, 0.014, 0]}
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
        position={[28.4, 0.014, 0]}
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
        position={[25, 0.011, 0]}
        receiveShadow
      >
        <planeGeometry args={[4, 130]} />
        <meshStandardMaterial color="#e8d4a0" roughness={1} />
      </mesh>
      {/* A few darker wet-sand patches near the waterline. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[26.5, 0.012, 0]}
      >
        <planeGeometry args={[1.1, 130]} />
        <meshStandardMaterial color="#c8b078" roughness={1} />
      </mesh>
      {/* Small grey rocks dotting the sand. */}
      <mesh position={[24.6, 0.12, -22]} castShadow>
        <sphereGeometry args={[0.22, 8, 6]} />
        <meshStandardMaterial color="#9a9a96" roughness={1} />
      </mesh>
      <mesh position={[25.4, 0.1, 4]} castShadow>
        <sphereGeometry args={[0.18, 8, 6]} />
        <meshStandardMaterial color="#8a8a86" roughness={1} />
      </mesh>
      <mesh position={[24.4, 0.14, 14]} castShadow>
        <sphereGeometry args={[0.26, 8, 6]} />
        <meshStandardMaterial color="#a5a5a0" roughness={1} />
      </mesh>
      <mesh position={[25.6, 0.12, 22]} castShadow>
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
    { baseX: -39, baseH: 4.5, hVar: 2.5, litChance: 0.6 }, // closest, shortest
    { baseX: -44, baseH: 7, hVar: 3, litChance: 0.65 }, // mid
    { baseX: -49, baseH: 10, hVar: 4.5, litChance: 0.55 }, // back, tallest
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
const CITY_ANTENNAE = CITY_BUILDINGS.filter((b) => b.x < -46)
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
const ROAD_CENTER_X = -33;
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
// LazyRiver — outdoor curved-oval lazy-river loop south of the plaza.
// Replaces the gun range that replaced the old farm. Blue water inside
// a sandy beach ring, with foam strips animating around the channel.
// The water plane is the click target — anywhere on the water routes
// the character to the boarding spot and starts the tubing ride.
function LazyRiver({ onSelect }: { onSelect: () => void }) {
  const [hover, setHover] = useState(false);

  // Build the water shape as a Shape with a hole for the centre
  // island, then extrude into a flat plane. Done as one big ring
  // so the click target covers the entire water surface.
  const waterShape = useMemo(() => {
    const outer = new THREE.Shape();
    const N = 64;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const x = Math.cos(a) * (RIVER_RX + RIVER_HALF_WIDTH);
      const z = Math.sin(a) * (RIVER_RZ + RIVER_HALF_WIDTH);
      if (i === 0) outer.moveTo(x, z);
      else outer.lineTo(x, z);
    }
    // Inner hole — the island in the middle of the loop.
    const hole = new THREE.Path();
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const x = Math.cos(a) * (RIVER_RX - RIVER_HALF_WIDTH);
      const z = Math.sin(a) * (RIVER_RZ - RIVER_HALF_WIDTH);
      if (i === 0) hole.moveTo(x, z);
      else hole.lineTo(x, z);
    }
    outer.holes.push(hole);
    return outer;
  }, []);

  // Sand beach — same shape but slightly wider, sitting underneath.
  const sandShape = useMemo(() => {
    const outer = new THREE.Shape();
    const N = 64;
    const SAND_W = 1.6;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const x = Math.cos(a) * (RIVER_RX + RIVER_HALF_WIDTH + SAND_W);
      const z = Math.sin(a) * (RIVER_RZ + RIVER_HALF_WIDTH + SAND_W);
      if (i === 0) outer.moveTo(x, z);
      else outer.lineTo(x, z);
    }
    // Inner hole inside the centre island so the sand doesn't bleed
    // INTO the island (the island is grass, not sand).
    const hole = new THREE.Path();
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const x = Math.cos(a) * (RIVER_RX - RIVER_HALF_WIDTH - SAND_W);
      const z = Math.sin(a) * (RIVER_RZ - RIVER_HALF_WIDTH - SAND_W);
      if (i === 0) hole.moveTo(x, z);
      else hole.lineTo(x, z);
    }
    outer.holes.push(hole);
    return outer;
  }, []);

  return (
    <group position={[RIVER_CENTER.x, 0, RIVER_CENTER.z]}>
      {/* Sandy beach ring under the water — peeks out beyond the
          water edge on both inner + outer rims. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.015, 0]}
        receiveShadow
      >
        <shapeGeometry args={[sandShape]} />
        <meshStandardMaterial color="#d9c590" />
      </mesh>
      {/* Water ring — clickable. Slight elevation above the sand
          to avoid z-fighting; tone-mapped off keeps the blue vivid
          even under the warm sun light. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.03, 0]}
        receiveShadow
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHover(true);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={(e) => {
          e.stopPropagation();
          setHover(false);
          document.body.style.cursor = "";
        }}
      >
        <shapeGeometry args={[waterShape]} />
        <meshStandardMaterial
          color={hover ? "#5ab0d0" : "#4a9fc8"}
          roughness={0.3}
          metalness={0.1}
        />
      </mesh>
      {/* Boarding platform on the north bank — small wooden deck
          where the character stands before climbing in. */}
      <mesh position={[RIVER_ENTRY.x - RIVER_CENTER.x, 0.08, RIVER_ENTRY.z - RIVER_CENTER.z]} receiveShadow>
        <boxGeometry args={[3.2, 0.16, 1.4]} />
        <meshStandardMaterial color="#8b6644" />
      </mesh>
      {/* "LAZY RIVER" sign hanging over the boarding platform */}
      <Billboard
        position={[
          RIVER_ENTRY.x - RIVER_CENTER.x,
          3.0,
          RIVER_ENTRY.z - RIVER_CENTER.z - 0.5,
        ]}
      >
        <Text
          fontSize={0.5}
          color="#f4f1de"
          outlineColor="#1a0e08"
          outlineWidth={0.04}
          outlineOpacity={1}
          anchorY="middle"
        >
          LAZY RIVER
        </Text>
      </Billboard>
      {/* Two sign posts beside the boarding platform — bumped out
          to match the wider deck. */}
      <mesh position={[RIVER_ENTRY.x - RIVER_CENTER.x - 1.5, 1.4, RIVER_ENTRY.z - RIVER_CENTER.z - 0.5]} castShadow>
        <boxGeometry args={[0.12, 2.8, 0.12]} />
        <meshStandardMaterial color="#5a3c20" />
      </mesh>
      <mesh position={[RIVER_ENTRY.x - RIVER_CENTER.x + 1.5, 1.4, RIVER_ENTRY.z - RIVER_CENTER.z - 0.5]} castShadow>
        <boxGeometry args={[0.12, 2.8, 0.12]} />
        <meshStandardMaterial color="#5a3c20" />
      </mesh>

      {/* The map-spanning river has its own sandy beach ring +
          plenty of trees + bushes in the wider world, so the
          LazyRiver group doesn't add its own decor. The earlier
          internal palms / bushes were sized for the small-oval
          version of the river and ended up either on the plaza
          (blocking the character) or inside the new river channel. */}
    </group>
  );
}

// RiverBridge — wooden plank crossing the river channel. Plank top
// sits at BRIDGE_DECK_Y so the tube can float under it cleanly
// (tube top y=0.38, plank bottom y=0.42). Four corner posts go down
// to the ground, two short railings line the long sides. The
// character's onBridge check (used by resolveCollisions + Character
// useFrame) reads the RIVER_BRIDGES array so the visual + collision
// stay in sync — only edit the bridge size by tweaking the constants.
function RiverBridge({ bridge }: { bridge: Bridge }) {
  const { x, z, axis, length, width } = bridge;
  // Plank orientation: if axis === "z" the plank's long side runs
  // along z so length is the z extent. Use the box dims directly:
  // [x-extent, y-extent, z-extent].
  const planks =
    axis === "z"
      ? ([width, BRIDGE_DECK_THICKNESS, length] as const)
      : ([length, BRIDGE_DECK_THICKNESS, width] as const);
  const planksY = BRIDGE_DECK_Y - BRIDGE_DECK_THICKNESS / 2;

  const PLANK_COLOR = "#8b6644";
  const POST_COLOR = "#5a3c20";
  const RAIL_COLOR = "#5a3c20";

  // Corner posts — go from ground (y=0) up to the railing top.
  const POST_TOP_Y = BRIDGE_DECK_Y + 0.6;
  const POST_HEIGHT = POST_TOP_Y;
  // Position posts at the four corners of the plank footprint.
  const halfL = length / 2;
  const halfW = width / 2;
  const corners =
    axis === "z"
      ? [
          [-halfW + 0.1, -halfL + 0.1],
          [ halfW - 0.1, -halfL + 0.1],
          [-halfW + 0.1,  halfL - 0.1],
          [ halfW - 0.1,  halfL - 0.1],
        ]
      : [
          [-halfL + 0.1, -halfW + 0.1],
          [ halfL - 0.1, -halfW + 0.1],
          [-halfL + 0.1,  halfW - 0.1],
          [ halfL - 0.1,  halfW - 0.1],
        ];
  // Railings — two horizontal beams along the long sides of the
  // plank, at deck-top height + 0.4. Each runs the full plank
  // length, offset perpendicular to ±halfW.
  const railLen = length;
  const railThickness = 0.08;
  const railHeight = 0.4;

  return (
    <group position={[x, 0, z]}>
      {/* Plank deck — kid walks on top. */}
      <mesh position={[0, planksY, 0]} castShadow receiveShadow>
        <boxGeometry args={[planks[0], planks[1], planks[2]]} />
        <meshStandardMaterial color={PLANK_COLOR} roughness={0.85} />
      </mesh>
      {/* 4 corner posts going to the ground. */}
      {corners.map(([cx, cz], i) => (
        <mesh
          key={i}
          position={[cx, POST_HEIGHT / 2, cz]}
          castShadow
        >
          <boxGeometry args={[0.15, POST_HEIGHT, 0.15]} />
          <meshStandardMaterial color={POST_COLOR} roughness={0.9} />
        </mesh>
      ))}
      {/* Two railings along the long sides. */}
      {axis === "z" ? (
        <>
          <mesh
            position={[-halfW + 0.05, BRIDGE_DECK_Y + railHeight, 0]}
            castShadow
          >
            <boxGeometry args={[railThickness, railThickness, railLen]} />
            <meshStandardMaterial color={RAIL_COLOR} />
          </mesh>
          <mesh
            position={[halfW - 0.05, BRIDGE_DECK_Y + railHeight, 0]}
            castShadow
          >
            <boxGeometry args={[railThickness, railThickness, railLen]} />
            <meshStandardMaterial color={RAIL_COLOR} />
          </mesh>
        </>
      ) : (
        <>
          <mesh
            position={[0, BRIDGE_DECK_Y + railHeight, -halfW + 0.05]}
            castShadow
          >
            <boxGeometry args={[railLen, railThickness, railThickness]} />
            <meshStandardMaterial color={RAIL_COLOR} />
          </mesh>
          <mesh
            position={[0, BRIDGE_DECK_Y + railHeight, halfW - 0.05]}
            castShadow
          >
            <boxGeometry args={[railLen, railThickness, railThickness]} />
            <meshStandardMaterial color={RAIL_COLOR} />
          </mesh>
        </>
      )}
    </group>
  );
}

// Tube — Gracie-red inner tube, visible only while the character is
// riding. Positioned each frame based on the river state machine's
// (t, offset). The character mesh is positioned by the tubing state
// machine; this just draws the tube ring around their seated body.
function Tube({ riverRef }: { riverRef: React.MutableRefObject<RiverState> }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    const g = ref.current;
    if (!g) return;
    const r = riverRef.current;
    g.visible = r.active && r.riding;
    if (!g.visible) return;
    const pos = riverWorldAt(r.t, r.offset);
    g.position.x = pos.x;
    g.position.z = pos.z;
    // Sit on the water plane.
    g.position.y = 0.16;
    // Align the tube's "front" with the curve tangent so the donut
    // reads as drifting along the flow direction (not pointing
    // sideways across it).
    g.rotation.y = pos.angle;
  });
  return (
    <group ref={ref} visible={false}>
      {/* Donut — torus laid flat. Gracie red. */}
      <mesh rotation={[Math.PI / 2, 0, 0]} castShadow>
        <torusGeometry args={[0.65, 0.22, 12, 24]} />
        <meshStandardMaterial color="#c4262e" roughness={0.6} />
      </mesh>
      {/* Small white "G" decal on top of the tube, oriented toward
          the camera-facing side (the rider sits inside this ring). */}
      <mesh position={[0, 0.23, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.12, 16]} />
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
      </mesh>
    </group>
  );
}

// RiverBeltPickup — same pickup behaviour as the plaza BeltPickup,
// but its world position is derived from a (t, offset) sample of
// the river curve so the belt sits exactly where the tube physics
// will reach if the kid steers correctly. Bobs + spins like the
// plaza belts.
function RiverBeltPickup({
  index,
  spec,
  collectedRef,
}: {
  index: number;
  spec: { t: number; offset: number; label: string };
  collectedRef: React.MutableRefObject<boolean[]>;
}) {
  const ref = useRef<THREE.Group>(null);
  const phaseOffset = (index * 0.41) % 1;
  // Precompute world position from the curve sample — it never
  // changes once the curve is built.
  const pos = useMemo(() => riverWorldAt(spec.t, spec.offset), [spec.t, spec.offset]);
  useFrame((state) => {
    const g = ref.current;
    if (!g) return;
    const collected = collectedRef.current[index];
    g.visible = !collected;
    if (!collected) {
      const t = state.clock.elapsedTime + phaseOffset * 10;
      g.position.y =
        0.55 + Math.sin(t * BELT_BOB_FREQ * 2 * Math.PI) * BELT_BOB_AMP;
      g.rotation.y = t * BELT_SPIN_FREQ * 2 * Math.PI;
    }
  });
  return (
    <group ref={ref} position={[pos.x, 0.55, pos.z]}>
      <mesh castShadow>
        <boxGeometry args={[0.7, 0.18, 0.22]} />
        <meshStandardMaterial color="#0a0a0a" />
      </mesh>
      <mesh position={[0.22, 0, 0]} castShadow>
        <boxGeometry args={[0.12, 0.20, 0.24]} />
        <meshStandardMaterial
          color="#ffffff"
          emissive="#fde047"
          emissiveIntensity={0.9}
          toneMapped={false}
        />
      </mesh>
      {/* Soft ring above water for visibility */}
      <mesh
        position={[0, -0.5, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <ringGeometry args={[0.3, 0.55, 24]} />
        <meshBasicMaterial
          color="#fde047"
          transparent
          opacity={0.45}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}



// Atmospheric haze wall at the southern horizon (formerly behind
// the gun range, formerly behind the farm) — softens the abrupt
// grass-edge into a sky fade. Now sits behind the lazy river.
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

      {/* Hole 3 used to live here (greenLocal [-5, 12] = world
          (-19, 29)) but its green + flag landed inside the river
          channel after the river became map-spanning, so it was
          removed. Holes 1 + 2 cover the playable course. */}

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
      {/* (5, 11) → world (-9, 28) + (-6, 13) → world (-20, 30) both
          removed — landed inside the river channel or right at its
          inner-south edge after the river became map-spanning. */}

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

// Play-mode putt ball — separate from the easter-egg GolfBall above.
// Reads puttingRef each frame for live physics-driven position. Sunk
// state drops the ball into the cup (lower y) for a beat before the
// state machine respawns it at the tee.
function PuttBall({
  puttingRef,
}: {
  puttingRef: React.MutableRefObject<PuttingState>;
}) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    const p = puttingRef.current;
    m.visible = p.active;
    if (!p.active) return;
    m.position.x = p.ballX;
    m.position.z = p.ballZ;
    // Sunk → drop the ball into the cup; otherwise sit on the green.
    m.position.y = p.phase === "sunk" ? -0.05 : PUTT_BALL_Y;
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

// AimArrow — flat triangular indicator on the green that points in
// the kid's current facing direction while addressing the ball. Only
// visible during the idle phase of putting (hidden while the ball is
// rolling / sunk / missed). Length is fixed; colour shifts subtly
// when the kid is charging the putt.
function AimArrow({
  puttingRef,
  charRef,
}: {
  puttingRef: React.MutableRefObject<PuttingState>;
  charRef: React.MutableRefObject<CharState>;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(() => {
    const g = groupRef.current;
    const p = puttingRef.current;
    if (!g) return;
    g.visible = p.active && p.phase === "idle";
    if (!g.visible) return;
    // Anchor at the ball's current rest spot (the tee), rotate to
    // match the body's aim angle. charRef.angle is the source of
    // truth — the putting state machine rotates it directly from
    // A/D input.
    g.position.set(p.ballX, 0.02, p.ballZ);
    g.rotation.y = charRef.current.angle;
    // Brighten the arrow tip while charging so the kid sees the
    // power building up even before they look at the HUD.
    if (matRef.current) {
      const charge = p.charging ? p.power : 0;
      const r = 0.95;
      const gr = 0.4 + charge * 0.55; // fades from amber → yellow
      const b = 0.1 + charge * 0.4;
      matRef.current.color.setRGB(r, gr, b);
    }
  });
  // Arrow geometry: a thin elongated triangle. Built so the tip
  // points in +Z (the body's "forward" direction at angle 0 = south).
  // 1.6 units long, 0.32 wide at the base.
  const arrowGeom = useMemo(() => {
    const shape = new THREE.Shape();
    shape.moveTo(-0.16, 0);
    shape.lineTo(0.16, 0);
    shape.lineTo(0.08, 1.2);
    shape.lineTo(0.18, 1.2);
    shape.lineTo(0, 1.6);
    shape.lineTo(-0.18, 1.2);
    shape.lineTo(-0.08, 1.2);
    shape.closePath();
    return new THREE.ShapeGeometry(shape);
  }, []);
  return (
    <group ref={groupRef} visible={false}>
      <mesh geometry={arrowGeom} rotation={[-Math.PI / 2, 0, 0]}>
        <meshBasicMaterial
          ref={matRef}
          color="#f2a020"
          transparent
          opacity={0.8}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
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

// Play-mode collectible — a small glowing black belt (with a
// bright rank-stripe end) that bobs + spins in place. The visual
// reads as "a BJJ black belt with a stripe earned on it" — the
// reward kids on the mat actually earn. Reads collected-state
// from a shared ref so the parent (Scene) can mark it grabbed
// during the pickup check without a React re-render. Visibility
// is toggled directly on the mesh each frame. Sized like a Mario
// coin so it's findable from across the plaza.
function BeltPickup({
  position,
  index,
  collectedRef,
}: {
  position: { x: number; z: number };
  index: number;
  collectedRef: React.MutableRefObject<boolean[]>;
}) {
  const groupRef = useRef<THREE.Group | null>(null);
  // Stagger each belt's bob/spin phase so the cluster doesn't
  // pulse in lockstep when the kid sees several at once.
  const phaseOffset = (index * 0.41) % 1;
  useFrame((state) => {
    const g = groupRef.current;
    if (!g) return;
    const collected = collectedRef.current[index];
    g.visible = !collected;
    if (!collected) {
      const t = state.clock.elapsedTime + phaseOffset * 10;
      g.position.y =
        0.9 + Math.sin(t * BELT_BOB_FREQ * 2 * Math.PI) * BELT_BOB_AMP;
      g.rotation.y = t * BELT_SPIN_FREQ * 2 * Math.PI;
    }
  });
  return (
    <group ref={groupRef} position={[position.x, 0.9, position.z]}>
      {/* Belt — black core with a bright stripe band wrapped around */}
      <mesh castShadow>
        <boxGeometry args={[0.7, 0.18, 0.22]} />
        <meshStandardMaterial color="#0a0a0a" />
      </mesh>
      {/* Glowing "stripe" — small white tape on one end, the actual
          BJJ stripe shape. Emissive so it pops against the grass. */}
      <mesh position={[0.22, 0, 0]} castShadow>
        <boxGeometry args={[0.12, 0.20, 0.24]} />
        <meshStandardMaterial
          color="#ffffff"
          emissive="#fde047"
          emissiveIntensity={0.9}
          toneMapped={false}
        />
      </mesh>
      {/* Soft ground ring so the kid can see WHERE the belt is
          floating even when it's behind a hill / tree. Faint
          additive yellow disc. */}
      <mesh
        position={[0, -0.85, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <ringGeometry args={[0.3, 0.55, 24]} />
        <meshBasicMaterial
          color="#fde047"
          transparent
          opacity={0.35}
          depthWrite={false}
        />
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

      {/* ── Floating roof label ─────────────────────────────────── */}
      {/* Big section name floating above the roof, always faces the
          camera (drei <Billboard>). Visible from any orbit angle or
          distance so visitors can identify each building at a glance.
          Cream text on a dark outline pops against both the sky and
          the building colors. */}
      <Billboard position={[0, BUILDING_H + 1.9, 0]}>
        <Text
          fontSize={0.55}
          color={section.signColor}
          outlineColor="#1a1410"
          outlineWidth={0.045}
          outlineOpacity={1}
          anchorX="center"
          anchorY="middle"
          letterSpacing={0.06}
        >
          {section.label}
        </Text>
      </Billboard>

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
// Bare feet — skin tone so they read against both the green grass
// on the plaza and the black mat in the academy. (Previously
// "#1a1a1a" which vanished against the dark mat.)
const FOOT = SKIN;
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
  characterId,
}: {
  charRef: React.MutableRefObject<CharState>;
  balloonRef: React.MutableRefObject<BalloonState>;
  characterId: CharacterId;
}) {
  // Reference height / scale lifted from PartnerFace so the player
  // Character's face plane matches the partners' sizing in the
  // academy lineup. Without this, Sonny's old 0.95×1.27 plane read
  // as oversized + over-bright next to the smaller side characters
  // (the bald scalp filled too much of the frame).
  const faceScale = CHARACTER_DATA[characterId].faceScale;
  const planeRefH = (0.85 / 0.867) * faceScale; // matches PartnerFace
  // Three face textures per character swapped per frame based on
  // game state:
  //   * front  — default
  //   * back   — when walking away from the camera (camera mostly
  //              behind the character; e.g., the follow cam during
  //              a click-driven walk to a building)
  //   * scared — full balloon-ride sequence + the gator chase
  // Sonny has hand-edited variants for back + scared; other
  // characters reuse the single front image for all three slots
  // (the bobblehead + tremor animations don't care which texture
  // is on the plane, only that one is).
  const [texSonnyFront, texSonnyBack, texSonnyScared, texKate, texTravis] =
    useTexture([
      "/face.png",
      "/face-back.png",
      "/face-scared.png",
      "/kate.png",
      "/travis.png",
    ]);
  // Tag every face texture as sRGB so three.js doesn't apply an
  // extra brightness boost on top of an already-gamma-encoded photo.
  // Without this the player Character's face reads as visibly
  // brighter / washed-out compared to the TrainingPartner rendering
  // of the same photo (PartnerFace tags its texture; FaceBillboard
  // previously didn't, so Sonny + Travis looked "blown out" when
  // selected at centre and natural when on the side slots).
  texSonnyFront.colorSpace = THREE.SRGBColorSpace;
  texSonnyBack.colorSpace = THREE.SRGBColorSpace;
  texSonnyScared.colorSpace = THREE.SRGBColorSpace;
  texKate.colorSpace = THREE.SRGBColorSpace;
  texTravis.colorSpace = THREE.SRGBColorSpace;
  // Per-character texture pack (front / back / scared). Resolved
  // once per render — cheap; references the already-loaded textures.
  const facePack = useMemo(() => {
    if (characterId === "kate") {
      return { front: texKate, back: texKate, scared: texKate };
    }
    if (characterId === "travis") {
      return { front: texTravis, back: texTravis, scared: texTravis };
    }
    return { front: texSonnyFront, back: texSonnyBack, scared: texSonnyScared };
  }, [characterId, texSonnyFront, texSonnyBack, texSonnyScared, texKate, texTravis]);
  // Keep the locals named after their semantic role so the rest of
  // the file reads cleanly. They re-bind on character change.
  const texFront = facePack.front;
  const texBack = facePack.back;
  const texScared = facePack.scared;
  // Light color-correction pass on Sonny's back/scared sources only.
  // Tied to the actual Sonny textures (not the per-character pack)
  // because for Kate/Travis the back/scared slots ARE the same
  // texture as the front — filtering them would distort the front
  // too. Sonny's back/scared are separate PNGs that get a tiny
  // saturation/contrast bump for a hair more pop on the billboard.
  // A previous version applied `saturate(1.2) contrast(1.18)
  // brightness(1.04)` here, which pushed the new photos' skin tones
  // into a red tint. The current values are gentle enough.
  useEffect(() => {
    for (const tex of [texSonnyBack, texSonnyScared]) {
      // Idempotency tag: same reason as Travis's filter — the
      // mutation replaces tex.image, so a re-run would re-filter
      // the already-filtered canvas and push the colors out of
      // range on repeated mounts.
      const stamped = (tex as unknown as { __sonnyBackFiltered?: boolean });
      if (stamped.__sonnyBackFiltered) continue;
      const img = tex.image as HTMLImageElement | undefined;
      if (!img || !img.width || !img.height) continue;
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.filter = "saturate(1.10) contrast(1.06)";
      ctx.drawImage(img, 0, 0);
      tex.image = canvas;
      tex.needsUpdate = true;
      stamped.__sonnyBackFiltered = true;
    }
  }, [texSonnyBack, texSonnyScared]);

  // Vertical alignment fix specific to Sonny's scared face PNG —
  // its head sits higher in the source canvas than face.png does,
  // so without a shift the scared face hovers above the shoulders.
  // texture.offset.y in UV space (V=0 bottom, V=1 top). Positive
  // offset shifts texture content DOWN on the plane. Tuned by eye.
  // Kate/Travis don't need this — their "scared" slot is the same
  // image as their front, which is already aligned correctly.
  useEffect(() => {
    texSonnyScared.offset.y = 0.10;
    texSonnyScared.needsUpdate = true;
  }, [texSonnyScared]);
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  // Scratch vectors so we don't allocate every frame.
  const meshWorld = useMemo(() => new THREE.Vector3(), []);
  const lookTarget = useMemo(() => new THREE.Vector3(), []);

  useFrame((state) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const c = charRef.current;

    // Pick which face texture to show this frame. With the gun-range
    // shooting easter egg removed and the body-rotation override
    // pointing the body's front at the camera in every other mode
    // (see Character), back-of-head is no longer reachable — the
    // face only needs front vs scared. The texBack texture is still
    // loaded (kept for any future behind-camera modes) but unused.
    let wantTex: THREE.Texture = texFront;
    if (c.mode === "ballooning" || c.mode === "flee") {
      wantTex = texScared;
    }
    void texBack;
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

  // Plane width derives from the texture's natural aspect. Sized to
  // match PartnerFace exactly so the player Character's face appears
  // at the same physical size as the side TrainingPartners in the
  // academy lineup. Width per character: sonny 0.735, kate 0.85,
  // travis 0.506 (faceScale-shrunk because his PNG is tightly
  // cropped). Bobble + scared-shake Z-rotations pivot around the
  // plane center regardless of texture content position.
  const facePack2 = facePack;
  const facePngImg = (facePack2.front.image as HTMLImageElement | undefined);
  const aspect2 =
    facePngImg && facePngImg.width && facePngImg.height
      ? facePngImg.width / facePngImg.height
      : 0.75;
  const planeW = planeRefH * aspect2;
  return (
    <mesh ref={meshRef}>
      <planeGeometry args={[planeW, planeRefH]} />
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
  characterId,
  visible = true,
  onSelect,
}: {
  charRef: React.MutableRefObject<CharState>;
  golfRef: React.MutableRefObject<GolfState>;
  balloonRef: React.MutableRefObject<BalloonState>;
  characterId: CharacterId;
  visible?: boolean;
  // When provided, the entire player figure becomes clickable. Used
  // in the academy so the user can click the player Character at
  // centre to pick "sonny" (the same way clicking a TrainingPartner
  // picks the other characters).
  onSelect?: () => void;
}) {
  // Per-character visual data — face PNG, belt color, and the y
  // anchor for the face plane (lifted higher for tight-cropped
  // photos like Travis's so the chin doesn't sit inside the torso).
  const charData = CHARACTER_DATA[characterId];
  const beltColor = charData.belt;
  const faceY = charData.faceY;
  // Front-only details (gi V, belt knot, neck/forearm tattoos) are
  // gated to Sonny. He pairs them with a hand-edited back-of-head
  // photo so the back of him reads coherently from behind. The
  // other characters don't have back-of-head art, so showing
  // front-only details would make the body look "backwards" from
  // the chase-cam vantage. Hiding them gives Kate/Travis a body
  // that reads the same from any angle.
  const showFrontDetails = characterId === "sonny";
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
      clubRef.current.visible = c.mode === "golfing" || c.mode === "putting";
    }
    if (rootRef.current) {
      rootRef.current.position.x = c.x;
      rootRef.current.position.z = c.z;
      // y is driven by the game tick for ride (track height), golf
      // (celebration jumps), ballooning (rising / falling), and tubing
      // (rider seat height on the tube); zero on foot otherwise. While
      // riding the coaster, lower the character so the hips (at
      // body-local y=0.66) sit on the cart's top surface (cart-local
      // y=0.36 × PARK_SCALE) rather than standing on top.
      // Lazy-river bridges sit at BRIDGE_DECK_Y above the water;
      // when the kid walks across, lift them so their feet stand on
      // the plank top. Skip the bump for the special-action modes
      // that drive their own y (riding, tubing, golfing, etc.) so
      // a transient onBridge() at the kid's auto-board position
      // doesn't fight the tubing tick.
      const standsOnBridge =
        c.mode !== "tubing" &&
        c.mode !== "riding" &&
        c.mode !== "ballooning" &&
        onBridge(c.x, c.z);
      rootRef.current.position.y =
        c.mode === "riding"
          ? c.y + 0.36 * PARK_SCALE - 0.66
          : standsOnBridge
          ? c.y + BRIDGE_DECK_Y
          : c.y; // covers golfing / ballooning / tubing AND play-mode jumps
      // Show / hide the whole player avatar based on the `visible`
      // prop — used to hide the player Character in the academy
      // (where the 3 selectable TrainingPartners take over the mat).
      rootRef.current.visible = visible;
      // Pick the body's target facing angle. UNIFIED behavior:
      // every character's body always faces the camera (regardless
      // of which character is selected). For 4-8-year-olds the kid
      // audience this trades a touch of "realism" (you don't see
      // your character's back) for huge UX wins: identity always
      // visible, consistent across characters, no "head on backwards"
      // edge cases, simpler code. Movement direction is still
      // communicated by position change + footstep animation.
      // Special-action modes (ride / golf / ballooning / tubing)
      // ignore the override because they use scripted camera
      // vantages tied to the body's actual heading (e.g., the
      // tube auto-rotates to face the curve tangent so the rider
      // points down the river).
      let wantAngle = c.angle;
      const isSpecial =
        c.mode === "riding" ||
        c.mode === "golfing" ||
        c.mode === "ballooning" ||
        c.mode === "tubing" ||
        c.mode === "putting";
      if (!isSpecial) {
        const camToCharX = c.x - state.camera.position.x;
        const camToCharZ = c.z - state.camera.position.z;
        if (camToCharX !== 0 || camToCharZ !== 0) {
          // atan2(-camToChar) flips the camera→char vector to
          // char→camera, which is the direction the body should
          // face to point its front at the camera.
          wantAngle = Math.atan2(-camToCharX, -camToCharZ);
        }
      }
      // Smoothly rotate to that target angle. Snap during special modes.
      const cur = rootRef.current.rotation.y;
      let diff = wantAngle - cur;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      rootRef.current.rotation.y = isSpecial ? wantAngle : cur + diff * 0.2;
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

    if (c.mode === "tubing") {
      // Seated-on-tube pose: legs stick out forward (sitting in the
      // donut), arms down/relaxed at sides, body upright. A small
      // sine wave drives a gentle bob to suggest the river current.
      const bob = Math.sin(t * 1.8) * 0.04;
      if (leftHipRef.current) leftHipRef.current.rotation.x = -Math.PI / 2;
      if (rightHipRef.current) rightHipRef.current.rotation.x = -Math.PI / 2;
      if (leftShoulderRef.current) {
        leftShoulderRef.current.rotation.x = -0.15;
        leftShoulderRef.current.rotation.z = 0;
      }
      if (rightShoulderRef.current) {
        rightShoulderRef.current.rotation.x = -0.15;
        rightShoulderRef.current.rotation.z = 0;
      }
      if (bodyRef.current) {
        bodyRef.current.rotation.x = 0;
        bodyRef.current.position.y = bob;
      }
      return;
    }

    if (c.mode === "putting") {
      // Putting stance — feet flat, slight forward body bend, arms
      // extended forward at chest height with inward tilt so both
      // hands meet on the putter grip (same trick as the golf-egg
      // pose, just static). Legs stay straight (no hip rotation).
      const FORWARD = -0.55;
      const INWARD = 0.48;
      if (leftHipRef.current) leftHipRef.current.rotation.x = 0;
      if (rightHipRef.current) rightHipRef.current.rotation.x = 0;
      if (leftShoulderRef.current) {
        leftShoulderRef.current.rotation.x = FORWARD;
        leftShoulderRef.current.rotation.z = INWARD;
      }
      if (rightShoulderRef.current) {
        rightShoulderRef.current.rotation.x = FORWARD;
        rightShoulderRef.current.rotation.z = -INWARD;
      }
      if (clubHolderRef.current) {
        clubHolderRef.current.rotation.x = FORWARD;
        clubHolderRef.current.rotation.z = 0;
      }
      if (bodyRef.current) {
        bodyRef.current.rotation.x = 0.15; // slight forward lean
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
      // centreline of the body while putting. FORWARD = negative
      // rotation.x on both shoulders tilts the arms forward from
      // the shoulder sockets so the whole swing arc lives IN FRONT
      // of the torso (instead of hanging straight down at body
      // depth, where it reads as the arms swinging through the
      // chest from the south camera vantage).
      const INWARD = 0.42;
      const FORWARD = -0.55;
      if (leftShoulderRef.current) {
        leftShoulderRef.current.rotation.x = FORWARD;
        leftShoulderRef.current.rotation.z = swingZ + INWARD;
      }
      if (rightShoulderRef.current) {
        rightShoulderRef.current.rotation.x = FORWARD;
        rightShoulderRef.current.rotation.z = swingZ - INWARD;
      }
      if (clubHolderRef.current) {
        clubHolderRef.current.rotation.x = FORWARD;
        clubHolderRef.current.rotation.z = swingZ;
      }
      if (leftHipRef.current) leftHipRef.current.rotation.x = 0;
      if (rightHipRef.current) rightHipRef.current.rotation.x = 0;
      // Slight forward bend over the ball. Kept small (0.15 rad ≈ 9°)
      // because a deeper bend tilts the arms' swing plane backward and
      // tucks them behind the torso from the south camera vantage —
      // makes the swing look like the arms are coming from behind the
      // character's back.
      if (bodyRef.current) {
        if (gt < 0.4) bodyRef.current.rotation.x = 0.15;
        else if (gt < 0.55) bodyRef.current.rotation.x = 0.12;
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
    <group
      ref={rootRef}
      position={[0, 0, 0]}
      onClick={
        onSelect
          ? (e) => {
              e.stopPropagation();
              onSelect();
            }
          : undefined
      }
      onPointerOver={
        onSelect
          ? (e) => {
              e.stopPropagation();
              document.body.style.cursor = "pointer";
            }
          : undefined
      }
      onPointerOut={
        onSelect
          ? (e) => {
              e.stopPropagation();
              document.body.style.cursor = "";
            }
          : undefined
      }
    >
      <group ref={bodyRef}>
        {/* Torso (gi top) */}
        <mesh position={[0, 1.0, 0]} castShadow>
          <boxGeometry args={[0.55, 0.55, 0.32]} />
          <meshStandardMaterial color={GI} />
        </mesh>

        {/* Front-only chest detail (V-skin + crossed lapels + piping).
            Skipped for non-Sonny characters who don't have a back-
            of-head photo to pair with — see `showFrontDetails`. */}
        {showFrontDetails && (
          <>
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
          </>
        )}

        {/* Belt — color comes from CHARACTER_DATA so it matches the
            selected character (Sonny: black, Kate: brown, etc.) */}
        <mesh position={[0, 0.71, 0]} castShadow>
          <boxGeometry args={[0.58, 0.10, 0.34]} />
          <meshStandardMaterial color={beltColor} />
        </mesh>
        {/* Sonny-style belt knot + ends (front-only, paired with his
            back-of-head photo so the back of him reads coherently). */}
        {showFrontDetails && (
          <>
            {/* Belt knot — slightly raised square at the front centre */}
            <mesh position={[0, 0.71, 0.18]} castShadow>
              <boxGeometry args={[0.10, 0.13, 0.05]} />
              <meshStandardMaterial color={beltColor} />
            </mesh>
            {/* Belt ends — two short strips hanging from the knot, one
                angled so it doesn't sit perfectly straight (looks tied
                rather than glued on). */}
            <mesh position={[-0.025, 0.55, 0.195]} rotation={[0, 0, 0.08]}>
              <boxGeometry args={[0.045, 0.20, 0.02]} />
              <meshStandardMaterial color={beltColor} />
            </mesh>
            <mesh position={[0.04, 0.56, 0.195]} rotation={[0, 0, -0.15]}>
              <boxGeometry args={[0.045, 0.18, 0.02]} />
              <meshStandardMaterial color={beltColor} />
            </mesh>
          </>
        )}

        {/* Non-Sonny: closed-kimono lapels + a small belt knot. Same
            shapes as TrainingPartner uses for Kate/Travis. Gives the
            body a clear "this is the front" indication so it doesn't
            read as backwards when the body is rotated to face the
            camera. No exposed skin V because these characters' gis
            are closed (Kate, Travis, etc.). */}
        {!showFrontDetails && (
          <>
            {/* Left lapel */}
            <mesh position={[-0.09, 1.04, 0.165]} rotation={[0, 0, 0.4]}>
              <boxGeometry args={[0.10, 0.46, 0.025]} />
              <meshStandardMaterial color={GI_SHADE} />
            </mesh>
            {/* Right lapel — slightly more forward so it overlaps the
                left at the waist (kimono "left over right" close). */}
            <mesh position={[0.09, 1.04, 0.168]} rotation={[0, 0, -0.4]}>
              <boxGeometry args={[0.10, 0.46, 0.025]} />
              <meshStandardMaterial color={GI_SHADE} />
            </mesh>
            {/* Dark piping along the inner edge of each lapel */}
            <mesh position={[-0.05, 1.06, 0.182]} rotation={[0, 0, 0.4]}>
              <boxGeometry args={[0.016, 0.46, 0.005]} />
              <meshStandardMaterial color="#9c9580" />
            </mesh>
            <mesh position={[0.05, 1.06, 0.185]} rotation={[0, 0, -0.4]}>
              <boxGeometry args={[0.016, 0.46, 0.005]} />
              <meshStandardMaterial color="#9c9580" />
            </mesh>
            {/* Belt knot — matches the TrainingPartner build */}
            <mesh position={[0, 0.71, 0.18]} castShadow>
              <boxGeometry args={[0.10, 0.13, 0.05]} />
              <meshStandardMaterial color={beltColor} />
            </mesh>
            <mesh position={[-0.025, 0.55, 0.193]} rotation={[0, 0, 0.08]}>
              <boxGeometry args={[0.045, 0.20, 0.02]} />
              <meshStandardMaterial color={beltColor} />
            </mesh>
            <mesh position={[0.04, 0.56, 0.193]} rotation={[0, 0, -0.15]}>
              <boxGeometry args={[0.045, 0.18, 0.02]} />
              <meshStandardMaterial color={beltColor} />
            </mesh>
          </>
        )}

        {/* Face — Sonny's actual photo on a plane positioned where the
            old bald head was. FaceBillboard manages its own rotation
            internally: billboards to the camera most of the time, but
            locks to body rotation while riding the coaster so the face
            points down the track.

            Y position chosen for the current source PNGs (433×577,
            face content in the upper ~60% of the canvas). With the
            plane height = 1.27, the face center on the plane sits
            ~0.16 above the plane's geometric center, so a group y
            of 1.50 puts the face center near y=1.66 and the chin
            just above the gi collar (y≈1.275). If you swap the
            photos with differently-cropped sources, retune this. */}
        <group position={[0, faceY, 0]}>
          <FaceBillboard charRef={charRef} balloonRef={balloonRef} characterId={characterId} />
        </group>

        {/* Neck tattoo — Sonny-specific front detail. Hidden for
            other characters (none of them have this tattoo IRL and
            it sits on the front of the body only, so it'd read as
            "stuck on someone else's neck"). */}
        {showFrontDetails && (
          <mesh position={[0, 1.28, 0.14]}>
            <boxGeometry args={[0.1, 0.04, 0.02]} />
            <meshBasicMaterial color={TATTOO} />
          </mesh>
        )}

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
          {/* Tattoo bands — Sonny only (his actual ink). */}
          {showFrontDetails && (
            <>
              <mesh position={[0, -0.42, 0]}>
                <boxGeometry args={[0.14, 0.04, 0.16]} />
                <meshBasicMaterial color={TATTOO} />
              </mesh>
              <mesh position={[0, -0.55, 0]}>
                <boxGeometry args={[0.14, 0.025, 0.16]} />
                <meshBasicMaterial color={TATTOO} />
              </mesh>
            </>
          )}
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
          {showFrontDetails && (
            <>
              <mesh position={[0, -0.4, 0]}>
                <boxGeometry args={[0.14, 0.035, 0.16]} />
                <meshBasicMaterial color={TATTOO} />
              </mesh>
              <mesh position={[0, -0.52, 0]}>
                <boxGeometry args={[0.14, 0.025, 0.16]} />
                <meshBasicMaterial color={TATTOO} />
              </mesh>
            </>
          )}
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

// The default plaza vantage is no longer a module-level constant —
// it's selected per device in GameWorld (desktop: 0,20,25; mobile:
// 0,26,32) and threaded through Scene → CameraRig as the camDefault
// prop. The glide-back after a cinematic mode uses that prop so it
// lands exactly where the Canvas's initial camera position is set.

// ── Drone tour ─────────────────────────────────────────────────────
// When the user is idle for a moment, the camera flies between named
// "waypoints" around the world, dwelling on each long enough for a
// slow rotation before quickly transitioning to the next. Each
// waypoint has a `target` (what the camera looks at) and a
// `camOffset` (initial position relative to target — the rotation
// during dwell sweeps this offset around the target's Y axis).
// Two speed presets for the drone tour. First time through after a
// page load the camera moves briskly — a ~25s "preview sweep" that
// shows the visitor the whole world before settling. After the first
// full lap the values drop to the SLOW set, turning the tour into
// slow ambient wallpaper. CameraRig picks between them via
// firstCycleDoneRef.
const DRONE_TRANSITION_S_FAST = 0.6;
const DRONE_DWELL_S_FAST = 1.2;
const DRONE_DWELL_ROT_SPEED_FAST = 0.3; // radians per second
const DRONE_DWELL_RAMP_S_FAST = 0.2;
const DRONE_TRANSITION_S_SLOW = 3.0;
const DRONE_DWELL_S_SLOW = 9.0;
const DRONE_DWELL_ROT_SPEED_SLOW = 0.14;
const DRONE_DWELL_RAMP_S_SLOW = 1.5;
// Any pointer/wheel/touch input pauses the drone for this long, so
// the user can take over the camera and look around freely.
const DRONE_INPUT_PAUSE_S = 10;
const DRONE_TOUR: { name: string; target: THREE.Vector3; camOffset: THREE.Vector3 }[] = [
  // Plaza overview — buildings + character on the central plaza
  { name: "plaza", target: new THREE.Vector3(0, 2, 0), camOffset: new THREE.Vector3(0, 12, 16) },
  // Amusement park — coaster + carousel + ferris wheel
  { name: "park", target: new THREE.Vector3(-21, 3, -38), camOffset: new THREE.Vector3(20, 14, 18) },
  // Lake & alligator
  { name: "lake", target: new THREE.Vector3(9, 1, -8), camOffset: new THREE.Vector3(8, 6, 9) },
  // Hot-air balloon
  { name: "balloon", target: new THREE.Vector3(10, 4, 6), camOffset: new THREE.Vector3(7, 5, 8) },
  // Lazy river — curved oval loop with sandy beach + palms. Vantage
  // from the north-east, slightly elevated, looking south-west
  // across the water so the full loop + boarding deck fit in frame.
  { name: "river", target: new THREE.Vector3(RIVER_CENTER.x, 1.5, RIVER_CENTER.z), camOffset: new THREE.Vector3(14, 12, -14) },
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
  balloonAdventureRef,
  pathname,
  camDefault,
  playMode,
  playCamSnapRef,
}: {
  charRef: React.MutableRefObject<CharState>;
  gatorRef: React.MutableRefObject<GatorState>;
  balloonAdventureRef: React.MutableRefObject<BalloonAdventureState>;
  pathname: string;
  camDefault: { x: number; y: number; z: number };
  playMode: boolean;
  playCamSnapRef: React.MutableRefObject<boolean>;
}) {
  const targetVec = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const controlsRef = useRef<React.ComponentRef<typeof OrbitControls>>(null);
  // Tracks whether a special mode has hijacked the camera position. Set on
  // entry to riding/golfing; cleared once the camera has glided back close
  // to CAM_DEFAULT. Used so the post-ride walk-back gets a camera return.
  const camHijackedRef = useRef(false);
  // True while the user is actively dragging OrbitControls (mousedown
  // → mouseup with movement, or pinch-zoom on touch). Wired via the
  // OrbitControls 'start'/'end' events on mount.
  const userDraggingRef = useRef(false);
  // Sticky version of userDragging: set to true on drag start, stays
  // true after release so the follow-cam doesn't snap the camera back
  // to its tracking position the instant the user lets go. Cleared
  // when a fresh click fires (pointerdown listener), since clicking
  // on a new event is a clear signal the user wants the auto-camera
  // back. Especially important during the walk-back after an event
  // — the user gets to keep whatever vantage they dragged to instead
  // of fighting the follow-cam pulling it back every frame.
  const manualOverrideRef = useRef(false);
  // Previous frame's c.walking, used to detect the false→true edge
  // that clears manualOverrideRef (= the user clicked something and
  // started a fresh walk-to-event, so they want the follow-cam back).
  const prevWalkingRef = useRef(false);
  // Previous-frame balloonAdventure.active — used to detect the
  // false→true edge so we can clear stale user drag overrides
  // when the adventure starts (Sonny doesn't walk so the c.walking
  // edge can't trigger this clear).
  const prevAdvActiveRef = useRef(false);

  // Drone tour state (idle waypoint-by-waypoint world tour).
  const droneActiveRef = useRef(false);
  const droneStateRef = useRef<"transitioning" | "dwelling">("transitioning");
  const droneIdxRef = useRef(0);
  const dronePhaseStartRef = useRef(0);
  const dronePrevPosRef = useRef(new THREE.Vector3());
  const dronePrevTargetRef = useRef(new THREE.Vector3());
  // Tracks whether the drone tour has completed at least one full
  // lap. First lap uses the FAST preset (~25s total — a brisk
  // preview sweep that shows the visitor the whole world). After
  // that, the tour drops to the SLOW preset (~72s/lap) so it
  // becomes ambient wallpaper instead of demanding attention.
  // Persists for the session (only reset by a page reload).
  const firstCycleDoneRef = useRef(false);
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
    const bump = (e: Event) => {
      lastInputTimeRef.current = performance.now() / 1000;
      // CRITICAL for click reliability during drone tour: only handle
      // pointerdown here (wheel/touchstart go to the simple stamp).
      // R3F's onClick requires pointerdown and pointerup raycasts to
      // land on the same mesh; if the camera shifts between them
      // (drone motion, or OrbitControls damping continuing to apply
      // a residual delta from the drone's recent position writes),
      // the raycasts can hit different meshes and onClick silently
      // fails. Visible symptom is "sometimes the click works,
      // sometimes it doesn't" — variability comes from where in the
      // transition/dwell cycle the click landed.
      //
      // Fix: on pointerdown, halt the drone IMMEDIATELY (don't wait
      // for the next useFrame), flush any pending damping, and arm
      // the camHijacked glide so the camera will recover to
      // CAM_DEFAULT if the click misses. If the click hits and
      // starts a walk, the follow-cam wantCam branch takes
      // precedence over the glide-back (see wantCam if/else chain
      // in useFrame below).
      if (e.type === "pointerdown") {
        droneActiveRef.current = false;
        camHijackedRef.current = true;
        if (controlsRef.current) controlsRef.current.update();
        // Note: manualOverrideRef is NOT cleared here. The window
        // pointerdown listener bubbles AFTER OrbitControls fires its
        // 'start' (which sets manualOverrideRef = true), so clearing
        // here would erase the user's drag intent every time. Instead
        // manualOverrideRef is cleared in useFrame on the
        // c.walking false→true edge (i.e. a click that started a
        // new walk-to-event — a clearer "user wants auto-cam back"
        // signal than just any pointerdown).
      }
    };
    window.addEventListener("pointerdown", bump);
    window.addEventListener("wheel", bump, { passive: true });
    window.addEventListener("touchstart", bump, { passive: true });

    // Track active manipulation so the wantCam chain yields to the
    // user during drags. OrbitControls dispatches 'start' on the
    // first pointer/wheel input that actually moves the camera and
    // 'end' when it stops.
    const onDragStart = () => {
      userDraggingRef.current = true;
      manualOverrideRef.current = true;
    };
    const onDragEnd = () => {
      userDraggingRef.current = false;
    };
    const controls = controlsRef.current;
    if (controls) {
      controls.addEventListener("start", onDragStart);
      controls.addEventListener("end", onDragEnd);
    }

    // Reset-view button (rendered by GameShell) dispatches this
    // custom event when clicked. We listen on window to keep
    // CameraRig decoupled from GameShell's component tree.
    const onResetCamera = () => {
      manualOverrideRef.current = false;
      droneActiveRef.current = false;
      camHijackedRef.current = true; // triggers glide-back to camDefault
      lastInputTimeRef.current = performance.now() / 1000;
    };
    window.addEventListener("reset-camera", onResetCamera);

    return () => {
      window.removeEventListener("pointerdown", bump);
      window.removeEventListener("wheel", bump);
      window.removeEventListener("touchstart", bump);
      window.removeEventListener("reset-camera", onResetCamera);
      if (controls) {
        controls.removeEventListener("start", onDragStart);
        controls.removeEventListener("end", onDragEnd);
      }
    };
  }, []);

  // Glide the camera to its (new) default whenever the route
  // changes scene (camDefault changes). Without this, exiting the
  // academy would leave the camera stranded at the inside-the-room
  // pose while the plaza renders, and entering would leave it at
  // the plaza overview while inside the academy walls.
  useEffect(() => {
    manualOverrideRef.current = false;
    droneActiveRef.current = false;
    camHijackedRef.current = true;
    lastInputTimeRef.current = performance.now() / 1000;
  }, [camDefault.x, camDefault.y, camDefault.z]);

  useFrame((state, dt) => {
    const c = charRef.current;

    // Per-route field of view. Indoors (academy) the portrait
    // viewport at 45° FOV crops the wide rectangular room to just
    // the centre 3-banner cluster, so widen to 65° so the full
    // banner wall + kick pad reads in one frame. Outdoors 45° is
    // the long-tuned default. Setting fov is a no-op when the
    // value doesn't change; we still call updateProjectionMatrix
    // unconditionally because Three.js doesn't track the change.
    const wantFov =
      pathname === "/jiu-jitsu" ? 65 : pathname === "/chess" ? 50 : 45;
    const camAsPersp = state.camera as THREE.PerspectiveCamera;
    if (camAsPersp.fov !== wantFov) {
      camAsPersp.fov = wantFov;
      camAsPersp.updateProjectionMatrix();
    }

    // ── PLAY MODE CAMERA ──
    // SM64-style chase cam: always 5.5u behind Sonny's facing
    // direction at y=4, tracking smoothly. Skips the entire
    // portfolio camera state machine below (cinematics, drone tour,
    // manual override, glide-back) — play mode owns the camera
    // exclusively. OrbitControls' target follows the character
    // each frame so the camera stays looking at him even if the
    // user has nudged the orbit (we ignore the manual-override ref
    // in play mode).
    if (playMode && pathname === "/") {
      // Critical: camera Y is PINNED — it does NOT follow c.y. If
      // it did, jumps would lift the camera 1:1 with the character
      // and Sonny would appear motionless on screen while the world
      // dropped (it reads as "the camera jumped, not the character").
      // Keeping the camera at a fixed height makes the jump visibly
      // lift Sonny in the frame, the way it should look.
      const wantCam = {
        x: c.x - Math.sin(c.angle) * 5.5,
        y: 4,
        z: c.z - Math.cos(c.angle) * 5.5,
      };
      // On play-mode entry the camera could be anywhere (portfolio
      // default plaza vantage, drone-tour waypoint, etc.) — a lerp
      // from there would feel like a confusing 2-second pan before
      // the kid can actually see where they are. Snap on entry so
      // the kid lands behind Sonny instantly.
      const snap = playCamSnapRef.current;
      if (snap) {
        state.camera.position.set(wantCam.x, wantCam.y, wantCam.z);
        playCamSnapRef.current = false;
      } else {
        const k = Math.min(1, dt * 4.0);
        state.camera.position.x += (wantCam.x - state.camera.position.x) * k;
        state.camera.position.y += (wantCam.y - state.camera.position.y) * k;
        state.camera.position.z += (wantCam.z - state.camera.position.z) * k;
      }
      if (controlsRef.current) {
        // Look at a fixed torso height (1.5u) — also independent of
        // c.y so jumps don't tilt the camera up with the character.
        // The character will visibly leap upward in the screen frame.
        controlsRef.current.target.set(c.x, 1.5, c.z);
        controlsRef.current.update();
      }
      // Reset hijack / manual flags so exiting play mode lands in
      // a clean state and the next portfolio frame glides cleanly
      // back to camDefault.
      camHijackedRef.current = true;
      manualOverrideRef.current = false;
      droneActiveRef.current = false;
      return;
    }

    // Clear the manual-override sticky bit when the character begins
    // a fresh walk (false→true edge on c.walking). That's the
    // explicit "user clicked something that started an event" signal
    // — past drag-overrides should give way to the follow-cam now.
    if (c.walking && !prevWalkingRef.current) {
      manualOverrideRef.current = false;
    }
    prevWalkingRef.current = c.walking;

    // Same edge-trigger for the balloon adventure: Sonny doesn't
    // walk when the balloon is clicked, so the c.walking edge above
    // doesn't fire. Clear manualOverrideRef when the adventure goes
    // inactive → active so the wantCam pan to the balloon vantage
    // takes effect (otherwise a stale user drag from earlier in
    // the session blocks the camera from following the rise).
    const advActive = balloonAdventureRef.current.active;
    if (advActive && !prevAdvActiveRef.current) {
      manualOverrideRef.current = false;
      droneActiveRef.current = false;
    }
    prevAdvActiveRef.current = advActive;

    // ── Target ────────────────────────────────────────────────────────────
    // OrbitControls .target lerps toward the character whenever they're
    // moving or locked in a special mode. For golfing we instead focus on
    // the midpoint between the tee and the hole so the ball flight stays
    // framed. Otherwise the target glides back to the plaza.
    const isIdleForTarget =
      c.mode === "idle" && !c.walking && !camHijackedRef.current;
    // Default look-at point. Outdoors looks at the plaza origin.
    // Indoors (academy) target the character's chest height so he's
    // centred in frame from the corner vantage; the wider FOV
    // surrounding the character still pulls in the banners + back
    // wall + ceiling.
    let wantTX = pathname === "/jiu-jitsu" ? c.x : 0;
    let wantTZ = pathname === "/jiu-jitsu" ? c.z : 0;
    let wantTY = pathname === "/jiu-jitsu" ? 1.5 : 1;
    // /chess: look at a point above the board (y=1.7) so the camera
    // tilts less steeply downward — that keeps Sonny's whole head
    // in frame across the table even though he's seated further
    // back (z=2.2) than directly behind the board.
    if (pathname === "/chess") {
      wantTX = 0;
      wantTZ = 0;
      wantTY = 1.7;
    }
    if (c.mode === "golfing") {
      wantTX = GOLF_MIDPOINT.x;
      wantTZ = GOLF_MIDPOINT.z;
      wantTY = 1;
    } else if (c.mode === "tubing") {
      // Chase the tube around the river: target lerps to char (the
      // rider's seat) so they stay framed regardless of where on
      // the loop they are. Y is bumped slightly above water so the
      // camera tilts down a hair to catch the foam and palms.
      wantTX = c.x;
      wantTZ = c.z;
      wantTY = 1.2;
    } else if (c.mode === "putting") {
      // Target a point a few units ahead of the kid in their aim
      // direction so the cup naturally sits in the centre of frame
      // when the kid is pointed at it. The chase cam below sits
      // behind the kid, so this looks "down the aim line".
      const ang = c.angle;
      wantTX = c.x + Math.sin(ang) * 1.5;
      wantTZ = c.z + Math.cos(ang) * 1.5;
      wantTY = 0.4;
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
    } else if (balloonAdventureRef.current.active) {
      // Adventure: look at the "action" altitude (adv.riderY). For
      // rising/atTop that IS the balloon (riders in basket). For
      // jumping/parachuting it's the average character Y so the
      // camera follows the chutes down while the balloon stays up
      // at peak (above frame). Boarding/landing/returning track
      // ground level so the camera lowers as the characters land
      // and walk away.
      const adv = balloonAdventureRef.current;
      wantTX = BALLOON_POSITION.x;
      wantTZ = BALLOON_POSITION.z;
      wantTY = adv.riderY + 0.9;
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
    } else if (c.mode === "tubing") {
      // Chase cam behind the tube — position 4.5u BEHIND the rider
      // along their current direction of travel, lifted to y=3.0 so
      // the camera looks slightly down at the water + tube + palms.
      // Tangent is derived from the body angle (already set to the
      // curve's tangent direction by the tubing tick), so the cam
      // tracks the tube smoothly around every bend without snapping.
      const ang = c.angle;
      wantCam = {
        x: c.x - Math.sin(ang) * 4.5,
        y: 3.0,
        z: c.z - Math.cos(ang) * 4.5,
      };
      camLerpSpeed = 3.5;
      camHijackedRef.current = true;
    } else if (c.mode === "putting") {
      // Over-the-shoulder vantage — camera sits 3u BEHIND the kid
      // (relative to their aim direction) and 2u up, so the aim
      // arrow + ball + cup all read along a line going "into" the
      // screen. Lerps faster than the default so the camera tracks
      // each A/D aim adjustment without dragging behind.
      const ang = c.angle;
      wantCam = {
        x: c.x - Math.sin(ang) * 3.0,
        y: 2.0,
        z: c.z - Math.cos(ang) * 3.0,
      };
      camLerpSpeed = 4.0;
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
    } else if (balloonAdventureRef.current.active) {
      // Travis+Kate balloon adventure: camera pulls back south-east
      // and lifts with the action altitude (adv.riderY). During
      // rising/atTop riderY == balloonY so the camera goes up with
      // the balloon. During jumping/parachuting riderY follows the
      // characters down (the balloon stays at peak above frame).
      // During landing/returning riderY is 0 so the camera lowers
      // to ground level. Sonny is OFF-CAMERA on the plaza — he's a
      // spectator, not a rider.
      const adv = balloonAdventureRef.current;
      wantCam = {
        x: BALLOON_POSITION.x + 4,
        // ~2u above the action. 3.5 minimum keeps the camera off
        // the ground even when riderY = 0.
        y: Math.max(3.5, adv.riderY + 2),
        z: BALLOON_POSITION.z + 14,
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
      // freely orbit again. (camDefault swaps between desktop and mobile
      // framings — see GameWorld isMobile detect.)
      wantCam = camDefault;
      camLerpSpeed = 1.4;
      const cam = state.camera;
      const dx = cam.position.x - camDefault.x;
      const dy = cam.position.y - camDefault.y;
      const dz = cam.position.z - camDefault.z;
      if (Math.hypot(dx, dy, dz) < 0.5) {
        camHijackedRef.current = false;
      }
    }
    if (wantCam && !manualOverrideRef.current) {
      // Skip the wantCam lerp while the user has manually taken over
      // the camera (any drag this session, until the next click).
      // Otherwise the follow-cam / glide-back fights the user's input
      // every frame and the camera snaps back the instant they
      // release the mouse mid-drag. Most painful during the walk-
      // back after an event (gator chase, coaster ride, golf,
      // balloon ride) where the user expects to be able to look
      // around the world while Sonny walks home.
      const cam = state.camera;
      const k = Math.min(1, dt * camLerpSpeed);
      cam.position.x += (wantCam.x - cam.position.x) * k;
      cam.position.y += (wantCam.y - cam.position.y) * k;
      cam.position.z += (wantCam.z - cam.position.z) * k;
    }

    if (controlsRef.current) {
      // Don't overwrite the user's drag-controlled target once they've
      // taken over manually — otherwise pan input is erased each frame
      // by the targetVec lerp and the target snaps back as soon as the
      // wantCam recovery resumes.
      if (!manualOverrideRef.current) {
        controlsRef.current.target.copy(targetVec);
      }
      const nowSec = performance.now() / 1000;
      const userIdle =
        !lastInputTimeRef.current ||
        nowSec - lastInputTimeRef.current > DRONE_INPUT_PAUSE_S;
      // Drone tour only flies the plaza waypoints — disable it on
      // any other route (especially the academy interior, where the
      // waypoints would point at coordinates in the wrong scene).
      const isOnHomeRoute = pathname === "/";
      const isIdle =
        c.mode === "idle" &&
        !c.walking &&
        !camHijackedRef.current &&
        !balloonAdventureRef.current.active &&
        userIdle &&
        isOnHomeRoute;
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
        // Pick speed preset based on whether we've finished a lap.
        const transitionS = firstCycleDoneRef.current
          ? DRONE_TRANSITION_S_SLOW
          : DRONE_TRANSITION_S_FAST;
        const dwellS = firstCycleDoneRef.current
          ? DRONE_DWELL_S_SLOW
          : DRONE_DWELL_S_FAST;
        const dwellRotSpeed = firstCycleDoneRef.current
          ? DRONE_DWELL_ROT_SPEED_SLOW
          : DRONE_DWELL_ROT_SPEED_FAST;
        const dwellRampS = firstCycleDoneRef.current
          ? DRONE_DWELL_RAMP_S_SLOW
          : DRONE_DWELL_RAMP_S_FAST;
        if (droneStateRef.current === "transitioning") {
          const progress = Math.min(1, elapsed / transitionS);
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
          // up to dwellRotSpeed over dwellRampS so the motion
          // never snaps in (matters especially when the drone
          // resumes after the user-input pause).
          const rampT = Math.min(1, elapsed / dwellRampS);
          const eased = rampT * rampT * (3 - 2 * rampT);
          dwellAngleRef.current += dwellRotSpeed * eased * dt;
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
          if (elapsed > dwellS) {
            // End of dwell — seed prev for the next transition and
            // advance to the next waypoint (wrap around the loop).
            dronePrevPosRef.current.copy(state.camera.position);
            dronePrevTargetRef.current.copy(wp.target);
            const nextIdx =
              (droneIdxRef.current + 1) % DRONE_TOUR.length;
            // We just finished the LAST waypoint of the lap — flip
            // to slow preset for all subsequent laps.
            if (nextIdx === 0) firstCycleDoneRef.current = true;
            droneIdxRef.current = nextIdx;
            droneStateRef.current = "transitioning";
            dronePhaseStartRef.current = now;
          }
        }
      } else {
        // The pointerdown listener already cleared droneActiveRef and
        // armed camHijackedRef, so the glide-back-to-CAM_DEFAULT (if
        // the click missed) or the follow-cam (if a walk started)
        // handles the visual recovery automatically.
        droneActiveRef.current = false;
      }
      controlsRef.current.update();
    }
  });

  // Suppress unused warning for prop kept for potential future use
  // Indoors (academy / chess study) we tighten orbit constraints so
  // the user can't pull the camera outside the room walls or zoom in
  // past the action. Outdoors the existing wide range stays for the
  // whole-world view.
  const isAcademy = pathname === "/jiu-jitsu";
  const isChess = pathname === "/chess";
  const isIndoors = isAcademy || isChess;
  // Chess room is smaller and the board is the focal point — keep
  // the user close to it but allow looking down (high polar angle =
  // nearly top-down) to read the squares clearly.
  const minDist = isChess ? 2.4 : 4;
  const maxDist = isChess ? 9 : isAcademy ? 20 : 70;
  const minPolar = Math.PI * (isChess ? 0.05 : isAcademy ? 0.2 : 0.12);
  const maxPolar = Math.PI * (isChess ? 0.45 : isAcademy ? 0.5 : 0.48);

  return (
    <OrbitControls
      ref={controlsRef}
      enableDamping
      dampingFactor={0.08}
      minDistance={isIndoors ? minDist : 4}
      maxDistance={maxDist}
      minPolarAngle={minPolar}
      maxPolarAngle={maxPolar}
      target={[0, 1, 0]}
      autoRotateSpeed={0.4}
      // On /chess, disable camera rotation + pan so a small mouse
      // drag while clicking a piece doesn't rotate the view out
      // from under the user. Zoom is left on so the board can still
      // be inspected closer. R3F's onClick raycaster on the square
      // / piece meshes still fires normally — OrbitControls only
      // owns the camera, not the pick events.
      enableRotate={!isChess}
      enablePan={!isChess}
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

// -------------------- jiu-jitsu academy interior --------------------

// Room is centred at the origin so the existing Character coords
// (which assume origin-centred world space) still work without
// transformation. The character spawns at the entrance on
// /jiu-jitsu (see pathname useEffect in GameWorld).
const ACADEMY_W = 26; // east-west width (x extent ±13)
const ACADEMY_L = 20; // north-south length (z extent ±10)
const ACADEMY_H = 6; // wall height (ceiling at y=6)
const ACADEMY_MAT_INSET = 1.2; // distance from wall to mat edge

// Door is on the south wall (-z), slightly off-centre so the
// exterior building's door alignment carries over. Character snaps
// to just inside this door on route entry.
const ACADEMY_DOOR_W = 1.6;
const ACADEMY_DOOR_H = 2.2;
const ACADEMY_DOOR_Z = -ACADEMY_L / 2; // south wall
const ACADEMY_ENTRY = { x: 0, z: -ACADEMY_L / 2 + 2 };

// Brown belt color used by training partners standing on the mat
// with the player character. Warm BJJ brown, matches typical IBJJF
// brown belt color.
const BROWN_BELT = "#6b4226";

// PartnerFace — billboarded photo plane for the training partner's
// head. Same trick as FaceBillboard: aim the plane's local -Z away
// from the camera so the textured +Z side ends up facing it.
function PartnerFace({ src, size = 0.85 }: { src: string; size?: number }) {
  // Treat `size` as a "reference width" for API compat — the actual
  // plane HEIGHT is fixed at the same height Kate had originally
  // (size / 0.867, her PNG's aspect), and the width derives from
  // the texture's own aspect. Result: all characters' heads are the
  // same vertical size on screen; only the silhouette width differs.
  const planeHeight = size / 0.867;
  const tex = useTexture(src);
  // sRGB so the photo's colors render correctly (not washed out as
  // if it were a linear-color data texture).
  tex.colorSpace = THREE.SRGBColorSpace;
  // Per-source colour correction. travis.png has a noticeably warm
  // orange cast vs the other photos (different lighting / white
  // balance when shot). We desaturate + dial down brightness a hair
  // to bring his face into the same neutral tone range as Kate +
  // Sonny so the three line-up reads consistently. Done once at
  // load via a canvas filter; replaces the texture image in place,
  // so it's free per-frame.
  useEffect(() => {
    if (src !== "/travis.png") return;
    // Idempotency tag: the filter mutates tex.image to a canvas, so
    // re-running on remount would compound the desaturation each
    // time the user switches characters (Travis would get darker
    // and darker after every click). Stamp the texture once and
    // skip subsequent applications.
    const stamped = (tex as unknown as { __travisFiltered?: boolean });
    if (stamped.__travisFiltered) return;
    const img = tex.image as HTMLImageElement | undefined;
    if (!img || !img.width || !img.height) return;
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.filter = "saturate(0.78) brightness(0.96)";
    ctx.drawImage(img, 0, 0);
    tex.image = canvas;
    tex.needsUpdate = true;
    stamped.__travisFiltered = true;
  }, [src, tex]);
  const meshRef = useRef<THREE.Mesh>(null);
  const meshWorld = useMemo(() => new THREE.Vector3(), []);
  const lookTarget = useMemo(() => new THREE.Vector3(), []);
  useFrame((state) => {
    const m = meshRef.current;
    if (!m) return;
    m.getWorldPosition(meshWorld);
    lookTarget.copy(meshWorld).multiplyScalar(2).sub(state.camera.position);
    m.lookAt(lookTarget);
  });
  // Plane HEIGHT is fixed (planeHeight, derived from size as if it
  // were Kate's aspect) and width is derived from the texture's
  // natural aspect. This keeps all characters' heads at the same
  // vertical size on screen — earlier we computed h from size/aspect,
  // which gave Travis (narrow 0.717 aspect) a noticeably TALLER plane
  // than Kate or Sonny, and his face read as "too big and pushed
  // down" because the same eye-level on each PNG ended up at a
  // different world y. Fixing height equalises perceived head size.
  const img = tex.image as HTMLImageElement | undefined;
  const aspect = img && img.width && img.height ? img.width / img.height : 0.867;
  const w = planeHeight * aspect;
  return (
    <mesh ref={meshRef}>
      <planeGeometry args={[w, planeHeight]} />
      <meshBasicMaterial
        map={tex}
        transparent
        toneMapped={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

// TrainingPartner — a static figure standing on the academy mat
// next to the player character. Same gi style as the Character
// component but slimmer, no tattoos, no exposed chest-V (closed
// kimono), and a configurable belt color. Face is a billboard
// photo plane (see PartnerFace).
function TrainingPartner({
  position,
  beltColor = BROWN_BELT,
  faceSrc,
  faceScale = 1.0,
  faceY = 1.45,
  onSelect,
}: {
  position: [number, number, number];
  beltColor?: string;
  faceSrc: string;
  // Per-character scale multiplier for the face plane. Compensates
  // for source PNGs that fill more (or less) of their canvas than
  // Kate's reference (see CHARACTER_DATA.faceScale).
  faceScale?: number;
  // World-Y of the face plane center. Lifted for tight-cropped photos
  // so the chin clears the torso top (~y=1.275).
  faceY?: number;
  // Optional click handler — when provided, the whole figure becomes
  // a clickable "character pick" target. Used by the academy to
  // make every standing partner selectable as the playable avatar.
  onSelect?: () => void;
}) {
  // Body-local +Z is the front of the body. Group is rotated by π
  // around Y so the body faces world -Z (south, toward the camera
  // at the default academy vantage). Lapels / belt ends are placed
  // at local +Z (positive) so they render on the camera-facing side
  // after the rotation flips +Z to world -Z.
  return (
    <group
      position={position}
      rotation={[0, Math.PI, 0]}
      onClick={
        onSelect
          ? (e) => {
              e.stopPropagation();
              onSelect();
            }
          : undefined
      }
      onPointerOver={
        onSelect
          ? (e) => {
              e.stopPropagation();
              document.body.style.cursor = "pointer";
            }
          : undefined
      }
      onPointerOut={
        onSelect
          ? (e) => {
              e.stopPropagation();
              document.body.style.cursor = "";
            }
          : undefined
      }
    >
      {/* Torso (gi top) — slightly slimmer than Sonny's 0.55 */}
      <mesh position={[0, 1.0, 0]} castShadow>
        <boxGeometry args={[0.48, 0.55, 0.30]} />
        <meshStandardMaterial color={GI} />
      </mesh>
      {/* Closed kimono — two crossed lapels, no exposed skin V.
          Left lapel sits behind the right at the waist so the right
          lapel visibly overlaps. */}
      <mesh position={[-0.09, 1.04, 0.155]} rotation={[0, 0, 0.4]}>
        <boxGeometry args={[0.10, 0.46, 0.025]} />
        <meshStandardMaterial color={GI_SHADE} />
      </mesh>
      <mesh position={[0.09, 1.04, 0.158]} rotation={[0, 0, -0.4]}>
        <boxGeometry args={[0.10, 0.46, 0.025]} />
        <meshStandardMaterial color={GI_SHADE} />
      </mesh>
      {/* Dark piping along the inner edge of each lapel. */}
      <mesh position={[-0.05, 1.06, 0.172]} rotation={[0, 0, 0.4]}>
        <boxGeometry args={[0.016, 0.46, 0.005]} />
        <meshStandardMaterial color="#9c9580" />
      </mesh>
      <mesh position={[0.05, 1.06, 0.175]} rotation={[0, 0, -0.4]}>
        <boxGeometry args={[0.016, 0.46, 0.005]} />
        <meshStandardMaterial color="#9c9580" />
      </mesh>

      {/* Belt */}
      <mesh position={[0, 0.71, 0]} castShadow>
        <boxGeometry args={[0.51, 0.10, 0.32]} />
        <meshStandardMaterial color={beltColor} />
      </mesh>
      {/* Belt knot */}
      <mesh position={[0, 0.71, 0.17]} castShadow>
        <boxGeometry args={[0.10, 0.13, 0.05]} />
        <meshStandardMaterial color={beltColor} />
      </mesh>
      {/* Belt ends */}
      <mesh position={[-0.025, 0.55, 0.183]} rotation={[0, 0, 0.08]}>
        <boxGeometry args={[0.045, 0.20, 0.02]} />
        <meshStandardMaterial color={beltColor} />
      </mesh>
      <mesh position={[0.04, 0.56, 0.183]} rotation={[0, 0, -0.15]}>
        <boxGeometry args={[0.045, 0.18, 0.02]} />
        <meshStandardMaterial color={beltColor} />
      </mesh>

      {/* Arms — hanging at sides, no swing. Slimmer than Sonny. */}
      <group position={[-0.29, 1.22, 0]}>
        <mesh position={[0, -0.2, 0]} castShadow>
          <boxGeometry args={[0.14, 0.4, 0.17]} />
          <meshStandardMaterial color={GI} />
        </mesh>
        <mesh position={[0, -0.5, 0]} castShadow>
          <boxGeometry args={[0.11, 0.25, 0.13]} />
          <meshStandardMaterial color={SKIN} />
        </mesh>
      </group>
      <group position={[0.29, 1.22, 0]}>
        <mesh position={[0, -0.2, 0]} castShadow>
          <boxGeometry args={[0.14, 0.4, 0.17]} />
          <meshStandardMaterial color={GI} />
        </mesh>
        <mesh position={[0, -0.5, 0]} castShadow>
          <boxGeometry args={[0.11, 0.25, 0.13]} />
          <meshStandardMaterial color={SKIN} />
        </mesh>
      </group>

      {/* Legs — gi pants + bare feet (no shoes on the mat). */}
      <group position={[-0.12, 0.66, 0]}>
        <mesh position={[0, -0.32, 0]} castShadow>
          <boxGeometry args={[0.2, 0.6, 0.22]} />
          <meshStandardMaterial color={GI} />
        </mesh>
        <mesh position={[0, -0.66, 0.02]} castShadow>
          <boxGeometry args={[0.22, 0.08, 0.28]} />
          <meshStandardMaterial color={SKIN} />
        </mesh>
      </group>
      <group position={[0.12, 0.66, 0]}>
        <mesh position={[0, -0.32, 0]} castShadow>
          <boxGeometry args={[0.2, 0.6, 0.22]} />
          <meshStandardMaterial color={GI} />
        </mesh>
        <mesh position={[0, -0.66, 0.02]} castShadow>
          <boxGeometry args={[0.22, 0.08, 0.28]} />
          <meshStandardMaterial color={SKIN} />
        </mesh>
      </group>

      {/* Head — photo billboard. Plane rotation is managed inside
          PartnerFace so the photo always faces the camera. `faceScale`
          shrinks (or grows) the plane to compensate for per-character
          PNG cropping differences — see CHARACTER_DATA. `faceY` lifts
          the plane higher for tightly-cropped photos so the chin
          clears the torso. */}
      <group position={[0, faceY, 0]}>
        <PartnerFace src={faceSrc} size={0.85 * faceScale} />
      </group>
    </group>
  );
}

// Travis — black-belt friend hanging out by the hot-air balloon.
// Same BJJ gi build as Sonny (white kimono + black belt) so he
// reads as another practitioner. Distinct from Sonny via the face
// photo (/public/travis.png). Position + facing + walking
// animation are driven by an AvatarState ref so the same figure
// can stand idle by the balloon, walk into the basket, parachute
// down, and walk back without remounting.
function Travis({
  avatarRef,
  faceSrc = "/travis.png",
}: {
  avatarRef: React.MutableRefObject<AvatarState>;
  faceSrc?: string;
}) {
  const rootRef = useRef<THREE.Group>(null);
  const leftShoulderRef = useRef<THREE.Group>(null);
  const rightShoulderRef = useRef<THREE.Group>(null);
  const leftHipRef = useRef<THREE.Group>(null);
  const rightHipRef = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!avatarRef || !avatarRef.current || !rootRef.current) return;
    const a = avatarRef.current;
    rootRef.current.visible = a.visible;
    if (!a.visible) return;
    rootRef.current.position.x = a.x;
    rootRef.current.position.y = a.y;
    rootRef.current.position.z = a.z;
    // Smooth rotation toward target facing direction (same lerp
    // approach as Sonny — 20% per frame is a comfortable turn rate).
    const cur = rootRef.current.rotation.y;
    let diff = a.angle - cur;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    rootRef.current.rotation.y = cur + diff * 0.2;
    // Limb swing while walking — opposite-phase shoulders/hips for
    // a natural gait. Match the WALK_SPEED * 4.5 step rate Sonny uses.
    const swing = a.walking ? Math.sin(a.stepPhase * Math.PI * 2) * 0.6 : 0;
    if (leftShoulderRef.current) leftShoulderRef.current.rotation.x = swing;
    if (rightShoulderRef.current) rightShoulderRef.current.rotation.x = -swing;
    if (leftHipRef.current) leftHipRef.current.rotation.x = -swing;
    if (rightHipRef.current) rightHipRef.current.rotation.x = swing;
  });
  return (
    <group ref={rootRef}>
      {/* Torso (gi top) — closed kimono, same width as TrainingPartner. */}
      <mesh position={[0, 1.0, 0]} castShadow>
        <boxGeometry args={[0.48, 0.55, 0.30]} />
        <meshStandardMaterial color={GI} />
      </mesh>
      {/* Closed-kimono lapels on the front (camera-facing +Z when
          angle=0). Crossed at the waist with a small overlap. */}
      <mesh position={[-0.09, 1.04, 0.155]} rotation={[0, 0, 0.4]}>
        <boxGeometry args={[0.10, 0.46, 0.025]} />
        <meshStandardMaterial color={GI_SHADE} />
      </mesh>
      <mesh position={[0.09, 1.04, 0.158]} rotation={[0, 0, -0.4]}>
        <boxGeometry args={[0.10, 0.46, 0.025]} />
        <meshStandardMaterial color={GI_SHADE} />
      </mesh>
      {/* Black belt around the waist + knot + ends */}
      <mesh position={[0, 0.71, 0]} castShadow>
        <boxGeometry args={[0.51, 0.10, 0.32]} />
        <meshStandardMaterial color={BELT} />
      </mesh>
      <mesh position={[0, 0.71, 0.17]} castShadow>
        <boxGeometry args={[0.10, 0.13, 0.05]} />
        <meshStandardMaterial color={BELT} />
      </mesh>
      <mesh position={[-0.025, 0.55, 0.183]} rotation={[0, 0, 0.08]}>
        <boxGeometry args={[0.045, 0.20, 0.02]} />
        <meshStandardMaterial color={BELT} />
      </mesh>
      <mesh position={[0.04, 0.56, 0.183]} rotation={[0, 0, -0.15]}>
        <boxGeometry args={[0.045, 0.18, 0.02]} />
        <meshStandardMaterial color={BELT} />
      </mesh>

      {/* Arms — gi sleeves + forearm skin. Pivot at the shoulder so
          rotation.x swings forward/back during walks. */}
      <group ref={leftShoulderRef} position={[-0.29, 1.22, 0]}>
        <mesh position={[0, -0.2, 0]} castShadow>
          <boxGeometry args={[0.14, 0.4, 0.17]} />
          <meshStandardMaterial color={GI} />
        </mesh>
        <mesh position={[0, -0.5, 0]} castShadow>
          <boxGeometry args={[0.11, 0.25, 0.13]} />
          <meshStandardMaterial color={SKIN} />
        </mesh>
      </group>
      <group ref={rightShoulderRef} position={[0.29, 1.22, 0]}>
        <mesh position={[0, -0.2, 0]} castShadow>
          <boxGeometry args={[0.14, 0.4, 0.17]} />
          <meshStandardMaterial color={GI} />
        </mesh>
        <mesh position={[0, -0.5, 0]} castShadow>
          <boxGeometry args={[0.11, 0.25, 0.13]} />
          <meshStandardMaterial color={SKIN} />
        </mesh>
      </group>

      {/* Legs — gi pants, bare feet (matches the academy look). */}
      <group ref={leftHipRef} position={[-0.12, 0.66, 0]}>
        <mesh position={[0, -0.32, 0]} castShadow>
          <boxGeometry args={[0.2, 0.6, 0.22]} />
          <meshStandardMaterial color={GI} />
        </mesh>
        <mesh position={[0, -0.66, 0.02]} castShadow>
          <boxGeometry args={[0.22, 0.08, 0.28]} />
          <meshStandardMaterial color={SKIN} />
        </mesh>
      </group>
      <group ref={rightHipRef} position={[0.12, 0.66, 0]}>
        <mesh position={[0, -0.32, 0]} castShadow>
          <boxGeometry args={[0.2, 0.6, 0.22]} />
          <meshStandardMaterial color={GI} />
        </mesh>
        <mesh position={[0, -0.66, 0.02]} castShadow>
          <boxGeometry args={[0.22, 0.08, 0.28]} />
          <meshStandardMaterial color={SKIN} />
        </mesh>
      </group>

      {/* Head — photo billboard. y=1.7 sits the chin just above
          the gi collar/lapel V — earlier y=1.6 cropped the beard,
          earlier y=1.78 floated noticeably above the torso.
          Suspense fallback={null} so the body still renders if
          the photo is missing/loading. */}
      <group position={[0, 1.7, 0]}>
        <Suspense fallback={null}>
          <PartnerFace src={faceSrc} size={0.85} />
        </Suspense>
      </group>
    </group>
  );
}

// KateOutside — Kate's BJJ-gi figure used OUTSIDE the academy
// (during the balloon adventure). Same gi build as TrainingPartner
// but driven by an AvatarState ref so she can walk, sit in the
// basket, and parachute down. The static academy version
// (TrainingPartner) is unchanged.
function KateOutside({
  avatarRef,
  faceSrc = "/kate.png",
}: {
  avatarRef: React.MutableRefObject<AvatarState>;
  faceSrc?: string;
}) {
  const rootRef = useRef<THREE.Group>(null);
  const leftShoulderRef = useRef<THREE.Group>(null);
  const rightShoulderRef = useRef<THREE.Group>(null);
  const leftHipRef = useRef<THREE.Group>(null);
  const rightHipRef = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!avatarRef || !avatarRef.current || !rootRef.current) return;
    const a = avatarRef.current;
    rootRef.current.visible = a.visible;
    if (!a.visible) return;
    rootRef.current.position.x = a.x;
    rootRef.current.position.y = a.y;
    rootRef.current.position.z = a.z;
    const cur = rootRef.current.rotation.y;
    let diff = a.angle - cur;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    rootRef.current.rotation.y = cur + diff * 0.2;
    const swing = a.walking ? Math.sin(a.stepPhase * Math.PI * 2) * 0.6 : 0;
    if (leftShoulderRef.current) leftShoulderRef.current.rotation.x = swing;
    if (rightShoulderRef.current) rightShoulderRef.current.rotation.x = -swing;
    if (leftHipRef.current) leftHipRef.current.rotation.x = -swing;
    if (rightHipRef.current) rightHipRef.current.rotation.x = swing;
  });
  // Wrap in another group at root so child-space content (lapels)
  // sits correctly when rootRef.rotation is applied around the
  // figure's vertical axis.
  return (
    <group ref={rootRef}>
      {/* Torso (gi top) */}
      <mesh position={[0, 1.0, 0]} castShadow>
        <boxGeometry args={[0.48, 0.55, 0.30]} />
        <meshStandardMaterial color={GI} />
      </mesh>
      {/* Closed kimono — lapels on the FRONT of the body (+Z, the
          character's facing direction). Earlier these were at -Z
          (back of body), which made Kate look like she was on
          backwards. rootRef.rotation.y is set per-frame from
          kateRef.angle so the lapels rotate to wherever her body
          is facing. Rotation signs match Travis: outer lapel tips
          tilt OUTWARD at the top (forming the V at the collar). */}
      <mesh position={[-0.09, 1.04, 0.155]} rotation={[0, 0, 0.4]}>
        <boxGeometry args={[0.10, 0.46, 0.025]} />
        <meshStandardMaterial color={GI_SHADE} />
      </mesh>
      <mesh position={[0.09, 1.04, 0.158]} rotation={[0, 0, -0.4]}>
        <boxGeometry args={[0.10, 0.46, 0.025]} />
        <meshStandardMaterial color={GI_SHADE} />
      </mesh>

      {/* Belt — brown. Knot on the FRONT (+Z) so it reads with the
          lapels above it. */}
      <mesh position={[0, 0.71, 0]} castShadow>
        <boxGeometry args={[0.51, 0.10, 0.32]} />
        <meshStandardMaterial color={BROWN_BELT} />
      </mesh>
      <mesh position={[0, 0.71, 0.17]} castShadow>
        <boxGeometry args={[0.10, 0.13, 0.05]} />
        <meshStandardMaterial color={BROWN_BELT} />
      </mesh>

      {/* Arms — pivot at shoulder for walking swing. */}
      <group ref={leftShoulderRef} position={[-0.29, 1.22, 0]}>
        <mesh position={[0, -0.2, 0]} castShadow>
          <boxGeometry args={[0.14, 0.4, 0.17]} />
          <meshStandardMaterial color={GI} />
        </mesh>
        <mesh position={[0, -0.5, 0]} castShadow>
          <boxGeometry args={[0.11, 0.25, 0.13]} />
          <meshStandardMaterial color={SKIN} />
        </mesh>
      </group>
      <group ref={rightShoulderRef} position={[0.29, 1.22, 0]}>
        <mesh position={[0, -0.2, 0]} castShadow>
          <boxGeometry args={[0.14, 0.4, 0.17]} />
          <meshStandardMaterial color={GI} />
        </mesh>
        <mesh position={[0, -0.5, 0]} castShadow>
          <boxGeometry args={[0.11, 0.25, 0.13]} />
          <meshStandardMaterial color={SKIN} />
        </mesh>
      </group>

      {/* Legs — gi pants, pivot at hip for walking swing. */}
      <group ref={leftHipRef} position={[-0.12, 0.66, 0]}>
        <mesh position={[0, -0.32, 0]} castShadow>
          <boxGeometry args={[0.2, 0.6, 0.22]} />
          <meshStandardMaterial color={GI} />
        </mesh>
        <mesh position={[0, -0.66, 0.02]} castShadow>
          <boxGeometry args={[0.22, 0.08, 0.28]} />
          <meshStandardMaterial color={SKIN} />
        </mesh>
      </group>
      <group ref={rightHipRef} position={[0.12, 0.66, 0]}>
        <mesh position={[0, -0.32, 0]} castShadow>
          <boxGeometry args={[0.2, 0.6, 0.22]} />
          <meshStandardMaterial color={GI} />
        </mesh>
        <mesh position={[0, -0.66, 0.02]} castShadow>
          <boxGeometry args={[0.22, 0.08, 0.28]} />
          <meshStandardMaterial color={SKIN} />
        </mesh>
      </group>

      {/* Head — photo billboard. */}
      <group position={[0, 1.45, 0]}>
        <Suspense fallback={null}>
          <PartnerFace src={faceSrc} size={0.85} />
        </Suspense>
      </group>
    </group>
  );
}

// Parachute — dome canopy + 4 suspension lines above a falling
// character. Only visible during the balloon-adventure parachuting
// phase. Position tracks the avatar so the chute follows them
// during their descent.
function Parachute({
  avatarRef,
  adventureRef,
  color = "#d94a4a",
  altColor = "#f4f1de",
}: {
  avatarRef: React.MutableRefObject<AvatarState>;
  adventureRef: React.MutableRefObject<BalloonAdventureState>;
  color?: string;
  altColor?: string;
}) {
  const groupRef = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!groupRef.current || !avatarRef || !avatarRef.current || !adventureRef || !adventureRef.current) return;
    const a = avatarRef.current;
    const adv = adventureRef.current;
    const visible = adv.active && adv.phase === "parachuting";
    groupRef.current.visible = visible;
    if (!visible) return;
    // Position above the character's head (head sits at ~y=1.6 in
    // their local frame). Canopy's base sits at y=2.4 above the
    // character's feet, lines reach down to shoulder level.
    groupRef.current.position.x = a.x;
    groupRef.current.position.y = a.y + 2.4;
    groupRef.current.position.z = a.z;
  });
  // Canopy radius + line length. Tuned by eye to look "carrying"
  // rather than oversized.
  const CANOPY_R = 1.2;
  const LINE_LEN = 1.4;
  const LINE_R = 0.012;
  // Suspension lines at four corners. Each is a thin cylinder
  // angled from the canopy edge down to the character's shoulder.
  const corners: [number, number][] = [
    [-CANOPY_R * 0.55, -CANOPY_R * 0.55],
    [CANOPY_R * 0.55, -CANOPY_R * 0.55],
    [-CANOPY_R * 0.55, CANOPY_R * 0.55],
    [CANOPY_R * 0.55, CANOPY_R * 0.55],
  ];
  return (
    <group ref={groupRef} visible={false}>
      {/* Canopy — upper hemisphere of a sphere = dome shape */}
      <mesh castShadow>
        <sphereGeometry
          args={[CANOPY_R, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2]}
        />
        <meshStandardMaterial color={color} side={THREE.DoubleSide} />
      </mesh>
      {/* Alternating-color stripes for a parachute-like pattern.
          Thin equator band in a contrasting color. */}
      <mesh position={[0, 0.02, 0]}>
        <torusGeometry args={[CANOPY_R * 0.99, 0.04, 6, 24]} />
        <meshStandardMaterial color={altColor} />
      </mesh>
      {/* Four suspension lines — cylinders angled from canopy edge
          down to where the character's shoulders are (~y=-LINE_LEN). */}
      {corners.map(([cx, cz], i) => {
        // Each line goes from (cx, 0, cz) to (0, -LINE_LEN, 0).
        // Use a midpoint position + lookAt-style rotation.
        const mid = new THREE.Vector3(cx / 2, -LINE_LEN / 2, cz / 2);
        const dir = new THREE.Vector3(-cx, -LINE_LEN, -cz);
        const len = dir.length();
        // cylinder geometry hangs along +Y; rotate so its axis aligns
        // with dir. Use quaternion from up-axis (+Y) to dir.
        const quat = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          dir.clone().normalize()
        );
        return (
          <mesh
            key={i}
            position={[mid.x, mid.y, mid.z]}
            quaternion={quat}
          >
            <cylinderGeometry args={[LINE_R, LINE_R, len, 6]} />
            <meshStandardMaterial color="#1a1a1a" />
          </mesh>
        );
      })}
    </group>
  );
}

// Heart — small love-heart that pops up above Travis + Kate during
// the balloon-adventure kiss phase, then floats up + fades out as
// they walk away during the returning phase.
//
// Built from two top-lobe spheres + a downward-pointing cone for
// the V-point (low-poly heart silhouette). Position locks to the
// kiss spot on entry to kiss — during returning we keep it at the
// snapshotted spot (so the heart stays where the kiss happened
// instead of trailing Travis as he walks home).
function Heart({
  adventureRef,
  travisRef,
  kateRef,
}: {
  adventureRef: React.MutableRefObject<BalloonAdventureState>;
  travisRef: React.MutableRefObject<AvatarState>;
  kateRef: React.MutableRefObject<AvatarState>;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const fixedXRef = useRef(0);
  const fixedZRef = useRef(0);
  const wasKissRef = useRef(false);
  useFrame((state) => {
    const g = groupRef.current;
    if (
      !g ||
      !adventureRef ||
      !adventureRef.current ||
      !travisRef ||
      !travisRef.current ||
      !kateRef ||
      !kateRef.current
    )
      return;
    const adv = adventureRef.current;
    const trav = travisRef.current;
    const k = kateRef.current;
    const isKiss = adv.active && adv.phase === "kiss";
    const isReturn = adv.active && adv.phase === "returning";
    // Reset wasKissRef whenever the adventure is anywhere BEFORE
    // kiss (or inactive), so a fresh adventure cycle re-captures
    // the snapshot cleanly even if Fast Refresh / HMR preserved
    // the ref from a previous cycle.
    if (
      !adv.active ||
      adv.phase === "kateWalking" ||
      adv.phase === "boarding" ||
      adv.phase === "rising" ||
      adv.phase === "atTop" ||
      adv.phase === "jumping" ||
      adv.phase === "parachuting" ||
      adv.phase === "landing"
    ) {
      wasKissRef.current = false;
    }
    // Snapshot kiss-spot midpoint on entry to kiss so during the
    // returning phase the heart stays put (instead of following
    // Travis as he walks back home).
    if (isKiss && !wasKissRef.current) {
      fixedXRef.current = (trav.x + k.x) / 2;
      fixedZRef.current = (trav.z + k.z) / 2;
    }
    wasKissRef.current = isKiss;
    let visible = false;
    let posY = 2.6;
    let opacity = 1;
    let scale = 0.5;
    if (isKiss) {
      visible = true;
      const t = adv.t;
      // Pop in over the first 20% of the kiss, then gentle pulse.
      if (t < 0.2) scale = (t / 0.2) * 0.55;
      else scale = 0.55 + Math.sin(state.clock.elapsedTime * 6) * 0.05;
      posY = 2.6 + Math.sin(state.clock.elapsedTime * 3) * 0.06;
      g.position.x = (trav.x + k.x) / 2;
      g.position.z = (trav.z + k.z) / 2;
    } else if (isReturn) {
      visible = true;
      // adv.t in the returning phase is elapsed seconds since the
      // phase started (game tick sets it to += clampedDt each
      // frame). Slow rise at 1.5u/sec so the heart stays in frame
      // long enough to read clearly; stays fully opaque the whole
      // way up and disappears when the adventure ends (both home).
      const HEART_RISE_RATE = 1.5;
      posY = 2.6 + adv.t * HEART_RISE_RATE;
      opacity = 1;
      scale = 0.75;
      g.position.x = fixedXRef.current;
      g.position.z = fixedZRef.current;
    }
    g.visible = visible && opacity > 0.01;
    if (!g.visible) return;
    g.position.y = posY;
    g.scale.setScalar(scale);
    // Apply opacity to all materials in the heart so the fade-out
    // affects every sub-mesh uniformly.
    g.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const mat = mesh.material as THREE.Material | undefined;
      if (mat && "opacity" in mat) {
        (mat as THREE.MeshStandardMaterial).opacity = opacity;
        mat.transparent = true;
      }
    });
  });
  // Heart silhouette: two top-lobe spheres + a downward-pointing
  // cone (rotated π around X so its apex points down). The cone's
  // top edge sits just below the spheres so the three shapes
  // visually merge into a heart silhouette.
  const PINK = "#ff3a78";
  const DEEP_PINK = "#ff1a5a";
  return (
    <group ref={groupRef} visible={false}>
      <mesh position={[-0.22, 0.08, 0]}>
        <sphereGeometry args={[0.28, 14, 10]} />
        <meshStandardMaterial
          color={PINK}
          emissive={DEEP_PINK}
          emissiveIntensity={0.6}
          transparent
        />
      </mesh>
      <mesh position={[0.22, 0.08, 0]}>
        <sphereGeometry args={[0.28, 14, 10]} />
        <meshStandardMaterial
          color={PINK}
          emissive={DEEP_PINK}
          emissiveIntensity={0.6}
          transparent
        />
      </mesh>
      <mesh position={[0, -0.36, 0]} rotation={[Math.PI, 0, 0]}>
        <coneGeometry args={[0.42, 0.6, 18]} />
        <meshStandardMaterial
          color={PINK}
          emissive={DEEP_PINK}
          emissiveIntensity={0.6}
          transparent
        />
      </mesh>
    </group>
  );
}

// Glowing yellow ground ring shown under the currently-selected
// character in the academy. Pure visual confirmation of "this is
// who you are playing as." Faint additive disc that bobs slightly
// so the eye catches it.
function SelectionRing({ position }: { position: [number, number, number] }) {
  const meshRef = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (!meshRef.current) return;
    // Tiny pulse in opacity so the ring "breathes."
    const t = state.clock.elapsedTime;
    const mat = meshRef.current.material as THREE.MeshBasicMaterial;
    mat.opacity = 0.35 + Math.sin(t * 2.5) * 0.12;
  });
  return (
    <mesh
      ref={meshRef}
      position={position}
      rotation={[-Math.PI / 2, 0, 0]}
    >
      <ringGeometry args={[0.55, 0.78, 32]} />
      <meshBasicMaterial
        color="#fde047"
        transparent
        opacity={0.4}
        depthWrite={false}
      />
    </mesh>
  );
}

function Academy({
  onExit,
  characterId,
}: {
  onExit: () => void;
  characterId: CharacterId;
}) {
  // Colours pulled from the user's reference photo.
  const MAT_BLACK = "#1f1f23";
  const TILE_GRAY = "#9a9893";
  const WALL_WHITE = "#e8e2d6";
  const CEILING_PANEL = "#dcd6cc";
  const CEILING_LIGHT = "#fffceb";
  const KICKPAD_BLACK = "#15151a";
  const DOOR_FRAME = "#33312c";
  const DOOR_GLASS = "#5a7388";

  // Photo banner of Helio Gracie in front of the Federação de
  // Jiu-Jitsu da Guanabara flag — hung as the centerpiece banner.
  const helioTex = useTexture("/helio.jpg");
  helioTex.colorSpace = THREE.SRGBColorSpace;

  // Wall planes face INWARD (visible from inside the room only).
  return (
    <group>
      {/* ── Lighting ──────────────────────────────────────────── */}
      {/* Bright fluorescent feel — flat ambient + a few overhead
          point lights distributed along the room so the mat reads
          evenly. No directional sun light because we're indoors. */}
      <ambientLight intensity={1.05} color="#f4f0e6" />
      {[
        [0, ACADEMY_H - 0.2, -7],
        [0, ACADEMY_H - 0.2, 0],
        [0, ACADEMY_H - 0.2, 7],
      ].map(([x, y, z], i) => (
        <pointLight
          key={i}
          position={[x, y, z]}
          intensity={0.55}
          distance={20}
          decay={1.6}
          color="#fffaeb"
        />
      ))}

      {/* ── Floor ─────────────────────────────────────────────── */}
      {/* Tile border: full room footprint */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0, 0]}
        receiveShadow
      >
        <planeGeometry args={[ACADEMY_W, ACADEMY_L]} />
        <meshStandardMaterial color={TILE_GRAY} roughness={0.9} />
      </mesh>
      {/* Black training mat — inset from the walls so a tile border
          shows around the edge (matches the photo). Pushed up
          0.005 to avoid z-fighting with the tile floor. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.005, 0]}
        receiveShadow
      >
        <planeGeometry
          args={[
            ACADEMY_W - ACADEMY_MAT_INSET * 2,
            ACADEMY_L - ACADEMY_MAT_INSET * 2,
          ]}
        />
        <meshStandardMaterial color={MAT_BLACK} roughness={1} />
      </mesh>

      {/* ── Walls ─────────────────────────────────────────────── */}
      {/* East wall (+x), facing -x (inward) */}
      <mesh position={[ACADEMY_W / 2, ACADEMY_H / 2, 0]} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[ACADEMY_L, ACADEMY_H]} />
        <meshStandardMaterial color={WALL_WHITE} roughness={0.95} side={THREE.DoubleSide} />
      </mesh>
      {/* West wall (-x), facing +x (inward) */}
      <mesh position={[-ACADEMY_W / 2, ACADEMY_H / 2, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[ACADEMY_L, ACADEMY_H]} />
        <meshStandardMaterial color={WALL_WHITE} roughness={0.95} side={THREE.DoubleSide} />
      </mesh>
      {/* North wall (+z), the banner wall — see banners below */}
      <mesh position={[0, ACADEMY_H / 2, ACADEMY_L / 2]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[ACADEMY_W, ACADEMY_H]} />
        <meshStandardMaterial color={WALL_WHITE} roughness={0.95} side={THREE.DoubleSide} />
      </mesh>
      {/* South wall (-z), with a door opening */}
      <mesh position={[0, ACADEMY_H / 2, ACADEMY_DOOR_Z]} rotation={[0, 0, 0]}>
        <planeGeometry args={[ACADEMY_W, ACADEMY_H]} />
        <meshStandardMaterial color={WALL_WHITE} roughness={0.95} side={THREE.DoubleSide} />
      </mesh>

      {/* ── Ceiling + light panels ────────────────────────────── */}
      <mesh
        rotation={[Math.PI / 2, 0, 0]}
        position={[0, ACADEMY_H, 0]}
      >
        <planeGeometry args={[ACADEMY_W, ACADEMY_L]} />
        <meshStandardMaterial color={CEILING_PANEL} roughness={1} />
      </mesh>
      {/* Recessed light panels — bright emissive rectangles on the
          ceiling matching the photo's fluorescent grid. */}
      {[-7, -3.5, 0, 3.5, 7].map((cz) =>
        [-3, 3].map((cx) => (
          <mesh
            key={`${cx},${cz}`}
            rotation={[Math.PI / 2, 0, 0]}
            position={[cx, ACADEMY_H - 0.005, cz]}
          >
            <planeGeometry args={[1.6, 0.9]} />
            <meshBasicMaterial color={CEILING_LIGHT} toneMapped={false} />
          </mesh>
        ))
      )}

      {/* ── Kick pad along the north wall base ────────────────── */}
      {/* Wide black padded section matching the photo's wall pad. */}
      <mesh position={[0, 0.95, ACADEMY_L / 2 - 0.06]}>
        <boxGeometry args={[ACADEMY_W - 1.5, 1.9, 0.12]} />
        <meshStandardMaterial color={KICKPAD_BLACK} roughness={1} />
      </mesh>

      {/* ── Banner wall above the kick pad ────────────────────── */}
      {/* Five banners stripe across the upper north wall. From left
          to right (looking at the wall from inside the room):
          Gracie-style red, US flag, Helio Gracie photo (centerpiece),
          Brazil flag, "NEVER GIVE UP" black. */}
      {[
        { color: "#9a2424", x: -4.0 }, // Gracie red
        { color: "#1a3a72", x: -2.0 }, // US blue field abstraction
        { color: "#1a8a3a", x: 2.0 }, // Brazil green
        { color: "#101012", x: 4.0 }, // Never Give Up (black)
      ].map((b, i) => (
        <mesh
          key={i}
          position={[b.x, 3.5, ACADEMY_L / 2 - 0.08]}
        >
          <planeGeometry args={[1.5, 1.6]} />
          <meshStandardMaterial color={b.color} roughness={0.85} side={THREE.DoubleSide} />
        </mesh>
      ))}
      {/* Helio Gracie centerpiece — slightly taller (2u) to match the
          portrait photo's 0.75 aspect without squishing his face. */}
      <mesh position={[0, 3.5, ACADEMY_L / 2 - 0.08]}>
        <planeGeometry args={[1.5, 2.0]} />
        <meshBasicMaterial map={helioTex} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
      {/* Subtle red horizontal stripe on the US "flag" so it reads
          as a flag, not just a blue rectangle. */}
      <mesh position={[-2.0, 3.2, ACADEMY_L / 2 - 0.07]}>
        <planeGeometry args={[1.5, 0.18]} />
        <meshBasicMaterial color="#b03030" toneMapped={false} />
      </mesh>
      {/* Yellow rhombus on the Brazil "flag" centre. */}
      <mesh position={[2.0, 3.5, ACADEMY_L / 2 - 0.07]} rotation={[0, 0, Math.PI / 4]}>
        <planeGeometry args={[0.9, 0.9]} />
        <meshBasicMaterial color="#fbd34c" toneMapped={false} />
      </mesh>

      {/* ── Door on the south wall — clickable to exit ────────── */}
      <group position={[0, 0, ACADEMY_DOOR_Z + 0.01]}>
        {/* Frame */}
        <mesh position={[0, ACADEMY_DOOR_H / 2, 0]}>
          <boxGeometry args={[ACADEMY_DOOR_W + 0.18, ACADEMY_DOOR_H + 0.18, 0.06]} />
          <meshStandardMaterial color={DOOR_FRAME} roughness={0.7} />
        </mesh>
        {/* Glass/door — clickable. Click anywhere on it triggers
            navigation back to /. */}
        <mesh
          position={[0, ACADEMY_DOOR_H / 2, 0.04]}
          onClick={(e) => {
            e.stopPropagation();
            onExit();
          }}
          onPointerOver={(e) => {
            document.body.style.cursor = "pointer";
            e.stopPropagation();
          }}
          onPointerOut={() => {
            document.body.style.cursor = "auto";
          }}
        >
          <boxGeometry args={[ACADEMY_DOOR_W, ACADEMY_DOOR_H, 0.04]} />
          <meshStandardMaterial
            color={DOOR_GLASS}
            roughness={0.25}
            metalness={0.1}
          />
        </mesh>
        {/* Door handle */}
        <mesh position={[ACADEMY_DOOR_W / 2 - 0.18, ACADEMY_DOOR_H / 2 - 0.1, 0.08]}>
          <sphereGeometry args={[0.06, 8, 6]} />
          <meshStandardMaterial color="#c2b59a" metalness={0.6} roughness={0.4} />
        </mesh>
      </group>

      {/* ── Training partner — Kate, brown belt ─────────────────── */}
      {/* Character picker — the academy becomes a 3-character pose
          line-up. The selected character is the player Character at
          the centre slot (0,0); the OTHER two characters render as
          static TrainingPartners on the side slots, clickable to
          switch the selection. A glowing yellow ring under the
          centre slot marks "this is who you're playing as." */}
      {(() => {
        const others = ALL_CHARACTERS.filter((id) => id !== characterId);
        const slots: [number, number, number][] = [
          [-1.4, 0, 0],
          [1.4, 0, 0],
        ];
        return (
          <>
            <SelectionRing position={[0, 0.02, 0]} />
            {others.map((id, i) => (
              <TrainingPartner
                key={id}
                position={slots[i]}
                faceSrc={CHARACTER_DATA[id].face}
                beltColor={CHARACTER_DATA[id].belt}
                faceScale={CHARACTER_DATA[id].faceScale}
                faceY={CHARACTER_DATA[id].faceY}
                onSelect={() =>
                  window.dispatchEvent(
                    new CustomEvent("select-character", { detail: id })
                  )
                }
              />
            ))}
          </>
        );
      })()}

      {/* ── Sandals lined up at the mat edge ──────────────────── */}
      {/* A signature jiu-jitsu detail — couple of pairs along the
          south mat edge (the user's reference photo has flip-flops
          right where students step off the mat). */}
      {[-3.2, -2.7, -1.6, -1.1, 1.4, 1.9, 2.8, 3.3].map((sx, i) => (
        <mesh
          key={i}
          position={[sx, 0.04, -ACADEMY_L / 2 + ACADEMY_MAT_INSET - 0.35]}
          rotation={[0, ((i % 2) * Math.PI) / 18 - Math.PI / 36, 0]}
        >
          <boxGeometry args={[0.18, 0.05, 0.42]} />
          <meshStandardMaterial color={i % 2 === 0 ? "#2a2a2e" : "#3a342a"} roughness={1} />
        </mesh>
      ))}
    </group>
  );
}

// ── Chess study scene ──────────────────────────────────────────────
// Mounted by Scene when pathname === "/chess". Renders a wood-paneled
// study with a chess table in the middle, the player seated at south
// (where the default camera sits) playing against Stockfish at a
// ~1000-1200 Elo level (Skill Level 2).
//
// Architecture:
//   - chess.js owns the game state (legal moves, check / mate, FEN).
//   - Stockfish.js runs in a Web Worker, fed FEN + asked for a best
//     move whenever it's the AI's turn.
//   - Board geometry is 8 × 8 clickable square meshes; clicking a
//     piece selects it and highlights legal destination squares.
//     Clicking a legal destination plays the move.
//   - Pieces are low-poly THREE primitives, rendered from chess.js
//     `board()` each render (no per-frame work).

const CHESS_SQUARE = 0.28; // edge length of one board square
const CHESS_BOARD_EDGE = CHESS_SQUARE * 8; // 2.24
// Y of the top surface of the board (table top + board veneer).
const CHESS_BOARD_TOP_Y = 0.95;
const CHESS_TABLE_TOP_Y = CHESS_BOARD_TOP_Y - 0.04;
// Board square colors — classic warm wood palette (lichess/
// chess.com brown). Light squares are warm cream, dark squares are
// caramel. Pieces (defined below) are tuned so the warm-white
// pieces have enough lightness contrast against the cream squares
// to not blend in.
const CHESS_LIGHT = "#e2c89c"; // warm cream (slightly deeper than lichess)
const CHESS_DARK = "#b58863"; // caramel brown
const CHESS_HILITE = "#f6e58d"; // selected-square overlay
const CHESS_LEGAL_DOT = "#5d8b48"; // small dot on legal-destination squares
// Last-move highlight — slightly muted yellow that mixes nicely with
// each of the two base square colors. Two shades (one per base
// square color) so the highlight reads consistently against either.
const CHESS_LAST_LIGHT = "#e8d068";
const CHESS_LAST_DARK = "#b89438";
// Piece colors — white pieces are pushed brighter than the cream
// light squares so they stand out clearly. Black pieces stay deep
// near-black; both _DARK variants are used for the bases / collars
// so pieces have a touch of shading rather than being a single
// flat hue.
const PIECE_WHITE = "#fafaf0";
const PIECE_WHITE_DARK = "#d8d5c4";
// Black pieces — was #2a241e (near-black) but the lighting couldn't
// carve out enough detail at that depth. Bumped to a dark walnut so
// shape detail (the king's cross, queen's crown, rook's
// crenellations) reads clearly while pieces still feel "black".
const PIECE_BLACK = "#3e2f22";
const PIECE_BLACK_DARK = "#1e1610";
// Room palette — dark forest green walls (classic study /
// gentlemen's club vibe), warm honey-oak floor, deep brown ceiling.
// Green walls + warm wood floor + walnut table is a traditional
// library / chess club combination — the cool dark green frames
// the warm-toned board as the focal point.
const STUDY_WALL = "#2a4530"; // dark forest green
const STUDY_FLOOR = "#a48562"; // muted honey oak
const STUDY_CEILING = "#241712";
// Table — warm walnut. Was previously near-black (#3a2820) which
// blended into the black chess pieces (#2a241e). Lighter walnut
// keeps the wood feel without disappearing behind the pieces.
const STUDY_TABLE = "#7a4628";
const STUDY_TABLE_DARK = "#4a2818";
// Stockfish strength — Skill Level 2 lands roughly around 1000-1200
// Elo per the engine's internal scaling. Range is 0 (random-ish) to
// 20 (full ~3500 Elo).
const STOCKFISH_SKILL = 2;
// Time the engine gets to think before returning a move (ms).
// 1000 ms gives the human a beat between making their move and
// seeing the AI respond — feels less instant / robotic. The
// engine's strength is capped by Skill Level, so the extra
// thinking time doesn't push it beyond the user's rating.
const STOCKFISH_MOVE_MS = 1000;

type PieceColor = "w" | "b";
type PieceType = "p" | "n" | "b" | "r" | "q" | "k";

// Convert a (file, rank) pair (file 0..7 = a..h, rank 0..7 = 1..8)
// to its world (x, z) on the board. Files map screen LEFT→RIGHT as
// a→h (so x = (3.5 - file) * SQUARE because the default camera is
// south of the origin, where world +X projects to screen LEFT).
// Ranks map z so that rank 1 (white's home) is closest to the
// camera (most negative Z).
function chessSquareToWorld(file: number, rank: number): [number, number] {
  const x = (3.5 - file) * CHESS_SQUARE;
  const z = (rank - 3.5) * CHESS_SQUARE;
  return [x, z];
}

// Parse a chess.js square name ("e4") back to (file, rank).
function chessSquareToFR(sq: string): [number, number] {
  const file = sq.charCodeAt(0) - 97; // 'a' = 0
  const rank = parseInt(sq[1], 10) - 1; // '1' = 0
  return [file, rank];
}

// Synthesized chess-move sound. Uses Web Audio API to make a short
// noise burst through a band-pass filter so it reads as a wood tap
// rather than a sine beep — no external audio files needed, no
// asset loading lag, no browser-autoplay headaches as long as the
// AudioContext is created (or resumed) inside a user gesture
// (the click that moves the piece).
function makeMoveSoundPlayer() {
  let ctx: AudioContext | null = null;
  return function playMoveSound() {
    if (typeof window === "undefined") return;
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctx) return;
      if (!ctx) ctx = new Ctx();
      if (ctx.state === "suspended") void ctx.resume();
      const duration = 0.09; // seconds
      const sampleRate = ctx.sampleRate;
      const buffer = ctx.createBuffer(
        1,
        Math.floor(sampleRate * duration),
        sampleRate
      );
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        const t = i / sampleRate;
        const envelope = Math.exp(-t * 38); // quick percussive decay
        data[i] = (Math.random() * 2 - 1) * envelope;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      // Band-pass filter centred around 700 Hz to give the noise a
      // wood-knock character (low enough to feel "thunk", high
      // enough to feel like wood on wood rather than a soft thud).
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 720;
      filter.Q.value = 1.8;
      const gain = ctx.createGain();
      gain.gain.value = 0.28;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      source.start();
    } catch {
      // Silent failure — never break the game over a sound effect.
    }
  };
}


// Clone a chess.js instance while PRESERVING the move history. The
// obvious-looking `new Chess(game.fen())` only carries the position
// across — its `.history()` resets to empty, which breaks anything
// that depends on the move log (the captured-pieces display).
// Using PGN round-trips both position AND moves.
function cloneChessWithHistory(game: Chess): Chess {
  const next = new Chess();
  const pgn = game.pgn();
  if (pgn) {
    try {
      next.loadPgn(pgn);
    } catch {
      // Fall back to position-only clone if the PGN is somehow
      // malformed; the captured-pieces display will be stale for
      // this game but the game itself stays playable.
      return new Chess(game.fen());
    }
  }
  return next;
}

function ChessRoom(_: { onExit: () => void }) {
  // onExit is unused here — GameShell renders the top-left Exit
  // button which navigates back via plain anchor routing.
  // One AudioContext per ChessRoom mount, lazily created on the
  // first move so the browser doesn't yell about autoplay.
  const playMoveSoundRef = useRef(makeMoveSoundPlayer());
  // ── Game state ────────────────────────────────────────────────
  // chess.js Chess instance lives in state. Mutations replace the
  // instance (new Chess(fen)) so React picks up renders.
  const [game, setGame] = useState(() => new Chess());
  // Who the user is playing as. Randomized once at mount; resets on
  // a new game.
  const [playerColor, setPlayerColor] = useState<PieceColor>(() =>
    Math.random() < 0.5 ? "w" : "b"
  );
  // The square currently selected by the user (origin of next move).
  // null when nothing's picked up yet.
  const [selected, setSelected] = useState<Square | null>(null);
  // Legal destination squares from `selected` — used to highlight
  // dots and validate the second click.
  const [legalMoves, setLegalMoves] = useState<Square[]>([]);
  // Resigned-by tracker. chess.js doesn't model resignation; we
  // track it as separate state and treat it like a game-over so
  // the banner shows the result and the click handler stops
  // accepting input. Reset on every new game.
  const [resignedBy, setResignedBy] = useState<PieceColor | null>(null);
  // Game over state. `null` while the game is in progress;
  // otherwise holds a human-readable reason for the end (used by
  // the banner above the board).
  const gameOver = useMemo(() => {
    if (resignedBy) {
      return resignedBy === playerColor
        ? "You resigned — Sonny won"
        : "Sonny resigned — You won";
    }
    if (!game.isGameOver()) return null;
    if (game.isCheckmate()) {
      // The side whose turn it IS got mated. Loser = game.turn().
      const loserColor = game.turn();
      const winner = loserColor === playerColor ? "Sonny" : "You";
      return `Checkmate — ${winner} won`;
    }
    if (game.isStalemate()) return "Stalemate — draw";
    if (game.isThreefoldRepetition()) return "Draw — threefold repetition";
    if (game.isInsufficientMaterial())
      return "Draw — insufficient material";
    if (game.isDraw()) return "Draw";
    return "Game over";
  }, [game, playerColor, resignedBy]);

  // ── Stockfish worker ─────────────────────────────────────────
  // Spawns once on mount. Subsequent re-renders just re-use it.
  const stockfishRef = useRef<Worker | null>(null);
  useEffect(() => {
    if (typeof Worker === "undefined") return;
    const w = new Worker("/stockfish-18-lite-single.js");
    stockfishRef.current = w;
    w.postMessage("uci");
    w.postMessage(`setoption name Skill Level value ${STOCKFISH_SKILL}`);
    w.postMessage("isready");
    return () => {
      w.terminate();
      stockfishRef.current = null;
    };
  }, []);

  // Ask Stockfish for a move whenever it's the AI's turn.
  useEffect(() => {
    const w = stockfishRef.current;
    if (!w) return;
    if (game.isGameOver() || resignedBy) return;
    if (game.turn() === playerColor) return;
    let cancelled = false;
    const handle = (e: MessageEvent) => {
      const line =
        typeof e.data === "string" ? e.data : String(e.data);
      // Stockfish emits "bestmove e2e4" (with optional promotion
      // char appended, e.g. "e7e8q"). Ignore everything else.
      if (!line.startsWith("bestmove ")) return;
      w.removeEventListener("message", handle);
      if (cancelled) return;
      const move = line.split(/\s+/)[1];
      if (!move || move === "(none)") return;
      const next = cloneChessWithHistory(game);
      const result = next.move({
        from: move.slice(0, 2) as Square,
        to: move.slice(2, 4) as Square,
        promotion: move.length > 4 ? move[4] : undefined,
      });
      if (result) {
        playMoveSoundRef.current();
        setGame(next);
      }
    };
    w.addEventListener("message", handle);
    w.postMessage(`position fen ${game.fen()}`);
    w.postMessage(`go movetime ${STOCKFISH_MOVE_MS}`);
    return () => {
      cancelled = true;
      w.removeEventListener("message", handle);
    };
  }, [game, playerColor, resignedBy]);

  // ── Move handlers ────────────────────────────────────────────
  // Two interactions both lead to a move:
  //
  // 1. Click-click — press + release on origin (selects), then
  //    press + release on destination (moves).
  // 2. Drag-and-drop — press on origin, drag, release on destination.
  //
  // To support both, we attach onPointerDown + onPointerUp instead
  // of onClick. PointerDown records the drag origin and updates the
  // selection; PointerUp fires the actual move whenever it lands on
  // a different (legal) square than the press. PointerUp on the
  // same square is a no-op (a plain tap leaves the piece selected
  // for the next click).
  const dragFromRef = useRef<Square | null>(null);
  // While the user is dragging a piece, this state holds the
  // current board-local (x, z) the dragged piece is rendered at.
  // Set on pointerdown to the origin square's centre, updated by
  // pointermove to follow the cursor, cleared on pointerup. When
  // non-null the original piece is hidden from its square and the
  // dragged piece is rendered floating at this position.
  const [dragPos, setDragPos] = useState<{ x: number; z: number } | null>(
    null
  );

  function selectPiece(sq: Square) {
    const piece = game.get(sq);
    if (piece && piece.color === playerColor) {
      const moves = game.moves({ square: sq, verbose: true });
      setSelected(sq);
      setLegalMoves(moves.map((m) => m.to as Square));
      return true;
    }
    return false;
  }

  function attemptMove(from: Square, to: Square): boolean {
    if (game.isGameOver() || resignedBy) return false;
    if (game.turn() !== playerColor) return false;
    if (!legalMoves.includes(to)) return false;
    const next = cloneChessWithHistory(game);
    const result = next.move({
      from,
      to,
      promotion: "q", // auto-queen on promotion (UI for picking
      // under-promotions is overkill for a portfolio toy)
    });
    if (!result) return false;
    playMoveSoundRef.current();
    setGame(next);
    return true;
  }

  function onSquarePointerDown(sq: Square) {
    if (game.isGameOver() || resignedBy) return;
    if (game.turn() !== playerColor) return;
    const piece = game.get(sq);
    // Friendly piece → start drag from here. Switches selection
    // automatically if a different friendly piece was previously
    // selected.
    if (piece && piece.color === playerColor) {
      selectPiece(sq);
      dragFromRef.current = sq;
      const [f, r] = chessSquareToFR(sq);
      const [lx, lz] = chessSquareToWorld(f, r);
      setDragPos({ x: lx, z: lz });
      return;
    }
    // Empty / opponent square WITH an active selection that legally
    // covers this square → arm the drag-from so the matching
    // PointerUp commits the move (whether the user actually dragged
    // or just clicked).
    if (selected !== null && legalMoves.includes(sq)) {
      dragFromRef.current = selected;
      return;
    }
    // Anywhere else → drop the selection.
    setSelected(null);
    setLegalMoves([]);
    dragFromRef.current = null;
    setDragPos(null);
  }

  function onSquarePointerMove(worldX: number, worldZ: number) {
    if (!dragFromRef.current) return;
    // Pieces live inside the boardRotY-wrapped group, so positions
    // we set on them are interpreted in BOARD-LOCAL coords. The
    // pointermove event gives us a world-space intersection. When
    // the board is flipped (player is black), local = -world.
    const localX = boardRotY === Math.PI ? -worldX : worldX;
    const localZ = boardRotY === Math.PI ? -worldZ : worldZ;
    setDragPos({ x: localX, z: localZ });
  }

  function onSquarePointerUp(sq: Square) {
    const from = dragFromRef.current;
    dragFromRef.current = null;
    setDragPos(null);
    if (!from) return;
    if (from === sq) {
      // Plain tap on the dragged square — leave the piece selected
      // so the user can click-click their destination next.
      return;
    }
    // Released on a different square — try the move. attemptMove
    // returns false if it wasn't legal; in either case clear the
    // selection so we don't leave a stale highlight.
    attemptMove(from, sq);
    setSelected(null);
    setLegalMoves([]);
  }

  // Fallback: if the pointer is released OUTSIDE any board square
  // (e.g., off the board on the table or wall), no square's
  // onPointerUp fires and the drag would otherwise stay armed
  // forever. A window-level pointerup catches the case and resets
  // the drag state without committing a move.
  useEffect(() => {
    function onUp() {
      if (dragFromRef.current === null) return;
      dragFromRef.current = null;
      setDragPos(null);
      setSelected(null);
      setLegalMoves([]);
    }
    window.addEventListener("pointerup", onUp);
    return () => window.removeEventListener("pointerup", onUp);
  }, []);

  // Reset to a fresh game with a new random color assignment.
  function newGame() {
    setGame(new Chess());
    setPlayerColor(Math.random() < 0.5 ? "w" : "b");
    setSelected(null);
    setLegalMoves([]);
    setResignedBy(null);
  }

  // ── External button events ──────────────────────────────────
  // GameShell renders the New Game + Resign buttons as DOM
  // overlays (outside the canvas), so they reach into our state
  // via window CustomEvents — the same pattern used by the
  // reset-camera button. Refs hold the latest copies of the state
  // we need to read inside the handlers, so the listener callbacks
  // can stay stable for the lifetime of the component instead of
  // re-binding on every re-render.
  const playerColorRef = useRef(playerColor);
  playerColorRef.current = playerColor;
  const gameRef = useRef(game);
  gameRef.current = game;
  const resignedByRef = useRef(resignedBy);
  resignedByRef.current = resignedBy;
  useEffect(() => {
    function onNewGame() {
      setGame(new Chess());
      setPlayerColor(Math.random() < 0.5 ? "w" : "b");
      setSelected(null);
      setLegalMoves([]);
      setResignedBy(null);
    }
    function onResign() {
      if (gameRef.current.isGameOver()) return;
      if (resignedByRef.current) return;
      setResignedBy(playerColorRef.current);
    }
    window.addEventListener("chess-new-game", onNewGame);
    window.addEventListener("chess-resign", onResign);
    return () => {
      window.removeEventListener("chess-new-game", onNewGame);
      window.removeEventListener("chess-resign", onResign);
    };
  }, []);

  // ── Captured pieces ───────────────────────────────────────────
  // Walk chess.js's move history and bucket each capture by who
  // made it. `player` = pieces the user has taken (opponent's
  // color); `ai` = pieces Stockfish has taken (player's color).
  // Sorted by value (high to low) so the row reads like a
  // material display rather than a chronological log.
  const captures = useMemo(() => {
    const VALUE: Record<PieceType, number> = {
      q: 9,
      r: 5,
      b: 3,
      n: 3,
      p: 1,
      k: 0,
    };
    const player: PieceType[] = [];
    const ai: PieceType[] = [];
    for (const move of game.history({ verbose: true })) {
      if (!move.captured) continue;
      const taken = move.captured as PieceType;
      if (move.color === playerColor) player.push(taken);
      else ai.push(taken);
    }
    player.sort((a, b) => VALUE[b] - VALUE[a]);
    ai.sort((a, b) => VALUE[b] - VALUE[a]);
    return { player, ai };
  }, [game, playerColor]);

  // Broadcast captures to the GameShell HUD whenever they change.
  // The 2D overlay sits outside the canvas, so a window event is
  // the simplest bridge (same pattern as the new-game / resign
  // buttons going the other direction).
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("chess-captures-update", {
        detail: {
          player: captures.player,
          ai: captures.ai,
          playerColor,
        },
      })
    );
  }, [captures, playerColor]);

  // ── Render ────────────────────────────────────────────────────
  const boardLayout = game.board();
  const selectedFR = selected ? chessSquareToFR(selected) : null;
  const legalFRSet = useMemo(
    () => new Set(legalMoves.map((sq) => sq)),
    [legalMoves]
  );
  // Last move's from/to squares (for highlighting). Pulled from the
  // verbose move history so we get the algebraic square names.
  const lastMoveSquares = useMemo(() => {
    const history = game.history({ verbose: true });
    const last = history[history.length - 1];
    if (!last) return new Set<string>();
    return new Set<string>([last.from, last.to]);
  }, [game]);
  // Rotation around Y for the visible board so the player's pieces
  // are always at the bottom of the camera frame. Pulled out of the
  // JSX so the inline ternary inside an array literal inside a JSX
  // prop doesn't trip the parser up.
  const boardRotY = playerColor === "b" ? Math.PI : 0;

  return (
    <group>
      {/* ── Lights ──────────────────────────────────────────── */}
      {/* Bright enough that the board is clearly legible. A direct
          overhead light hits the board surface so the light /dark
          square contrast pops; ambient fills in the room and front
          face of the pieces so nothing is in deep shadow. */}
      <ambientLight intensity={1.5} color="#fff1d8" />
      <directionalLight
        position={[0, 6, 0]}
        intensity={1.4}
        color="#fff4dc"
        target-position={[0, 0, 0]}
      />
      <pointLight
        position={[0, 3.2, 0]}
        intensity={2.2}
        color="#ffe9b8"
        distance={10}
        decay={1.2}
      />
      <pointLight
        position={[-3.0, 1.6, 0]}
        intensity={0.7}
        color="#b8d6f0"
        distance={6}
        decay={2}
      />

      {/* ── Room shell ──────────────────────────────────────── */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0, 0]}
        receiveShadow
      >
        <planeGeometry args={[10, 9]} />
        <meshStandardMaterial color={STUDY_FLOOR} roughness={0.9} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 4.0, 0]}>
        <planeGeometry args={[10, 9]} />
        <meshStandardMaterial color={STUDY_CEILING} roughness={0.9} />
      </mesh>
      <mesh position={[0, 2.0, 4.5]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[10, 4.0]} />
        <meshStandardMaterial
          color={STUDY_WALL}
          roughness={0.85}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh position={[0, 2.0, -4.5]}>
        <planeGeometry args={[10, 4.0]} />
        <meshStandardMaterial
          color={STUDY_WALL}
          roughness={0.85}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh position={[5.0, 2.0, 0]} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[9, 4.0]} />
        <meshStandardMaterial
          color={STUDY_WALL}
          roughness={0.85}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh position={[-5.0, 2.0, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[9, 4.0]} />
        <meshStandardMaterial
          color={STUDY_WALL}
          roughness={0.85}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* ── Pendant lamp ────────────────────────────────────── */}
      {/* Mounted higher than a "normal" pendant (shade at y=3.45)
          so it clears Sonny's bald head silhouette in the camera's
          framing — with the shade at the original 2.95 it hung
          right at his hair-line and was cropping the top of his
          head against the board. Wire is shorter to compensate
          (ceiling y=4 → shade top y=3.6). */}
      <mesh position={[0, 3.8, 0]}>
        <cylinderGeometry args={[0.01, 0.01, 0.4, 6]} />
        <meshStandardMaterial color="#1a1410" />
      </mesh>
      <mesh position={[0, 3.45, 0]} castShadow>
        <coneGeometry args={[0.35, 0.30, 16, 1, true]} />
        <meshStandardMaterial color="#1a1410" side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 3.30, 0]}>
        <sphereGeometry args={[0.06, 12, 10]} />
        <meshBasicMaterial color="#fff4c8" toneMapped={false} />
      </mesh>

      {/* ── Table ───────────────────────────────────────────── */}
      {/* IMPORTANT: position={[0, y, 0]} on a boxGeometry centers the
          box at y, so for the box's TOP to land at CHESS_TABLE_TOP_Y
          (= 0.91, just under the board surface at 0.95), we sit the
          centre at CHESS_TABLE_TOP_Y - thickness/2. Earlier version
          forgot this and the table top ended up at y=0.96, occluding
          the board squares (which sit at 0.95) entirely. */}
      <mesh
        position={[0, CHESS_TABLE_TOP_Y - 0.05, 0]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[3.0, 0.10, 3.0]} />
        <meshStandardMaterial color={STUDY_TABLE} roughness={0.7} />
      </mesh>
      {[
        [-1.35, -1.35],
        [1.35, -1.35],
        [-1.35, 1.35],
        [1.35, 1.35],
      ].map(([x, z], i) => (
        <mesh
          key={i}
          position={[x, (CHESS_TABLE_TOP_Y - 0.10) / 2, z]}
          castShadow
        >
          <boxGeometry args={[0.10, CHESS_TABLE_TOP_Y - 0.10, 0.10]} />
          <meshStandardMaterial
            color={STUDY_TABLE_DARK}
            roughness={0.85}
          />
        </mesh>
      ))}

      {/* ── Board ───────────────────────────────────────────── */}
      {/* The whole board + pieces rotate 180 around Y when the
          player is black so the player's pieces are always closest
          to the camera. Pure visual flip - chess.js square names
          and click-handler logic don't change. */}
      <group rotation={[0, boardRotY, 0]}>
      {/* Board border — dark walnut frame around the squares, the
          classic chess-board look. Sits OUTSIDE the playing area
          so it doesn't matter that black pieces are dark too —
          pieces are on the squares, not on the frame. Frames the
          whole board with a clear edge against the cream squares. */}
      <mesh position={[0, CHESS_BOARD_TOP_Y - 0.011, 0]}>
        <boxGeometry
          args={[
            CHESS_BOARD_EDGE + 0.18,
            0.02,
            CHESS_BOARD_EDGE + 0.18,
          ]}
        />
        <meshStandardMaterial color="#6b3f25" roughness={0.7} />
      </mesh>
      {Array.from({ length: 8 }).flatMap((_, rank) =>
        Array.from({ length: 8 }).map((__, file) => {
          const [x, z] = chessSquareToWorld(file, rank);
          const dark = (file + rank) % 2 === 0;
          const square = (String.fromCharCode(97 + file) +
            (rank + 1)) as Square;
          const isSelected =
            selectedFR &&
            selectedFR[0] === file &&
            selectedFR[1] === rank;
          const isLegal = legalFRSet.has(square);
          const isLastMove = lastMoveSquares.has(square);
          // Color precedence: selected → last-move → base square.
          // Last-move uses a per-base tint so the highlight reads
          // the same brightness against either square color.
          const squareColor = isSelected
            ? CHESS_HILITE
            : isLastMove
            ? dark
              ? CHESS_LAST_DARK
              : CHESS_LAST_LIGHT
            : dark
            ? CHESS_DARK
            : CHESS_LIGHT;
          return (
            <group key={square}>
              <mesh
                position={[x, CHESS_BOARD_TOP_Y, z]}
                rotation={[-Math.PI / 2, 0, 0]}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onSquarePointerDown(square);
                }}
                onPointerUp={(e) => {
                  e.stopPropagation();
                  onSquarePointerUp(square);
                }}
                onPointerMove={(e) => {
                  // e.point is the world-space intersection on this
                  // square's plane. Forwarded to the move handler
                  // which converts to board-local coords (the
                  // dragged piece lives inside the rotation wrapper).
                  if (dragFromRef.current === null) return;
                  e.stopPropagation();
                  onSquarePointerMove(e.point.x, e.point.z);
                }}
                onPointerOver={(e) => {
                  document.body.style.cursor = "pointer";
                  e.stopPropagation();
                }}
                onPointerOut={() => {
                  document.body.style.cursor = "auto";
                }}
              >
                <planeGeometry args={[CHESS_SQUARE, CHESS_SQUARE]} />
                <meshStandardMaterial
                  color={squareColor}
                  roughness={0.6}
                />
              </mesh>
              {isLegal && (
                <mesh
                  position={[x, CHESS_BOARD_TOP_Y + 0.002, z]}
                  rotation={[-Math.PI / 2, 0, 0]}
                >
                  <circleGeometry args={[CHESS_SQUARE * 0.18, 16]} />
                  <meshBasicMaterial
                    color={CHESS_LEGAL_DOT}
                    transparent
                    opacity={0.85}
                    toneMapped={false}
                  />
                </mesh>
              )}
            </group>
          );
        })
      )}

      {/* ── Pieces ──────────────────────────────────────────── */}
      {/* The dragged piece is re-positioned at the current cursor
          intersection (via dragPos) and lifted above the board so
          it visibly "floats" while the user holds it. Every other
          piece sits on its square as usual. */}
      {boardLayout.flatMap((row, r) =>
        row.map((cell, f) => {
          if (!cell) return null;
          const rank = 7 - r;
          const square = (String.fromCharCode(97 + f) +
            (rank + 1)) as Square;
          const isDragging =
            dragFromRef.current === square && dragPos !== null;
          const [x, z] = isDragging
            ? [dragPos.x, dragPos.z]
            : chessSquareToWorld(f, rank);
          const y = isDragging
            ? CHESS_BOARD_TOP_Y + 0.20
            : CHESS_BOARD_TOP_Y + 0.005;
          return (
            <group key={`${f}-${rank}`} position={[x, y, z]}>
              <Piece
                type={cell.type as PieceType}
                color={cell.color as PieceColor}
              />
            </group>
          );
        })
      )}

      </group>

      {/* ── Game-over banner ────────────────────────────────── */}
      {gameOver && (
        <Billboard position={[0, 2.2, 0]}>
          <group>
            <mesh position={[0, 0, -0.01]}>
              <planeGeometry args={[2.6, 0.55]} />
              <meshBasicMaterial color="#1a1410" toneMapped={false} />
            </mesh>
            <Text
              position={[0, 0.06, 0]}
              fontSize={0.18}
              color="#fff4c8"
              anchorX="center"
              anchorY="middle"
            >
              {gameOver}
            </Text>
            <Text
              position={[0, -0.13, 0]}
              fontSize={0.10}
              color="#cfc7b8"
              anchorX="center"
              anchorY="middle"
              onClick={(e) => {
                e.stopPropagation();
                newGame();
              }}
              onPointerOver={(e) => {
                document.body.style.cursor = "pointer";
                e.stopPropagation();
              }}
              onPointerOut={() => {
                document.body.style.cursor = "auto";
              }}
            >
              click here to play again
            </Text>
          </group>
        </Billboard>
      )}

    </group>
  );
}

// ── Chess piece geometry ───────────────────────────────────────────
// Each piece is a small low-poly assembly of cylinders / spheres /
// cones, sized to comfortably fit on a single board square (square
// width = CHESS_SQUARE = 0.28). Colors come from the two palettes
// above (PIECE_WHITE / PIECE_BLACK + their *_DARK accent).

function Piece({
  type,
  color,
}: {
  type: PieceType;
  color: PieceColor;
}) {
  switch (type) {
    case "p":
      return <PiecePawn color={color} />;
    case "r":
      return <PieceRook color={color} />;
    case "n":
      return <PieceKnight color={color} />;
    case "b":
      return <PieceBishop color={color} />;
    case "q":
      return <PieceQueen color={color} />;
    case "k":
      return <PieceKing color={color} />;
  }
}

function pieceColors(color: PieceColor) {
  return color === "w"
    ? { main: PIECE_WHITE, dark: PIECE_WHITE_DARK }
    : { main: PIECE_BLACK, dark: PIECE_BLACK_DARK };
}

function PiecePawn({ color }: { color: PieceColor }) {
  const { main, dark } = pieceColors(color);
  return (
    <group>
      <mesh position={[0, 0.018, 0]} castShadow>
        <cylinderGeometry args={[0.055, 0.065, 0.036, 18]} />
        <meshStandardMaterial color={dark} roughness={0.65} />
      </mesh>
      <mesh position={[0, 0.086, 0]} castShadow>
        <cylinderGeometry args={[0.026, 0.042, 0.10, 18]} />
        <meshStandardMaterial color={main} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.165, 0]} castShadow>
        <sphereGeometry args={[0.038, 18, 14]} />
        <meshStandardMaterial color={main} roughness={0.5} />
      </mesh>
    </group>
  );
}

function PieceRook({ color }: { color: PieceColor }) {
  const { main, dark } = pieceColors(color);
  return (
    <group>
      <mesh position={[0, 0.02, 0]} castShadow>
        <cylinderGeometry args={[0.065, 0.075, 0.04, 20]} />
        <meshStandardMaterial color={dark} roughness={0.65} />
      </mesh>
      <mesh position={[0, 0.11, 0]} castShadow>
        <cylinderGeometry args={[0.048, 0.058, 0.14, 20]} />
        <meshStandardMaterial color={main} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.205, 0]} castShadow>
        <cylinderGeometry args={[0.055, 0.055, 0.05, 20]} />
        <meshStandardMaterial color={main} roughness={0.5} />
      </mesh>
      {[
        [0.04, 0],
        [-0.04, 0],
        [0, 0.04],
        [0, -0.04],
      ].map(([cx, cz], i) => (
        <mesh key={i} position={[cx, 0.245, cz]} castShadow>
          <boxGeometry args={[0.026, 0.03, 0.026]} />
          <meshStandardMaterial color={main} roughness={0.5} />
        </mesh>
      ))}
    </group>
  );
}

function PieceKnight({ color }: { color: PieceColor }) {
  const { main, dark } = pieceColors(color);
  // Horse head faces the +X body axis (sideways from the camera
  // POV), so the iconic horse profile reads at a glance instead of
  // the head pointing up/down toward/away from the camera as a
  // generic blocky lump.
  return (
    <group>
      {/* Base */}
      <mesh position={[0, 0.02, 0]} castShadow>
        <cylinderGeometry args={[0.065, 0.075, 0.04, 18]} />
        <meshStandardMaterial color={dark} roughness={0.65} />
      </mesh>
      {/* Body — short stout neck below the head */}
      <mesh position={[0, 0.11, 0]} castShadow>
        <cylinderGeometry args={[0.042, 0.062, 0.14, 18]} />
        <meshStandardMaterial color={main} roughness={0.5} />
      </mesh>
      {/* Horse head assembly. All sub-meshes are at the same y so
          the silhouette reads as a side-on horse head when viewed
          from south (camera). +X is the snout direction. */}
      <group position={[0, 0.215, 0]}>
        {/* Back of the head — squarish block */}
        <mesh position={[-0.005, 0, 0]} castShadow>
          <boxGeometry args={[0.10, 0.10, 0.07]} />
          <meshStandardMaterial color={main} roughness={0.5} />
        </mesh>
        {/* Snout — narrower block extending forward (+X), tipped
            slightly down so it has the classic horse-head droop. */}
        <group position={[0.075, -0.012, 0]} rotation={[0, 0, -0.35]}>
          <mesh castShadow>
            <boxGeometry args={[0.085, 0.055, 0.058]} />
            <meshStandardMaterial color={main} roughness={0.5} />
          </mesh>
        </group>
        {/* Underjaw — tucked under the snout for a stronger profile */}
        <mesh
          position={[0.07, -0.045, 0]}
          rotation={[0, 0, -0.55]}
          castShadow
        >
          <boxGeometry args={[0.055, 0.025, 0.05]} />
          <meshStandardMaterial color={dark} roughness={0.55} />
        </mesh>
        {/* Mane crest on the back of the head, pointing up + back */}
        <mesh
          position={[-0.045, 0.06, 0]}
          rotation={[0, 0, 0.55]}
          castShadow
        >
          <boxGeometry args={[0.06, 0.04, 0.065]} />
          <meshStandardMaterial color={dark} roughness={0.55} />
        </mesh>
        {/* Two pointed ears on top, slightly tilted forward */}
        <mesh
          position={[0.005, 0.075, -0.025]}
          rotation={[0, 0, -0.2]}
          castShadow
        >
          <coneGeometry args={[0.014, 0.045, 6]} />
          <meshStandardMaterial color={main} roughness={0.5} />
        </mesh>
        <mesh
          position={[0.005, 0.075, 0.025]}
          rotation={[0, 0, -0.2]}
          castShadow
        >
          <coneGeometry args={[0.014, 0.045, 6]} />
          <meshStandardMaterial color={main} roughness={0.5} />
        </mesh>
      </group>
    </group>
  );
}

function PieceBishop({ color }: { color: PieceColor }) {
  const { main, dark } = pieceColors(color);
  return (
    <group>
      <mesh position={[0, 0.02, 0]} castShadow>
        <cylinderGeometry args={[0.062, 0.072, 0.04, 18]} />
        <meshStandardMaterial color={dark} roughness={0.65} />
      </mesh>
      <mesh position={[0, 0.12, 0]} castShadow>
        <cylinderGeometry args={[0.026, 0.054, 0.16, 18]} />
        <meshStandardMaterial color={main} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.215, 0]} castShadow>
        <cylinderGeometry args={[0.034, 0.026, 0.025, 18]} />
        <meshStandardMaterial color={dark} roughness={0.55} />
      </mesh>
      <mesh position={[0, 0.275, 0]} castShadow>
        <coneGeometry args={[0.034, 0.10, 18]} />
        <meshStandardMaterial color={main} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.345, 0]} castShadow>
        <sphereGeometry args={[0.016, 12, 10]} />
        <meshStandardMaterial color={main} roughness={0.5} />
      </mesh>
    </group>
  );
}

function PieceQueen({ color }: { color: PieceColor }) {
  const { main, dark } = pieceColors(color);
  // Queen is intentionally TALLER than the rook + has a crown of
  // pointed cone spikes (not little spheres) so the silhouette
  // reads instantly as "queen" rather than "rook with bumps."
  return (
    <group>
      {/* Base — slightly wider than other pieces */}
      <mesh position={[0, 0.02, 0]} castShadow>
        <cylinderGeometry args={[0.072, 0.082, 0.04, 20]} />
        <meshStandardMaterial color={dark} roughness={0.65} />
      </mesh>
      {/* Tall tapered body */}
      <mesh position={[0, 0.155, 0]} castShadow>
        <cylinderGeometry args={[0.034, 0.064, 0.23, 20]} />
        <meshStandardMaterial color={main} roughness={0.5} />
      </mesh>
      {/* Crown collar — a slightly darker ring under the spikes */}
      <mesh position={[0, 0.285, 0]} castShadow>
        <cylinderGeometry args={[0.05, 0.038, 0.025, 20]} />
        <meshStandardMaterial color={dark} roughness={0.6} />
      </mesh>
      {/* Crown of 8 pointed spikes around the rim — these are the
          key visual differentiator from the rook's blocky
          crenellations. */}
      {Array.from({ length: 8 }, (_, i) => {
        const angle = (i / 8) * Math.PI * 2;
        return (
          <mesh
            key={i}
            position={[
              Math.cos(angle) * 0.04,
              0.34,
              Math.sin(angle) * 0.04,
            ]}
            castShadow
          >
            <coneGeometry args={[0.014, 0.075, 8]} />
            <meshStandardMaterial color={main} roughness={0.5} />
          </mesh>
        );
      })}
      {/* Centre dome / orb on top */}
      <mesh position={[0, 0.36, 0]} castShadow>
        <sphereGeometry args={[0.020, 14, 12]} />
        <meshStandardMaterial color={main} roughness={0.5} />
      </mesh>
    </group>
  );
}

function PieceKing({ color }: { color: PieceColor }) {
  const { main, dark } = pieceColors(color);
  return (
    <group>
      <mesh position={[0, 0.02, 0]} castShadow>
        <cylinderGeometry args={[0.07, 0.08, 0.04, 20]} />
        <meshStandardMaterial color={dark} roughness={0.65} />
      </mesh>
      <mesh position={[0, 0.13, 0]} castShadow>
        <cylinderGeometry args={[0.036, 0.062, 0.18, 20]} />
        <meshStandardMaterial color={main} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.234, 0]} castShadow>
        <cylinderGeometry args={[0.05, 0.04, 0.05, 20]} />
        <meshStandardMaterial color={main} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.282, 0]} castShadow>
        <sphereGeometry args={[0.03, 16, 12]} />
        <meshStandardMaterial color={main} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.34, 0]} castShadow>
        <boxGeometry args={[0.012, 0.060, 0.012]} />
        <meshStandardMaterial color={main} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.345, 0]} castShadow>
        <boxGeometry args={[0.038, 0.012, 0.012]} />
        <meshStandardMaterial color={main} roughness={0.5} />
      </mesh>
    </group>
  );
}
