import type { Config } from "tailwindcss";

export default {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: { sans: ["Inter", "Segoe UI", "sans-serif"] },
      colors: {
        ink: "#101827",
        ocean: "#1176ba",
        mint: "#17ad90"
      }
    }
  },
  plugins: []
} satisfies Config;
