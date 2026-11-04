// Pi's session and agent events: load the state, keep the tools and the plan progress current, guard tool
// calls and tell the model about the mode.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FLAG } from "./flags.ts";
import { buildSection } from "./plan/handoff.ts";
import { planFile } from "./plan/write.ts";
import {
	architectSection,
	drawingRulesInContext,
	MODE_MESSAGE,
	modeNotice,
	modeToldToModel,
	SECTION,
} from "./prompt.ts";
import { blockReason } from "./readonly/index.ts";
import type { ArchitectSession } from "./session.ts";
import { pinSelectedTools } from "./tools-activation.ts";

export function registerLifecycle(pi: ExtensionAPI, session: ArchitectSession): void {
	pi.on("session_start", async (event, ctx) => {
		session.load(ctx);
		await session.syncProgress(ctx);
		if (event.reason === "startup" && pi.getFlag(FLAG) === true && session.state.mode !== "architect")
			await session.setMode("architect", ctx);
	});

	// Pi fires this after every session_start handler, also after a reload: a tool another extension turned on
	// at session start goes off again.
	pi.on("resources_discover", async () => {
		if (session.state.mode === "architect") session.applyTools();
	});

	pi.on("session_tree", async (_event, ctx) => {
		session.load(ctx);
		await session.syncProgress(ctx);
	});

	// Progress lives in the plan file's boxes. Re-read it after a tool that may have ticked one, and after
	// each run as a catch-all for other ways to edit it.
	pi.on("tool_result", async (event, ctx) => {
		const plan = session.state.plan;
		if (!plan || event.isError) return;
		const path = (event.input as { path?: unknown } | undefined)?.path;
		const touches =
			event.toolName === "bash" ||
			(typeof path === "string" && planFile(ctx.cwd, path.replace(/^@/, "")) === planFile(ctx.cwd, plan.path));
		if (touches) await session.syncProgress(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		await session.syncProgress(ctx);
	});

	pi.on("session_shutdown", async () => {
		session.shutdown();
	});

	pi.on("tool_call", async (event) => {
		if (session.state.mode !== "architect") return;
		const reason = blockReason(event.toolName, event.input);
		if (reason) return { block: true, reason };
	});

	// Tools can register after architect mode started, e.g. MCP tools, also in the middle of a run: turn them
	// off before each request.
	pi.on("turn_start", async () => {
		if (session.state.mode === "architect") session.applyTools();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		session.ctx = ctx;
		if (session.state.mode === "architect") {
			session.applyTools();
			// Handlers of extensions that load later run after this one and may turn tools back on.
			pinSelectedTools(event.systemPromptOptions, pi.getActiveTools());
		}
		const { state, progress } = session;
		const sections = event.systemPromptOptions.sections;
		const section =
			architectSection(state, {
				drawingRulesInContext:
					state.architecture !== undefined &&
					drawingRulesInContext(ctx.sessionManager.getBranch(), state.architecture.phase),
			}) ?? (state.mode === "build" && state.plan ? buildSection(state.plan, progress) : undefined);
		if (section) sections[SECTION] = section;
		else delete sections[SECTION];
		if (modeToldToModel(ctx.sessionManager.getBranch()) === state.mode) return;
		return {
			message: {
				customType: MODE_MESSAGE,
				content: modeNotice(state.mode, state.architecture),
				display: false,
				details: { mode: state.mode },
			},
		};
	});
}
