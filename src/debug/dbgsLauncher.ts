/**
 * Поиск и запуск dbgs.exe (сервер отладки 1С).
 * Используется расширением при активации и при необходимости — отладчиком для file-based ИБ.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Ищет каталог версии платформы (точное совпадение или префикс 8.3.27.xxxx).
 */
export function findVersionDirectory(rootPath: string, v8version: string): string | undefined {
	const directMatch = path.join(rootPath, v8version);
	if (fs.existsSync(directMatch) && fs.statSync(directMatch).isDirectory()) {
		return directMatch;
	}

	const versionDirectories = fs
		.readdirSync(rootPath, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.startsWith(`${v8version}.`))
		.map((entry) => entry.name)
		.sort((left, right) => right.localeCompare(left));

	if (versionDirectories.length === 0) {
		return undefined;
	}

	return path.join(rootPath, versionDirectories[0]);
}

function uniqueExistingDirectories(candidates: Array<string | undefined>): string[] {
	const existing = candidates.filter((candidate): candidate is string => {
		if (!candidate) {
			return false;
		}
		return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
	});
	return [...new Set(existing)];
}

/**
 * Возвращает путь к dbgs.exe для указанной версии платформы.
 */
export function resolveDbgsPath(v8version: string, configuredRoot?: string): string | undefined {
	const roots = uniqueExistingDirectories([
		configuredRoot,
		process.env.V8_PLATFORM_ROOT,
		process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, '1cv8') : undefined,
		process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], '1cv8') : undefined,
	]);

	for (const root of roots) {
		const matchedVersionFolder = findVersionDirectory(root, v8version);
		if (!matchedVersionFolder) {
			continue;
		}

		const dbgsCandidates = [
			path.join(matchedVersionFolder, 'bin', 'dbgs.exe'),
			path.join(matchedVersionFolder, 'dbgs.exe'),
		];

		for (const candidatePath of dbgsCandidates) {
			if (fs.existsSync(candidatePath)) {
				return candidatePath;
			}
		}
	}

	return undefined;
}

export interface LaunchDbgsOptions {
	debugServer: string;
	portRange: string;
	ownerPid: number;
	notifyFilePath: string;
}

/**
 * Запускает dbgs.exe. Возвращает процесс; не ждёт notify-файл.
 */
export function launchDbgsProcess(
	dbgsPath: string,
	options: LaunchDbgsOptions,
): ChildProcess {
	return spawn(dbgsPath, [
		`--addr=${options.debugServer}`,
		`--portRange=${options.portRange}`,
		`--ownerPID=${options.ownerPid}`,
		`--notify=${options.notifyFilePath}`,
	], {
		windowsHide: true,
		stdio: 'ignore',
	});
}
