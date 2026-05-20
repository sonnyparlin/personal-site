// This route deliberately renders nothing — the jiu-jitsu "section"
// is a full 3D scene inside the academy, mounted by GameWorld when
// pathname === "/jiu-jitsu". GameShell knows to skip its overlay
// container for this route so canvas clicks (the exit door, the
// reset-view button, etc.) remain interactive.

export const metadata = { title: "Jiu Jitsu — Sonny Parlin" };

export default function JiuJitsuPage() {
  return null;
}
