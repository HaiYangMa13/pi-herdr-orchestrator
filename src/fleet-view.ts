import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export type Row = { mark: string; state: string; label: string; def: string; dur: string; flags: string };

const colors: Record<string, string> = {
	running: 'accent',
	starting: 'accent',
	blocked: 'warning',
	done: 'success',
	failed: 'error',
	spawn_failed: 'error',
	timeout: 'error',
	no_result: 'error',
	closed: 'muted',
};

const status: Record<string, string> = {
	running: 'running',
	starting: 'starting',
	blocked: 'blocked',
	done: 'done',
	failed: 'failed',
	spawn_failed: 'spawn failed',
	timeout: 'timeout',
	no_result: 'no result',
	closed: 'closed',
};

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const clean = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, '');

const pad = (text: string, width: number): string => {
	const w = visibleWidth(text);
	return text + ' '.repeat(Math.max(0, width - w));
};

const fit = (text: string, n: number): string => {
	const clipped = truncateToWidth(clean(text), n);
	return clipped + ' '.repeat(Math.max(0, n - visibleWidth(clipped)));
};

export class FleetView {
	rows: Row[] = [];
	summary = '';
	tui: any;
	theme: any;
	private animTimer: any = null;

	invalidate() {}

	dispose() {
		if (this.animTimer) {
			clearInterval(this.animTimer);
			this.animTimer = null;
		}
	}

	render(width: number): string[] {
		width = Math.max(1, width);
		const paint = (color: string, text: string) => (this.theme?.fg ? this.theme.fg(color, text) : text);
		const bold = (text: string) => (typeof this.theme?.bold === 'function' ? this.theme.bold(text) : text);

		const hasActive = this.rows.some((r) => r.state === 'running' || r.state === 'starting');
		if (hasActive) {
			if (!this.animTimer && this.tui) {
				this.animTimer = setInterval(() => {
					const stillActive = this.rows.some((r) => r.state === 'running' || r.state === 'starting');
					if (!stillActive) {
						clearInterval(this.animTimer);
						this.animTimer = null;
					}
					this.tui?.requestRender?.();
				}, 100);
			}
		} else if (this.animTimer) {
			clearInterval(this.animTimer);
			this.animTimer = null;
		}

		if (width < 25) {
			const minimal = this.rows.map((r) => `${r.mark} ${truncateToWidth(r.label, width - 2)}`);
			return minimal.map((l) => truncateToWidth(l, width));
		}

		const innerW = width - 4;
		const out: string[] = [];

		// Header border: ╭─ Tasks ────────────────────── 0 running · 1 blocked · 1 done ─╮
		const titleStr = ' Tasks ';
		const summaryStr = this.summary ? ` ${this.summary} ` : '';
		const leftTop = '╭─' + titleStr;
		const rightTop = summaryStr ? summaryStr + '─╮' : '─╮';
		const dashes = Math.max(0, width - visibleWidth(leftTop) - visibleWidth(rightTop));
		out.push(
			paint('border', '╭─') +
				bold(paint('text', titleStr)) +
				paint('border', '─'.repeat(dashes)) +
				(summaryStr ? paint('muted', summaryStr) : '') +
				paint('border', rightTop.endsWith('─╮') && summaryStr ? '─╮' : rightTop),
		);

		const spinnerChar = SPINNER_FRAMES[Math.floor(Date.now() / 100) % SPINNER_FRAMES.length];

		// Item rows
		for (const row of this.rows) {
			const isSpinner = row.state === 'running' || row.state === 'starting';
			const markChar = isSpinner ? spinnerChar : row.mark;
			const mark = paint(colors[row.state] ?? 'muted', markChar);

			const labelW = Math.max(8, Math.min(22, Math.floor(innerW * 0.35)));
			const label = paint('text', fit(row.label, labelW));

			const role = row.def && width >= 60 ? `${paint('syntaxType', fit(row.def, 9))} ` : '';
			const dur = width >= 45 ? `${paint('muted', fit(row.dur, 6))} ` : '';

			const desc =
				row.flags === '/herdr'
					? paint('muted', '+N more')
					: paint(colors[row.state] ?? 'muted', status[row.state] ?? row.state);

			const content = `${mark} ${label} ${role}${dur}${desc}`;
			const rowLine = pad(' ' + content, innerW);
			out.push(paint('border', '│ ') + rowLine + paint('border', ' │'));
		}

		// Bottom border
		out.push(paint('border', '╰' + '─'.repeat(Math.max(0, width - 2)) + '╯'));

		return out.map((line) => truncateToWidth(line, width));
	}
}
