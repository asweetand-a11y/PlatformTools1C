/**
 * Команда «Показать значение в отдельном окне» для коллекций в панели переменных отладчика.
 * Открывает WebviewPanel с табличным представлением элементов коллекции (структуры, массивы, таблицы значений и т.д.).
 */

import * as vscode from 'vscode';

interface DebugVariable {
	name: string;
	value: string;
	type?: string;
	variablesReference?: number;
	evaluateName?: string;
}

interface DebugVariableContainer {
	name?: string;
	variablesReference?: number;
}

/** Макс. глубина — защита от иных рекурсивных структур. */
const FETCH_VARIABLE_TREE_MAX_DEPTH = 12;

/** Рекурсивно получает дочерние переменные. Цепочки .Ссылка.Ссылка, .Родитель.Родитель — не шлём повторный запрос. */
async function fetchVariableTree(
	session: vscode.DebugSession,
	variablesReference: number,
	prefix: string,
	depth = 0,
): Promise<Array<{ name: string; value: string; type: string; path: string }>> {
	const result = await session.customRequest('variables', { variablesReference });
	const vars = (result as { variables?: DebugVariable[] }).variables ?? [];
	const rows: Array<{ name: string; value: string; type: string; path: string }> = [];
	const atMaxDepth = depth >= FETCH_VARIABLE_TREE_MAX_DEPTH;
	for (const v of vars) {
		const path = prefix ? `${prefix}.${v.name}` : v.name;
		const displayValue = atMaxDepth && v.variablesReference ? `${v.value} …` : v.value;
		rows.push({ name: v.name, value: displayValue, type: v.type ?? '', path });
		// Триггер рекурсии: последний сегмент пути совпадает с именем дочернего узла (...,X + X → повтор).
		// Работает для любых имён (Ссылка, Родитель, Владелец и т.д.) без привязки к конкретным значениям.
		const lastSegment = prefix.split('.').pop() ?? '';
		const isStructuralRecursion = lastSegment !== '' && lastSegment === v.name;
		if (v.variablesReference && v.variablesReference > 0 && !isStructuralRecursion && !atMaxDepth) {
			const nested = await fetchVariableTree(session, v.variablesReference, path, depth + 1);
			rows.push(...nested);
		}
	}
	return rows;
}

/** Преобразует collectionRows в плоский список строк (fallback для buildHtml). */
function collectionRowsToTableRows(
	prefix: string,
	collectionRows: Array<{ index: number; cells: Array<{ name: string; value: string; typeName?: string }> }>,
): Array<{ name: string; value: string; type: string; path: string }> {
	const rows: Array<{ name: string; value: string; type: string; path: string }> = [];
	for (const row of collectionRows) {
		for (const cell of row.cells) {
			rows.push({
				name: cell.name,
				value: cell.value,
				type: cell.typeName ?? '',
				path: `${prefix}[${row.index}].${cell.name}`,
			});
		}
	}
	return rows;
}

/** Строит HTML для табличного представления коллекции (колонки как заголовки). */
function buildCollectionHtml(
	title: string,
	typeName: string,
	collectionRows: Array<{ index: number; cells: Array<{ name: string; value: string; typeName?: string }> }>,
): string {
	const escape = (s: string) =>
		s
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	const columns = collectionRows[0]?.cells.map((c) => c.name) ?? [];
	const headerCells = ['Индекс', ...columns].map((h) => `<th>${escape(h)}</th>`).join('');
	const dataRows = collectionRows
		.map(
			(r) =>
				`<tr><td>${r.index}</td>${r.cells.map((c) => `<td>${escape(c.value)}</td>`).join('')}</tr>`,
		)
		.join('');
	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<style>
		body { font-family: var(--vscode-font-family); font-size: 13px; padding: 12px; color: var(--vscode-foreground); }
		table { border-collapse: collapse; width: 100%; }
		th, td { border: 1px solid var(--vscode-panel-border); padding: 6px 10px; text-align: left; }
		th { background: var(--vscode-editor-inactiveSelectionBackground); }
		tr:nth-child(even) { background: var(--vscode-editor-inactiveSelectionBackground); opacity: 0.5; }
		h2 { margin-top: 0; }
		.count { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 8px; }
	</style>
</head>
<body>
	<h2>${escape(title)}</h2>
	<div class="count">Количество элементов: ${collectionRows.length}${typeName ? ` | Тип: ${escape(typeName)}` : ''}</div>
	<table>
		<thead><tr>${headerCells}</tr></thead>
		<tbody>${dataRows}</tbody>
	</table>
</body>
</html>`;
}

/** Открывает окно с содержимым переменной. Вызов из панели переменных (context.variable) или из редактора (выделенный текст). */
export async function showVariableInWindow(
	context: { variable: DebugVariable; container: DebugVariableContainer } | undefined,
): Promise<void> {
	const session = vscode.debug.activeDebugSession;
	if (!session || session.type !== 'onec') {
		vscode.window.showWarningMessage('Нет активной сессии отладки 1С');
		return;
	}

	let expression: string;
	const variable = context?.variable;
	if (variable) {
		expression = variable.evaluateName ?? variable.name;
	} else {
		// Вызов из редактора: использовать выделенный текст
		const editor = vscode.window.activeTextEditor;
		const selection = editor?.selection;
		const text = selection && !selection.isEmpty
			? editor.document.getText(selection)
			: editor?.document.getText(editor.document.getWordRangeAtPosition(editor.selection.active));
		if (!text?.trim()) {
			vscode.window.showWarningMessage('Выделите имя переменной в редакторе или выберите переменную в панели переменных');
			return;
		}
		expression = text.trim();
	}
	if (!expression) {
		vscode.window.showWarningMessage('Не удалось определить выражение переменной');
		return;
	}

	try {
		const threads = await session.customRequest('threads');
		const threadList = (threads as { threads?: Array<{ id: number }> }).threads ?? [];
		const threadId = threadList[0]?.id ?? 1;

		const stack = await session.customRequest('stackTrace', { threadId });
		const frames = (stack as { stackFrames?: Array<{ id: number }> }).stackFrames ?? [];
		const frameId = frames[0]?.id ?? 0;

		// Для коллекций — запрос 1c/evaluateCollection (строки/пары Ключ-Значение).
		// ВременнаяТаблицаЗапроса — исключена (строки не вычисляем, зацикливание)
		const isCollectionType = (t: string) =>
			/ТаблицаЗначений|Массив|Структура|Соответствие|СписокЗначений|Коллекция|МенеджерВременныхТаблиц|ВременныеТаблицыЗапроса/i.test(t ?? '');
		let typeName = variable?.type ?? '';
		let collectionData: { collectionRows?: Array<{ index: number; cells: Array<{ name: string; value: string; typeName?: string }> }> } | null = null;

		// Если тип неизвестен (вызов из редактора) — сначала evaluate для определения типа.
		// context: 'repl' — синхронный eval, без evalExprWatchAndInvalidate и InvalidatedEvent
		if (!typeName && !variable) {
			try {
				const prelim = await session.customRequest('evaluate', { expression, frameId, context: 'repl' });
				typeName = (prelim as { type?: string }).type ?? '';
			} catch {
				// игнорируем
			}
		}
		if (isCollectionType(typeName)) {
			const useEnum = /Структура|Соответствие/i.test(typeName);
			// МенеджерВременныхТаблиц: коллекция в свойстве .Таблицы
			const collExpr = /МенеджерВременныхТаблиц/i.test(typeName) && !/\.Таблицы\b/.test(expression)
				? `${expression}.Таблицы`
				: expression;
			try {
				const collRes = await session.customRequest('1c/evaluateCollection', {
					expression: collExpr,
					frameId,
					interfaceType: useEnum ? 'enum' : 'collection',
				});
				const body = (collRes as { typeName?: string; collectionRows?: unknown[] }) ?? {};
				if (Array.isArray(body.collectionRows) && body.collectionRows.length > 0) {
					collectionData = { collectionRows: body.collectionRows as Array<{ index: number; cells: Array<{ name: string; value: string; typeName?: string }> }> };
					typeName = body.typeName ?? typeName;
				}
			} catch {
				// fallback к evaluate + variables
			}
		}

		let rows: Array<{ name: string; value: string; type: string; path: string }>;
		if (collectionData?.collectionRows && collectionData.collectionRows.length > 0) {
			rows = collectionRowsToTableRows(expression, collectionData.collectionRows);
		} else {
			// context: 'repl' — синхронный eval, иначе watch даёт «Неопределено» + фоновый eval + InvalidatedEvent → лишние запросы
			const evalResult = await session.customRequest('evaluate', {
				expression,
				frameId,
				context: 'repl',
			});
			const res = evalResult as { result?: string; variablesReference?: number; type?: string };
			typeName = res.type ?? typeName;
			if (res.variablesReference && res.variablesReference > 0) {
				rows = await fetchVariableTree(session, res.variablesReference, expression);
			} else {
				rows = [{ name: expression, value: res.result ?? variable?.value ?? '', type: typeName, path: expression }];
			}
		}

		const panel = vscode.window.createWebviewPanel(
			'1cVariableWindow',
			`${expression} (${typeName || 'значение'})`,
			vscode.ViewColumn.Beside,
			{ enableScripts: true },
		);

		panel.webview.html = collectionData?.collectionRows
			? buildCollectionHtml(expression, typeName, collectionData.collectionRows)
			: buildHtml(expression, typeName, rows);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Ошибка получения значения: ${msg}`);
	}
}

function buildHtml(
	title: string,
	typeName: string,
	rows: Array<{ name: string; value: string; type: string; path: string }>,
): string {
	const escape = (s: string) =>
		s
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	const rowsHtml = rows
		.map(
			(r) =>
				`<tr><td>${escape(r.path)}</td><td>${escape(r.value)}</td><td>${escape(r.type)}</td></tr>`,
		)
		.join('');

	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<style>
		body { font-family: var(--vscode-font-family); font-size: 13px; padding: 12px; color: var(--vscode-foreground); }
		table { border-collapse: collapse; width: 100%; }
		th, td { border: 1px solid var(--vscode-panel-border); padding: 6px 10px; text-align: left; }
		th { background: var(--vscode-editor-inactiveSelectionBackground); }
		tr:nth-child(even) { background: var(--vscode-editor-inactiveSelectionBackground); opacity: 0.5; }
		h2 { margin-top: 0; }
		.count { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 8px; }
	</style>
</head>
<body>
	<h2>${escape(title)}</h2>
	<div class="count">Количество элементов: ${rows.length}${typeName ? ` | Тип: ${escape(typeName)}` : ''}</div>
	<table>
		<thead><tr><th>Имя / Путь</th><th>Значение</th><th>Тип</th></tr></thead>
		<tbody>${rowsHtml}</tbody>
	</table>
</body>
</html>`;
}
