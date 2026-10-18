import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { LintOptions, LintResult } from "../src/types";

const root = path.resolve(__dirname, "..");
const cli = path.join(root, "dist", "cli.cjs");
const linter = path.join(root, "dist", "linter.cjs");
const require = createRequire(import.meta.url);
const temporaryProjects: string[] = [];
let lint: (options: LintOptions) => Promise<LintResult>;

function project(version: "v3" | "v4", files: Record<string, string> = {}) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tailwind-concurrency-"));
	temporaryProjects.push(cwd);
	const fixture = path.join(__dirname, "fixtures", version);
	fs.mkdirSync(path.join(cwd, "src"));
	fs.copyFileSync(
		path.join(fixture, "package.json"),
		path.join(cwd, "package.json"),
	);
	fs.mkdirSync(path.join(cwd, "node_modules"));
	// Resolve pnpm's relative package symlink before linking from a temp directory.
	fs.symlinkSync(
		fs.realpathSync(path.join(fixture, "node_modules", "tailwindcss")),
		path.join(cwd, "node_modules", "tailwindcss"),
		process.platform === "win32" ? "junction" : "dir",
	);
	const configPath = path.join(
		cwd,
		version === "v3" ? "tailwind.config.js" : "src/app.css",
	);
	fs.writeFileSync(
		configPath,
		version === "v3"
			? "module.exports = { content: ['./src/**/*.html'], theme: {}, plugins: [] };\n"
			: '@import "tailwindcss";\n',
	);
	for (const [name, content] of Object.entries(files)) {
		fs.writeFileSync(path.join(cwd, "src", name), content);
	}
	return { cwd, configPath, patterns: ["src/**/*.html"], autoDiscover: false };
}

function runCli(cwd: string, args: string[], timeout = 20_000) {
	const result = spawnSync(process.execPath, [cli, ...args], {
		cwd,
		encoding: "utf8",
		timeout,
		env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
	});
	expect(result.error).toBeUndefined();
	expect(result.signal).toBeNull();
	return result;
}

describe("packaged worker concurrency", () => {
	beforeAll(() => {
		execSync("pnpm build", { cwd: root, stdio: "pipe", timeout: 60_000 });
		lint = require(linter).lint;
	}, 70_000);

	afterEach(() => {
		for (const cwd of temporaryProjects.splice(0)) {
			// Only remove exact directories returned by mkdtemp, including their junctions.
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it.each(["v3", "v4"] as const)(
		"returns the same sorted diagnostics with one or two workers for %s",
		async (version) => {
			const options = project(version, {
				"z.html": '<div class="block flex"></div>\n',
				"a.html": '<div class="text-left text-center"></div>\n',
				"clean.html": '<div class="p-4"></div>\n',
			});
			const serial = await lint({ ...options, concurrency: 1 });
			const parallel = await lint({ ...options, concurrency: 2 });
			expect(parallel).toEqual(serial);
			expect(parallel.files).toHaveLength(2);
			expect(parallel.files.every((file) => file.diagnostics.length > 0)).toBe(
				true,
			);
			expect(parallel.files.map((file) => file.path)).toEqual([
				path.join("src", "a.html"),
				path.join("src", "z.html"),
			]);
			expect(parallel.totalFilesProcessed).toBe(version === "v4" ? 4 : 3);
		},
	);

	it("keeps each package's theme when workers process multiple config targets", async () => {
		const html = '<div class="text-[var(--color-brand)]"></div>\n';
		const { cwd } = project("v4", { "a.html": html, "b.html": html });
		const nested = path.join(cwd, "packages", "brand");
		fs.mkdirSync(path.join(nested, "src"), { recursive: true });
		fs.writeFileSync(path.join(nested, "package.json"), '{"type":"module"}\n');
		fs.writeFileSync(
			path.join(nested, "src", "app.css"),
			'@import "tailwindcss";\n@theme { --color-brand: red; }\n',
		);
		for (const name of ["a.html", "b.html"]) {
			fs.writeFileSync(path.join(nested, "src", name), html);
		}
		const options = { cwd, patterns: ["**/*.html"], autoDiscover: false };
		const serial = await lint({ ...options, concurrency: 1 });
		const parallel = await lint({ ...options, concurrency: 2 });
		expect(parallel).toEqual(serial);
		expect(parallel.totalFilesProcessed).toBe(6);
		expect(parallel.files).toHaveLength(4);
		for (const file of parallel.files) {
			const suggestion = file.path.startsWith(`packages${path.sep}`)
				? "`text-brand`"
				: "`text-(--color-brand)`";
			expect(
				file.diagnostics.some(({ message }) => message.endsWith(suggestion)),
			).toBe(true);
		}
	});

	it("produces identical fixed bytes and leaves a second parallel fix unchanged", async () => {
		const files = {
			"z.html": '<div class="p-[16px] w-[200px] top-[60px]">Z</div>\n',
			"a.html":
				'<div class="max-w-[780px] bg-[var(--app-bg-primary)]">A</div>\n',
		};
		const serialOptions = project("v4", files);
		const parallelOptions = project("v4", files);
		const serial = await lint({ ...serialOptions, concurrency: 1, fix: true });
		const parallel = await lint({
			...parallelOptions,
			concurrency: 2,
			fix: true,
		});
		expect(parallel).toEqual(serial);
		expect(parallel.files).toHaveLength(2);
		expect(
			parallel.files.every((file) => file.fixed && file.fixedCount! > 0),
		).toBe(true);
		const fixedBytes = Object.keys(files).map((name) => {
			const actual = fs.readFileSync(
				path.join(parallelOptions.cwd, "src", name),
			);
			expect(actual).toEqual(
				fs.readFileSync(path.join(serialOptions.cwd, "src", name)),
			);
			expect(actual.toString()).not.toBe(files[name as keyof typeof files]);
			return actual;
		});
		const rerun = await lint({ ...parallelOptions, concurrency: 2, fix: true });
		expect(rerun.files).toEqual([]);
		for (const [index, name] of Object.keys(files).entries()) {
			expect(
				fs.readFileSync(path.join(parallelOptions.cwd, "src", name)),
			).toEqual(fixedBytes[index]);
		}
	});

	it("deduplicates overlapping patterns and reports each completion exactly once", async () => {
		const options = project("v4", {
			"a.html": '<div class="block flex"></div>\n',
			"b.html": '<div class="hidden block"></div>\n',
			"c.html": '<div class="text-left text-center"></div>\n',
		});
		const progress: Array<{ current: number; total: number; file: string }> =
			[];
		const result = await lint({
			...options,
			patterns: ["src/**/*.html", "src/a.html", "src/*", "src/app.css"],
			concurrency: 2,
			onProgress: (current, total, file) =>
				progress.push({ current, total, file }),
		});
		expect(result.totalFilesProcessed).toBe(4);
		expect(result.files).toHaveLength(3);
		expect(progress.map(({ current }) => current)).toEqual([1, 2, 3, 4]);
		expect(progress.every(({ total }) => total === 4)).toBe(true);
		expect(new Set(progress.map(({ file }) => file)).size).toBe(4);
		expect(progress.map(({ file }) => file).sort()).toEqual(
			["a.html", "app.css", "b.html", "c.html"]
				.map((name) => path.join("src", name))
				.sort(),
		);
	});

	it("returns an empty result without progress for an empty file set", async () => {
		const options = project("v3");
		const progress: string[] = [];
		await expect(
			lint({
				...options,
				concurrency: 2,
				onProgress: (_current, _total, file) => progress.push(file),
			}),
		).resolves.toEqual({ files: [], totalFilesProcessed: 0, skippedFiles: [] });
		expect(progress).toEqual([]);
	});

	it.each([0, -1, 1.5, NaN, Infinity, "2", "invalid"])(
		"rejects invalid API concurrency %s before processing files",
		async (concurrency) => {
			const options = project("v3");
			await expect(
				lint({ ...options, concurrency } as LintOptions),
			).rejects.toThrow(/concurrency/i);
		},
	);

	it.each(["0", "-1", "1.5", "NaN", "Infinity", "invalid"])(
		"rejects invalid CLI concurrency %s",
		(concurrency) => {
			const options = project("v3");
			const result = runCli(options.cwd, [
				"--concurrency",
				concurrency,
				"--format",
				"json",
			]);
			expect(result.status).not.toBe(0);
			expect(result.stderr + result.stdout).toMatch(/concurrency/i);
		},
	);

	it("supports numeric and auto concurrency in the built CLI", () => {
		const options = project("v4", {
			"a.html": '<div class="block flex"></div>\n',
			"b.html": '<div class="hidden block"></div>\n',
		});
		const args = [
			"src/**/*.html",
			"--config",
			options.configPath,
			"--format",
			"json",
		];
		const serial = runCli(options.cwd, args);
		const parallel = runCli(options.cwd, [...args, "--concurrency", "2"]);
		const automatic = runCli(options.cwd, [...args, "--concurrency", "auto"]);
		const output = JSON.parse(serial.stdout);
		expect(output.error).toBeUndefined();
		expect(output.summary.totalFilesProcessed).toBe(3);
		expect(output.files).toHaveLength(2);
		expect(
			output.files.every(
				(file: { diagnostics: unknown[] }) => file.diagnostics.length > 0,
			),
		).toBe(true);
		expect(parallel.status).toBe(serial.status);
		expect(automatic.status).toBe(serial.status);
		expect(JSON.parse(parallel.stdout)).toEqual(output);
		expect(JSON.parse(automatic.stdout)).toEqual(output);
	});

	it("keeps the default serial and starts two real Node worker threads when requested", () => {
		const options = project("v3", {
			"a.html": '<div class="block flex"></div>\n',
			"b.html": '<div class="hidden block"></div>\n',
		});
		expect(fs.existsSync(path.join(root, "dist", "lint-worker.cjs"))).toBe(
			true,
		);
		const script = `
const threads = require('node:worker_threads');
const NativeWorker = threads.Worker;
const started = [];
threads.Worker = class extends NativeWorker {
  constructor(...args) {
    super(...args);
    this.once('online', () => started.push(this.threadId));
  }
};
(async () => {
  const { lint } = require(${JSON.stringify(linter)});
  await lint(${JSON.stringify(options)});
  const defaultWorkers = started.length;
  const result = await lint(${JSON.stringify({ ...options, concurrency: 2 })});
  console.log(JSON.stringify({ defaultWorkers, started, total: result.totalFilesProcessed }));
})().catch(error => { console.error(error); process.exitCode = 1; });
`;
		const result = spawnSync(process.execPath, ["-e", script], {
			cwd: options.cwd,
			encoding: "utf8",
			timeout: 20_000,
		});
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		const output = JSON.parse(result.stdout);
		expect(output.defaultWorkers).toBe(0);
		expect(output.total).toBe(2);
		expect(new Set(output.started).size).toBe(2);
		expect(output.started.every((id: number) => id > 0)).toBe(true);
	});

	it("exits after worker initialization fails instead of leaving idle workers alive", () => {
		const options = project("v3", {
			"a.html": '<div class="block flex"></div>\n',
			"b.html": '<div class="hidden block"></div>\n',
		});
		fs.writeFileSync(
			options.configPath,
			"throw new Error('worker-init-sentinel');\n",
		);
		const script = `
require(${JSON.stringify(linter)}).lint(${JSON.stringify({ ...options, concurrency: 2 })})
  .then(() => { console.error('unexpected success'); process.exitCode = 2; })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
`;
		const result = spawnSync(process.execPath, ["-e", script], {
			cwd: options.cwd,
			encoding: "utf8",
			timeout: 15_000,
		});
		expect(result.error).toBeUndefined();
		expect(result.signal).toBeNull();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("worker-init-sentinel");
	});

	it("terminates successful workers even when a config leaves a timer active", () => {
		const options = project("v3", {
			"a.html": '<div class="block flex"></div>\n',
			"b.html": '<div class="hidden block"></div>\n',
		});
		fs.writeFileSync(
			options.configPath,
			"if (!require('node:worker_threads').isMainThread) setInterval(() => {}, 1000);\nmodule.exports = { content: ['./src/**/*.html'] };\n",
		);
		const script = `
require(${JSON.stringify(linter)}).lint(${JSON.stringify({ ...options, concurrency: 2 })})
  .then(result => console.log(JSON.stringify({ total: result.totalFilesProcessed })))
  .catch(error => { console.error(error); process.exitCode = 1; });
`;
		const result = spawnSync(process.execPath, ["-e", script], {
			cwd: options.cwd,
			encoding: "utf8",
			timeout: 15_000,
		});
		expect(result.error).toBeUndefined();
		expect(result.signal).toBeNull();
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ total: 2 });
	});

	it("rejects a throwing progress callback and terminates the remaining workers", () => {
		const options = project("v3", {
			"a.html": '<div class="block flex"></div>\n',
			"b.html": '<div class="hidden block"></div>\n',
		});
		const script = `
const options = ${JSON.stringify({ ...options, concurrency: 2 })};
options.onProgress = () => { throw new Error('progress-sentinel'); };
require(${JSON.stringify(linter)}).lint(options)
  .then(() => { console.error('unexpected success'); process.exitCode = 2; })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
`;
		const result = spawnSync(process.execPath, ["-e", script], {
			cwd: options.cwd,
			encoding: "utf8",
			timeout: 15_000,
		});
		expect(result.error).toBeUndefined();
		expect(result.signal).toBeNull();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("progress-sentinel");
	});
});
