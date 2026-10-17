export interface IndicatorTask {
	id: string;
	name: string;
	status: string;
	startTime: number;
}

/** A bounded idle-state indicator; terminal jobs never look active. */
export function backgroundTaskIndicator(tasks: readonly IndicatorTask[], now = Date.now()): string[] | undefined {
	const running = tasks.filter((task) => task.status === "running");
	if (running.length === 0) return undefined;
	const lines = [`▶ 백그라운드 실행 중 ${running.length}개`];
	for (const task of running.slice(0, 3)) {
		const seconds = Math.max(0, Math.floor((now - task.startTime) / 1000));
		const name = task.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
		const id = task.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12);
		lines.push(`  ${name} [${id}] ${Math.floor(seconds / 60)}분 ${seconds % 60}초`);
	}
	if (running.length > 3) lines.push(`  외 ${running.length - 3}개 실행 중`);
	return lines;
}
