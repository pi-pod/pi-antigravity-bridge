import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { NativeDisplayEvent } from "./provider.js";
import type { PollRunData } from "./poll-fold.js";

/** Display-only registrations shared by ordinary Pi and pipod's launcher-side renderer. */
export function registerDisplayRenderers(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<NativeDisplayEvent>("agy-native-event", (entry, { expanded }, theme) => {
		const event = entry.data;
		const firstLine = (value: string | undefined): string | undefined => value?.split(/\r?\n/, 1)[0].trim() || undefined;
		const detail = event?.path ? path.basename(event.path) : firstLine(event?.command) ?? firstLine(event?.output);
		const status = event?.status === "failed" ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const lines = [`${status} ${theme.fg("toolTitle", event?.name ?? "Antigravity")}${detail ? ` ${theme.fg("muted", detail.slice(0, 160))}` : ""}`];
		if (expanded) {
			if (event?.path) lines.push(theme.fg("dim", event.path));
			if (event?.diff) for (const line of event.diff.split("\n")) {
				const color = line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext";
				lines.push(theme.fg(color, line));
			}
			if (event?.output && (!event.diff || event.status === "failed")) lines.push(theme.fg("toolOutput", event.output));
		}
		return new Text(lines.join("\n"), 0, 0);
	});
	pi.registerEntryRenderer<PollRunData>("agy-poll-run", (entry, { expanded }, theme) => {
		const run = entry.data;
		const count = run?.count ?? 0;
		const label = `Poll ${run?.target ?? "bridge call"} (x${count}${run?.state === "failed" ? ", failed" : ""})`;
		const lines = [`♊︎ ${theme.fg("toolTitle", "bridge_poll_result")} ${theme.fg("muted", label)}`];
		if (expanded && run) {
			const time = (iso: string): string => new Date(iso).toLocaleTimeString();
			lines.push(theme.fg("dim", `${count} ${count === 1 ? "poll" : "polls"}, ${time(run.firstAt)} → ${time(run.lastAt)}`));
		}
		return new Text(lines.join("\n"), 0, 0);
	});
}
