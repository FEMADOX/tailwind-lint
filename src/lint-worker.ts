import { parentPort, workerData } from "node:worker_threads";
import { initializeState, processFiles } from "./file-processor";
import type { LintFileResult } from "./types";
import type { WorkerInput, WorkerMessage } from "./worker-pool";

async function run() {
	const { cwd, fix, verbose, tasks } = workerData as WorkerInput;
	const initialized = [];
	for (const task of tasks) {
		initialized.push({
			...task,
			state: await initializeState(cwd, task.target, verbose),
		});
	}
	const start = new Promise<void>((resolve) =>
		parentPort!.once("message", () => resolve()),
	);
	parentPort!.postMessage({ type: "ready" } satisfies WorkerMessage);
	await start;
	const files: LintFileResult[] = [];
	for (const task of initialized) {
		files.push(
			...(await processFiles(
				task.state,
				cwd,
				task.files,
				fix,
				(_current, _total, file) => {
					parentPort!.postMessage({
						type: "progress",
						file,
					} satisfies WorkerMessage);
				},
			)),
		);
	}
	parentPort!.postMessage({ type: "result", files } satisfies WorkerMessage);
	parentPort!.close();
}

void run();
