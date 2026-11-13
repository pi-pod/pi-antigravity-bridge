import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDisplayRenderers } from "./display-renderers.js";

/** pipod runs this in the launcher. No providers, CLI processes, auth, or mutable state here. */
export default function (pi: ExtensionAPI): void {
	registerDisplayRenderers(pi);
}
