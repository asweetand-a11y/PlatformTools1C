/**
 * Панель «Выражение» — вычисление произвольных выражений в контексте отладки.
 * Ввод выражения, кнопка «Рассчитать», вывод результата (Свойство, Значение, Тип).
 */

import * as vscode from 'vscode';

interface DebugVariable {
	name: string;
	value: string;
	type?: string;
	variablesReference?: number;
}

/** Макс. глубина рекурсии при получении дочерних переменных. */
const FETCH_VARIABLE_TREE_MAX_DEPTH = 12;

/** Триггер рекурсии: последний сегмент пути совпадает с именем дочернего узла. */
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
		const lastSegment = prefix.split('.').pop() ?? '';
		const isStructuralRecursion = lastSegment !== '' && lastSegment === v.name;
		if (v.variablesReference && v.variablesReference > 0 && !isStructuralRecursion && !atMaxDepth) {
			const nested = await fetchVariableTree(session, v.variablesReference, path, depth + 1);
			rows.push(...nested);
		}
	}
	return rows;
}

const isCollectionType = (t: string) =>
	/ТаблицаЗначений|Массив|Структура|Соответствие|СписокЗначений|Коллекция|МенеджерВременныхТаблиц|ВременныеТаблицыЗапроса/i.test(
		t ?? '',
	);

/** Вычисляет выражение и возвращает строки для таблицы (путь, значение, тип). */
async function evaluateExpression(
	session: vscode.DebugSession,
	expression: string,
): Promise<Array<{ name: string; value: string; type: string }>> {
	const threads = await session.customRequest('threads');
	const threadList = (threads as { threads?: Array<{ id: number }> }).threads ?? [];
	const threadId = threadList[0]?.id ?? 1;
	const stack = await session.customRequest('stackTrace', { threadId });
	const frames = (stack as { stackFrames?: Array<{ id: number }> }).stackFrames ?? [];
	const frameId = frames[0]?.id ?? 0;

	const evalResult = await session.customRequest('evaluate', {
		expression,
		frameId,
		context: 'repl',
	});
	const res = evalResult as { result?: string; variablesReference?: number; type?: string };
	const typeName = res.type ?? '';

	// Коллекции — 1c/evaluateCollection для строк/элементов (ТаблицаЗначений, Структура и т.д.)
	if (isCollectionType(typeName)) {
		const useEnum = /Структура|Соответствие/i.test(typeName);
		const collExpr =
			/МенеджерВременныхТаблиц/i.test(typeName) && !/\.Таблицы\b/.test(expression)
				? `${expression}.Таблицы`
				: expression;
		try {
			const collRes = await session.customRequest('1c/evaluateCollection', {
				expression: collExpr,
				frameId,
				interfaceType: useEnum ? 'enum' : 'collection',
			});
			const body = (collRes as { collectionRows?: Array<{ index: number; cells: Array<{ name: string; value: string; typeName?: string }> }> }) ?? {};
			if (Array.isArray(body.collectionRows) && body.collectionRows.length > 0) {
				const rows: Array<{ name: string; value: string; type: string }> = [];
				for (const row of body.collectionRows) {
					const summary = row.cells.map((c) => `${c.name}=${c.value}`).join(', ');
					rows.push({
						name: `[${row.index}]`,
						value: summary,
						type: 'СтрокаТаблицыЗначений',
					});
				}
				return rows;
			}
		} catch {
			// fallback — используем variablesReference ниже
		}
	}

	// Объекты с дочерними свойствами — fetchVariableTree
	if (res.variablesReference && res.variablesReference > 0) {
		const rows = await fetchVariableTree(session, res.variablesReference, expression);
		return rows.map((r) => ({ name: r.path, value: r.value, type: r.type }));
	}

	return [{ name: expression, value: res.result ?? '', type: typeName }];
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

interface TreeNode {
	key: string;
	name: string;
	value: string;
	type: string;
	children: TreeNode[];
}

/** Строит дерево из плоского списка путей. */
function buildTree(rows: Array<{ name: string; value: string; type: string }>, rootExpression: string): TreeNode {
	const byPath = new Map<string, TreeNode>();
	const root: TreeNode = { key: rootExpression, name: rootExpression, value: '', type: '', children: [] };
	byPath.set(rootExpression, root);

	// Сортировка: более короткие пути первыми
	const sorted = [...rows].sort((a, b) => a.name.length - b.name.length);

	for (const r of sorted) {
		const path = r.name;
		const segments = path.split('.');
		const displayName = segments.pop() ?? path;
		const parentPath = segments.join('.');

		const node: TreeNode = {
			key: path,
			name: displayName,
			value: r.value,
			type: r.type,
			children: [],
		};
		byPath.set(path, node);

		const parent = parentPath ? byPath.get(parentPath) : root;
		if (parent) {
			parent.children.push(node);
		} else {
			root.children.push(node);
		}
	}

	return root;
}

function renderTreeHtml(node: TreeNode, depth: number): string {
	const hasChildren = node.children.length > 0;
	const indent = depth * 16;
	const valueType = [node.value, node.type].filter(Boolean).join('  ');
	const toggle = hasChildren
		? `<span class="toggle" role="button" tabindex="0" aria-expanded="false">▶</span>`
		: '<span class="no-toggle"></span>';

	const childrenHtml = hasChildren
		? `<div class="tree-children collapsed">${node.children.map((c) => renderTreeHtml(c, depth + 1)).join('')}</div>`
		: '';

	return `
		<div class="tree-node" data-key="${escapeHtml(node.key)}">
			<div class="tree-row" style="padding-left: ${indent}px">
				${toggle}
				<span class="name">${escapeHtml(node.name)}</span>
				${valueType ? `<span class="value-type">${escapeHtml(valueType)}</span>` : ''}
			</div>
			${childrenHtml}
		</div>`;
}

function buildResultHtml(rows: Array<{ name: string; value: string; type: string }>, expression: string): string {
	// Проверяем, есть ли иерархия (пути с точкой)
	const hasHierarchy = rows.some((r) => r.name.includes('.'));
	if (!hasHierarchy || rows.length <= 1) {
		// Плоский вывод для коллекций и примитивов
		const rowsHtml = rows
			.map((r) => `<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.value)}</td><td>${escapeHtml(r.type)}</td></tr>`)
			.join('');
		return `
		<div class="result-section">
			<div class="count">Элементов: ${rows.length}</div>
			<table>
				<thead><tr><th>Свойство</th><th>Значение</th><th>Тип</th></tr></thead>
				<tbody>${rowsHtml}</tbody>
			</table>
		</div>`;
	}

	const tree = buildTree(rows, expression);
	const treeHtml =
		tree.children.length > 0
			? tree.children.map((c) => renderTreeHtml(c, 0)).join('')
			: `<div class="tree-row"><span class="no-toggle"></span><span class="name">${escapeHtml(expression)}</span><span class="value-type">(пусто)</span></div>`;

	return `
	<div class="result-section tree-view">
		<div class="count">Элементов: ${rows.length}</div>
		<div class="tree-container" id="treeRoot">${treeHtml}</div>
	</div>`;
}

function getPanelHtml(expression: string, resultHtml: string | null, error?: string): string {
	const resultOrError = error
		? `<div class="error">${escapeHtml(error)}</div>`
		: resultHtml ?? '<div class="hint">Введите выражение и нажмите «Рассчитать»</div>';
	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<style>
		body { font-family: var(--vscode-font-family); font-size: 13px; padding: 16px; color: var(--vscode-foreground); }
		.input-row { display: flex; gap: 8px; align-items: center; margin-bottom: 16px; }
		label { font-weight: 500; white-space: nowrap; }
		input { flex: 1; padding: 6px 10px; font-family: inherit; }
		button { padding: 6px 16px; cursor: pointer; }
		table { border-collapse: collapse; width: 100%; margin-top: 8px; }
		th, td { border: 1px solid var(--vscode-panel-border); padding: 6px 10px; text-align: left; }
		th { background: var(--vscode-editor-inactiveSelectionBackground); }
		tr:nth-child(even) { background: var(--vscode-editor-inactiveSelectionBackground); opacity: 0.5; }
		.result-section { margin-top: 16px; }
		.count { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 8px; }
		.error { color: var(--vscode-errorForeground); margin-top: 12px; }
		.hint { color: var(--vscode-descriptionForeground); margin-top: 12px; }
		.tree-view .tree-container { font-family: var(--vscode-editor-font-family); }
		.tree-view .tree-node { display: block; }
		.tree-view .tree-row { display: flex; align-items: baseline; gap: 8px; padding: 2px 0; line-height: 1.4; }
		.tree-view .tree-row:hover { background: var(--vscode-list-hoverBackground); }
		.tree-view .toggle { cursor: pointer; width: 16px; flex-shrink: 0; user-select: none; font-size: 10px; }
		.tree-view .no-toggle { width: 16px; flex-shrink: 0; display: inline-block; }
		.tree-view .name { flex-shrink: 0; font-weight: 500; }
		.tree-view .value-type { color: var(--vscode-descriptionForeground); word-break: break-all; }
		.tree-view .tree-children { margin-left: 4px; }
		.tree-view .tree-children.collapsed { display: none; }
	</style>
</head>
<body>
	<h2>Выражение</h2>
	<div class="input-row">
		<label for="expr">Выражение:</label>
		<input type="text" id="expr" value="${escapeHtml(expression)}" placeholder="Запрос.МенеджерВременныхТаблиц.Таблицы[0]" />
		<button id="calc">Рассчитать</button>
	</div>
	<div class="result-area">${resultOrError}</div>
	<script>
		const vscode = acquireVsCodeApi();
		const exprInput = document.getElementById('expr');
		const calcBtn = document.getElementById('calc');
		const resultArea = document.querySelector('.result-area');
		calcBtn.addEventListener('click', () => {
			const expr = exprInput.value.trim();
			if (!expr) return;
			calcBtn.disabled = true;
			resultArea.innerHTML = '<div class="hint">Вычисление…</div>';
			vscode.postMessage({ command: 'calculate', expression: expr });
		});
		window.addEventListener('message', (e) => {
			const msg = e.data;
			if (msg.type === 'result') {
				resultArea.innerHTML = msg.html;
			} else if (msg.type === 'error') {
				resultArea.innerHTML = '<div class="error">' + (msg.message || 'Ошибка') + '</div>';
			}
			calcBtn.disabled = false;
		});
		resultArea.addEventListener('click', (e) => {
			const btn = e.target.closest && e.target.closest('.toggle');
			if (!btn) return;
			const node = btn.closest('.tree-node');
			const children = node && node.querySelector(':scope > .tree-children');
			if (!children) return;
			const collapsed = children.classList.toggle('collapsed');
			btn.textContent = collapsed ? '▶' : '▼';
			btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
		});
	</script>
</body>
</html>`;
}

let currentPanel: vscode.WebviewPanel | undefined;

/** Открывает панель вычисления выражений. */
export function openCalculateExpressionPanel(): void {
	const session = vscode.debug.activeDebugSession;
	if (!session || session.type !== 'onec') {
		vscode.window.showWarningMessage('Нет активной сессии отладки 1С. Запустите отладку перед использованием.');
		return;
	}

	const column = vscode.ViewColumn.Beside;
	if (currentPanel) {
		currentPanel.reveal(column);
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		'1cCalculateExpression',
		'Выражение',
		column,
		{ enableScripts: true },
	);

	currentPanel = panel;
	let lastExpression = '';

	panel.webview.html = getPanelHtml(lastExpression, null);

	panel.webview.onDidReceiveMessage(async (msg) => {
		if (msg.command !== 'calculate' || !msg.expression?.trim()) return;
		const expression = String(msg.expression).trim();
		lastExpression = expression;
		try {
			const rows = await evaluateExpression(session, expression);
			const html = buildResultHtml(rows, expression);
			panel.webview.postMessage({ type: 'result', html });
		} catch (err) {
			const msg2 = err instanceof Error ? err.message : String(err);
			panel.webview.postMessage({ type: 'error', message: msg2 });
		}
	});

	panel.onDidDispose(() => {
		currentPanel = undefined;
	});
}
