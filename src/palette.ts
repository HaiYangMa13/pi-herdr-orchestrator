import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

export type MenuEntry = {
	id: string;
	label: string;
	detail?: string;
	action: string;
	color?: string;
	role?: string;
	state?: string;
	mark?: string;
};

export const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, '');

const paint = (theme: any, color: string, text: string) => (theme?.fg ? theme.fg(color, text) : text);
const bold = (theme: any, text: string) => (typeof theme?.bold === 'function' ? theme.bold(text) : text);

const fit = (text: string, n: number): string => {
	const clipped = truncateToWidth(clean(text), n);
	return clipped + ' '.repeat(Math.max(0, n - visibleWidth(clipped)));
};

/**
 * Bottom-docked selector component matching Pi's native /model selector.
 * Embeds in editorContainer without an overlay, avoiding image clipping.
 */
export class AgentPalette {
	private input = new Input({ prompt: '> ', placeholder: 'Filter subagents (e.g. scout, worker)...' });
	private selected = 0;
	private offset = 0;
	private maxVisible = 6;
	private query = '';

	constructor(
		private tui: any,
		private theme: any,
		private entries: MenuEntry[],
		private scope: string,
		private done: (entry: MenuEntry | undefined) => void,
	) {
		this.input.onSubmit = () => this.choose();
		this.input.onEscape = () => done(undefined);
	}

	get focused() {
		return this.input.focused;
	}
	set focused(value: boolean) {
		this.input.focused = value;
	}
	invalidate() {
		this.input.invalidate();
	}

	filtered() {
		const q = this.input.getValue().trim().toLowerCase();
		return this.entries.filter((e) => `${e.label} ${e.role ?? ''} ${e.state ?? ''} ${e.detail ?? ''} ${e.action}`.toLowerCase().includes(q));
	}

	private choose() {
		const entry = this.filtered()[this.selected];
		if (entry) this.done(entry);
	}

	handleInput(data: string) {
		const rows = this.filtered();
		if (matchesKey(data, 'escape')) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
			const delta = matchesKey(data, 'up') ? -1 : 1;
			this.selected = rows.length ? (this.selected + delta + rows.length) % rows.length : 0;
		} else if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
			return;
		} else {
			this.input.handleInput(data);
			if (this.query !== this.input.getValue()) {
				this.query = this.input.getValue();
				this.selected = 0;
				this.offset = 0;
			}
		}
		this.tui.requestRender();
	}

	handleMouse(event: any) {
		const rows = this.filtered();
		if (rows.length === 0) return { handled: true };
		if (event.type === 'wheel') {
			const delta = Math.sign(event.wheelDelta ?? 0);
			this.selected = Math.max(0, Math.min(rows.length - 1, this.selected + delta));
			this.tui.requestRender();
			return { handled: true };
		}
		// Row 0: Title, Row 1: Input, Row 2: Spacer, Row 3+: Items
		const index = this.offset + event.y - 3;
		if (event.type === 'click' && event.button === 'left' && event.y >= 3 && event.y < 3 + this.maxVisible && rows[index]) {
			this.selected = index;
			this.choose();
			return { handled: true };
		}
		return { handled: true };
	}

	render(width: number): string[] {
		width = Math.max(1, width);
		const rows = this.filtered();
		this.maxVisible = Math.max(3, Math.min(7, (this.tui.terminal?.rows ?? 24) - 8));

		if (this.selected < this.offset) this.offset = this.selected;
		if (this.selected >= this.offset + this.maxVisible) this.offset = this.selected - this.maxVisible + 1;

		const out: string[] = [];

		// Row 0: Scope / Header hint
		out.push(paint(this.theme, 'muted', clean(this.scope)));

		// Row 1: Search input
		const renderedInput = this.input.render(width);
		out.push(renderedInput[0] ?? '> ');

		// Row 2: Spacer
		out.push('');

		// Rows 3+: Item list
		if (rows.length === 0) {
			out.push(paint(this.theme, 'muted', '  No matching subagents'));
		} else {
			const visibleSlice = rows.slice(this.offset, this.offset + this.maxVisible);
			for (let i = 0; i < visibleSlice.length; i++) {
				const actualIdx = this.offset + i;
				const isSelected = actualIdx === this.selected;
				const e = visibleSlice[i];

				const arrow = isSelected ? paint(this.theme, 'accent', '→ ') : '  ';
				const marker = e.mark ? `${paint(this.theme, e.color ?? 'muted', e.mark)} ` : '  ';

				const labelW = Math.max(8, Math.min(24, Math.floor(width * 0.35)));
				const labelText = fit(e.label, labelW);
				const styledLabel = isSelected ? bold(this.theme, paint(this.theme, 'accent', labelText)) : labelText;

				const roleText = e.role && width >= 55 ? `${paint(this.theme, 'syntaxType', fit(e.role, 9))} ` : '';
				const stateText = e.state ? paint(this.theme, e.color ?? 'muted', e.state) : '';

				const actionPill = isSelected
					? bold(this.theme, paint(this.theme, 'accent', `[ ${clean(e.action)} ]`))
					: paint(this.theme, 'muted', `[ ${clean(e.action)} ]`);

				const left = `${arrow}${marker}${styledLabel} ${roleText}${stateText}`;
				const leftW = visibleWidth(left);
				const rightW = visibleWidth(actionPill);
				const gap = Math.max(1, width - leftW - rightW);

				out.push(`${left}${' '.repeat(gap)}${actionPill}`);
			}
		}

		// Spacer before footer
		out.push('');

		// Footer
		const countStr = rows.length > 0 ? `(${this.selected + 1}/${rows.length})  ` : '';
		const keysHint = 'Enter to select · Escape to cancel';
		out.push(paint(this.theme, 'muted', `${countStr}${keysHint}`));

		return out.map((line) => truncateToWidth(line, width));
	}
}

/**
 * Bottom-docked result details viewer.
 * Embeds in editorContainer without an overlay.
 */
export class ResultViewer {
	private offset = 0;
	private lines: string[] = [];
	private pageSize = 12;

	constructor(
		private tui: any,
		private theme: any,
		private title: string,
		private body: string,
		private done: () => void,
	) {}

	invalidate() {}

	handleInput(data: string) {
		if (matchesKey(data, 'escape') || matchesKey(data, 'enter')) {
			this.done();
			return;
		}
		const delta = matchesKey(data, 'down') ? 1 : matchesKey(data, 'up') ? -1 : matchesKey(data, 'pageDown') ? this.pageSize : matchesKey(data, 'pageUp') ? -this.pageSize : 0;
		this.offset = Math.max(0, Math.min(Math.max(0, this.lines.length - this.pageSize), this.offset + delta));
		this.tui.requestRender();
	}

	render(width: number): string[] {
		width = Math.max(1, width);
		this.pageSize = Math.max(3, Math.min(14, (this.tui.terminal?.rows ?? 24) - 7));
		this.lines = this.body.split('\n').flatMap((line) => wrapTextWithAnsi(clean(line), width));

		const out: string[] = [];
		out.push(bold(this.theme, paint(this.theme, 'accent', `📄 ${clean(this.title)}`)));
		out.push(paint(this.theme, 'muted', '─'.repeat(Math.min(width, 80))));

		const slice = this.lines.slice(this.offset, this.offset + this.pageSize);
		for (const line of slice) out.push(line);
		for (let i = slice.length; i < Math.min(this.pageSize, 4); i++) out.push('');

		out.push(paint(this.theme, 'muted', '─'.repeat(Math.min(width, 80))));
		const scroll = `(${Math.min(this.lines.length, this.offset + this.pageSize)}/${this.lines.length})`;
		out.push(paint(this.theme, 'muted', `↑↓ / PgUp PgDn scroll · Enter/Esc return   ${scroll}`));

		return out.map((line) => truncateToWidth(line, width));
	}
}
