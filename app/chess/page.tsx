// This route deliberately renders nothing — the chess "section"
// is a full 3D scene inside a chess study room, mounted by
// GameWorld when pathname === "/chess". GameShell knows to skip
// its overlay container for this route so canvas clicks (the
// chess board squares, the exit door, the reset-view button)
// remain interactive.

export const metadata = { title: "Chess — Sonny Parlin" };

export default function ChessPage() {
  return null;
}
