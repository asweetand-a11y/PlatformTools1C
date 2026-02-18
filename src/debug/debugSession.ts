/**
 * DAP DebugSession для 1C:Enterprise.
 * Обрабатывает initialize, launch, attach, disconnect; остальное — заглушки для MVP.
 */

import {
	DebugSession,
	InitializedEvent,
	InvalidatedEvent,
	OutputEvent,
	Source,
	StackFrame,
	StoppedEvent,
	Thread,
	ThreadEvent,
} from '@vscode/debugadapter';
import type { DebugProtocol } from '@vscode/debugprotocol';
import type { ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { getLastDbgsLaunch } from './dbgsLaunchInfo';
import { format1cv8cCommandLine, launch1cv8c, resolvePlatformBin } from './launch1cv8c';
import { getVariableNamesFromProcedureAtLine } from './bslProcedureVariables';
import { mapBaseBreakpointToExtensionLines } from './bslModuleStructure';
import { getExtensionVersionHash, getExtendingModules, getModuleInfoByPath, getModulePathByModuleIdStr, getModulePathByObjectProperty } from './metadataProvider';
import { getDebugTimingConfig } from './debugTimingConfig';
import { RdbgClient } from './rdbgClient';
import {
	AttachDebugUiResult,
	getAttachResultMessage,
	type CallStackFormedResult,
	type DebugTargetId,
	type DebugStepAction,
	type EvalExprResult,
	type ExprEvaluatedStore,
	type ModuleBpInfoForRequest,
	type BreakpointInfoRdbg,
	type StackItemViewInfoData,
} from './rdbgTypes';
import { References } from './references';

/** Получать локальные переменные с сервера RDBG. false — снимает нагрузку на сервер отладки (evalLocalVariables не вызывается). */
const FETCH_LOCAL_VARIABLES = false;

export interface OnecLaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	request: 'launch' | 'attach';
	debugServerHost?: string;
	debugServerPort?: number;
	/** Строка подключения к ИБ из env.json (--ibconnection), например "/F./build/ib". */
	ibconnection?: string;
	/** Алиас ИБ для RDBG (DefAlias для файловой). */
	infoBaseAlias?: string;
	/** Имя/алиас ИБ для RDBG (env --infoBase), например "Информационная база #2". */
	infoBase?: string;
	dbUser?: string;
	dbPwd?: string;
	rootProject?: string;
	platformPath?: string;
	platformVersion?: string;
	extensions?: string[];
	autoAttachTypes?: string[];
}

/** Аргументы setBreakpoints по одному источнику (как в onec-debug-adapter _moduleSetBreakpointsArguments). */
interface StoredBreakpoints {
	source: DebugProtocol.Source;
	breakpoints: DebugProtocol.SourceBreakpoint[];
}

/** Отображаемое имя типа цели в Call Stack (перевод на русский). */
const TARGET_TYPE_LABELS: Record<string, string> = {
	ServerEmulation: 'Сервер (файловый режим)',
	ManagedClient: 'Клиент (менеджер)',
	Client: 'Клиент',
	WebClient: 'Веб-клиент',
	MobileClient: 'Мобильный клиент',
	Server: 'Сервер',
	MobileServer: 'Мобильный сервер',
};

function getTargetTypeDisplayName(targetType: string): string {
	const t = (targetType ?? '').trim();
	const label = TARGET_TYPE_LABELS[t];
	return label !== undefined ? label : t;
}

/** Client→Client,ManagedClient,WebClient; Server→Server,ServerEmulation. */
function matchesAutoAttachType(targetType: string, autoAttachTypes: string[]): boolean {
	const t = targetType.trim();
	for (const a of autoAttachTypes) {
		const type = a.trim();
		if (type === t) return true;
		if (type === 'Client' && /^(Client|ManagedClient|WebClient|MobileClient)$/i.test(t)) return true;
		if (type === 'Server' && /^(Server|ServerEmulation|MobileServer)$/i.test(t)) return true;
	}
	return false;
}

/** Строка пригодна для отображения как имя источника (модуль/процедура). Отсекает бинарные/некорректные значения, из-за которых IDE показывает "Could not load source '@мусор'". */
function isSafeSourceDisplayName(s: string | undefined): boolean {
	if (s == null || typeof s !== 'string') return false;
	const t = s.trim();
	if (t.length === 0 || t.length > 512) return false;
	// Запрет управляющих символов, null, и строк из одних непечатаемых
	for (let i = 0; i < t.length; i++) {
		const code = t.charCodeAt(i);
		if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return false;
	}
	// Должен быть хотя бы один символ, подходящий для имени (буква, цифра, точка, кириллица)
	return /[\u0400-\u04FFa-zA-Z0-9.]/.test(t);
}

export class OnecDebugSession extends DebugSession {
	private rdbgClient: RdbgClient | undefined;
	/** Идентификатор сеанса отладчика (UUID), генерируется при создании сессии и передаётся в RDBG как idOfDebuggerUI при attachDebugUI. */
	private debuggerId: string;
	/** Алиас ИБ для RDBG (из launch.json infoBaseAlias или DefAlias). */
	private rdbgInfoBaseAlias = 'DefAlias';
	/** Корень проекта (workspace) для маппинга путей к модулям. */
	private rootProject: string;
	private attached: boolean;
	private targets: DebugTargetId[];
	/** Все модули с точками останова: при setBreakpoints в RDBG отправляется полный bpWorkspace (как в onec-debug-adapter). */
	private readonly moduleBreakpoints = new Map<string, StoredBreakpoints>();
	/** Кэш стека вызовов по threadId (из CallStackFormed). Порядок: root → current (как в onec-debug-adapter). */
	private readonly threadsCallStack = new Map<number, StackItemViewInfoData[]>();
	/** Управление ссылками на фреймы и переменные для DAP. */
	private readonly references = new References();
	/** Кэш результатов evalExpr по ключу targetId:frameIndex:expression. При пустом ответе сервера (данные не изменились) отдаём из кэша. */
	private readonly evalExprCache = new Map<string, { result: string; typeName?: string; children?: EvalExprResult['children']; variablesRef: number }>();
	/** exprEvaluated из pollPing для variablesRequest (race: pollPing и retry evalLocalVariables конкурируют за ping). */
	private readonly exprEvaluatedStore = new Map<string, EvalExprResult>();
	/** rteProcVersion по targetId (из rtgt pingDBGTGT) для RemoteDebuggerRunTime. */
	private readonly rteProcVersionByTargetId = new Map<string, string>();
	/** Время последнего pingDBGTGT по targetId — троттлинг, чтобы не дергать rtgt каждые 50 мс (расход памяти dbgs). */
	private readonly lastPingDbgtgtByTargetId = new Map<string, number>();
	/** bpVersion из ответа setBreakpoints (для RemoteDebuggerRunTime). */
	private lastBpVersion: string | undefined;
	private pingTimerId: ReturnType<typeof setTimeout> | undefined;
	private pingCount = 0;
	/** Таймеры отложенного getCallStack после Step (F10/F11/Shift+F11). */
	private readonly pendingStackRefreshTimeouts = new Map<number, ReturnType<typeof setTimeout>>();
	/** ID таймеров scheduleImmediatePingForCallStack — отменяем при первом callStackFormed, чтобы не дублировать обработку. */
	private readonly immediatePingTimerIds = new Set<ReturnType<typeof setTimeout>>();
	/** Дедупликация callStackFormed: не обрабатывать повторно, если тот же стек уже обработан недавно. */
	private lastCallStackFormedAt = 0;
	private lastCallStackFormedKey = '';
	/** Дебаунс InvalidatedEvent(['variables']) при exprEvaluated — уменьшает частоту запросов переменных. */
	private exprEvaluatedInvalidateTimer: ReturnType<typeof setTimeout> | undefined;
	/** Дебаунс InvalidatedEvent при обновлении Watch — один событие вместо лавины при множественных выражениях (нагрузка на dbgs). */
	private watchInvalidateTimer: ReturnType<typeof setTimeout> | undefined;
	/** Ограничение конкурентных evalExpr (Watch): при большом числе выражений — распределение по времени, снижение нагрузки на dbgs. */
	private evalExprWatchInFlight = 0;
	/** Время последнего evalExpr по cacheKey — пропуск фонового обновления при недавнем кэше (разрыв цикла переменные→refresh→запросы). */
	private readonly lastEvalExprByCacheKey = new Map<string, number>();
	private autoAttachTypes: string[] = [];
	/** Процесс 1cv8c, запущенный в режиме launch. Нужен для завершения при остановке отладки. */
	private launchedProcess: ChildProcess | undefined;
	/** Настройки таймингов (1c-dev-tools.debug.timings). Загружаются при launch/attach. */
	private timingConfig = getDebugTimingConfig();

	constructor() {
		super();
		this.debuggerId = randomUUID();
		this.rootProject = '';
		this.attached = false;
		this.targets = [];
	}

	/** Кастомный запрос 1c/evaluateCollection — строки коллекции (ТаблицаЗначений и т.д.) для «Показать в отдельном окне». */
	protected override dispatchRequest(request: DebugProtocol.Request): void {
		if (request.command === '1c/evaluateCollection') {
			void this.handleEvaluateCollectionRequest(request);
			return;
		}
		super.dispatchRequest(request);
	}

	private async handleEvaluateCollectionRequest(request: DebugProtocol.Request): Promise<void> {
		const req = request as unknown as { seq?: number };
		const requestSeq = req.seq ?? 0;
		const response: DebugProtocol.Response = {
			type: 'response',
			seq: requestSeq + 1,
			request_seq: requestSeq,
			success: true,
			command: request.command,
		};
		try {
			if (!this.rdbgClient || !this.attached) {
				response.success = false;
				response.message = 'Нет активной сессии отладки';
				this.sendResponse(response);
				return;
			}
			const args = (request.arguments ?? {}) as { expression?: string; frameId?: number; interfaceType?: 'collection' | 'enum' };
			const expression = typeof args.expression === 'string' ? args.expression.trim() : '';
			const interfaceType = args.interfaceType ?? 'collection';
			if (!expression) {
				response.success = false;
				response.message = 'Не указано выражение';
				this.sendResponse(response);
				return;
			}
			// МенеджерВременныхТаблиц.Таблицы.[N] — не вычислять строки внутри временной таблицы (зацикливание)
			if (/\.Таблицы\.\[\d+\]/.test(expression)) {
				response.body = { typeName: '', collectionRows: [], collectionSize: 0 };
				this.sendResponse(response);
				return;
			}
			const frameId = args.frameId ?? 0;
			const threadId = frameId >= 10000 ? Math.floor(frameId / 10000) : 1;
			const frameIndex = frameId >= 1000 ? Math.max(0, (frameId % 10000) - 1000) : 0;
			const target = this.targets[threadId - 1] ?? this.targets[0];
			if (!target) {
				response.success = false;
				response.message = 'Нет активной цели отладки';
				this.sendResponse(response);
				return;
			}
			const result =
				interfaceType === 'enum'
					? await this.rdbgClient.evalExprEnum(
							{ infoBaseAlias: this.rdbgInfoBaseAlias, idOfDebuggerUi: this.debuggerId },
							{ id: target.id },
							expression,
							frameIndex,
						)
					: await this.rdbgClient.evalExprCollection(
							{ infoBaseAlias: this.rdbgInfoBaseAlias, idOfDebuggerUi: this.debuggerId },
							{ id: target.id },
							expression,
							frameIndex,
						);
			if (result.error) {
				response.success = false;
				response.message = result.error;
				this.sendResponse(response);
				return;
			}
			response.body = {
				typeName: result.typeName,
				collectionRows: result.collectionRows,
				collectionSize: result.collectionSize,
				result: result.result,
			};
		} catch (err) {
			response.success = false;
			response.message = err instanceof Error ? err.message : String(err);
		}
		this.sendResponse(response);
	}

	private static normalizePath(p: string): string {
		return path.resolve(p).replace(/\\/g, '/');
	}

	private getThreadIdByTargetId(targetId: string): number {
		const idx = this.targets.findIndex((t) => t.id === targetId);
		return idx >= 0 ? idx + 1 : 1;
	}

	/**
	 * Подключение к целям отладки (как onec-debug-adapter DebugTargetsManager.AttachDebugTargets).
	 * Вызывает clearBreakOnNextStatement и attachDetachDbgTargets(attach=true).
	 */
	/** Убирает дубликаты целей по id (первое вхождение сохраняется). */
	private deduplicateTargetsById(targets: DebugTargetId[]): DebugTargetId[] {
		const seen = new Set<string>();
		return targets.filter((t) => {
			const id = t.id?.trim() ?? '';
			if (!id || seen.has(id)) return false;
			seen.add(id);
			return true;
		});
	}

	/** targetIDStr для RemoteDebuggerRunTime: только из ответа сервера (getDbgTargets/step), не формировать из id. */
	private getTargetIDStr(target: DebugTargetId): string | undefined {
		return target.targetIDStr && target.targetIDStr.trim() !== '' ? target.targetIDStr : undefined;
	}

	/** Обновляет targetIDStr у целей из ответа step/getDbgTargets (response.item или response.id с targetIDStr). */
	private mergeTargetIDStrFromResponse(response: unknown): void {
		if (!response || typeof response !== 'object') return;
		const r = response as Record<string, unknown>;
		const list = r.item ?? r.id;
		const items = Array.isArray(list) ? list : list != null ? [list] : [];
		for (const it of items) {
			const item = it as Record<string, unknown>;
			const str = item.targetIDStr ?? item.TargetIDStr;
			if (str == null || String(str).trim() === '') continue;
			const targetIdNode = item.targetID ?? item.TargetID;
			const flat = targetIdNode && typeof targetIdNode === 'object' ? (targetIdNode as Record<string, unknown>) : item;
			const id = String(flat.id ?? flat.Id ?? item.id ?? item.Id ?? '');
			if (!id) continue;
			const t = this.targets.find((x) => x.id === id);
			if (t) t.targetIDStr = String(str).trim();
		}
	}

	private async attachToTargets(targets: DebugTargetId[]): Promise<void> {
		if (!this.rdbgClient || targets.length === 0) return;
		const base = { infoBaseAlias: this.rdbgInfoBaseAlias, idOfDebuggerUi: this.debuggerId };
		try {
			await this.rdbgClient.clearBreakOnNextStatement(base);
			await this.rdbgClient.attachDetachDbgTargets(base, { attach: targets.map((t) => t.id), detach: [] });
			for (const t of targets) {
				try {
					await this.rdbgClient.startDBGTGT(base, t.id);
				} catch {
					// игнорируем ошибки startDBGTGT
				}
				const targetIDStr = this.getTargetIDStr(t);
				if (targetIDStr) {
					try {
						await this.rdbgClient.registerRemoteDebuggerRunTime(base, targetIDStr, true);
					} catch {
						// игнорируем ошибки register
					}
				}
			}
			await this.resendBreakpointsToServer();
		} catch {
			// игнорируем ошибки attach
		}
	}

	/** Повторная отправка breakpoints в RDBG при подключении к новым целям (ServerEmulation, ManagedClient и др.). */
	private async resendBreakpointsToServer(): Promise<void> {
		if (!this.rdbgClient || !this.attached || this.moduleBreakpoints.size === 0) return;
		const root = this.rootProject || '';
		const bpWorkspace: ModuleBpInfoForRequest[] = [];
		for (const [, stored] of this.moduleBreakpoints) {
			const p = stored.source.path ?? '';
			const moduleInfo = getModuleInfoByPath(root, p);
			if (!moduleInfo.objectId || !moduleInfo.propertyId) continue;
			const bpInfoRdbg: BreakpointInfoRdbg[] = stored.breakpoints.map((bp) => ({
				line: bp.line,
				isActive: true,
				breakOnCondition: !!bp.condition,
				condition: bp.condition ?? '',
				breakOnHitCount: !!bp.hitCondition,
				hitCount: typeof bp.hitCondition === 'string' && /^\d+$/.test(bp.hitCondition) ? parseInt(bp.hitCondition, 10) : 0,
				showOutputMessage: !!bp.logMessage,
				putExpressionResult: bp.logMessage ?? '',
				continueExecution: !!bp.logMessage,
			}));
			const ext = moduleInfo.extension?.trim() ?? '';
			const version = ext ? getExtensionVersionHash(root, ext) : undefined;
			bpWorkspace.push({
				extension: ext,
				objectId: moduleInfo.objectId,
				propertyId: moduleInfo.propertyId,
				bslModuleType: moduleInfo.bslModuleType,
				moduleIdString: moduleInfo.moduleIdString || undefined,
				bpInfo: bpInfoRdbg,
				...(version && { version }),
			});
			if (!ext && moduleInfo.propertyId === 'a637f77f-3840-441d-a1c3-699c8c5cb7e0') {
				const baseBslPath = path.isAbsolute(p) ? p : path.resolve(root, p);
				for (const extMod of getExtendingModules(root, moduleInfo.objectId)) {
					const extVersion = getExtensionVersionHash(root, extMod.extension);
					const extBpInfo: BreakpointInfoRdbg[] = [];
					for (const bp of stored.breakpoints) {
						const extLines = mapBaseBreakpointToExtensionLines(baseBslPath, bp.line, extMod.bslPath);
						for (const L of extLines) {
							extBpInfo.push({
								line: L,
								isActive: true,
								breakOnCondition: !!bp.condition,
								condition: bp.condition ?? '',
								breakOnHitCount: !!bp.hitCondition,
								hitCount: typeof bp.hitCondition === 'string' && /^\d+$/.test(bp.hitCondition) ? parseInt(bp.hitCondition, 10) : 0,
								showOutputMessage: !!bp.logMessage,
								putExpressionResult: bp.logMessage ?? '',
								continueExecution: !!bp.logMessage,
							});
						}
					}
					if (extBpInfo.length > 0) {
						bpWorkspace.push({
							extension: extMod.extension,
							objectId: extMod.objectId,
							propertyId: extMod.propertyId,
							bslModuleType: 'ObjectModule',
							moduleIdString: undefined,
							bpInfo: extBpInfo,
							...(extVersion && { version: extVersion }),
						});
					}
				}
			}
		}
		if (bpWorkspace.length === 0) return;
		try {
			const res = await this.rdbgClient.setBreakpoints({
				infoBaseAlias: this.rdbgInfoBaseAlias,
				idOfDebuggerUi: this.debuggerId,
				bpWorkspace,
			});
			if (res.bpVersion) this.lastBpVersion = res.bpVersion;
		} catch {
			// игнорируем
		}
	}

	private startPingPolling(): void {
		this.stopPingPolling();
		const scheduleNext = () => {
			const isStopped = this.threadsCallStack.size > 0;
			const delayMs = isStopped ? this.timingConfig.pingStoppedIntervalMs : this.timingConfig.pingIntervalMs;
			this.pingTimerId = setTimeout(() => {
				void this.pollPing().finally(() => scheduleNext());
			}, delayMs);
		};
		scheduleNext();
	}

	private stopPingPolling(): void {
		if (this.pingTimerId !== undefined) {
			clearTimeout(this.pingTimerId);
			this.pingTimerId = undefined;
		}
		if (this.exprEvaluatedInvalidateTimer) {
			clearTimeout(this.exprEvaluatedInvalidateTimer);
			this.exprEvaluatedInvalidateTimer = undefined;
		}
		if (this.watchInvalidateTimer) {
			clearTimeout(this.watchInvalidateTimer);
			this.watchInvalidateTimer = undefined;
		}
		this.threadsCallStack.clear();
	}

	/** Очистка кэша выражений (Watch, раскрываемые переменные). Вызывается при отключении. */
	private clearEvalExprCache(): void {
		this.evalExprCache.clear();
		this.lastEvalExprByCacheKey.clear();
	}

	/** После остановки (F10/F11/Shift+F11) открыть файл модуля BSL на текущей строке. Задержка 100 ms — чтобы панель отладки успела обновиться. */
	private revealCurrentFrameInEditor(threadId: number): void {
		setTimeout(() => {
			const stack = this.threadsCallStack.get(threadId);
			if (!stack?.length) return;
			const item = stack[0];
			const root = this.rootProject || '';
			let sourcePath = '';
			const objectId = (item.moduleId?.objectId ?? '').trim();
			const propertyId = (item.moduleId?.propertyId ?? '').trim();
			const extensionName = (item.moduleId?.extensionName ?? '').trim();
			if (objectId && propertyId) {
				sourcePath = getModulePathByObjectProperty(root, objectId, propertyId, extensionName);
			}
			if (!sourcePath && item.moduleIdStr?.trim()) {
				sourcePath = getModulePathByModuleIdStr(root, item.moduleIdStr, extensionName);
			}
			if (sourcePath && propertyId === 'a637f77f-3840-441d-a1c3-699c8c5cb7e0') {
				const presentation = (item.presentation ?? '').trim();
				if (presentation && extensionName === '') {
					const extMods = getExtendingModules(root, objectId);
					for (const em of extMods) {
						const prefix = em.extension.toLowerCase() + '_';
						if (presentation.toLowerCase().startsWith(prefix)) {
							sourcePath = em.bslPath;
							break;
						}
					}
				}
			}
			if (!sourcePath) {
				// Fallback: активный редактор .bsl — при отладке пользователь обычно держит нужный модуль открытым
				const active = vscode.window.activeTextEditor;
				if (active?.document.fileName.toLowerCase().endsWith('.bsl')) {
					sourcePath = active.document.uri.fsPath;
				}
			}
			if (!sourcePath) {
				const lineNo = item.lineNo ?? '?';
				this.sendEvent(new OutputEvent(
					`[DEBUG] reveal: не найден путь (rootProject=${root || '(пусто)'}, objectId=${objectId || '—'}, propertyId=${propertyId || '—'}, moduleIdStr=${(item.moduleIdStr || '').slice(0, 60) || '—'}, lineNo=${lineNo})\n`,
					'console',
				));
				return;
			}
			const fullPath = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(root, sourcePath);
			const line = typeof item.lineNo === 'number' ? item.lineNo : parseInt(String(item.lineNo ?? 0), 10) || 1;
			const line0 = Math.max(0, line - 1);
			const uri = vscode.Uri.file(fullPath);
			void vscode.window.showTextDocument(uri, {
				// Выделяем всю строку — подсветка текущей позиции исполнения
				selection: new vscode.Range(line0, 0, line0 + 1, 0),
				preview: false,
				viewColumn: vscode.ViewColumn.One,
				preserveFocus: true, // Не переключать фокус с Call Stack — переменные появляются без повторного клика
			});
		}, 100);
	}

	/** После шага (F10/F11/Shift+F11) запрашивает getCallStack, отправляет StoppedEvent — IDE запросит evalLocalVariables и evalExpr (Watch). */
	private scheduleRefreshStackAndReveal(threadId: number, stepInOrOut = false): void {
		const existing = this.pendingStackRefreshTimeouts.get(threadId);
		if (existing !== undefined) clearTimeout(existing);
		this.pendingStackRefreshTimeouts.delete(threadId);
		const target = this.targets[threadId - 1] ?? this.targets[0];
		if (!this.rdbgClient || !this.attached || !target?.id) return;
		const delayMs = stepInOrOut ? this.timingConfig.stepInOutDelayMs : this.timingConfig.varFetchDelayMs;
		const timeoutId = setTimeout(async () => {
			this.pendingStackRefreshTimeouts.delete(threadId);
			try {
				const stack = await this.rdbgClient!.getCallStack(
					{ infoBaseAlias: this.rdbgInfoBaseAlias, idOfDebuggerUi: this.debuggerId },
					{ id: target.id },
				);
				if (stack.length > 0) {
					const current = this.threadsCallStack.get(threadId) ?? [];
					const stackChanged = !this.isCallStackEqual(current, stack);
					if (stackChanged) {
						this.threadsCallStack.set(threadId, stack);
						// Не очищаем evalExprCache — при InvalidatedEvent возвращаем кэш, пока сервер не ответит. Иначе переменные «обнуляются» при быстром F11.
						const stoppedEv = new StoppedEvent('step', threadId);
						(stoppedEv as { body: Record<string, unknown> }).body.preserveFocusHint = true;
						this.sendEvent(stoppedEv);
						this.sendEvent(new InvalidatedEvent(['stack', 'variables']));
						this.revealCurrentFrameInEditor(threadId);
					}
				}
			} catch {
				// игнорируем
			}
		}, delayMs);
		this.pendingStackRefreshTimeouts.set(threadId, timeoutId);
	}

	/** После F11/Shift+F11 — немедленные ping через 50, 100, 200 ms для вылова callStackFormed (сервер отдаёт его в ping раньше, чем getCallStack готов). */
	private scheduleImmediatePingForCallStack(_threadId: number): void {
		if (!this.rdbgClient || !this.attached) return;
		const base = { infoBaseAlias: this.rdbgInfoBaseAlias, idOfDebuggerUi: this.debuggerId };
		const delays = this.timingConfig.immediatePingDelaysMs;
		for (let i = 0; i < delays.length; i++) {
			const delayMs = delays[i];
			const id = setTimeout(async () => {
				this.immediatePingTimerIds.delete(id);
				if (!this.rdbgClient || !this.attached) return;
				try {
					const result = await this.rdbgClient.pingDebugUIParams(base);
					if (result?.callStackFormed) this.processCallStackFormed(result.callStackFormed);
				} catch {
					// игнорируем
				}
			}, delayMs);
			this.immediatePingTimerIds.add(id);
		}
	}

	/** Отменить отложенные immediate-ping — вызывается после успешной обработки callStackFormed. */
	private cancelImmediatePingTimers(): void {
		for (const id of this.immediatePingTimerIds) {
			clearTimeout(id);
		}
		this.immediatePingTimerIds.clear();
	}

	/** Дебаунс InvalidatedEvent при обновлении Watch — при множественных выражениях один событие вместо лавины запросов (нагрузка на dbgs). */
	private scheduleWatchInvalidate(): void {
		if (this.watchInvalidateTimer) clearTimeout(this.watchInvalidateTimer);
		this.watchInvalidateTimer = setTimeout(() => {
			this.watchInvalidateTimer = undefined;
			this.sendEvent(new InvalidatedEvent(['variables']));
		}, 200);
	}

	/** Обработка callStackFormed: сохраняем стек, отправляем StoppedEvent, reveal. */
	private processCallStackFormed(csf: CallStackFormedResult): void {
		const top = csf.callStack?.[0];
		const key = top ? `${top.presentation ?? ''}:${top.lineNo ?? 0}` : '';
		const now = Date.now();
		if (key && now - this.lastCallStackFormedAt < 400 && this.lastCallStackFormedKey === key) {
			return;
		}
		this.lastCallStackFormedAt = now;
		this.lastCallStackFormedKey = key;
		this.cancelImmediatePingTimers();

		let threadId = 1;
		if (csf.targetId?.trim()) {
			threadId = this.getThreadIdByTargetId(csf.targetId);
		} else if (csf.targetIDStr && this.targets.length > 0) {
			const target = this.targets.find((t) => t.targetIDStr === csf.targetIDStr);
			if (target) threadId = this.getThreadIdByTargetId(target.id);
		} else if (this.targets.length > 0) {
			threadId = 1;
		}
		// Отменяем отложенный getCallStack — уже получили стек из ping, избегаем двойного StoppedEvent и повторных запросов переменных
		this.cancelPendingStackRefresh(threadId);
		if (csf.targetIDStr?.trim()) {
			const target = this.targets[threadId - 1] ?? this.targets[0];
			if (target) target.targetIDStr = csf.targetIDStr;
		}
		const stackOrdered = csf.callStack;
		this.threadsCallStack.set(threadId, stackOrdered);
		// Не очищаем evalExprCache на step — иначе Watch показывает «Неопределено» пока сервер не ответит на evalExpr.
		const stoppedEv = new StoppedEvent(csf.reason, threadId);
		(stoppedEv as { body: Record<string, unknown> }).body.preserveFocusHint = true;
		this.sendEvent(stoppedEv);
		this.sendEvent(new InvalidatedEvent(['stack', 'variables']));
		this.revealCurrentFrameInEditor(threadId);
	}

	/** После получения списка локальных переменных в фоне запрашивает evalExpr по каждой раскрываемой переменной и заполняет evalExprCache — при раскрытии узла данные уже будут в кэше. */
	private prefetchLocalsChildren(targetId: string, frameIndex: number, expandableNames: string[]): void {
		if (!this.rdbgClient || !this.attached || expandableNames.length === 0) return;
		const base = { infoBaseAlias: this.rdbgInfoBaseAlias, idOfDebuggerUi: this.debuggerId };
		const target = { id: targetId };
		for (const name of expandableNames) {
			const cacheKey = `${targetId}:${frameIndex}:${name}`;
			if (this.evalExprCache.has(cacheKey)) continue;
			void this.rdbgClient.evalExpr(base, target, name, frameIndex).then((result) => {
				this.evalExprCache.set(cacheKey, {
					result: result.result ?? '',
					typeName: result.typeName,
					children: result.children,
					variablesRef: 0,
				});
			}).catch(() => {});
		}
	}

	/** Фоновое вычисление выражения из Watch: после ответа сервера кэширует результат и отправляет InvalidatedEvent. При 400 (вычисления только в остановленном предмете) выполняет retry с задержками evalExprRetryDelaysMs. */
	private async evalExprWatchAndInvalidate(
		cacheKey: string,
		expression: string,
		frameIndex: number,
		threadId: number,
		target: DebugTargetId,
	): Promise<void> {
		if (!this.rdbgClient || !this.attached) return;
		// Распределение по времени при большом числе Watch — снижает лавину evalExpr и нагрузку на dbgs (анализ D:\traf).
		const stagger = Math.min(this.evalExprWatchInFlight * 50, 200);
		this.evalExprWatchInFlight++;
		try {
			if (stagger > 0) await new Promise((r) => setTimeout(r, stagger));
		const base = { infoBaseAlias: this.rdbgInfoBaseAlias, idOfDebuggerUi: this.debuggerId };
		const targetLight = { id: target.id };
		const exprStore = {
			take: (id: string) => {
				const r = this.exprEvaluatedStore.get(id);
				if (r) this.exprEvaluatedStore.delete(id);
				return r;
			},
		};
		const doEval = async (): Promise<void> => {
			let result = await this.rdbgClient!.evalExpr(base, targetLight, expression, frameIndex, exprStore);
			// Соответствие: interfaces=context даёт пустой результат — fallback на interfaces=enum
			const isCorrespondence = /Соответствие/i.test(result.typeName ?? '');
			if (isCorrespondence && (!result.children || result.children.length === 0)) {
				try {
					const enumResult = await this.rdbgClient!.evalExprEnum(base, targetLight, expression, frameIndex);
					if (enumResult.collectionRows && enumResult.collectionRows.length > 0) {
						result = {
							...result,
							children: enumResult.collectionRows.map((row) => {
								const keyCell = row.cells.find((c) => /^Ключ$/i.test(c.name));
								const valCell = row.cells.find((c) => /^Значение$/i.test(c.name));
								return {
									name: keyCell?.value ?? `[${row.index}]`,
									value: valCell?.value ?? '',
									typeName: valCell?.typeName,
								};
							}),
						};
					}
				} catch {
					// оставляем result как есть
				}
			}
			// МенеджерВременныхТаблиц: не вычислять элементы коллекций (Таблицы, строки) — приводит к зацикливанию
			const isUnderManagerTempTables = /МенеджерВременныхТаблиц/i.test(expression);
			// ТаблицаЗначений: interfaces=context даёт только Колонки/Индексы — fallback на interfaces=collection для строк
			const isTable = /ТаблицаЗначений/i.test(result.typeName ?? '');
			const onlyMetadata =
				result.children?.length === 2 &&
				result.children.every((c) => /^(Колонки|Индексы)$/i.test(c.name));
			if (isTable && onlyMetadata && (result.collectionSize ?? 0) > 0 && !isUnderManagerTempTables) {
				try {
					const collResult = await this.rdbgClient!.evalExprCollection(base, targetLight, expression, frameIndex);
					if (collResult.collectionRows && collResult.collectionRows.length > 0) {
						const rowChildren = collResult.collectionRows.map((row) => {
							const summary = row.cells.map((c) => `${c.name}=${c.value}`).join(', ');
							return { name: `[${row.index}]`, value: summary, typeName: 'СтрокаТаблицыЗначений' };
						});
						result = { ...result, children: [...(result.children ?? []), ...rowChildren] };
					}
				} catch {
					// оставляем result.children
				}
			}
			// ВременныеТаблицыЗапроса (Запрос.МенеджерВременныхТаблиц.Таблицы): показывать список таблиц [0],[1],[2]
			const isTempTables = /ВременныеТаблицыЗапроса/i.test(result.typeName ?? '');
			if (isTempTables && (result.collectionSize ?? 0) > 0 && (!result.children || result.children.length === 0)) {
				try {
					const collResult = await this.rdbgClient!.evalExprCollection(base, targetLight, expression, frameIndex);
					if (collResult.collectionRows && collResult.collectionRows.length > 0) {
						const rowChildren = collResult.collectionRows.map((row) => {
							const summary = row.cells.map((c) => `${c.name}=${c.value}`).join(', ');
							return { name: `[${row.index}]`, value: summary, typeName: 'ВременнаяТаблицаЗапроса' };
						});
						result = { ...result, children: rowChildren };
					}
				} catch {
					// оставляем result
				}
			}
			const hasMeaningful = (result.result ?? '').trim() !== '' || (result.children && result.children.length > 0);
			if (!hasMeaningful) {
				const cached = this.evalExprCache.get(cacheKey);
				if (cached && ((cached.result ?? '').trim() !== '' || (cached.children?.length ?? 0) > 0)) {
					this.scheduleWatchInvalidate();
					return;
				}
			}
			const displayResult = result.error ?? result.result ?? result.typeName ?? 'Неопределено';
			const hasChildren = !!(result.children && result.children.length > 0);
			const cached = this.evalExprCache.get(cacheKey);
			const resultChanged =
				!cached ||
				cached.result !== displayResult ||
				(cached.children?.length ?? 0) !== (result.children?.length ?? 0);
			let variablesReference = 0;
			if (hasChildren) {
				variablesReference = this.references.registerVariable(`eval:${expression}`, {
					type: 'evalChildren',
					expression,
					children: result.children!,
					frameIndex,
					threadId,
				});
			}
			this.evalExprCache.set(cacheKey, {
				result: displayResult,
				typeName: result.typeName,
				children: result.children,
				variablesRef: variablesReference,
			});
			this.lastEvalExprByCacheKey.set(cacheKey, Date.now());
			if (resultChanged) this.scheduleWatchInvalidate();
		};
		try {
			await doEval();
		} catch (err) {
			if (OnecDebugSession.isEvalOnlyWhenStoppedError(err)) {
				for (const delayMs of this.timingConfig.evalExprRetryDelaysMs) {
					await new Promise((r) => setTimeout(r, delayMs));
					try {
						await doEval();
						return;
					} catch (retryErr) {
						if (!OnecDebugSession.isEvalOnlyWhenStoppedError(retryErr)) {
							const errMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
							this.evalExprCache.set(cacheKey, {
								result: `Ошибка: ${errMsg}`,
								variablesRef: 0,
							});
							this.scheduleWatchInvalidate();
							return;
						}
					}
				}
			}
			const errMsg = err instanceof Error ? err.message : String(err);
			this.evalExprCache.set(cacheKey, {
				result: `Ошибка: ${errMsg}`,
				variablesRef: 0,
			});
			this.scheduleWatchInvalidate();
		}
		} finally {
			this.evalExprWatchInFlight = Math.max(0, this.evalExprWatchInFlight - 1);
		}
	}

	/** Отменить отложенный getCallStack для потока (вызывать после обработки callStackFormed). */
	private cancelPendingStackRefresh(threadId: number): void {
		const id = this.pendingStackRefreshTimeouts.get(threadId);
		if (id !== undefined) {
			clearTimeout(id);
			this.pendingStackRefreshTimeouts.delete(threadId);
		}
	}

	/** Сравнение двух стеков по ключевым полям (presentation, lineNo, moduleId). Если равны — не слать InvalidatedEvent, чтобы не терять контекст и не дергать запросы переменных. */
	private isCallStackEqual(a: StackItemViewInfoData[], b: StackItemViewInfoData[]): boolean {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			const ai = a[i];
			const bi = b[i];
			if (String(ai.presentation ?? '').trim() !== String(bi.presentation ?? '').trim()) return false;
			const lineA = typeof ai.lineNo === 'number' ? ai.lineNo : parseInt(String(ai.lineNo ?? 0), 10) || 0;
			const lineB = typeof bi.lineNo === 'number' ? bi.lineNo : parseInt(String(bi.lineNo ?? 0), 10) || 0;
			if (lineA !== lineB) return false;
			const objA = ai.moduleId?.objectId ?? '';
			const objB = bi.moduleId?.objectId ?? '';
			const propA = ai.moduleId?.propertyId ?? '';
			const propB = bi.moduleId?.propertyId ?? '';
			if (objA !== objB || propA !== propB) return false;
		}
		return true;
	}

	private async pollPing(): Promise<void> {
		if (!this.rdbgClient || !this.attached) return;
		this.pingCount++;
		try {
			// Периодически опрашиваем getDbgTargets если целей нет (fallback, каждые 2 пинга = ~800 ms)
			if (this.targets.length === 0 && this.pingCount % 2 === 0) {
				try {
					const targetsRes = await this.rdbgClient.getDbgTargets({
						infoBaseAlias: this.rdbgInfoBaseAlias,
						idOfDebuggerUi: this.debuggerId,
					});
					const idList = targetsRes.id;
					let list = Array.isArray(idList) ? idList : idList ? [idList] : [];
					if (this.autoAttachTypes.length > 0) {
						list = list.filter((t) => {
							const tt = t.targetType ?? '';
							if (!tt.trim()) return true;
							return matchesAutoAttachType(tt, this.autoAttachTypes);
						});
					}
					if (list.length > 0) {
						const merged = this.deduplicateTargetsById([...this.targets, ...list]);
						const newTargets = merged.filter((t) => !this.targets.some((existing) => existing.id === t.id));
						this.targets = merged;
						if (newTargets.length > 0) {
							await this.attachToTargets(newTargets);
							// Удаляем placeholder «1C: Main», если он был
							const hadPlaceholder = this.targets.length === newTargets.length;
							if (hadPlaceholder) {
								this.sendEvent(new ThreadEvent('exited', 1));
							}
							for (const t of newTargets) {
								const threadId = this.getThreadIdByTargetId(t.id);
								this.sendEvent(new ThreadEvent('started', threadId));
							this.sendEvent(new OutputEvent(
								`[DEBUG] Цель отладки (getDbgTargets): ${getTargetTypeDisplayName(t.targetType ?? '') || 'Unknown'} (${t.userName ?? ''})\n`,
								'console',
							));
						}
						this.sendEvent(new InvalidatedEvent(['threads', 'stack']));
					}
				}
			} catch {
				// игнорируем ошибки getDbgTargets
			}
		}

			const result = await this.rdbgClient.pingDebugUIParams({
				infoBaseAlias: this.rdbgInfoBaseAlias,
				idOfDebuggerUi: this.debuggerId,
			});

			// Пинг целей rtgt — только когда НЕ остановлены. В режиме остановки (стек есть) цели не меняются — не нагружаем dbgs.
			const isStopped = this.threadsCallStack.size > 0;
			if (!isStopped) {
				const base = { infoBaseAlias: this.rdbgInfoBaseAlias, idOfDebuggerUi: this.debuggerId };
				const now = Date.now();
				const intervalMs = this.timingConfig.pingDbgtgtIntervalMs;
				for (const t of this.targets) {
					const seanceId = t.seanceId ?? '';
					if (!seanceId && !this.rteProcVersionByTargetId.has(t.id)) continue;
					const last = this.lastPingDbgtgtByTargetId.get(t.id) ?? 0;
					if (now - last < intervalMs) continue;
					this.lastPingDbgtgtByTargetId.set(t.id, now);
					void this.rdbgClient.pingDBGTGT(base, t.id, seanceId, this.rteProcVersionByTargetId.get(t.id))
						.then((res) => {
							if (res.rteProcVersion) this.rteProcVersionByTargetId.set(t.id, res.rteProcVersion);
						})
						.catch(() => {});
				}
			}

			if (!result) return;

			// exprEvaluated — для variablesRequest (retry evalLocalVariables конкурирует с pollPing за ping)
			// Как только появились данные переменных — триггерим обновление VARIABLES и Watch в IDE
			let hadNewExprEvaluated = false;
			for (const ev of result.exprEvaluated ?? []) {
				if (ev.expressionResultID && ev.result) {
					this.exprEvaluatedStore.set(ev.expressionResultID, ev.result);
					hadNewExprEvaluated = true;
				}
			}
			if (hadNewExprEvaluated) {
				// Дебаунс 150 мс — при серии exprEvaluated один InvalidatedEvent вместо потока запросов переменных
				if (this.exprEvaluatedInvalidateTimer) clearTimeout(this.exprEvaluatedInvalidateTimer);
				this.exprEvaluatedInvalidateTimer = setTimeout(() => {
					this.exprEvaluatedInvalidateTimer = undefined;
					this.sendEvent(new InvalidatedEvent(['variables']));
				}, 150);
			}

			// Событие targetStarted — новая цель отладки (как в onec-debug-adapter DebugTargetsManager)
			if (result.targetStarted) {
				const toAdd = result.targetStarted.filter((target) => {
					if (this.autoAttachTypes.length > 0) {
						const tt = target.targetType ?? '';
						if (tt.trim() && !matchesAutoAttachType(tt, this.autoAttachTypes)) return false;
					}
					return !this.targets.some((t) => t.id === target.id);
				});
				const merged = this.deduplicateTargetsById([...this.targets, ...toAdd]);
				const newTargets = merged.filter((t) => !this.targets.some((existing) => existing.id === t.id));
				this.targets = merged;
				if (newTargets.length > 0) {
					await this.attachToTargets(newTargets);
					const hadPlaceholder = this.targets.length === newTargets.length;
					if (hadPlaceholder) {
						this.sendEvent(new ThreadEvent('exited', 1));
					}
					for (const target of newTargets) {
						const threadId = this.getThreadIdByTargetId(target.id);
						const typeDisplay = getTargetTypeDisplayName(target.targetType ?? '') || 'Unknown';
						const threadName = `${typeDisplay} (${target.userName ?? 'unknown'})`;
						this.sendEvent(new ThreadEvent('started', threadId));
					this.sendEvent(new OutputEvent(
						`[DEBUG] Цель отладки подключена: ${threadName}\n`,
						'console',
					));
				}
				this.sendEvent(new InvalidatedEvent(['threads', 'stack']));
			}
		}

			// targetQuit — при шаге (callStackFormed) не удалять цель, в которой остановились
			if (result.targetQuit) {
				const steppedTargetId = result.callStackFormed?.targetId?.trim()
					|| (result.callStackFormed?.targetIDStr && this.targets.find(t => t.targetIDStr === result.callStackFormed!.targetIDStr)?.id)
					|| '';
				const isSteppedTargetInQuit = result.callStackFormed && this.targets.length === 1
					&& result.targetQuit.some(t => t.id === this.targets[0]?.id);
				let hadQuit = false;
				for (const target of result.targetQuit) {
					if (!target.id?.trim() || target.id === steppedTargetId || isSteppedTargetInQuit) continue;
					const index = this.targets.findIndex(t => t.id === target.id);
					if (index >= 0) {
						const threadId = index + 1;
						this.targets.splice(index, 1);
						this.rteProcVersionByTargetId.delete(target.id);
						this.lastPingDbgtgtByTargetId.delete(target.id);
						this.sendEvent(new ThreadEvent('exited', threadId));
						this.sendEvent(new OutputEvent(
							`[DEBUG] Цель отладки завершена: ${getTargetTypeDisplayName(target.targetType ?? '') || 'Unknown'}\n`,
							'console',
						));
						hadQuit = true;
					}
				}
				if (hadQuit) this.sendEvent(new InvalidatedEvent(['threads', 'stack']));
			}

			// Событие callStackFormed — останов на брейкпойнте/шаге. StoppedEvent переводит IDE в состояние paused (F10/F11).
			if (result.callStackFormed) {
				this.processCallStackFormed(result.callStackFormed);
			}
		} catch {
			// игнорируем ошибки опроса
		}
	}

	protected override initializeRequest(
		response: DebugProtocol.InitializeResponse,
		args: DebugProtocol.InitializeRequestArguments,
	): void {
		response.body = response.body ?? {};
		response.body.supportsConfigurationDoneRequest = true;
		(response.body as Record<string, unknown>).supportsThreads = true;
		(response.body as Record<string, unknown>).supportsInvalidatedEvent = true;
		response.body.supportsEvaluateForHovers = true;
		response.body.supportsConditionalBreakpoints = true;
		response.body.supportsLogPoints = true;
		response.body.supportsExceptionFilterOptions = true;
		response.body.supportsExceptionInfoRequest = false;
		response.body.exceptionBreakpointFilters = [
			{
				filter: 'all',
				label: 'Остановка по ошибке',
				description: 'Остановка при возникновении исключения времени выполнения',
				supportsCondition: true,
				conditionDescription: 'Искомая подстрока текста исключения',
			},
		];
		this.sendResponse(response);
	}

	protected override async launchRequest(
		response: DebugProtocol.LaunchResponse,
		args: OnecLaunchRequestArguments,
		_request?: DebugProtocol.Request,
	): Promise<void> {
		await this.initLaunchAttach(response, args, true);
	}

	protected override async attachRequest(
		response: DebugProtocol.AttachResponse,
		args: OnecLaunchRequestArguments,
		_request?: DebugProtocol.Request,
	): Promise<void> {
		await this.initLaunchAttach(response, args, false);
	}

	private async initLaunchAttach(
		response: DebugProtocol.LaunchResponse | DebugProtocol.AttachResponse,
		args: OnecLaunchRequestArguments,
		_launch: boolean,
	): Promise<void> {
		const host = args.debugServerHost ?? 'localhost';
		const port = args.debugServerPort ?? 1560;
		this.rootProject = (args.rootProject ?? '').trim()
			|| vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
			|| '';
		this.rdbgInfoBaseAlias = args.infoBaseAlias ?? 'DefAlias';

		// Вывод в Debug Console: PID Cursor и команда запуска dbgs (если dbgs был запущен расширением)
		this.sendEvent(new OutputEvent(`PID процесса Cursor (extension host): ${process.pid}\n`, 'console'));
		const dbgsInfo = getLastDbgsLaunch();
		if (dbgsInfo) {
			this.sendEvent(new OutputEvent(`Запуск dbgs: ${dbgsInfo.commandLine}\n`, 'console'));
		} else {
			this.sendEvent(new OutputEvent('Запуск dbgs: (данные недоступны — dbgs мог быть запущен вне расширения)\n', 'console'));
		}

		try {
			this.timingConfig = getDebugTimingConfig();
			const logProtocol = vscode.workspace.getConfiguration('1c-dev-tools').get<boolean>('debug.logProtocol', false);
			this.rdbgClient = new RdbgClient(host, port, {
				logProtocol,
				timing: {
					varFetchDelayMs: this.timingConfig.varFetchDelayMs,
					calcWaitingTimeMs: this.timingConfig.calcWaitingTimeMs,
					evalExprRetryDelaysMs: this.timingConfig.evalExprRetryDelaysMs,
				},
			});
			await this.rdbgClient.test();

			const attachResponse = await this.rdbgClient.attachDebugUI({
				infoBaseAlias: this.rdbgInfoBaseAlias,
				idOfDebuggerUi: this.debuggerId,
				options: { foregroundAbility: true },
			});

			const result = String(attachResponse.result ?? '').trim();
			const resultLower = result.toLowerCase();

			if (resultLower === AttachDebugUiResult.Registered) {
				this.attached = true;
				const logDir = this.rdbgClient?.getProtocolLogDirectory?.();
				if (logDir) {
					this.sendEvent(new OutputEvent(
						`[DEBUG] Протокол RDBG: ${logDir}\n`,
						'console',
					));
				}
				// Инициализация настроек отладки (initSettings) после успешного подключения
				try {
					await this.rdbgClient.initSettings({
						infoBaseAlias: this.rdbgInfoBaseAlias,
						idOfDebuggerUi: this.debuggerId,
					});
				} catch {
					// игнорируем ошибки initSettings
				}
				
				// Настройка автоподключения (setAutoAttachSettings) если указаны autoAttachTypes
				const autoAttachTypes = args.autoAttachTypes;
				this.autoAttachTypes = Array.isArray(autoAttachTypes) ? autoAttachTypes : [];
				if (autoAttachTypes && this.autoAttachTypes.length > 0) {
					try {
						const targetTypes = autoAttachTypes.map(type => ({
							type,
							autoAttach: true,
						}));
						await this.rdbgClient.setAutoAttachSettings(
							{ infoBaseAlias: this.rdbgInfoBaseAlias, idOfDebuggerUi: this.debuggerId },
							{ targetTypes },
						);
						this.sendEvent(new OutputEvent(
							`[DEBUG] Auto-attach настроен для типов: ${autoAttachTypes.join(', ')}\n`,
							'console',
						));
					} catch (err) {
						// Логируем ошибку setAutoAttachSettings для диагностики
						const errMsg = err instanceof Error ? err.message : String(err);
						this.sendEvent(new OutputEvent(
							`[WARNING] Ошибка setAutoAttachSettings: ${errMsg}\n`,
							'stderr',
						));
					}
				}
				
				try {
					// Задержка перед первым опросом: даём серверу 1С время обработать attachDebugUI
					await new Promise((r) => setTimeout(r, 500));
					// Один ping с dbgui до первого getDbgTargets: сервер может отдавать цели только после регистрации отладчика через ping
					try {
						await this.rdbgClient.pingDebugUIParams({
							infoBaseAlias: this.rdbgInfoBaseAlias,
							idOfDebuggerUi: this.debuggerId,
						});
					} catch {
						// игнорируем ошибку ping
					}
					// Пауза после ping, затем 1–2 вызова getDbgTargets (сервер может отдавать цели с задержкой)
					const baseReq = { infoBaseAlias: this.rdbgInfoBaseAlias, idOfDebuggerUi: this.debuggerId };
					const applyTargets = (res: { id?: unknown; item?: unknown }): void => {
						const idList = res.id ?? res.item;
						const list = Array.isArray(idList) ? idList : idList ? [idList] : [];
						let filtered = list as DebugTargetId[];
						if (autoAttachTypes && autoAttachTypes.length > 0) {
							filtered = list.filter((t: DebugTargetId) => {
								const tt = t.targetType ?? '';
								if (!tt.trim()) return true;
								return matchesAutoAttachType(tt, autoAttachTypes);
							}) as DebugTargetId[];
						}
						if (filtered.length > 0) this.targets = this.deduplicateTargetsById(filtered);
					};
					await new Promise((r) => setTimeout(r, 300));
					try {
						const res1 = await this.rdbgClient.getDbgTargets(baseReq);
						applyTargets(res1);
						if (this.targets.length === 0) {
							await new Promise((r) => setTimeout(r, 300));
							const res2 = await this.rdbgClient.getDbgTargets(baseReq);
							applyTargets(res2);
						}
					} catch {
						// игнорируем, дальше сработает цикл опроса или ping
					}

					// В режиме attach: ждём появления целей до 15 с (клиент 1С может подключаться с задержкой)
					const waitTargetsMs = _launch ? 0 : 15000;
					const pollIntervalMs = 150;
					for (let elapsed = 0; elapsed < waitTargetsMs && this.targets.length === 0; elapsed += pollIntervalMs) {
						await new Promise((r) => setTimeout(r, pollIntervalMs));
						try {
							const res = await this.rdbgClient!.getDbgTargets({
								infoBaseAlias: this.rdbgInfoBaseAlias,
								idOfDebuggerUi: this.debuggerId,
							});
							const list = Array.isArray(res.id) ? res.id : res.id ? [res.id] : [];
							const filtered =
								autoAttachTypes?.length
									? list.filter((t) => {
											const tt = t.targetType ?? '';
											if (!tt.trim()) return true;
											return matchesAutoAttachType(tt, autoAttachTypes);
										})
									: list;
							if (filtered.length > 0) {
								this.targets = this.deduplicateTargetsById(filtered);
								await this.attachToTargets(this.targets);
								this.sendEvent(new OutputEvent(
									`[DEBUG] Ожидание целей: найдено ${this.targets.length}\n`,
									'console',
								));
								break;
							}
						} catch {
							// продолжаем опрос
						}
					}
				} catch {
					this.targets = [];
				}
				// При launch: сначала запускаем 1cv8c, затем ждём появления цели (клиент вызывает threadsRequest сразу после InitializedEvent)
				if (_launch) {
					this.run1cv8c(args, host, port);
					const waitTargetsMs = 15000;
					const pollIntervalMs = 150;
					for (let elapsed = 0; elapsed < waitTargetsMs && this.targets.length === 0; elapsed += pollIntervalMs) {
						await new Promise((r) => setTimeout(r, pollIntervalMs));
						try {
							const res = await this.rdbgClient!.getDbgTargets({
								infoBaseAlias: this.rdbgInfoBaseAlias,
								idOfDebuggerUi: this.debuggerId,
							});
							const list = Array.isArray(res.id) ? res.id : res.id ? [res.id] : [];
							const filtered =
								autoAttachTypes?.length
									? list.filter((t) => {
											const tt = t.targetType ?? '';
											if (!tt.trim()) return true;
											return matchesAutoAttachType(tt, autoAttachTypes);
										})
									: list;
							if (filtered.length > 0) {
								this.targets = this.deduplicateTargetsById(filtered);
								// В launch: подождать и запросить цели ещё раз — ManagedClient может подключиться чуть позже ServerEmulation
								await new Promise((r) => setTimeout(r, 800));
								try {
									const res2 = await this.rdbgClient!.getDbgTargets({
										infoBaseAlias: this.rdbgInfoBaseAlias,
										idOfDebuggerUi: this.debuggerId,
									});
									const list2 = Array.isArray(res2.id) ? res2.id : res2.id ? [res2.id] : [];
									const filtered2 =
										autoAttachTypes?.length
											? list2.filter((t: DebugTargetId) => {
													const tt = t.targetType ?? '';
													if (!tt.trim()) return true;
													return matchesAutoAttachType(tt, autoAttachTypes);
												})
											: (list2 as DebugTargetId[]);
									this.targets = this.deduplicateTargetsById([...this.targets, ...filtered2]);
								} catch {
									// игнорируем
								}
								await this.attachToTargets(this.targets);
								this.sendEvent(new OutputEvent(
									`[DEBUG] Ожидание целей (launch): найдено ${this.targets.length}\n`,
									'console',
								));
								break;
							}
						} catch {
							// продолжаем опрос
						}
					}
				}
				this.sendResponse(response);
				this.sendEvent(new InitializedEvent());
				this.startPingPolling();
			} else {
				const message = getAttachResultMessage(result);
				this.sendErrorResponse(response, { id: 1, format: message });
			}
		} catch (err) {
			const e = err instanceof Error ? err : new Error(String(err));
			const cause = e.cause instanceof Error ? e.cause.message : '';
			const message = cause ? `${e.message} (${cause})` : e.message;
			this.sendErrorResponse(response, { id: 100, format: 'Ошибка запуска отладки: {_message}', variables: { _message: message } });
		}
	}

	/**
	 * Запускает 1cv8c.exe (толстый клиент) с /DEBUG -http -attach и /DEBUGGERURL.
	 */
	private run1cv8c(args: OnecLaunchRequestArguments, host: string, port: number): void {
		const v8version = args.platformVersion ?? '8.3.27';
		const platformRoot = args.platformPath;
		const platformBin = resolvePlatformBin(v8version, platformRoot);
		if (!platformBin) {
			this.sendEvent(new OutputEvent(
				`1C Dev Tools: не найден 1cv8c.exe (platformVersion=${v8version}, platformPath=${platformRoot ?? 'не задан'}). Запустите 1С вручную.\n`,
				'stderr',
			));
			return;
		}
		const debuggerUrl = `http://${host}:${port}`;
		const workspaceRoot = args.rootProject ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
		if (!workspaceRoot && args.ibconnection?.trim().match(/^\/F/i)) {
			this.sendEvent(new OutputEvent(
				'1C Dev Tools: не задана папка проекта (rootProject). Откройте папку проекта (E:\\DATA1C\\BASE) в Cursor и запустите отладку снова.\n',
				'stderr',
			));
		}
		const launchOptions = {
			debuggerUrl,
			ibConnection: args.ibconnection,
			infoBase: args.infoBase,
			workspaceRoot,
			dbUser: args.dbUser,
			dbPwd: args.dbPwd,
		};
		const commandLine = format1cv8cCommandLine(platformBin, launchOptions);
		this.sendEvent(new OutputEvent(`1C Dev Tools: запуск 1cv8c: ${commandLine}\n`, 'console'));
		const proc = launch1cv8c(platformBin, launchOptions);
		this.launchedProcess = proc;
		proc.unref();
	}

	protected override async disconnectRequest(
		response: DebugProtocol.DisconnectResponse,
		args: DebugProtocol.DisconnectArguments,
		_request?: DebugProtocol.Request,
	): Promise<void> {
		this.stopPingPolling();
		this.clearEvalExprCache();
		this.targets = [];
		this.rteProcVersionByTargetId.clear();
		this.lastPingDbgtgtByTargetId.clear();
		// В launch-режиме всегда завершаем процесс 1cv8c (как onec-debug-adapter)
		if (this.launchedProcess && (args.terminateDebuggee !== false)) {
			try {
				this.launchedProcess.kill();
			} catch {
				// игнорируем ошибки при завершении
			}
			this.launchedProcess = undefined;
		}
		if (this.attached && this.rdbgClient) {
			try {
				await this.rdbgClient.detachDebugUI({
					infoBaseAlias: this.rdbgInfoBaseAlias,
					idOfDebuggerUi: this.debuggerId,
				});
			} catch {
				// игнорируем ошибки при отключении
			}
			this.attached = false;
		}
		this.sendResponse(response);
	}

	protected override terminateRequest(
		response: DebugProtocol.TerminateResponse,
		_args: DebugProtocol.TerminateArguments,
		_request?: DebugProtocol.Request,
	): void {
		if (this.launchedProcess) {
			try {
				this.launchedProcess.kill();
			} catch {
				// игнорируем
			}
			this.launchedProcess = undefined;
		}
		this.sendResponse(response);
	}

	protected override threadsRequest(response: DebugProtocol.ThreadsResponse, _request?: DebugProtocol.Request): void {
		const threads =
			this.targets.length > 0
				? this.targets.map((t, i) => {
						const typeDisplay = getTargetTypeDisplayName(t.targetType ?? '');
						const name = [typeDisplay, t.userName, t.seanceNo].filter(Boolean).join(', ') || `Target ${i + 1}`;
						return new Thread(i + 1, name);
					})
				: [new Thread(1, '1C: Main')];
		response.body = { threads };
		this.sendEvent(new OutputEvent(
			`[DEBUG] threadsRequest: ${threads.length} поток(ов): ${threads.map((th) => th.name).join('; ')}\n`,
			'console',
		));
		this.sendResponse(response);
	}

	protected override async setBreakPointsRequest(
		response: DebugProtocol.SetBreakpointsResponse,
		args: DebugProtocol.SetBreakpointsArguments,
		_request?: DebugProtocol.Request,
	): Promise<void> {
		const source = args.source;
		const sourcePath = source?.path;
		const requestedLines = args.breakpoints ?? [];

		if (!sourcePath) {
			response.body = { breakpoints: [] };
			this.sendResponse(response);
			return;
		}

		const root = this.rootProject || '';
		const key = OnecDebugSession.normalizePath(sourcePath);

		// Храним точки по всем модулям (как onec-debug-adapter): при каждом setBreakpoints отправляем в RDBG полный bpWorkspace.
		if (requestedLines.length === 0) {
			this.moduleBreakpoints.delete(key);
		} else {
			this.moduleBreakpoints.set(key, { source: source!, breakpoints: requestedLines });
		}

		const bpWorkspace: ModuleBpInfoForRequest[] = [];
		for (const [, stored] of this.moduleBreakpoints) {
			const p = stored.source.path ?? '';
			const moduleInfo = getModuleInfoByPath(root, p);
			if (!moduleInfo.objectId || !moduleInfo.propertyId) continue;
			const bpInfoRdbg: BreakpointInfoRdbg[] = stored.breakpoints.map((bp) => ({
				line: bp.line,
				isActive: true,
				breakOnCondition: !!bp.condition,
				condition: bp.condition ?? '',
				breakOnHitCount: !!bp.hitCondition,
				hitCount: typeof bp.hitCondition === 'string' && /^\d+$/.test(bp.hitCondition) ? parseInt(bp.hitCondition, 10) : 0,
				showOutputMessage: !!bp.logMessage,
				putExpressionResult: bp.logMessage ?? '',
				continueExecution: !!bp.logMessage,
			}));
			const ext = moduleInfo.extension?.trim() ?? '';
			const version = ext ? getExtensionVersionHash(root, ext) : undefined;
			bpWorkspace.push({
				extension: ext,
				objectId: moduleInfo.objectId,
				propertyId: moduleInfo.propertyId,
				bslModuleType: moduleInfo.bslModuleType,
				moduleIdString: moduleInfo.moduleIdString || undefined,
				bpInfo: bpInfoRdbg,
				...(version && { version }),
			});
			// При breakpoint в базовом ObjectModule — добавить точки в расширяющие модули. Маппинг строк по структуре процедур (&ИзменениеИКонтроль, &Вместо).
			if (!ext && moduleInfo.propertyId === 'a637f77f-3840-441d-a1c3-699c8c5cb7e0') {
				const baseBslPath = path.isAbsolute(p) ? p : path.resolve(root, p);
				for (const extMod of getExtendingModules(root, moduleInfo.objectId)) {
					const extVersion = getExtensionVersionHash(root, extMod.extension);
					const extBpInfo: BreakpointInfoRdbg[] = [];
					for (const bp of stored.breakpoints) {
						const extLines = mapBaseBreakpointToExtensionLines(baseBslPath, bp.line, extMod.bslPath);
						for (const L of extLines) {
							extBpInfo.push({
								line: L,
								isActive: true,
								breakOnCondition: !!bp.condition,
								condition: bp.condition ?? '',
								breakOnHitCount: !!bp.hitCondition,
								hitCount: typeof bp.hitCondition === 'string' && /^\d+$/.test(bp.hitCondition) ? parseInt(bp.hitCondition, 10) : 0,
								showOutputMessage: !!bp.logMessage,
								putExpressionResult: bp.logMessage ?? '',
								continueExecution: !!bp.logMessage,
							});
						}
					}
					if (extBpInfo.length > 0) {
						bpWorkspace.push({
							extension: extMod.extension,
							objectId: extMod.objectId,
							propertyId: extMod.propertyId,
							bslModuleType: 'ObjectModule',
							moduleIdString: undefined,
							bpInfo: extBpInfo,
							...(extVersion && { version: extVersion }),
						});
					}
				}
			}
		}

		const currentModuleInfo = getModuleInfoByPath(root, sourcePath);
		const hasValidModuleId = !!(currentModuleInfo.objectId && currentModuleInfo.propertyId);

		if (!hasValidModuleId) {
			response.body = {
				breakpoints: requestedLines.map((bp) => ({
					id: undefined,
					verified: false,
					line: bp.line,
					message: 'Модуль не найден в метаданных конфигурации. Убедитесь, что проект — выгрузка в файлы (src/cf) и файл открыт из этой конфигурации.',
				})),
			};
			this.sendResponse(response);
			return;
		}

		if (this.attached && this.rdbgClient) {
			try {
				const setBpRes = await this.rdbgClient.setBreakpoints({
					infoBaseAlias: this.rdbgInfoBaseAlias,
					idOfDebuggerUi: this.debuggerId,
					bpWorkspace,
				});
				if (setBpRes.bpVersion) this.lastBpVersion = setBpRes.bpVersion;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				response.body = {
					breakpoints: requestedLines.map((bp) => ({ id: undefined, verified: false, line: bp.line, message: msg })),
				};
				this.sendResponse(response);
				return;
			}
		}

		response.body = {
			breakpoints: requestedLines.map((bp) => ({
				id: undefined,
				verified: true,
				line: bp.line,
			})),
		};
		this.sendResponse(response);
	}

	protected override stackTraceRequest(
		response: DebugProtocol.StackTraceResponse,
		args: DebugProtocol.StackTraceArguments,
		_request?: DebugProtocol.Request,
	): void {
		const threadId = args.threadId ?? 1;
		const stack = this.threadsCallStack.get(threadId) ?? [];
		const root = this.rootProject || '';
		const startFrame = args.startFrame ?? 0;
		const maxLevels = args.levels ?? stack.length;
		const stackFrames: StackFrame[] = [];

		if (stack.length > 0) {
			// frameId = threadId*10000 + 1000 + i — иначе при двух потоках frameId совпадают, переменные путаются
			for (let i = startFrame; i < Math.min(startFrame + maxLevels, stack.length); i++) {
				const item = stack[i];
				const line = typeof item.lineNo === 'number' ? item.lineNo : parseInt(String(item.lineNo ?? 0), 10) || 1;
				const presentation = String(item.presentation ?? '').trim() || `[${i}]`;
				let sourcePath = '';
				const extName = (item.moduleId?.extensionName ?? '').trim();
				if (item.moduleId?.objectId && item.moduleId?.propertyId) {
					sourcePath = getModulePathByObjectProperty(root, item.moduleId.objectId, item.moduleId.propertyId, extName);
				}
				if (!sourcePath && item.moduleIdStr?.trim()) {
					sourcePath = getModulePathByModuleIdStr(root, item.moduleIdStr, extName);
				}
				if (sourcePath && item.moduleId?.propertyId === 'a637f77f-3840-441d-a1c3-699c8c5cb7e0') {
					const pres = (item.presentation ?? '').trim();
					if (pres && extName === '') {
						for (const em of getExtendingModules(root, item.moduleId!.objectId)) {
							if (pres.toLowerCase().startsWith(em.extension.toLowerCase() + '_')) {
								sourcePath = path.isAbsolute(em.bslPath) ? em.bslPath : path.resolve(root, em.bslPath);
								break;
							}
						}
					}
				}
				if (sourcePath && !path.isAbsolute(sourcePath)) {
					sourcePath = path.resolve(root, sourcePath);
				}
				const frameId = threadId * 10000 + 1000 + i;
				// Источник: путь к файлу или имя по moduleIdStr. Не используем moduleIdStr, если строка похожа на бинарные данные — иначе IDE показывает "Could not load source '@мусор'".
				const safeModuleIdStr = isSafeSourceDisplayName(item.moduleIdStr) ? item.moduleIdStr : undefined;
				const src = sourcePath
					? new Source(path.basename(sourcePath) || 'module', sourcePath)
					: (safeModuleIdStr ? new Source(safeModuleIdStr, '') : undefined);
				const frame = new StackFrame(frameId, presentation, src, line);
				// Фантомные/внутренние кадры — subtle, при F11 (шаг внутрь) фокус остаётся на процедуре пользователя
				if (item.isFantom) {
					(frame as DebugProtocol.StackFrame).presentationHint = 'subtle';
				}
				stackFrames.push(frame);
			}
		} else {
			// Поток выполняется — возвращаем placeholder, чтобы Call Stack отображал поток (VS Code может скрывать потоки с 0 фреймов)
			stackFrames.push(new StackFrame(0, '(Running)', undefined, 0));
		}

		response.body = { stackFrames, totalFrames: stack.length || 1 };
		this.sendResponse(response);
	}

	protected override scopesRequest(
		response: DebugProtocol.ScopesResponse,
		args: DebugProtocol.ScopesArguments,
		_request?: DebugProtocol.Request,
	): void {
		const frameId = args.frameId;
		// frameId = threadId*10000 + 1000 + i
		const threadId = frameId >= 10000 ? Math.floor(frameId / 10000) : 1;
		const frameIndex = frameId >= 1000 ? ((frameId % 10000) - 1000) : 0;
		const safeFrameIndex = frameIndex >= 0 ? frameIndex : 0;
		const localScopeRef = this.references.registerVariable('locals', { frameIndex: safeFrameIndex, threadId });
		response.body = {
			scopes: [
				{
					name: 'Локальные',
					variablesReference: localScopeRef,
					expensive: false,
				},
			],
		};
		this.sendResponse(response);
	}

	/** Сообщение сервера 400: вычисления только в остановленном предмете. При такой ошибке возвращаем пустой список. */
	private static isEvalOnlyWhenStoppedError(err: unknown): boolean {
		const msg = err instanceof Error ? err.message : String(err ?? '');
		return /400|остановленном предмете отладки|вычислений возможно только/i.test(msg);
	}

	protected override async variablesRequest(
		response: DebugProtocol.VariablesResponse,
		args: DebugProtocol.VariablesArguments,
		_request?: DebugProtocol.Request,
	): Promise<void> {
		let responseSent = false;
		const sendOnce = (body: { variables: DebugProtocol.Variable[] }) => {
			if (responseSent) return;
			responseSent = true;
			response.body = body;
			this.sendResponse(response);
		};
		try {
			const varInfo = this.references.getVariable(args.variablesReference);
			if (!varInfo) {
				sendOnce({ variables: [] });
				return;
			}

			// Результат раскрытия выражения из Watch (evalExpr с children), в т.ч. вложенные уровни (Структура, Параметры и т.д.)
			const val = varInfo.value as {
				type?: string;
				children?: Array<{ name: string; value: string; typeName?: string }>;
				expression?: string;
				frameIndex?: number;
				threadId?: number;
			};
			if (val?.type === 'evalChildren') {
				const frameIndex = val.frameIndex ?? 0;
				const threadId = val.threadId ?? 1;
				const parentExpr = varInfo.path.replace(/^eval:/, '');
				if (val.expression && (!val.children || val.children.length === 0) && this.rdbgClient && this.attached) {
					const target = this.targets[threadId - 1] ?? this.targets[0];
					if (target) {
						const nestedCacheKey = `${target.id}:${frameIndex}:${val.expression}`;
						try {
							let result = await this.rdbgClient.evalExpr(
								{ infoBaseAlias: this.rdbgInfoBaseAlias, idOfDebuggerUi: this.debuggerId },
								{ id: target.id },
								val.expression,
								frameIndex,
							);
							// Соответствие: interfaces=context даёт пустой результат — fallback на interfaces=enum
							const isCorrespondence = /Соответствие/i.test(result.typeName ?? '');
							if (isCorrespondence && (!result.children || result.children.length === 0)) {
								try {
									const enumResult = await this.rdbgClient.evalExprEnum(
										{ infoBaseAlias: this.rdbgInfoBaseAlias, idOfDebuggerUi: this.debuggerId },
										{ id: target.id },
										val.expression,
										frameIndex,
									);
									if (enumResult.collectionRows && enumResult.collectionRows.length > 0) {
										result = {
											...result,
											children: enumResult.collectionRows.map((row) => {
												const keyCell = row.cells.find((c) => /^Ключ$/i.test(c.name));
												const valCell = row.cells.find((c) => /^Значение$/i.test(c.name));
												return {
													name: keyCell?.value ?? `[${row.index}]`,
													value: valCell?.value ?? '',
													typeName: valCell?.typeName,
												};
											}),
										};
									}
								} catch {
									// оставляем result как есть
								}
							}
							// МенеджерВременныхТаблиц: не вычислять элементы коллекций — зацикливание
							const isUnderManagerTempTables = /МенеджерВременныхТаблиц/i.test(val.expression ?? '');
							// ТаблицаЗначений: interfaces=context даёт только Колонки/Индексы — fallback на interfaces=collection для строк
							const isTable = /ТаблицаЗначений/i.test(result.typeName ?? '');
							const onlyMetadata =
								result.children?.length === 2 &&
								result.children.every((c) => /^(Колонки|Индексы)$/i.test(c.name));
							if (isTable && onlyMetadata && (result.collectionSize ?? 0) > 0 && !isUnderManagerTempTables) {
								try {
									const collResult = await this.rdbgClient.evalExprCollection(
										{ infoBaseAlias: this.rdbgInfoBaseAlias, idOfDebuggerUi: this.debuggerId },
										{ id: target.id },
										val.expression,
										frameIndex,
									);
									if (collResult.collectionRows && collResult.collectionRows.length > 0) {
										const rowChildren = collResult.collectionRows.map((row) => {
											const summary = row.cells.map((c) => `${c.name}=${c.value}`).join(', ');
											return { name: `[${row.index}]`, value: summary, typeName: 'СтрокаТаблицыЗначений' };
										});
										val.children = [...(result.children ?? []), ...rowChildren];
									}
								} catch {
									// оставляем result.children (Колонки, Индексы)
								}
							}
							// ВременныеТаблицыЗапроса: показывать список таблиц [0],[1],[2]
							const isTempTables = /ВременныеТаблицыЗапроса/i.test(result.typeName ?? '');
							if (isTempTables && (result.collectionSize ?? 0) > 0 && (!result.children || result.children.length === 0)) {
								try {
									const collResult = await this.rdbgClient.evalExprCollection(
										{ infoBaseAlias: this.rdbgInfoBaseAlias, idOfDebuggerUi: this.debuggerId },
										{ id: target.id },
										val.expression,
										frameIndex,
									);
									if (collResult.collectionRows && collResult.collectionRows.length > 0) {
										val.children = collResult.collectionRows.map((row) => {
											const summary = row.cells.map((c) => `${c.name}=${c.value}`).join(', ');
											return { name: `[${row.index}]`, value: summary, typeName: 'ВременнаяТаблицаЗапроса' };
										});
									}
								} catch {
									// оставляем result
								}
							}
							if (!val.children || val.children.length === 0) {
								if (result.children && result.children.length > 0) {
									val.children = result.children;
								}
							}
							if (!val.children || val.children.length === 0) {
								const cachedNested = this.evalExprCache.get(nestedCacheKey);
								if (cachedNested?.children && cachedNested.children.length > 0) {
									val.children = cachedNested.children;
								}
							}
						} catch (e) {
							// 400 «только в остановленном предмете» — отдаём кэш или пустых детей, чтобы колесо не крутилось
							const cachedNested = this.evalExprCache.get(nestedCacheKey);
							if (cachedNested?.children && cachedNested.children.length > 0) {
								val.children = cachedNested.children;
							}
						}
					}
				}
				const childrenList = Array.isArray(val.children) ? val.children : [];
				const isExpandable = (typeName?: string) => {
					const t = (typeName ?? '').trim();
					if (!t) return false;
					if (/^(Число|Строка|Булево|Дата|Неопределено|Null|УникальныйИдентификатор|ВременнаяТаблицаЗапроса)$/i.test(t)) return false;
					return true;
				};
				const variables = childrenList.map((c) => {
					const expandable = isExpandable(c.typeName);
					let variablesReference = 0;
					const nestedExpr = parentExpr ? (parentExpr.includes('.') ? `${parentExpr}.${c.name}` : `${parentExpr}.${c.name}`) : c.name;
					if (expandable && parentExpr) {
						variablesReference = this.references.registerVariable(`eval:${nestedExpr}`, {
							type: 'evalChildren',
							expression: nestedExpr,
							frameIndex,
							threadId: val.threadId ?? 1,
							children: [],
						});
					}
					return {
						name: c.name,
						value: c.value,
						type: c.typeName,
						variablesReference,
						evaluateName: nestedExpr,
					};
				});
				sendOnce({ variables });
				return;
			}

			// Локальные переменные (scope «Локальные»)
			if (!FETCH_LOCAL_VARIABLES) {
				sendOnce({ variables: [] });
				return;
			}
			if (!this.rdbgClient || !this.attached) {
				sendOnce({ variables: [] });
				return;
			}
			const scopeVal = varInfo.value as { frameIndex?: number; threadId?: number };
			const frameIndex = Math.max(0, scopeVal?.frameIndex ?? 0);
			const threadId = scopeVal?.threadId ?? 1;
			const target = this.targets[threadId - 1] ?? this.targets[0];
			if (!target) {
				sendOnce({ variables: [] });
				return;
			}

			// RDBG возвращает только контекст текущего кадра (stackLevel в запросе не передаётся).
			// Для родительских кадров (frameIndex > 0) переменные недоступны.
			if (frameIndex > 0) {
				sendOnce({ variables: [] });
				return;
			}

			const isExpandableType = (typeName?: string): boolean => {
				const t = (typeName ?? '').trim();
				if (!t) return false;
				if (/^(Число|Строка|Булево|Дата|Неопределено|Null|УникальныйИдентификатор)$/i.test(t)) return false;
				return true;
			};

			const exprStore: ExprEvaluatedStore = {
				take: (id) => {
					const r = this.exprEvaluatedStore.get(id);
					if (r) this.exprEvaluatedStore.delete(id);
					return r;
				},
			};
			const base = { infoBaseAlias: this.rdbgInfoBaseAlias, idOfDebuggerUi: this.debuggerId };
			const targetReq = { id: target.id };
			let result: { variables: Array<{ name: string; value: string; typeName?: string }> };
			try {
				// Один запрос evalLocalVariables (контекст) — быстрее batch, batch в фоне для раскрытия
				result = await this.rdbgClient.evalLocalVariables(base, targetReq, frameIndex, exprStore);
				if (result.variables.length === 0) {
					const delays = this.timingConfig.variablesRequestRetryDelaysMs ?? [50, 100, 150];
					for (const d of delays) {
						await new Promise((r) => setTimeout(r, d));
						result = await this.rdbgClient.evalLocalVariables(base, targetReq, frameIndex, exprStore);
						if (result.variables.length > 0) break;
					}
				}
			} catch (err) {
				// 400 «только в остановленном предмете» — после F10/F11 сервер может быть ещё не готов, повторяем с паузой
				if (OnecDebugSession.isEvalOnlyWhenStoppedError(err)) {
					result = { variables: [] };
					for (const delayMs of [50, 100, 150]) {
						await new Promise((r) => setTimeout(r, delayMs));
						try {
							result = await this.rdbgClient.evalLocalVariables(base, targetReq, frameIndex, exprStore);
							if (result.variables.length > 0) break;
						} catch {
							// продолжим цикл
						}
					}
					if (!result || result.variables.length === 0) {
						sendOnce({ variables: [] });
						return;
					}
					// result есть, пойдём в общий путь маппинга
				} else {
					sendOnce({
						variables: [
							{
								name: 'Ошибка',
								value: `Не удалось получить переменные: ${err instanceof Error ? err.message : String(err)}`,
								variablesReference: 0,
							},
						],
					});
					return;
				}
			}

			let variables = result.variables.map(v => {
				const expandable = isExpandableType(v.typeName);
				let variablesReference = 0;
				if (expandable) {
					variablesReference = this.references.registerVariable(`eval:${v.name}`, {
						type: 'evalChildren',
						expression: v.name,
						frameIndex,
						threadId,
						children: [],
					});
				}
				return {
					name: v.name,
					value: v.value,
					type: v.typeName ?? '',
					variablesReference,
					evaluateName: v.name,
				};
			});

			if (variables.length === 0) {
				const stack = this.threadsCallStack.get(threadId) ?? [];
				const item = stack[frameIndex];
				if (item && typeof item.lineNo !== 'undefined') {
						const root = this.rootProject || '';
						let modulePath = '';
						const extName = (item.moduleId?.extensionName ?? '').trim();
						if (item.moduleId?.objectId && item.moduleId?.propertyId) {
							modulePath = getModulePathByObjectProperty(root, item.moduleId.objectId, item.moduleId.propertyId, extName);
						}
						if (!modulePath && item.moduleIdStr?.trim()) {
							modulePath = getModulePathByModuleIdStr(root, item.moduleIdStr, extName);
						}
						if (!modulePath) {
							const active = vscode.window.activeTextEditor;
							if (active?.document.fileName.toLowerCase().endsWith('.bsl')) {
								modulePath = active.document.uri.fsPath;
							}
						}
						const lineNo = typeof item.lineNo === 'number' ? item.lineNo : parseInt(String(item.lineNo ?? 0), 10) || 1;
						if (modulePath) {
							const names = await getVariableNamesFromProcedureAtLine(modulePath, lineNo, root);
							variables = names.map(name => ({
								name,
								value: '',
								type: '',
								variablesReference: 0,
								evaluateName: name,
							}));
						}
				}
			}

			sendOnce({ variables });
			// Батч по раскрываемым в фоне — при раскрытии узла данные уже в кэше
			const expandableNames = variables.filter((v) => isExpandableType(v.type)).map((v) => v.name);
			if (expandableNames.length > 0) {
				void this.rdbgClient.evalLocalVariablesBatch(base, targetReq, frameIndex, expandableNames, exprStore).then((batch) => {
					for (const [expr, evalResult] of Object.entries(batch.childrenByExpression)) {
						this.evalExprCache.set(`${target.id}:${frameIndex}:${expr}`, {
							result: evalResult.result ?? '',
							typeName: evalResult.typeName,
							children: evalResult.children,
							variablesRef: 0,
						});
					}
				}).catch(() => {});
			}
		} finally {
			if (!responseSent) {
				response.body = { variables: [] };
				this.sendResponse(response);
			}
		}
	}

	protected override async continueRequest(
		response: DebugProtocol.ContinueResponse,
		args: DebugProtocol.ContinueArguments,
		_request?: DebugProtocol.Request,
	): Promise<void> {
		this.threadsCallStack.clear();
		await this.sendStepAction('Continue', args.threadId);
		response.body = { allThreadsContinued: true };
		this.sendResponse(response);
	}

	protected override async nextRequest(
		response: DebugProtocol.NextResponse,
		args: DebugProtocol.NextArguments,
		_request?: DebugProtocol.Request,
	): Promise<void> {
		await this.sendStepAction('Step', args.threadId);
		this.scheduleRefreshStackAndReveal(args.threadId);
		this.sendResponse(response);
	}

	protected override async stepInRequest(
		response: DebugProtocol.StepInResponse,
		args: DebugProtocol.StepInArguments,
		_request?: DebugProtocol.Request,
	): Promise<void> {
		await this.sendStepAction('StepIn', args.threadId);
		this.scheduleRefreshStackAndReveal(args.threadId, true);
		this.scheduleImmediatePingForCallStack(args.threadId);
		this.sendResponse(response);
	}

	protected override async stepOutRequest(
		response: DebugProtocol.StepOutResponse,
		args: DebugProtocol.StepOutArguments,
		_request?: DebugProtocol.Request,
	): Promise<void> {
		await this.sendStepAction('StepOut', args.threadId);
		this.scheduleRefreshStackAndReveal(args.threadId, true);
		this.scheduleImmediatePingForCallStack(args.threadId);
		this.sendResponse(response);
	}

	private async sendStepAction(action: DebugStepAction, threadId: number): Promise<void> {
		if (!this.rdbgClient || !this.attached) {
			return;
		}
		const target = this.targets[threadId - 1] ?? this.targets[0];
		if (!target?.id) {
			return;
		}
		const base = { infoBaseAlias: this.rdbgInfoBaseAlias, idOfDebuggerUi: this.debuggerId };
		try {
			// rdbg setBreakOnNextStatement перед step — не требует targetIDStr.
			if (action !== 'Continue') {
				try {
					await this.rdbgClient.setBreakOnNextStatement(base);
				} catch {
					// игнорируем
				}
			}
			const stepResponse = await this.rdbgClient.step(base, { id: target.id }, action);
			this.mergeTargetIDStrFromResponse(stepResponse);
			// evalExprStartStop — управление вычислениями на сервере, снижает память dbgs.exe. По умолчанию выключен — на части платформ может завершать отладку.
			const evalExprStartStopEnabled = vscode.workspace.getConfiguration('1c-dev-tools').get<boolean>('debug.evalExprStartStopEnabled', false);
			const targetIDStr = this.getTargetIDStr(target);
			if (evalExprStartStopEnabled && targetIDStr) {
				try {
					await this.rdbgClient.evalExprStartStopRemoteDebuggerRunTime(base, targetIDStr, {
						breakOnNextLine: action !== 'Continue',
						bpVersion: this.lastBpVersion,
						rteProcVersion: this.rteProcVersionByTargetId.get(target.id),
					});
				} catch {
					// игнорируем ошибки evalExprStartStop
				}
			}
		} catch {
			// игнорируем ошибки шага
		}
	}

	protected override async setExceptionBreakPointsRequest(
		response: DebugProtocol.SetExceptionBreakpointsResponse,
		args: DebugProtocol.SetExceptionBreakpointsArguments,
		_request?: DebugProtocol.Request,
	): Promise<void> {
		// Обработка exception breakpoints через setBreakOnRTE
		const filters = args.filters ?? [];
		const stopOnErrors = filters.includes('all') || filters.includes('error');

		if (this.attached && this.rdbgClient) {
			try {
				await this.rdbgClient.setBreakOnRTE(
					{ infoBaseAlias: this.rdbgInfoBaseAlias, idOfDebuggerUi: this.debuggerId },
					stopOnErrors,
				);
			} catch {
				// игнорируем ошибки setBreakOnRTE
			}
		}

		response.body = { breakpoints: [] };
		this.sendResponse(response);
	}

	protected override async evaluateRequest(
		response: DebugProtocol.EvaluateResponse,
		args: DebugProtocol.EvaluateArguments,
		_request?: DebugProtocol.Request,
	): Promise<void> {
		if (!this.rdbgClient || !this.attached || !args.expression) {
			response.body = { result: '', variablesReference: 0 };
			this.sendResponse(response);
			return;
		}

		// frameId = threadId*10000 + 1000 + i (как в stackTraceRequest)
		const frameId = args.frameId ?? 0;
		const threadId = frameId >= 10000 ? Math.floor(frameId / 10000) : 1;
		const frameIndex = frameId >= 1000 ? Math.max(0, (frameId % 10000) - 1000) : 0;
		const target = this.targets[threadId - 1] ?? this.targets[0];
		if (!target) {
			response.body = {
				result: 'Нет активной цели отладки',
				variablesReference: 0,
			};
			this.sendResponse(response);
			return;
		}

		const cacheKey = `${target.id}:${frameIndex}:${args.expression.trim()}`;
		const cached = this.evalExprCache.get(cacheKey);
		if (cached && (cached.variablesRef === 0 || this.references.getVariable(cached.variablesRef))) {
			response.body = {
				result: cached.result || cached.typeName || '',
				variablesReference: cached.variablesRef,
			};
			this.sendResponse(response);
			if (args.context === 'watch') {
				const lastEval = this.lastEvalExprByCacheKey.get(cacheKey) ?? 0;
				if (Date.now() - lastEval > 1500) {
					void this.evalExprWatchAndInvalidate(cacheKey, args.expression, frameIndex, threadId, target);
				}
			}
			return;
		}

		// Для Watch — сразу «Неопределено», затем фоновый запрос и InvalidatedEvent при ответе
		if (args.context === 'watch') {
			response.body = { result: 'Неопределено', variablesReference: 0 };
			this.sendResponse(response);
			void this.evalExprWatchAndInvalidate(cacheKey, args.expression, frameIndex, threadId, target);
			return;
		}

		try {
			let result = await this.rdbgClient.evalExpr(
				{ infoBaseAlias: this.rdbgInfoBaseAlias, idOfDebuggerUi: this.debuggerId },
				{ id: target.id },
				args.expression,
				frameIndex,
			);
			if (result.error) {
				response.body = { result: result.error, variablesReference: 0 };
				this.sendResponse(response);
				return;
			}
			// Соответствие: interfaces=context даёт пустой результат — fallback на interfaces=enum
			const isCorrespondence = /Соответствие/i.test(result.typeName ?? '');
			if (isCorrespondence && (!result.children || result.children.length === 0)) {
				try {
					const enumResult = await this.rdbgClient.evalExprEnum(
						{ infoBaseAlias: this.rdbgInfoBaseAlias, idOfDebuggerUi: this.debuggerId },
						{ id: target.id },
						args.expression,
						frameIndex,
					);
					if (enumResult.collectionRows && enumResult.collectionRows.length > 0) {
						const children: EvalExprResult['children'] = enumResult.collectionRows.map((row) => {
							const keyCell = row.cells.find((c) => /^Ключ$/i.test(c.name));
							const valCell = row.cells.find((c) => /^Значение$/i.test(c.name));
							return {
								name: keyCell?.value ?? `[${row.index}]`,
								value: valCell?.value ?? '',
								typeName: valCell?.typeName,
							};
						});
						result = { ...result, children };
					}
				} catch {
					// оставляем result как есть
				}
			}
			const serverReturnedEmpty = !(result.result ?? '').trim() && (!result.children || result.children.length === 0);
			if (serverReturnedEmpty) {
				const cachedOnEmpty = this.evalExprCache.get(cacheKey);
				if (cachedOnEmpty && (cachedOnEmpty.result || cachedOnEmpty.children?.length || cachedOnEmpty.variablesRef)) {
					response.body = {
						result: cachedOnEmpty.result || cachedOnEmpty.typeName || '',
						variablesReference: cachedOnEmpty.variablesRef,
					};
				} else {
					response.body = { result: result.result || result.typeName || '', variablesReference: 0 };
				}
				this.sendResponse(response);
				return;
			}
			let variablesReference = 0;
			if (result.children && result.children.length > 0) {
				const threadId = frameId >= 10000 ? Math.floor(frameId / 10000) : 1;
				variablesReference = this.references.registerVariable(`eval:${args.expression}`, {
					type: 'evalChildren',
					expression: args.expression,
					children: result.children,
					frameIndex,
					threadId,
				});
			}
			this.evalExprCache.set(cacheKey, {
				result: result.result ?? '',
				typeName: result.typeName,
				children: result.children,
				variablesRef: variablesReference,
			});
			response.body = {
				result: result.result || result.typeName || '',
				variablesReference,
			};
		} catch (err) {
			// 400 «только в остановленном предмете» — после F10/F11 повторяем с паузой
			if (OnecDebugSession.isEvalOnlyWhenStoppedError(err)) {
				await new Promise((r) => setTimeout(r, this.timingConfig.varFetchDelayMs));
				try {
					const retryResult = await this.rdbgClient.evalExpr(
						{ infoBaseAlias: this.rdbgInfoBaseAlias, idOfDebuggerUi: this.debuggerId },
						{ id: target.id },
						args.expression,
						frameIndex,
					);
					if (retryResult.error) {
						response.body = { result: retryResult.error, variablesReference: 0 };
					} else {
						const rr = retryResult.result ?? '';
						const ch = retryResult.children ?? [];
						let vref = 0;
						if (ch.length > 0) {
							vref = this.references.registerVariable(`eval:${args.expression}`, {
								type: 'evalChildren',
								children: ch,
								frameIndex,
								threadId,
							});
						}
						this.evalExprCache.set(cacheKey, {
							result: rr,
							typeName: retryResult.typeName,
							children: ch,
							variablesRef: vref,
						});
						response.body = { result: rr || retryResult.typeName || '', variablesReference: vref };
					}
					this.sendResponse(response);
					return;
				} catch {
					// оставляем ошибку ниже
				}
			}
			response.body = {
				result: `Ошибка вычисления: ${err instanceof Error ? err.message : String(err)}`,
				variablesReference: 0,
			};
		}
		this.sendResponse(response);
	}
}
