export const APP_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="T3 Research">
  <defs>
    <linearGradient id="g" x1="80" y1="64" x2="432" y2="448" gradientUnits="userSpaceOnUse">
      <stop stop-color="#63dcff"/>
      <stop offset="1" stop-color="#7c5cff"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="#0b0d12"/>
  <path d="M112 142h92l52 70 52-70h92M112 370h92l52-70 52 70h92" fill="none" stroke="url(#g)" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="112" cy="142" r="28" fill="#63dcff"/>
  <circle cx="400" cy="142" r="28" fill="#7cbcff"/>
  <circle cx="112" cy="370" r="28" fill="#6b9fff"/>
  <circle cx="400" cy="370" r="28" fill="#7c5cff"/>
  <circle cx="256" cy="256" r="58" fill="#111a28" stroke="#eaf8ff" stroke-width="22"/>
</svg>`;

export const WEB_MANIFEST = JSON.stringify({
  name: "T3 Research",
  short_name: "Research",
  description: "Local-first multi-agent deep research",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#0b0d12",
  theme_color: "#10131a",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
});
