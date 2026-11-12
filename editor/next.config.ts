import type { NextConfig } from "next";

// Station 256's editor is a set of files Station shows itself (station-editor://app), with no
// server: built once with `bun run build` into out/.
const nextConfig: NextConfig = {
	output: "export",
	trailingSlash: true,
	images: { unoptimized: true },
	reactStrictMode: true,
	productionBrowserSourceMaps: false,
	compiler: {
		removeConsole: process.env.NODE_ENV === "production" ? { exclude: ["error", "warn"] } : false,
	},
};

export default nextConfig;
