"use client";

import { forwardRef, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
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

type CharMode = "idle" | "flee" | "riding";

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

type SharedRefs = {
  char: React.MutableRefObject<CharState>;
  target: React.MutableRefObject<{
    x: number;
    z: number;
    sectionId: SectionId | null;
  } | null>;
  pendingNav: React.MutableRefObject<SectionId | null>;
  doors: React.MutableRefObject<DoorState>;
  gator: React.MutableRefObject<GatorState>;
  approachingGator: React.MutableRefObject<boolean>;
  coaster: React.MutableRefObject<CoasterState>;
  approachingPark: React.MutableRefObject<boolean>;
};

const WALK_SPEED = 2.5; // units/sec
const FLEE_SPEED = 5.8; // sprint speed when fleeing the gator
const GATOR_CHASE_SPEED = 2.2;
const GATOR_RETURN_SPEED = 1.4;
const ARRIVE_DIST = 0.18;
const DOOR_OPEN_SPEED = 3;
const DOOR_CLOSE_SPEED = 4;
const GATOR_HOME = { x: 11.5, z: -8, angle: 0.6 };
const CHAR_RADIUS = 0.32; // for building collision

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
      pendingNavRef.current = null;
      approachingGatorRef.current = false;
      gatorRef.current.chasing = false;
      approachingParkRef.current = false;
      coasterRef.current.riding = false;
      coasterRef.current.t = 0;
    } else {
      targetRef.current = null;
      pendingNavRef.current = null;
    }
  }, [pathname]);

  const refs: SharedRefs = useMemo(
    () => ({
      char: charRef,
      target: targetRef,
      pendingNav: pendingNavRef,
      doors: doorsRef,
      gator: gatorRef,
      approachingGator: approachingGatorRef,
      coaster: coasterRef,
      approachingPark: approachingParkRef,
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
        }
        refs.target.current = null;
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

    // Navigate when door fully open
    if (refs.pendingNav.current) {
      const openness = refs.doors.current[refs.pendingNav.current];
      if (openness >= 0.999) {
        const id = refs.pendingNav.current;
        refs.pendingNav.current = null;
        queueMicrotask(() => {
          const sec = SECTIONS.find((s) => s.id === id);
          if (sec) router.push(sec.path);
        });
      }
    }
  });

  function isBusy() {
    return (
      refs.char.current.mode === "flee" ||
      refs.char.current.mode === "riding" ||
      refs.gator.current.chasing ||
      refs.coaster.current.riding
    );
  }

  function handleBuildingClick(section: Section) {
    if (!isOnHome || isBusy()) return;
    const t = doorTarget(section);
    refs.target.current = { x: t.x, z: t.z, sectionId: section.id };
    refs.char.current.walking = true;
  }

  function handleGroundClick(e: ThreeEvent<MouseEvent>) {
    if (!isOnHome || isBusy()) return;
    const p = e.point;
    refs.target.current = { x: p.x, z: p.z, sectionId: null };
    refs.char.current.walking = true;
    e.stopPropagation();
  }

  function handleGatorClick() {
    if (!isOnHome || isBusy()) return;
    // Walk to a spot just in front of the gator (on the line back to plaza)
    const g = refs.gator.current;
    const r = Math.hypot(g.x, g.z);
    const offset = 1.6; // stand this far from the gator before it pounces
    const k = (r - offset) / r;
    refs.target.current = {
      x: g.x * k,
      z: g.z * k,
      sectionId: null,
    };
    refs.char.current.walking = true;
    refs.approachingGator.current = true;
  }

  function handleParkClick() {
    if (!isOnHome || isBusy()) return;
    // Walk to the park entrance (south of park, near the ticket booth)
    refs.target.current = {
      x: PARK.x,
      z: PARK.z + PARK_ENTRY_OFFSET,
      sectionId: null,
    };
    refs.char.current.walking = true;
    refs.approachingPark.current = true;
  }

  return (
    <>
      <Lights />
      <Sky />
      <Clouds />
      <Ground onClick={handleGroundClick} />
      <Plaza />
      <Environment
        gatorRef={refs.gator}
        onGatorClick={handleGatorClick}
        coasterRef={refs.coaster}
        onParkClick={handleParkClick}
      />
      {SECTIONS.map((s) => (
        <Building
          key={s.id}
          section={s}
          doorsRef={refs.doors}
          onSelect={() => handleBuildingClick(s)}
        />
      ))}
      <Character charRef={refs.char} />
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

function Ground({ onClick }: { onClick: (e: ThreeEvent<MouseEvent>) => void }) {
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0, 0]}
      receiveShadow
      onClick={onClick}
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
}: {
  gatorRef: React.MutableRefObject<GatorState>;
  onGatorClick: () => void;
  coasterRef: React.MutableRefObject<CoasterState>;
  onParkClick: () => void;
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
      <GolfCourse position={[-11.5, 0, 9]} />

      {/* Amusement park to the northwest (opposite the golf course) */}
      <AmusementPark onSelect={onParkClick} />
      <CoasterCart coasterRef={coasterRef} />

      {/* Scattered regular trees around the world perimeter */}
      <Tree position={[15, 0, 1]} scale={1.1} />
      <Tree position={[-7, 0, 0]} />
      <Tree position={[9, 0, 13]} scale={1.2} />
      <Tree position={[-7, 0, 14]} />
      <Tree position={[2, 0, -16]} scale={1.05} />
      <Tree position={[18, 0, -2]} scale={0.95} />
      <Tree position={[-19, 0, 5]} />
      <Tree position={[-21, 0, -14]} scale={1.15} />
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
}: {
  position: [number, number, number];
}) {
  return (
    <group position={position}>
      {/* Fairway — a wider rectangular patch of brighter grass */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.011, 0]} receiveShadow>
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
}: {
  charRef: React.MutableRefObject<CharState>;
}) {
  const rootRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Group>(null);
  const leftShoulderRef = useRef<THREE.Group>(null);
  const rightShoulderRef = useRef<THREE.Group>(null);
  const leftHipRef = useRef<THREE.Group>(null);
  const rightHipRef = useRef<THREE.Group>(null);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const c = charRef.current;
    if (rootRef.current) {
      rootRef.current.position.x = c.x;
      rootRef.current.position.z = c.z;
      // y is driven by the game tick during ride (track height); zero on foot.
      rootRef.current.position.y = c.mode === "riding" ? c.y + 0.36 : 0;
      // Smoothly rotate to face direction. Snap during ride so we always
      // match the cart's heading.
      const cur = rootRef.current.rotation.y;
      let diff = c.angle - cur;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      rootRef.current.rotation.y =
        c.mode === "riding" ? c.angle : cur + diff * 0.2;
    }

    if (c.mode === "riding") {
      // Arms way up — riding thrill — plus a little oscillation
      const wave = Math.sin(t * 5) * 0.15;
      const armsUp = -Math.PI * 0.85 + wave;
      if (leftShoulderRef.current) leftShoulderRef.current.rotation.x = armsUp;
      if (rightShoulderRef.current)
        rightShoulderRef.current.rotation.x = armsUp;
      if (leftHipRef.current) leftHipRef.current.rotation.x = 0;
      if (rightHipRef.current) rightHipRef.current.rotation.x = 0;
      if (bodyRef.current) {
        // Subtle vertical bounce as the cart goes over track joints
        bodyRef.current.position.y = Math.abs(Math.sin(t * 9)) * 0.03;
      }
      return;
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

        {/* Beard — oblate spheroid that wraps the jaw uniformly from every angle */}
        <mesh position={[0, 1.36, 0]} scale={[1.2, 0.85, 1.2]} castShadow>
          <sphereGeometry args={[0.185, 14, 12]} />
          <meshStandardMaterial color={BEARD} />
        </mesh>
        {/* Mustache — small dark patch above the lip on the front of the face */}
        <mesh position={[0, 1.47, 0.18]} rotation={[0.2, 0, 0]}>
          <boxGeometry args={[0.13, 0.035, 0.04]} />
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

function CameraRig({
  charRef,
  pathname,
}: {
  charRef: React.MutableRefObject<CharState>;
  pathname: string;
}) {
  const targetVec = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const controlsRef = useRef<React.ComponentRef<typeof OrbitControls>>(null);

  useFrame((_, dt) => {
    const c = charRef.current;
    // OrbitControls .target lerps toward character when walking to a section,
    // back to origin otherwise.
    const targetingSection = c.walking;
    const wantX = targetingSection ? c.x : 0;
    const wantZ = targetingSection ? c.z : 0;
    const wantY = 1;
    targetVec.x += (wantX - targetVec.x) * Math.min(1, dt * 2.5);
    targetVec.y += (wantY - targetVec.y) * Math.min(1, dt * 2.5);
    targetVec.z += (wantZ - targetVec.z) * Math.min(1, dt * 2.5);
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
