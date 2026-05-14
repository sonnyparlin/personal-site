"use client";

import { useEffect, useMemo, useRef } from "react";
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

type CharState = {
  x: number;
  z: number;
  angle: number; // facing angle (Y rotation, radians)
  walking: boolean;
  stepPhase: number; // 0..1
};

type DoorState = Record<SectionId, number>; // 0..1 (closed..open)

type SharedRefs = {
  char: React.MutableRefObject<CharState>;
  target: React.MutableRefObject<{
    x: number;
    z: number;
    sectionId: SectionId | null;
  } | null>;
  pendingNav: React.MutableRefObject<SectionId | null>;
  doors: React.MutableRefObject<DoorState>;
};

const WALK_SPEED = 2.5; // units/sec
const ARRIVE_DIST = 0.18;
const DOOR_OPEN_SPEED = 3;
const DOOR_CLOSE_SPEED = 4;

// -------------------- entry point --------------------

export default function GameWorld() {
  const charRef = useRef<CharState>({
    x: 0,
    z: 0,
    angle: 0,
    walking: false,
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
      targetRef.current = null;
      pendingNavRef.current = null;
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
    }),
    []
  );

  const isOnHome = (pathname ?? "/") === "/";

  return (
    <div className="w-full h-full">
      <Canvas
        shadows
        camera={{ position: [0, 11, 14], fov: 45, near: 0.1, far: 200 }}
        gl={{ antialias: true }}
      >
        <color attach="background" args={["#1a1a2e"]} />
        <fog attach="fog" args={["#3a4a6e", 30, 70]} />
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

    if (isOnHome && target && char.walking) {
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
            // Face the building (toward its center)
            char.angle = Math.atan2(sec.x - char.x, sec.z - char.z);
          }
          refs.pendingNav.current = target.sectionId;
        }
        refs.target.current = null;
      } else {
        const step = WALK_SPEED * clampedDt;
        char.x += (dx / dist) * step;
        char.z += (dz / dist) * step;
        char.angle = Math.atan2(dx, dz);
        char.stepPhase = (char.stepPhase + clampedDt * 2.2) % 1;
      }
    } else if (!char.walking) {
      char.stepPhase = 0;
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

  function handleBuildingClick(section: Section) {
    if (!isOnHome) return;
    const t = doorTarget(section);
    refs.target.current = { x: t.x, z: t.z, sectionId: section.id };
    refs.char.current.walking = true;
  }

  function handleGroundClick(e: ThreeEvent<MouseEvent>) {
    if (!isOnHome) return;
    const p = e.point;
    refs.target.current = { x: p.x, z: p.z, sectionId: null };
    refs.char.current.walking = true;
    e.stopPropagation();
  }

  return (
    <>
      <Lights />
      <Sky />
      <Ground onClick={handleGroundClick} />
      <Plaza />
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
  return (
    <mesh>
      <sphereGeometry args={[80, 24, 16]} />
      <meshBasicMaterial color="#6b9bd1" side={THREE.BackSide} />
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
      <planeGeometry args={[60, 60]} />
      <meshStandardMaterial color="#5a8a3a" />
    </mesh>
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
      // Smoothly rotate to face direction (LERP angles to avoid pop on big jumps)
      const cur = rootRef.current.rotation.y;
      let diff = c.angle - cur;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      rootRef.current.rotation.y = cur + diff * 0.2;
    }

    // Limb swing
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
      maxDistance={28}
      minPolarAngle={Math.PI * 0.15}
      maxPolarAngle={Math.PI * 0.48}
      target={[0, 1, 0]}
    />
  );
}
