/**
 * Извлечение имён переменных из процедуры/функции BSL по номеру строки.
 * Используется как fallback для панели VARIABLES, когда evalLocalVariables возвращает пустой список.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Регулярное выражение: присваивание переменной (идентификатор 1С: буквы, цифры, подчёркивание). */
const VAR_ASSIGN_RE = /^\s*([А-Яа-яёЁA-Za-z_][А-Яа-яёЁ\w]*)\s*=/;

/**
 * Возвращает имена переменных, объявленных/присваиваемых в процедуре или функции BSL,
 * в которой находится указанная строка.
 * @param filePath - абсолютный или относительный путь к файлу модуля
 * @param lineNo - номер строки (1-based), по которой определяется процедура
 * @param rootProject - корень проекта для разрешения относительного пути
 * @returns массив уникальных имён переменных в порядке первого появления
 */
export async function getVariableNamesFromProcedureAtLine(
	filePath: string,
	lineNo: number,
	rootProject: string,
): Promise<string[]> {
	const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(rootProject, filePath);
	let text: string;
	try {
		text = await fs.readFile(fullPath, 'utf8');
	} catch {
		return [];
	}
	const lines = text.split(/\r?\n/);
	const lineIndex = Math.max(0, lineNo - 1);
	let procStart = -1;
	let procEnd = -1;
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (/^\s*(Процедура|Функция)\s+/i.test(trimmed)) {
			procStart = i;
			procEnd = -1;
		} else if (/^\s*Конец(Процедуры|Функции)\s*$/i.test(trimmed) && procStart >= 0) {
			procEnd = i;
			if (lineIndex >= procStart && lineIndex <= procEnd) break;
			procStart = -1;
		}
	}
	if (procStart < 0 || procEnd < 0 || lineIndex < procStart || lineIndex > procEnd) {
		return [];
	}
	const seen = new Set<string>();
	const names: string[] = [];
	for (let i = procStart; i <= procEnd; i++) {
		const match = lines[i].match(VAR_ASSIGN_RE);
		if (match && !seen.has(match[1])) {
			seen.add(match[1]);
			names.push(match[1]);
		}
	}
	return names;
}
