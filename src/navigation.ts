import type { Herdr } from './herdr.ts';
import { agentPaths, listLabels, readJson, readText, type Meta } from './store.ts';
import { AgentPalette, ResultViewer, type MenuEntry } from './palette.ts';
import { fleetRank } from './fleet-policy.ts';

const statusText: Record<string, string> = {
	starting: 'starting',
	running: 'running',
	blocked: 'blocked',
	done: 'done',
	no_result: 'no result',
	timeout: 'timeout',
	failed: 'failed',
	closed: 'closed',
};

const matches = (agent: any, id: string) => {
	const value = agent.agent_session?.value;
	return typeof value === 'string' && (value === id || value.endsWith(`_${id}.jsonl`));
};

export async function openNavigator(ctx: any, h: Herdr, parentId: string, closeAll?: () => Promise<void>) {
	if (ctx.mode !== 'tui' || !ctx.hasUI) {
		ctx.ui.notify('Interactive TUI required for /herdr. Use herd_status in non-interactive mode.', 'warning');
		return;
	}

	let currentView: 'active' | 'archive' = 'active';

	while (true) {
		const parent = await h.sessionPane(parentId);
		const agents = await h.list();
		const metas: Meta[] = [];
		for (const label of await listLabels(parentId)) {
			const m = await readJson(agentPaths(parentId, label).meta);
			if (m) metas.push(m);
		}
		metas.sort((a, b) => fleetRank(a.state) - fleetRank(b.state) || b.startedAt - a.startedAt);

		const activeMetas: { meta: Meta; live: any }[] = [];
		const archiveMetas: Meta[] = [];

		for (const m of metas) {
			const live = agents.find((a) => matches(a, m.piSessionId) && parent && a.workspace_id === parent.workspace_id);
			const isRetained = m.state === 'running' || m.state === 'starting' || m.state === 'blocked' || (m.state === 'done' && Boolean(live));
			if (isRetained) {
				activeMetas.push({ meta: m, live });
			} else {
				archiveMetas.push(m);
			}
		}

		if (currentView === 'archive') {
			// === ARCHIVE VIEW ===
			const entries: MenuEntry[] = [
				{
					id: 'back',
					label: '← Back to active subagents',
					action: 'back',
					color: 'accent',
				},
			];

			for (const m of archiveMetas) {
				const isError = ['failed', 'timeout', 'no_result'].includes(m.state);
				const mark = isError ? 'x' : '·';
				const color = isError ? 'error' : 'muted';
				entries.push({
					id: `archive:${m.label}`,
					label: m.label,
					role: m.definition,
					state: statusText[m.state] ?? m.state,
					mark,
					action: 'view result',
					color,
				});
			}

			const title = `Archive (${archiveMetas.length} tasks) · Esc to return`;
			const choice = (await ctx.ui.custom(
				(tui: any, theme: any, _kb: any, done: any) => new AgentPalette(tui, theme, entries, title, done),
			)) as MenuEntry | undefined;

			if (!choice || choice.id === 'back') {
				currentView = 'active';
				continue;
			}

			const label = choice.id.replace('archive:', '');
			const meta = archiveMetas.find((m) => m.label === label);
			if (meta) {
				await showResultModal(ctx, parentId, meta);
			}
			continue;
		}

		// === ACTIVE / RETAINED VIEW ===
		const entries: MenuEntry[] = [];

		// Return to main session (if this pane is a child pane)
		const callerIsMain = parent && Boolean(agents.find((a) => a.pane_id === parent.pane_id && a.focused));
		if (!callerIsMain) {
			entries.push({
				id: 'main',
				label: 'MAIN · Return to main session',
				role: 'main',
				state: parent ? 'online' : 'offline',
				mark: '◀',
				action: parent ? 'focus' : 'offline',
				color: 'accent',
			});
		}

		// Retained / active subagents
		for (const { meta: m, live } of activeMetas) {
			const status = statusText[m.state] ?? m.state;
			const mark = m.state === 'blocked' ? '?' : m.state === 'done' ? '+' : m.state === 'running' ? '⠏' : '·';
			const color = m.state === 'blocked' ? 'warning' : m.state === 'done' ? 'success' : 'accent';
			entries.push({
				id: `agent:${m.label}`,
				label: m.label,
				role: m.definition,
				state: status,
				mark,
				action: live ? 'focus' : 'view result',
				color,
			});
		}

		// Archive entry
		if (archiveMetas.length > 0) {
			entries.push({
				id: 'open-archive',
				label: `📁 Archive (${archiveMetas.length} tasks)`,
				detail: `${archiveMetas.length} completed tasks`,
				action: 'open',
				color: 'muted',
			});
		}

		// Close all entry
		if (closeAll && activeMetas.length > 0) {
			entries.push({
				id: 'close-all',
				label: '✕ Close all subagents',
				role: 'admin',
				state: 'confirm',
				mark: '✕',
				action: 'close all',
				color: 'warning',
			});
		}

		const scopeText = `Subagents · workspace ${parent?.workspace_id ?? 'offline'} · parent ${parentId.slice(0, 8)}`;
		const choice = (await ctx.ui.custom(
			(tui: any, theme: any, _kb: any, done: any) => new AgentPalette(tui, theme, entries, scopeText, done),
		)) as MenuEntry | undefined;

		if (!choice) return;

		if (choice.id === 'main') {
			if (!(await h.focusSession(parentId, parentId))) ctx.ui.notify('Main window offline.', 'warning');
			return;
		}

		if (choice.id === 'open-archive') {
			currentView = 'archive';
			continue;
		}

		if (choice.id === 'close-all') {
			if (await ctx.ui.confirm('Close all subagents?', 'Running subagents will be stopped; results and logs are kept.')) {
				await closeAll?.();
			}
			continue;
		}

		const meta = metas.find((m) => `agent:${m.label}` === choice.id);
		if (!meta) continue;

		if (await h.focusSession(meta.piSessionId, parentId)) return;
		await showResultModal(ctx, parentId, meta);
	}
}

async function showResultModal(ctx: any, parentId: string, meta: Meta) {
	const p = agentPaths(parentId, meta.label);
	const result = await readText(p.result);
	const ask = await readText(p.ask);
	const content = [
		`Task: ${meta.label} · ${meta.definition} · ${statusText[meta.state] ?? meta.state}`,
		`Result Path: ${p.result}`,
		`Exit Reason: ${meta.exitReason ?? 'normal exit'}`,
		ask ? `Pending Question:\n${ask}` : '',
		result ?? 'No result.md produced; check log.jsonl.',
	]
		.filter(Boolean)
		.join('\n\n');

	const bounded = content.length > 60_000 ? `${content.slice(0, 60_000)}\n\n[Truncated; see file on disk]` : content;
	await ctx.ui.custom(
		(tui: any, theme: any, _kb: any, done: any) =>
			new ResultViewer(tui, theme, `${meta.label} (${meta.definition})`, bounded, () => done(undefined)),
	);
}
