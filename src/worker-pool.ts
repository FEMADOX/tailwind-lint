import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type { LintFileResult, LintOptions } from "./types";
import type { TailwindConfigTarget } from "./utils/config";

export interface WorkerTask {
	target: TailwindConfigTarget;
	files: string[];
}

export interface WorkerInput {
	cwd: string;
	fix: boolean;
	verbose: boolean;
	tasks: WorkerTask[];
}

export type WorkerMessage =
	| { type: "ready" }
	| { type: "progress"; file: string }
	| { type: "result"; files: LintFileResult[] };

export async function processWithWorkers(
	options: Pick<LintOptions, "cwd" | "fix" | "verbose" | "onProgress">,
	tasks: WorkerTask[],
	concurrency: number,
) {
	const total = tasks.reduce((count, task) => count + task.files.length, 0);
	const count = Math.min(concurrency, total);
	const workloads: WorkerTask[][] = Array.from({ length: count }, () => []);
	let nextWorker = 0;
	for (const task of tasks) {
		const partitions: string[][] = Array.from({ length: count }, () => []);
		for (const file of task.files) {
			partitions[nextWorker++ % count].push(file);
		}
		for (const [index, files] of partitions.entries()) {
			if (files.length > 0)
				workloads[index].push({ target: task.target, files });
		}
	}

	const workers: Worker[] = [];
	let ready = 0;
	let processed = 0;
	let stopping = false;
	try {
		const results = await Promise.all(
			workloads.map(
				(tasks) =>
					new Promise<LintFileResult[]>((resolve, reject) => {
						const worker = new Worker(path.join(__dirname, "lint-worker.cjs"), {
							workerData: {
								cwd: options.cwd,
								fix: options.fix ?? false,
								verbose: options.verbose ?? false,
								tasks,
							} satisfies WorkerInput,
							stdout: true,
							stderr: true,
						});
						workers.push(worker);
						// Plugin and adapter logs must not corrupt JSON stdout.
						worker.stdout.pipe(process.stderr);
						worker.stderr.pipe(process.stderr);
						let completed = false;
						worker.on("message", (message: WorkerMessage) => {
							if (stopping) return;
							if (message.type === "ready") {
								// Load every config before any worker can fix a CSS config file.
								if (++ready === count) {
									for (const initialized of workers)
										initialized.postMessage("start");
								}
							} else if (message.type === "result") {
								completed = true;
								resolve(message.files);
							} else {
								try {
									options.onProgress?.(++processed, total, message.file);
								} catch (error) {
									reject(error);
								}
							}
						});
						worker.once("error", reject);
						worker.once("messageerror", reject);
						worker.once("exit", (code) => {
							if (!completed) {
								reject(
									new Error(
										`Lint worker exited before completing (code ${code}).`,
									),
								);
							}
						});
					}),
			),
		);
		return results.flat();
	} finally {
		stopping = true;
		await Promise.all(workers.map((worker) => worker.terminate()));
	}
}
