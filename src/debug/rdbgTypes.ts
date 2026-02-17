/**
 * Типы запросов и ответов протокола 1С отладки (RDBG).
 * Соответствуют подмножеству Messages.cs onec-debug-adapter.
 */

/** Базовые поля каждого RDBG-запроса */
export interface RDbgBaseRequest {
	infoBaseAlias: string;
	idOfDebuggerUi: string;
}

/** Результат attachDebugUI (значения в XML от 1С). */
export enum AttachDebugUiResult {
	Unknown = 'unknown',
	Registered = 'registered',
	CredentialsRequired = 'credentialsRequired',
	IbInDebug = 'ibInDebug',
	NotRegistered = 'notRegistered',
	FullCredentialsRequired = 'fullCredentialsRequired',
}

/** Человекочитаемое сообщение по коду результата attachDebugUI. */
export function getAttachResultMessage(result: string): string {
	const normalized = String(result).trim().toLowerCase();
	const messages: Record<string, string> = {
		unknown: 'Неизвестная ошибка при подключении к серверу отладки.',
		registered: 'Подключение выполнено.',
		credentialsrequired: 'Требуется указать учётные данные для доступа к серверу отладки.',
		fullcredentialsrequired: 'Требуется полная аутентификация на сервере отладки.',
		ibindebug: 'Информационная база уже отлаживается. Завершите другой сеанс отладки или перезапустите сервер отладки (dbgs).',
		iblndebug: 'Информационная база уже отлаживается. Завершите другой сеанс отладки или перезапустите сервер отладки (dbgs).',
		notregistered: 'Не удалось подключиться к серверу отладки. Проверьте, что dbgs запущен и доступен по указанному адресу и порту.',
	};
	return messages[normalized] ?? `Ошибка отладки: ${result}.`;
}

export interface RdbgAttachDebugUiResponse {
	result: AttachDebugUiResult;
}

export interface RdbgDetachDebugUiResponse {
	result: boolean;
}

export interface DebuggerOptions {
	foregroundAbility?: boolean;
}

export interface RdbgAttachDebugUiRequest extends RDbgBaseRequest {
	options?: DebuggerOptions;
}

/** Лёгкий идентификатор цели отладки (для запросов). */
export interface DebugTargetIdLight {
	id: string;
}

/** Элемент ответа getDbgTargets (полный DebugTargetId в XML). */
export interface DebugTargetId {
	id: string;
	seanceId?: string;
	seanceNo?: number;
	infoBaseAlias?: string;
	targetType?: string;
	userName?: string;
	[key: string]: unknown;
}

export interface RdbgsGetDbgTargetsResponse {
	id?: DebugTargetId[] | DebugTargetId;
}

/** Действие шага отладки (значения в XML 1С). */
export type DebugStepAction = 'Continue' | 'Step' | 'StepIn' | 'StepOut';

export interface RdbgStepRequest extends RDbgBaseRequest {
	targetID: DebugTargetIdLight;
	action: DebugStepAction;
	simple?: boolean;
}

/** Тип модуля 1С (namespace debugBaseData). */
export type BslModuleType = 'ConfigModule' | 'ExtensionModule';

/** Идентификатор модуля для setBreakpoints (BslModuleIdInternal). Как в onec-debug-adapter: только type, extensionName, objectId, propertyId (URL не передаём). */
export interface BslModuleIdInternal {
	type: BslModuleType;
	extensionName: string;
	objectId: string;
	propertyId: string;
	extId?: number;
}

/** Одна точка останова в формате RDBG (BreakpointInfo). */
export interface BreakpointInfoRdbg {
	line: number;
	isActive?: boolean;
	breakOnCondition?: boolean;
	condition?: string;
	breakOnHitCount?: boolean;
	hitCount?: number;
	showOutputMessage?: boolean;
	putExpressionResult?: string;
	continueExecution?: boolean;
}

/** Модуль и его точки останова для setBreakpoints (ModuleBpInfoInternal). */
export interface ModuleBpInfoInternal {
	id: BslModuleIdInternal;
	bpInfo: BreakpointInfoRdbg[];
}

/** db:type для точки останова (http://v8.1c.ru/debug/db). */
export type DbModuleType = 'FormModule' | 'ObjectModule' | 'CommonModule' | 'ManagerModule' | 'Module';

/** BSLModuleType из XDTO-схемы debugBaseData (xdtoSchema). */
import type { BslModuleTypeEnum } from './xdtoSchema';
export type { BslModuleTypeEnum };

/** Модуль и точки останова для setBreakpoints. Поддерживаются форматы: moduleInfo (moduleType/moduleName) и BslModuleIdInternal (objectID/propertyID). */
export interface ModuleBpInfoForRequest {
	/** Имя расширения (пустая строка для основной конфигурации) */
	extension: string;
	/** GUID объекта метаданных (из Configuration.xml, Document.xml и т.д.) */
	objectId: string;
	/** GUID свойства/модуля (фиксированный по типу модуля: ObjectModule, ManagerModule и т.д.) */
	propertyId: string;
	/** Тип модуля BSL (для маппинга в BslModuleType enum) */
	bslModuleType: BslModuleTypeEnum;
	/** Строковый идентификатор модуля для формата moduleInfo (например Документ.Приказ.Module) */
	moduleIdString?: string;
	/** Точки останова в этом модуле */
	bpInfo: BreakpointInfoRdbg[];
}

/** Запрос установки точек останова в RDBG. Формат 8.3.27: moduleType/moduleName (moduleInfo). */
export interface RdbgSetBreakpointsRequest extends RDbgBaseRequest {
	bpWorkspace: ModuleBpInfoForRequest[];
}

/** Элемент стека вызовов из CallStackFormed (StackItemViewInfoData). */
export interface StackItemViewInfoData {
	moduleId?: BslModuleIdInternal;
	lineNo?: number;
	presentation?: string;
	isFantom?: boolean;
	moduleIdStr?: string;
	[key: string]: unknown;
}

/** Причина остановки в CallStackFormed. */
export type CallStackStopReason = 'Breakpoint' | 'Step' | 'Exception';

/** Результат ping: событие CallStackFormed (остановка по breakpoint/step/exception). */
export interface CallStackFormedResult {
	callStack: StackItemViewInfoData[];
	targetId: string;
	reason: CallStackStopReason;
	stopByBp?: boolean;
	suspendedByOther?: boolean;
}

/** Один результат exprEvaluated в ping (результат вычисления, доставленный асинхронно в ping). */
export interface ExprEvaluatedItem {
	expressionResultID: string;
	result: EvalExprResult;
}

/** Результат pingDebugUIParams со всеми возможными событиями */
export interface PingDebugUIParamsResult {
	/** Событие targetStarted - новая цель отладки появилась */
	targetStarted?: DebugTargetId[];
	/** Событие targetQuit - цель отладки завершилась */
	targetQuit?: DebugTargetId[];
	/** Событие callStackFormed - останов на брейкпойнте/шаге */
	callStackFormed?: CallStackFormedResult;
	/** Результаты вычислений expr, доставленные асинхронно (evalLocalVariables/evalExpr). */
	exprEvaluated?: ExprEvaluatedItem[];
}

/** Результат pingDebugUIParams: коллекция Result (может содержать CallStackFormed). */
export interface RdbgPingDebugUiResponse {
	result?: unknown | unknown[];
}

/** Дочерняя переменная из result evalExpr (valueOfContextPropInfo) для отображения в Watch. */
export interface EvalExprChild {
	name: string;
	value: string;
	typeName?: string;
}

/** Результат вычисления выражения evalExpr. */
export interface EvalExprResult {
	/** Краткая строка для отображения (тип, размер коллекции или значение). */
	result: string;
	/** Ошибка вычисления (если есть) */
	error?: string;
	/** Имя типа (например, ВыборкаИзРезультатаЗапроса). */
	typeName?: string;
	/** Есть ли дочерние свойства для раскрытия в Watch. */
	isExpandable?: boolean;
	/** Размер коллекции (если есть). */
	collectionSize?: number;
	/** Дочерние свойства (поля/элементы) для variablesReference. */
	children?: EvalExprChild[];
}

/** Локальная переменная из evalLocalVariables. */
export interface LocalVariable {
	name: string;
	value: string;
	typeName?: string;
}

/** Результат evalLocalVariables. */
export interface EvalLocalVariablesResult {
	variables: LocalVariable[];
}

/** Результат батч-запроса evalLocalVariables (контекст + дочерние выражения в одном запросе). */
export interface EvalLocalVariablesBatchResult {
	variables: LocalVariable[];
	/** Результаты по путям раскрываемых выражений (имя или путь, например "Запрос", "Запрос.Параметры"). */
	childrenByExpression: Record<string, EvalExprResult>;
}

/** Параметры для initSettings. */
export interface InitialDebugSettings {
	// Пока пустые настройки, расширим при необходимости
}

/** Параметры для attachDetachDbgTargets. */
export interface AttachDetachTargetsCommand {
	attach?: string[]; // массив ID целей для подключения
	detach?: string[]; // массив ID целей для отключения
}

/** Настройки автоподключения для setAutoAttachSettings. */
export interface AutoAttachSettings {
	targetTypes: Array<{ type: string; autoAttach: boolean }>;
}
