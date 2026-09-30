#!/usr/bin/env bun

import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";

const agentDir = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(agentDir, "..", "..");
const sdkVersion = "18.4.2";
const nativeFilename = "pi_natives.linux-x64-baseline.node";
const target = "bun-linux-x64-baseline" as const;
const sdkNames = ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-natives", "pi-tui", "pi-utils", "omp-stats", "pi-natives-linux-x64"] as const;
const bundledPackages = [
	{ name: "pi-agent-core", binding: "AgentCore" },
	{ name: "pi-ai", binding: "Ai", shim: "legacy-pi-ai-shim.ts" },
	{ name: "pi-coding-agent", binding: "CodingAgent", shim: "legacy-pi-coding-agent-shim.ts" },
	{ name: "pi-natives", binding: "Natives" },
	{ name: "pi-tui", binding: "Tui", shim: "legacy-pi-tui-shim.ts" },
	{ name: "pi-utils", binding: "Utils" },
] as const;

interface SdkPackage {
	name: string;
	root: string;
	exports?: Record<string, unknown>;
}

function parseArgs(argv: string[]): string {
	let outDir: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const [flag, inline] = argv[i]!.split("=", 2);
		if (flag !== "--out-dir" && flag !== "--target") throw new Error(`Unknown option: ${argv[i]}`);
		const value = inline ?? argv[++i];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
		if (flag === "--target") {
			if (value !== "linux-x64" && value !== target) throw new Error(`Unsupported target ${value}: only Linux x64 baseline is packaged`);
		} else {
			if (outDir !== undefined) throw new Error("--out-dir must be specified only once");
			outDir = value;
		}
	}
	if (!outDir) throw new Error("Usage: bun packages/agent/scripts/build-native.ts --out-dir <path> [--target linux-x64]");
	if (process.platform !== "linux" || process.arch !== "x64") {
		throw new Error(`Linux x64 host required for the packaged native addon; got ${process.platform}-${process.arch}`);
	}
	return path.resolve(outDir);
}

async function installedSdk(): Promise<Map<string, SdkPackage>> {
	const packages = new Map<string, SdkPackage>();
	for (const name of sdkNames) {
		const root = path.join(agentDir, "node_modules", "@oh-my-pi", name);
		const manifestPath = path.join(root, "package.json");
		let manifest: { name?: string; version?: string; exports?: Record<string, unknown> };
		try {
			manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		} catch (cause) {
			throw new Error(`Required SDK package missing or invalid: ${manifestPath} (run bun install --frozen-lockfile in packages/agent)`, { cause });
		}
		if (manifest.name !== `@oh-my-pi/${name}` || manifest.version !== sdkVersion) {
			throw new Error(`SDK mismatch at ${manifestPath}: expected @oh-my-pi/${name}@${sdkVersion}, got ${manifest.name}@${manifest.version}`);
		}
		packages.set(name, { name: manifest.name, root, exports: manifest.exports });
	}
	return packages;
}

function importTarget(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && "import" in value && typeof value.import === "string") return value.import;
	return undefined;
}

function bindingFor(identifier: string, subpath: string): string {
	return `bundled${identifier}${subpath.split("/").filter(Boolean).map(segment => segment.split(/[-_]/).filter(Boolean).map(part => part[0]!.toUpperCase() + part.slice(1)).join("")).join("")}`;
}

// Mirrors the upstream SDK's legacy-pi-virtual-module.ts, but resolves package
// exports against the installed npm packages rather than a monorepo checkout.
async function legacyModuleSource(packages: Map<string, SdkPackage>): Promise<string> {
	const entries = new Map<string, { binding: string; specifier: string }>();
	const bindings = new Set<string>();
	function add(key: string, binding: string, specifier: string): void {
		if (entries.has(key)) return;
		if (bindings.has(binding)) throw new Error(`Duplicate legacy Pi module binding ${binding} for ${key}`);
		bindings.add(binding);
		entries.set(key, { binding, specifier });
	}
	const coding = packages.get("pi-coding-agent")!;
	const shim = (file: string) => path.join(coding.root, "src", "extensibility", file);
	for (const info of bundledPackages) {
		const pkg = packages.get(info.name)!;
		const rootTarget = importTarget(pkg.exports?.["."]);
		if (!rootTarget?.startsWith("./")) throw new Error(`Missing root import export for ${pkg.name}`);
		const rootShim = "shim" in info ? shim(info.shim) : path.join(pkg.root, rootTarget.slice(2));
		if ("shim" in info && !(await Bun.file(rootShim).exists())) throw new Error(`Missing SDK legacy extension shim: ${rootShim}`);
		add(pkg.name, `bundled${info.binding}`, rootShim);
		for (const [key, value] of Object.entries(pkg.exports ?? {})) {
			if (!key.startsWith("./") || key.includes("*")) continue;
			const source = importTarget(value);
			if (!source?.startsWith("./")) throw new Error(`Missing import export ${pkg.name}/${key}`);
			const subpath = key.slice(2);
			add(`${pkg.name}/${subpath}`, bindingFor(info.binding, subpath), path.join(pkg.root, source.slice(2)));
		}
		for (const [key, value] of Object.entries(pkg.exports ?? {})) {
			if (!key.startsWith("./") || !key.includes("*")) continue;
			const source = importTarget(value);
			if (!source?.startsWith("./") || (key.match(/\*/g)?.length !== 1) || (source.match(/\*/g)?.length !== 1)) continue;
			const [exportPrefix, exportSuffix] = key.slice(2).split("*") as [string, string];
			const [sourcePrefix, sourceSuffix] = source.slice(2).split("*") as [string, string];
			if (!exportPrefix || !/\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(sourceSuffix)) continue;
			const sourceDir = path.join(pkg.root, sourcePrefix);
			let matches: string[] = [];
			try {
				matches = await Array.fromAsync(new Bun.Glob(`**/*${sourceSuffix}`).scan({ cwd: sourceDir, onlyFiles: true }));
			} catch (cause) {
				throw new Error(`Cannot enumerate SDK exports in ${sourceDir}`, { cause });
			}
			for (const match of matches.sort()) {
				if (!match.endsWith(sourceSuffix)) continue;
				const stem = match.slice(0, -sourceSuffix.length).split(path.sep).join("/");
				const parts = stem.split("/");
				const basename = parts.at(-1)!;
				if (parts.some(part => part.startsWith(".") || part.startsWith("_"))) continue;
				if (basename === "index" || basename === "worker-entry" || /\.(?:test|spec|d|generated|bench)$/.test(basename)) continue;
				const subpath = `${exportPrefix}${stem}${exportSuffix}`;
				add(`${pkg.name}/${subpath}`, bindingFor(info.binding, subpath), path.join(sourceDir, match));
			}
		}
	}
	const typebox = shim("legacy-typebox.ts");
	if (!(await Bun.file(typebox).exists())) throw new Error(`Missing SDK legacy extension shim: ${typebox}`);
	add("typebox", "bundledTypeBoxShim", typebox);
	return [
		...Array.from(entries.values(), ({ binding, specifier }) => `const ${binding} = () => import(${JSON.stringify(specifier)});`),
		"export const BUNDLED_PI_MODULE_LOADERS = {",
		...Array.from(entries, ([key, { binding }]) => `\t${JSON.stringify(key)}: ${binding},`),
		"};",
	].join("\n");
}

function assertBuild(result: Bun.BuildOutput, label: string): void {
	if (!result.success) throw new Error(`${label} failed:\n${result.logs.map(log => log.message).join("\n")}`);
}

async function statsArchive(pkg: SdkPackage): Promise<string> {
	const clientDir = path.join(pkg.root, "dist", "client");
	const files: Record<string, Uint8Array> = {};
	const entries = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: clientDir, onlyFiles: true }));
	for (const entry of entries.sort()) {
		const name = entry.split(path.sep).join("/");
		files[name] = new Uint8Array(await Bun.file(path.join(clientDir, entry)).arrayBuffer());
	}
	for (const name of ["index.html", "index.js", "index.css"]) {
		if (!files[name]?.length) throw new Error(`Published SDK stats client is missing ${name} in ${clientDir}`);
	}
	const bytes = await new Bun.Archive(files, { compress: "gzip" }).bytes();
	if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error("Stats frontend archive is not gzip");
	return Buffer.from(bytes).toString("base64");
}

async function compile(name: string, entry: string, outDir: string, plugins: Bun.BunPlugin[]): Promise<void> {
	if (!(await Bun.file(entry).exists())) throw new Error(`Missing agent entrypoint: ${entry}`);
	const outfile = path.join(outDir, name);
	const result = await Bun.build({
		entrypoints: [entry],
		root: repoRoot,
		format: "esm",
		plugins,
		define: { "process.env.PI_COMPILED": JSON.stringify("true") },
		compile: {
			target,
			outfile,
			autoloadBunfig: false,
			autoloadDotenv: false,
			autoloadTsconfig: false,
			autoloadPackageJson: false,
		},
		throw: false,
	});
	assertBuild(result, `${name} binary build`);
	if (!(await Bun.file(outfile).exists())) throw new Error(`Bun did not write compiled executable: ${outfile}`);
	console.log(`Built ${outfile}`);
}

async function main(): Promise<void> {
	const outDir = parseArgs(Bun.argv.slice(2));
	const packages = await installedSdk();
	const addonPath = path.join(packages.get("pi-natives-linux-x64")!.root, nativeFilename);
	const statsGeneratedPath = path.join(packages.get("omp-stats")!.root, "src", "embedded-client.generated.txt");
	const noticesPath = path.join(packages.get("pi-natives-linux-x64")!.root, "THIRD-PARTY-NOTICES.txt");
	for (const file of [addonPath, statsGeneratedPath, noticesPath, path.join(repoRoot, "LICENSE")]) {
		if (!(await Bun.file(file).exists()) || (await stat(file)).size === 0 && file !== statsGeneratedPath) {
			throw new Error(`Required native distribution asset missing or empty: ${file}`);
		}
	}
	const registry = await legacyModuleSource(packages);
	const archive = await statsArchive(packages.get("omp-stats")!);
	const plugins: Bun.BunPlugin[] = [{
		name: "agent-native-sdk-assets",
		setup(build) {
			build.onResolve({ filter: /^omp-legacy-pi-modules$/ }, () => ({ path: "omp-legacy-pi-modules", namespace: "agent-legacy-pi" }));
			build.onLoad({ filter: /.*/, namespace: "agent-legacy-pi" }, () => ({ contents: registry, loader: "ts" }));
			build.onLoad({ filter: /embedded-client\.generated\.txt$/ }, args => {
				if (path.resolve(args.path) !== statsGeneratedPath) throw new Error(`Unexpected stats archive import: ${args.path}`);
				return { contents: archive, loader: "text" };
			});
		},
	}];
	const entries = [
		["omp-hub-agent", path.join(agentDir, "src", "main.ts")],
		["omp-hub-agent-session", path.join(agentDir, "src", "session-host.ts")],
		["omp-hub-agent-stats", path.join(packages.get("omp-stats")!.root, "src", "index.ts")],
		["omp-hub-agent-subscriptions", path.join(agentDir, "src", "subscriptions-worker.ts")],
		["omp-hub-agent-sql-query", path.join(agentDir, "src", "sql-query-worker.ts")],
	] as const;
	await mkdir(outDir, { recursive: true });
	for (const [name, source] of entries) await compile(name, source, outDir, plugins);
	await copyFile(addonPath, path.join(outDir, nativeFilename));
	await copyFile(path.join(repoRoot, "LICENSE"), path.join(outDir, "LICENSE"));
	await copyFile(noticesPath, path.join(outDir, "THIRD-PARTY-NOTICES.txt"));
	const licenseDir = path.join(outDir, "licenses");
	await mkdir(licenseDir, { recursive: true });
	for (const name of sdkNames) {
		const source = path.join(packages.get(name)!.root, "LICENSE");
		if (!(await Bun.file(source).exists())) throw new Error(`Required SDK license missing: ${source}`);
		await copyFile(source, path.join(licenseDir, `${name}-LICENSE`));
	}
	console.log(`Packaged SDK ${sdkVersion} native addon, LICENSE and THIRD-PARTY-NOTICES.txt in ${outDir}`);
}

if (import.meta.main) {
	main().catch(error => {
		console.error("Native agent build failed:", error);
		process.exitCode = 1;
	});
}
