// Station 256: this editor runs in a Station 256 tab, which hands it the house's files and saves
// what it exports into them (panel/editor-preload.js, panel/lib/editor-app.js). Outside Station 256
// (in a plain browser while working on it) there's no bridge, and it works as OpenCut did.

export type StationBridge = {
	houseUrl: (target: string) => string;
	saveExport: (
		bytes: ArrayBuffer,
		filename: string,
		source: string | null,
	) => Promise<{ path: string }>;
	reveal: (target: string) => void;
	// The file to read for a house file: itself, or a copy the editor can read (an AVI, or an
	// iPhone's HEVC video), which Station makes first and reports progress on.
	editable: (target: string) => Promise<string>;
	onProgress: (
		callback: (value: { target: string; percent: number }) => void,
	) => () => void;
};

export function station(): StationBridge | null {
	if (typeof window === "undefined") return null;
	return (window as unknown as { station?: StationBridge }).station ?? null;
}

// Which project a house video opened into, so opening it again goes back to the same project.
const sourceKey = (projectId: string) => `station:source:${projectId}`;
const projectKey = (target: string) => `station:project:${target}`;

function read(key: string): string | null {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

export function sourceOf(projectId: string): string | null {
	return read(sourceKey(projectId));
}

export function projectFor(target: string): string | null {
	return read(projectKey(target));
}

export function linkProject(projectId: string, target: string): void {
	try {
		window.localStorage.setItem(sourceKey(projectId), target);
		window.localStorage.setItem(projectKey(target), projectId);
	} catch {
		// Without storage it just opens a new project next time.
	}
}

export const baseName = (target: string) => target.split("/").pop() || target;
export const stemOf = (name: string) => name.replace(/\.[^.]+$/, "") || name;
