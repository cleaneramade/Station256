// Station 256's editor has no server, accounts or online services of its own.
export const webEnv = {
	NODE_ENV: process.env.NODE_ENV ?? "production",
	NEXT_PUBLIC_SITE_URL: "station-editor://app",
};
