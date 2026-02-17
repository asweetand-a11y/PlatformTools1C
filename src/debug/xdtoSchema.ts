/**
 * Описание XDTO/XSD схем протокола RDBG (1С отладка).
 * Единый источник правды для namespace, имён элементов и типов.
 * За основу взят Messages.cs из onec-debug-adapter (XmlSchemaClassGenerator).
 * Формат платформы 8.3.27: debugBreakpointInfo, moduleInfo (moduleType/moduleName).
 */

/** Namespace URIs (XmlTypeAttribute Namespace). */
export const NS = {
	debugRDBGRequestResponse: 'http://v8.1c.ru/8.3/debugger/debugRDBGRequestResponse',
	debugBreakpoints: 'http://v8.1c.ru/8.3/debugger/debugBreakpoints',
	debugBaseData: 'http://v8.1c.ru/8.3/debugger/debugBaseData',
	debugRTEFilter: 'http://v8.1c.ru/8.3/debugger/debugRTEFilter',
	debugAutoAttach: 'http://v8.1c.ru/8.3/debugger/debugAutoAttach',
	xsi: 'http://www.w3.org/2001/XMLSchema-instance',
} as const;

/** BSLModuleType из debugBaseData.xsd + внутренние типы metadataProvider (ConfigModule, ManagedFormModule). */
export type BslModuleTypeEnum =
	| 'Unknown'
	| 'ConfigModule'
	| 'FormModule'
	| 'ObjectModule'
	| 'ManagerModule'
	| 'RecordSetModule'
	| 'ValueManagerModule'
	| 'CommandModule'
	| 'CommonModule'
	| 'SessionModule'
	| 'ExternalConnectionModule'
	| 'ManagedApplicationModule'
	| 'OrdinaryApplicationModule'
	| 'ManagedFormModule'
	| 'OrdinaryFormModule'
	| 'EventSubscription'
	| 'ScheduledJob'
	| 'DataProcessor'
	| 'Report'
	| 'IntegratedApplicationModule'
	| 'OperationModule'
	| 'ReportModule'
	| 'DynamicListModule'
	| 'HTTPServiceModule'
	| 'WebHookServiceModule'
	| 'ScheduledJobModule'
	| 'EventJobModule'
	| 'BotServiceModule'
	| 'ExternalReportModule'
	| 'ExternalDataProcessorModule';

/** ModuleInfo (debugBaseData) — moduleType, moduleName. */
export interface ModuleInfo {
	moduleType: string;
	moduleName: string;
}

/** ModuleIdWithInfo (debugBreakpoints) — вложенный moduleInfo. */
export interface ModuleIdWithInfo {
	moduleInfo: ModuleInfo;
}

/** DebugBreakpointInfo (debugBreakpoints) — одна точка останова. */
export interface DebugBreakpointInfo {
	id: string;
	line: number;
	condition: string;
	hitCount: number;
	moduleId: ModuleIdWithInfo;
	enabled: boolean;
}

/** BpWorkspace (debugBreakpoints) — массив debugBreakpointInfo. */
export interface BpWorkspace {
	debugBreakpointInfo: DebugBreakpointInfo[];
}

/** DbgTargetInfo (debugBaseData) — id, infobaseAlias. */
export interface DbgTargetInfo {
	id: string;
	infobaseAlias?: string;
}

/** RDbgBaseRequest (debugRDBGRequestResponse) — базовые поля запроса. */
export interface RDbgBaseRequestSchema {
	infoBaseAlias: string;
	idOfDebuggerUI: string;
}

/** RdbgSetBreakpointsRequest — RDbgBaseRequest + bpWorkspace. */
export interface RdbgSetBreakpointsRequestSchema extends RDbgBaseRequestSchema {
	bpWorkspace: BpWorkspace;
}

/** Regex для uuid (debugBaseData). */
export const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Имена элементов debugBreakpointInfo (порядок = sequence в XSD). */
export const DebugBreakpointInfoElements = {
	id: 'id',
	line: 'line',
	condition: 'condition',
	hitCount: 'hitCount',
	moduleId: 'moduleId',
	enabled: 'enabled',
} as const;

/** Имена элементов moduleInfo. */
export const ModuleInfoElements = {
	moduleType: 'moduleType',
	moduleName: 'moduleName',
} as const;

/** Имена элементов request (RDbgBaseRequest). */
export const RequestElements = {
	infoBaseAlias: 'infoBaseAlias',
	idOfDebuggerUI: 'idOfDebuggerUI',
	bpWorkspace: 'bpWorkspace',
} as const;

/**
 * Корень ответа от сервера (как в onec-debug-adapter RequestSerializer.Deserialize).
 * XmlRootAttribute("response") { Namespace = "http://v8.1c.ru/8.3/debugger/debugBaseData" }
 */
export const ResponseSchema = {
	rootElement: 'response',
	namespace: NS.debugBaseData,
} as const;

/** CmdId для полиморфных Result в ping (DbguiExtCmds). */
export const DbguiExtCmds = {
	CallStackFormed: 'callStackFormed',
	TargetStarted: 'targetStarted',
	TargetQuit: 'targetQuit',
	ExprEvaluated: 'exprEvaluated',
	RteProcessing: 'rteProcessing',
} as const;
