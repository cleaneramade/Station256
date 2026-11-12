"use client";

import { Suspense, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useEditor } from "@/editor/use-editor";
import { storageService } from "@/services/storage/service";
import { baseName, linkProject, projectFor, stemOf } from "@/station/bridge";

// Station 256: /open/?path=<house file>. The project that file opened into before, or a new one
// named after it that takes the file in as it opens.
export default function OpenPage() {
	return (
		<Suspense fallback={null}>
			<Opener />
		</Suspense>
	);
}

function Opener() {
	const router = useRouter();
	const editor = useEditor();
	const started = useRef(false);

	useEffect(() => {
		if (started.current) return;
		started.current = true;
		const target = new URLSearchParams(window.location.search).get("path");
		if (!target) {
			router.replace("/projects/");
			return;
		}
		(async () => {
			const known = projectFor(target);
			if (known) {
				const projects = await storageService.loadAllProjectsMetadata();
				if (projects.some((project) => project.id === known)) {
					router.replace(`/editor/?project=${known}`);
					return;
				}
			}
			const id = await editor.project.createNewProject({ name: stemOf(baseName(target)) });
			linkProject(id, target);
			router.replace(`/editor/?project=${id}&import=${encodeURIComponent(target)}`);
		})().catch(() => router.replace("/projects/"));
	}, [editor, router]);

	return (
		<div className="bg-background text-muted-foreground flex h-screen w-screen items-center justify-center text-sm">
			Opening…
		</div>
	);
}
