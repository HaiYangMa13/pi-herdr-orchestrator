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
		const title = `SUB · ${flag('herdr-label')} · ${flag('herdr-role')} · parent ${flag('herdr-parent').slice(0, 8)}`;
		ctx.ui.setTitle(title);
	});
}
