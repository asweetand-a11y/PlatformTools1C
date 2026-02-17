/**
 * Запуск толстого клиента 1С (1cv8c.exe) с ключами отладки /DEBUG -http -attach и /DEBUGGERURL.
 * Подключение к ИБ — только из параметра ibconnection (например "/F./build/ib").
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveDbgsPath } from './dbgsLauncher';

const EXE_NAME = process.platform === 'win32' ? '1cv8c.exe' : '1cv8c';

/**
 * Возвращает каталог платформы (bin), в котором лежат dbgs и 1cv8c.
 */
export function resolvePlatformBin(v8version: string, configuredRoot?: string): string | undefined {
	const dbgsPath = resolveDbgsPath(v8version, configuredRoot);
	if (!dbgsPath) {
		return undefined;
	}
	const binDir = path.dirname(dbgsPath);
	const exePath = path.join(binDir, EXE_NAME);
	return fs.existsSync(exePath) ? binDir : undefined;
}

export interface Launch1cv8cOptions {
	debuggerUrl: string;
	/** Строка подключения из env --ibconnection, например "/F./build/ib". */
	ibConnection?: string;
	/** Имя информационной базы из env --infoBase, например "Информационная база #2". */
	infoBase?: string;
	/** Корень workspace для разрешения относительных путей в /F. */
	workspaceRoot?: string;
	dbUser?: string;
	dbPwd?: string;
}

/** Если ibconnection — файловая ИБ (/F или File=), возвращает абсолютный путь. Только workspaceRoot (папка проекта), без process.cwd(). */
function resolveFileIbPath(ibconnection: string | undefined, workspaceRoot: string): string | undefined {
	if (!ibconnection || !workspaceRoot) return undefined;
	const s = ibconnection.trim();
	const fileMatch = /^\/F(?:ile)?=(.+)$/i.exec(s) ?? /^File=(.+)$/i.exec(s);
	if (fileMatch) {
		const raw = fileMatch[1].trim();
		return path.isAbsolute(raw) ? raw : path.resolve(workspaceRoot, raw);
	}
	const m = /^\/F\s*(.+)$/i.exec(s);
	if (m) {
		const raw = m[1].trim();
		return path.isAbsolute(raw) ? raw : path.resolve(workspaceRoot, raw);
	}
	return undefined;
}

/**
 * Собирает аргументы для 1cv8c: только файловая ИБ — подставляем /F и полный путь; иначе строка из env как есть (уже с /S и т.д.).
 */
function build1cv8cArgs(options: Launch1cv8cOptions): string[] {
	const args: string[] = [];
	const conn = options.ibConnection?.trim();
	const root = options.workspaceRoot ?? '';

	if (conn) {
		const filePath = resolveFileIbPath(conn, root);
		if (filePath) {
			args.push('/F', filePath);
		} else {
			args.push(conn);
		}
	}
	if (options.dbUser) args.push('/N', options.dbUser);
	if (options.dbPwd) args.push('/P', options.dbPwd);
	if (options.infoBase) args.push('/IBName', options.infoBase);
	args.push(
		'/TComp', '-SDC',
		'/DisableStartupMessages',
		'/DisplayPerfomance',
		'/TechnicalSpecialistMode',
		'/EnableCheckModal',
		'/EnableCheckExtensionsAndAddInsSyncCalls',
		'/DEBUG', '-http', '-attach',
		'/DEBUGGERURL', options.debuggerUrl,
		'/O', 'Normal',
	);
	return args;
}

/**
 * Возвращает строку команды для лога (exe + аргументы; аргументы с пробелами в кавычках).
 */
export function format1cv8cCommandLine(platformBin: string, options: Launch1cv8cOptions): string {
	const exePath = path.join(platformBin, EXE_NAME);
	const args = build1cv8cArgs(options);
	const quoted = args.map((a) => (a.includes(' ') || a.includes('"') ? `"${a.replace(/"/g, '\\"')}"` : a));
	return [exePath, ...quoted].join(' ');
}

/**
 * Запускает 1cv8c.exe. Подключение к ИБ только из ibconnection (например "/F./build/ib").
 */
export function launch1cv8c(platformBin: string, options: Launch1cv8cOptions): ChildProcess {
	const exePath = path.join(platformBin, EXE_NAME);
	const args = build1cv8cArgs(options);

	const proc = spawn(exePath, args, {
		windowsHide: true,
		stdio: 'ignore',
	});
	return proc;
}

/** @deprecated Используйте ibConnection + workspaceRoot в launch1cv8c. */
export function resolveIbPathFromConnection(
	ibconnection: string | undefined,
	workspaceRoot: string,
): string | undefined {
	return resolveFileIbPath(ibconnection, workspaceRoot);
}
