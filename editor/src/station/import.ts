import { toast } from "sonner";
import type { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";
import { baseName, station } from "./bridge";

const TYPES: Record<string, string> = {
	mp4: "video/mp4",
	m4v: "video/mp4",
	mov: "video/quicktime",
	webm: "video/webm",
	mkv: "video/x-matroska",
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	wav: "audio/wav",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
};

// House files are copied into the editor's own storage as they're read, so a long video never has
// to fit in memory. (Reading a big file from Station as one blob also fails in Electron 45.) The
// copies are only needed while the page that added them is open; ones over half a day old go.
const COPIES = "station-import";
const KEEP_COPIES_FOR = 12 * 60 * 60 * 1000;

async function copyIntoStorage(url: string): Promise<File> {
	const response = await fetch(url);
	if (!response.ok || !response.body) throw new Error("The file couldn't be read.");
	const root = await navigator.storage.getDirectory();
	const folder = await root.getDirectoryHandle(COPIES, { create: true });
	const names: string[] = [];
	for await (const name of (folder as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
	for (const name of names) {
		const made = Number(name.split("-")[0]);
		if (!(Date.now() - made < KEEP_COPIES_FOR)) await folder.removeEntry(name).catch(() => {});
	}
	const handle = await folder.getFileHandle(`${Date.now()}-${crypto.randomUUID()}`, { create: true });
	const writable = await handle.createWritable();
	await response.body.pipeTo(writable);
	return handle.getFile();
}

// Station 256: a house file opened with Editor goes into the project and onto the timeline, and the
// project takes the video's picture size.
export async function importFromHouse({
	editor,
	projectId,
	target,
}: {
	editor: EditorCore;
	projectId: string;
	target: string;
}): Promise<boolean> {
	const bridge = station();
	if (!bridge) return false;
	const name = baseName(target);
	const toastId = toast.loading(`Adding ${name}…`);
	try {
		const ext = (/\.([^.]+)$/.exec(name)?.[1] ?? "").toLowerCase();
		const stopWatching = bridge.onProgress(({ target: making, percent }) => {
			if (making === target) toast.loading(`Getting ${name} ready to edit… ${percent}%`, { id: toastId });
		});
		let readable = target;
		try {
			readable = await bridge.editable(target);
		} finally {
			stopWatching();
		}
		const stored = await copyIntoStorage(bridge.houseUrl(readable));
		// A copy Station made is an MP4, whatever the original was.
		const file = new File([stored], name, {
			type: (readable === target ? TYPES[ext] : TYPES.mp4) || "application/octet-stream",
			lastModified: Date.now(),
		});
		const [asset] = await processMediaAssets({ files: [file], onProgress: () => {} });
		if (!asset) throw new Error("This kind of file can't be edited here.");
		const added = await editor.media.addMediaAsset({ projectId, asset });
		if (!added) throw new Error("There wasn't room to keep it.");
		const { width, height } = added as { width?: number; height?: number };
		if (added.type !== "audio" && width && height) {
			const size = { width, height };
			await editor.project.updateSettings({
				settings: { canvasSize: size, canvasSizeMode: "custom", lastCustomCanvasSize: size },
				pushHistory: false,
			});
		}
		const duration =
			added.duration != null
				? mediaTimeFromSeconds({ seconds: added.duration })
				: DEFAULT_NEW_ELEMENT_DURATION;
		editor.timeline.insertElement({
			element: buildElementFromMedia({
				mediaId: added.id,
				mediaType: added.type,
				name: added.name,
				duration,
				startTime: ZERO_MEDIA_TIME,
			}),
			placement: { mode: "auto" },
		});
		toast.success(`${name} is ready to edit`, { id: toastId });
		return true;
	} catch (error) {
		toast.error(`${name} couldn't be added`, {
			id: toastId,
			description: error instanceof Error ? error.message : undefined,
		});
		return false;
	}
}

// Station 256: what's exported is saved into the house, beside the video it came from (or in
// Videos), instead of a browser download.
export async function saveExportToHouse({
	buffer,
	filename,
	source,
}: {
	buffer: ArrayBuffer;
	filename: string;
	source: string | null;
}): Promise<string | null> {
	const bridge = station();
	if (!bridge) return null;
	try {
		const saved = await bridge.saveExport(buffer, filename, source);
		toast.success(`Saved "${baseName(saved.path)}"`, {
			description: "In your files, next to where it came from.",
			action: { label: "Show", onClick: () => bridge.reveal(saved.path) },
			duration: 8000,
		});
		return saved.path;
	} catch (error) {
		toast.error("The video wasn't saved", {
			description: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : undefined,
		});
		return null;
	}
}
