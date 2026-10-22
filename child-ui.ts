/** Explicitly loaded child-only UI. No orchestration tools and no shutdown/cleanup hooks. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createHerdr } from './src/herdr.ts';
import { openNavigator } from './src/navigation.ts';

export default function childUI(pi: ExtensionAPI) {
	for (const name of ['herdr-parent', 'herdr-label', 'herdr-role']) {
		pi.registerFlag(name, { description: `pi-herdr child identity: ${name}`, type: 'string' });
	}
	const h = createHerdr((cmd, args, opts) => pi.exec(cmd, args, opts));
	const flag = (key: string) => String(pi.getFlag(key) ?? '');

	pi.registerCommand('herdr', {
		description: 'Switch panes, inspect archive, or return to main session',
		handler: async (_args, ctx) => {
			const parent = flag('herdr-parent');
			if (!parent) {
				ctx.ui.notify('Missing parent session ID.', 'warning');
				return;
			}
			try {
				await openNavigator(ctx, h, parent);
			} catch (error: any) {
				ctx.ui.notify(String(error?.message ?? error), 'error');
			}
		},
	});

	pi.on('session_start', async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const title = `SUB · ${flag('herdr-label')}`;
		ctx.ui.setTitle(title);
	});

	// Agent definitions are the owner's control surface: a definition pins the model, thinking level
	// and tool set of every future child, so a child that can write one can grant itself anything.
	// Blocked here (fail-closed) and audited again by the parent after the child ends.
	const PROTECTED = [/(^|[\\/])\.pi[\\/]agent[\\/]agents([\\/]|$)/i, /[\\/]\.pi[\\/]agent[\\/]pi-herd/i];
	const SHELL_WRITE = /(>>?|\btee\b|\bcp\b|\bmv\b|\bsed\s+-i|\brm\b|\btruncate\b|\binstall\b)/;
	const touchesProtected = (text: string) => PROTECTED.some((pattern) => pattern.test(text));
	const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'apply_patch', 'patch', 'str_replace']);

	pi.on('tool_call', async (event: any, ctx: any) => {
		try {
			const name = String(event?.toolName ?? '');
			const input = (event?.input ?? {}) as Record<string, unknown>;
			// Reading a definition is how a child learns its own contract; only writes are owner-only.
			let mutating = WRITE_TOOLS.has(name);
			if (!mutating) {
				try {
					const declared = (pi as any).getAllTools?.().find((tool: any) => tool.name === name);
					mutating = declared?.annotations ? declared.annotations.readOnlyHint !== true : false;
				} catch {
					/* older host: fall back to the explicit set above */
				}
			}
			const paths = mutating
				? [input.path, input.file_path, input.filePath].filter(
						(value): value is string => typeof value === 'string',
					)
				: [];
			const command = name === 'bash' ? String(input.command ?? '') : '';
			const hit =
				paths.some(touchesProtected) ||
				(command !== '' && touchesProtected(command) && SHELL_WRITE.test(command));
			if (!hit) return;
			ctx?.ui?.notify?.('子 agent 不能修改 agent 定义或编排配置', 'warning');
			return {
				block: true,
				reason: 'agent definitions and pi-herdr config are owner-only; report the need in result.md instead',
			};
		} catch {
			return { block: true, reason: 'definition guard could not evaluate this tool call' };
		}
	});
}
