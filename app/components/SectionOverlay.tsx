"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

type Props = {
  title: string;
  accent: string;
  children: React.ReactNode;
};

export default function SectionOverlay({ title, accent, children }: Props) {
  const router = useRouter();

  function close() {
    router.push("/");
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="absolute inset-0 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={close}
    >
      <div
        className="relative w-full max-w-3xl max-h-[85vh] overflow-y-auto rounded-lg shadow-2xl"
        style={{
          background: "#0f0f1e",
          border: `4px solid ${accent}`,
          boxShadow: `0 0 0 2px #0f0f1e, 0 0 40px ${accent}55`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="flex items-center justify-between px-6 py-4 border-b-2"
          style={{ borderColor: accent }}
        >
          <h2
            className="font-pixel text-lg tracking-wider"
            style={{ color: accent }}
          >
            {title}
          </h2>
          <button
            onClick={close}
            className="font-pixel text-sm text-white/80 hover:text-white border-2 border-white/30 hover:border-white px-3 py-1 transition-colors"
            aria-label="Close section"
          >
            X
          </button>
        </header>
        <div className="px-6 py-5 font-body text-xl text-[#f4f1de] leading-relaxed">
          {children}
        </div>
      </div>
    </div>
  );
}
