/**
 * HTTP-клиент к серверу отладки 1С (e1crdbg).
 * Отправляет XML-запросы, парсит XML-ответы.
 * Использует Node.js http для совместимости и понятных ошибок сети (ECONNREFUSED, ENOTFOUND).
 *
 * Формат запросов RDBG (из EMF-модели EDT): docs/RDBG_REQUEST_FORMAT.md
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
	RDbgBaseRequest,
	RdbgAttachDebugUiRequest,
	RdbgAttachDebugUiResponse,
	DebuggerOptions,
	RdbgsGetDbgTargetsResponse,
	DebugTargetIdLight,
	DebugTargetId,
	DebugStepAction,
	RdbgSetBreakpointsRequest,
	ModuleBpInfoForRequest,
	BreakpointInfoRdbg,
	CallStackFormedResult,
	PingDebugUIParamsResult,
	StackItemViewInfoData,
	BslModuleIdInternal,
	EvalExprResult,
	EvalLocalVariablesResult,
	EvalLocalVariablesBatchResult,
	LocalVariable,
	InitialDebugSettings,
	AttachDetachTargetsCommand,
	AutoAttachSettings,
} from './rdbgTypes';
import { XMLParser } from 'fast-xml-parser';
import { NS, ResponseSchema, DbguiExtCmds } from './xdtoSchema';

function buildBaseRequestXml(base: RDbgBaseRequest): string {
	return `<infoBaseAlias>${escapeXml(base.infoBaseAlias)}</infoBaseAlias><idOfDebuggerUI>${escapeXml(base.idOfDebuggerUi)}</idOfDebuggerUI>`;
}

/** Обёртка request (как XmlRootAttribute("request") в onec-debug-adapter). */
function buildRequestBody(content: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?><request xmlns="${NS.debugRDBGRequestResponse}">${content}</request>`;
}

/** Формат step по трафику Конфигуратора: default NS = debugBaseData, элементы RDBG с префиксом, id внутри targetID в default NS (debugBaseData), два idOfDebuggerUI, без simple. */
const STEP_REQUEST_NAMESPACES =
	`xmlns="http://v8.1c.ru/8.3/debugger/debugBaseData" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:debugRDBGRequestResponse="${NS.debugRDBGRequestResponse}" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`;

function buildStepRequestBody(base: RDbgBaseRequest, targetId: DebugTargetIdLight, action: DebugStepAction): string {
	const alias = escapeXml(base.infoBaseAlias);
	const dbgui = escapeXml(base.idOfDebuggerUi);
	const id = escapeXml(targetId.id);
	return `<?xml version="1.0" encoding="UTF-8"?><request ${STEP_REQUEST_NAMESPACES}>` +
		`<debugRDBGRequestResponse:infoBaseAlias>${alias}</debugRDBGRequestResponse:infoBaseAlias>` +
		`<debugRDBGRequestResponse:idOfDebuggerUI>${dbgui}</debugRDBGRequestResponse:idOfDebuggerUI>` +
		`<debugRDBGRequestResponse:idOfDebuggerUI>${dbgui}</debugRDBGRequestResponse:idOfDebuggerUI>` +
		`<debugRDBGRequestResponse:targetID><id>${id}</id></debugRDBGRequestResponse:targetID>` +
		`<debugRDBGRequestResponse:action>${action}</debugRDBGRequestResponse:action>` +
		`</request>`;
}

/** Формат getCallStack по трафику Конфигуратора: default NS debugBaseData, элементы с префиксом debugRDBGRequestResponse, элемент id (не targetID), один idOfDebuggerUI. */
function buildGetCallStackRequestBody(base: RDbgBaseRequest, targetId: DebugTargetIdLight): string {
	const alias = escapeXml(base.infoBaseAlias);
	const dbgui = escapeXml(base.idOfDebuggerUi);
	const id = escapeXml(targetId.id);
	return `<?xml version="1.0" encoding="UTF-8"?><request ${STEP_REQUEST_NAMESPACES}>` +
		`<debugRDBGRequestResponse:infoBaseAlias>${alias}</debugRDBGRequestResponse:infoBaseAlias>` +
		`<debugRDBGRequestResponse:idOfDebuggerUI>${dbgui}</debugRDBGRequestResponse:idOfDebuggerUI>` +
		`<debugRDBGRequestResponse:id><id>${id}</id></debugRDBGRequestResponse:id>` +
		`</request>`;
}

/** Формат evalLocalVariables/evalExpr по трафику Конфигуратора: expr с srcCalcInfo (expressionID, expressionResultID, interfaces=context), для evalExpr — calcItem. */
const EVAL_LOCAL_NAMESPACES =
	`xmlns="http://v8.1c.ru/8.3/debugger/debugBaseData" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:debugCalculations="http://v8.1c.ru/8.3/debugger/debugCalculations" xmlns:debugRDBGRequestResponse="${NS.debugRDBGRequestResponse}" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`;

/** Локальные переменные: expr с srcCalcInfo (expressionID, expressionResultID, interfaces=context), presOptions maxTextSize. По трафику Конфигуратора stackLevel в запросе не передаётся — сервер возвращает контекст текущего кадра. */
function buildEvalLocalVariablesRequestBody(
	base: RDbgBaseRequest,
	targetId: DebugTargetIdLight,
	_stackLevel: number,
): { body: string; expressionResultID: string } {
	const alias = escapeXml(base.infoBaseAlias);
	const dbgui = escapeXml(base.idOfDebuggerUi);
	const id = escapeXml(targetId.id);
	const expressionID = randomUUID();
	const expressionResultID = randomUUID();
	const exprBlock =
		`<debugRDBGRequestResponse:expr>` +
		`<debugCalculations:srcCalcInfo>` +
		`<debugCalculations:expressionID>${expressionID}</debugCalculations:expressionID>` +
		`<debugCalculations:expressionResultID>${expressionResultID}</debugCalculations:expressionResultID>` +
		`<debugCalculations:interfaces>context</debugCalculations:interfaces>` +
		`</debugCalculations:srcCalcInfo>` +
		`<debugCalculations:presOptions><debugCalculations:maxTextSize>307200</debugCalculations:maxTextSize></debugCalculations:presOptions>` +
		`</debugRDBGRequestResponse:expr>`;
	const body = `<?xml version="1.0" encoding="UTF-8"?><request ${EVAL_LOCAL_NAMESPACES}>` +
		`<debugRDBGRequestResponse:infoBaseAlias>${alias}</debugRDBGRequestResponse:infoBaseAlias>` +
		`<debugRDBGRequestResponse:idOfDebuggerUI>${dbgui}</debugRDBGRequestResponse:idOfDebuggerUI>` +
		`<debugRDBGRequestResponse:idOfDebuggerUI>${dbgui}</debugRDBGRequestResponse:idOfDebuggerUI>` +
		`<debugRDBGRequestResponse:calcWaitingTime>100</debugRDBGRequestResponse:calcWaitingTime>` +
		`<debugRDBGRequestResponse:targetID><id>${id}</id></debugRDBGRequestResponse:targetID>` +
		exprBlock +
		`</request>`;
	return { body, expressionResultID };
}

/** Вычисление выражения: expr с srcCalcInfo (expressionID, expressionResultID, calcItem с itemType=expression и expression=текст, interfaces=context) — формат CalculationSourceDataStorage из traf. */
function buildEvalExprRequestBody(
	base: RDbgBaseRequest,
	targetId: DebugTargetIdLight,
	expression: string,
	_frameIndex: number,
): { body: string; expressionResultID: string } {
	const alias = escapeXml(base.infoBaseAlias);
	const dbgui = escapeXml(base.idOfDebuggerUi);
	const id = escapeXml(targetId.id);
	const expressionID = randomUUID();
	const expressionResultID = randomUUID();
	const exprText = escapeXml(expression);
	const exprBlock =
		`<debugRDBGRequestResponse:expr>` +
		`<debugCalculations:srcCalcInfo>` +
		`<debugCalculations:expressionID>${expressionID}</debugCalculations:expressionID>` +
		`<debugCalculations:expressionResultID>${expressionResultID}</debugCalculations:expressionResultID>` +
		`<debugCalculations:calcItem><debugCalculations:itemType>expression</debugCalculations:itemType><debugCalculations:expression>${exprText}</debugCalculations:expression></debugCalculations:calcItem>` +
		`<debugCalculations:interfaces>context</debugCalculations:interfaces>` +
		`</debugCalculations:srcCalcInfo>` +
		`</debugRDBGRequestResponse:expr>`;
	const body = `<?xml version="1.0" encoding="UTF-8"?><request ${EVAL_LOCAL_NAMESPACES}>` +
		`<debugRDBGRequestResponse:infoBaseAlias>${alias}</debugRDBGRequestResponse:infoBaseAlias>` +
		`<debugRDBGRequestResponse:idOfDebuggerUI>${dbgui}</debugRDBGRequestResponse:idOfDebuggerUI>` +
		`<debugRDBGRequestResponse:idOfDebuggerUI>${dbgui}</debugRDBGRequestResponse:idOfDebuggerUI>` +
		`<debugRDBGRequestResponse:calcWaitingTime>100</debugRDBGRequestResponse:calcWaitingTime>` +
		`<debugRDBGRequestResponse:targetID><id>${id}</id></debugRDBGRequestResponse:targetID>` +
		exprBlock +
		`</request>`;
	return { body, expressionResultID };
}

/** Батч evalLocalVariables: один запрос с несколькими expr — первый контекст (interfaces=context), остальные дочерние выражения (calcItem itemType=expression, expression=путь). */
function buildEvalLocalVariablesBatchRequestBody(
	base: RDbgBaseRequest,
	targetId: DebugTargetIdLight,
	_stackLevel: number,
	expandableExpressions: string[],
): { body: string; expressionResultIDs: string[] } {
	const alias = escapeXml(base.infoBaseAlias);
	const dbgui = escapeXml(base.idOfDebuggerUi);
	const id = escapeXml(targetId.id);
	const expressionResultIDs: string[] = [];
	const exprBlocks: string[] = [];
	const ctxExpressionID = randomUUID();
	const ctxExpressionResultID = randomUUID();
	expressionResultIDs.push(ctxExpressionResultID);
	exprBlocks.push(
		`<debugRDBGRequestResponse:expr>` +
		`<debugCalculations:srcCalcInfo>` +
		`<debugCalculations:expressionID>${ctxExpressionID}</debugCalculations:expressionID>` +
		`<debugCalculations:expressionResultID>${ctxExpressionResultID}</debugCalculations:expressionResultID>` +
		`<debugCalculations:interfaces>context</debugCalculations:interfaces>` +
		`</debugCalculations:srcCalcInfo>` +
		`<debugCalculations:presOptions><debugCalculations:maxTextSize>307200</debugCalculations:maxTextSize></debugCalculations:presOptions>` +
		`</debugRDBGRequestResponse:expr>`,
	);
	for (const path of expandableExpressions) {
		const expressionID = randomUUID();
		const expressionResultID = randomUUID();
		expressionResultIDs.push(expressionResultID);
		const exprText = escapeXml(path);
		exprBlocks.push(
			`<debugRDBGRequestResponse:expr>` +
			`<debugCalculations:srcCalcInfo>` +
			`<debugCalculations:expressionID>${expressionID}</debugCalculations:expressionID>` +
			`<debugCalculations:expressionResultID>${expressionResultID}</debugCalculations:expressionResultID>` +
			`<debugCalculations:calcItem><debugCalculations:itemType>expression</debugCalculations:itemType><debugCalculations:expression>${exprText}</debugCalculations:expression></debugCalculations:calcItem>` +
			`<debugCalculations:interfaces>context</debugCalculations:interfaces>` +
			`</debugCalculations:srcCalcInfo>` +
			`</debugRDBGRequestResponse:expr>`,
		);
	}
	const body = `<?xml version="1.0" encoding="UTF-8"?><request ${EVAL_LOCAL_NAMESPACES}>` +
		`<debugRDBGRequestResponse:infoBaseAlias>${alias}</debugRDBGRequestResponse:infoBaseAlias>` +
		`<debugRDBGRequestResponse:idOfDebuggerUI>${dbgui}</debugRDBGRequestResponse:idOfDebuggerUI>` +
		`<debugRDBGRequestResponse:idOfDebuggerUI>${dbgui}</debugRDBGRequestResponse:idOfDebuggerUI>` +
		`<debugRDBGRequestResponse:calcWaitingTime>100</debugRDBGRequestResponse:calcWaitingTime>` +
		`<debugRDBGRequestResponse:targetID><id>${id}</id></debugRDBGRequestResponse:targetID>` +
		exprBlocks.join('') +
		`</request>`;
	return { body, expressionResultIDs };
}

function buildRequestInfoXml(base: RDbgBaseRequest): string {
	return `<requestInfo xmlns:xsi="${NS.xsi}" xmlns:b="${NS.debugBaseData}" xsi:type="b:DbgTargetInfo"><id>${escapeXml(base.idOfDebuggerUi)}</id><infobaseAlias>${escapeXml(base.infoBaseAlias)}</infobaseAlias></requestInfo>`;
}

function escapeXml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/** Извлекает содержимое первого элемента *:data из XML ответа 1С, декодирует Base64 и возвращает UTF-8 строку. */
function decodeBase64FromResponse(xmlResponse: string): string {
	// Варианты: <data>, <b:data>, <debugRDBGRequestResponse:data>, <dbgtgtRemoteRequestResponse:data>
	const match = xmlResponse.match(/<[^:>]*:?data[^>]*>([\s\S]*?)<\/[^:>]*:?data>/i);
	const b64 = match ? match[1].replace(/\s/g, '').trim() : '';
	if (!b64) return '';
	try {
		return Buffer.from(b64, 'base64').toString('utf8');
	} catch {
		return '';
	}
}

/** Извлекает элемент *:data из ответа и возвращает декодированный Buffer (для бинарного payload с UTF-16LE). */
function getDataBufferFromResponse(xmlResponse: string): Buffer | null {
	const match = xmlResponse.match(/<[^:>]*:?data[^>]*>([\s\S]*?)<\/[^:>]*:?data>/i);
	const b64 = match ? match[1].replace(/\s/g, '').trim() : '';
	if (!b64) return null;
	try {
		return Buffer.from(b64, 'base64');
	} catch {
		return null;
	}
}

/**
 * Парсит бинарный payload из ping (формат 1С: начало — URI модуля в UTF-8, затем имена стека в UTF-16LE).
 * Как в onec-debug-adapter: StackItemViewInfoData.moduleIDStr (base64) и presentation (base64, UTF-16).
 * Возвращает objectId/propertyId из URI (urn:module:md:UUID@property='propertyId';version='...') и массив presentation.
 */
function parsePingDataBinary(buffer: Buffer): {
	objectId?: string;
	propertyId?: string;
	presentations: string[];
} {
	const result: { objectId?: string; propertyId?: string; presentations: string[] } = { presentations: [] };
	const uriPrefix = Buffer.from('urn:module:md:', 'utf8');
	const idx = buffer.indexOf(uriPrefix);
	if (idx < 0) return result;
	const uriStart = idx;
	let uriEnd = buffer.indexOf(Buffer.from(')', 'utf8'), uriStart);
	if (uriEnd < 0) uriEnd = buffer.length;
	const uriBuf = buffer.subarray(uriStart, uriEnd);
	const uriStr = uriBuf.toString('utf8');
	const objectIdMatch = uriStr.match(/^urn:module:md:([0-9a-fA-F-]{36})/);
	if (objectIdMatch) result.objectId = objectIdMatch[1];
	const propertyMatch = uriStr.match(/@property='([0-9a-fA-F-]{36})'/);
	if (propertyMatch) result.propertyId = propertyMatch[1];
	// Хвост буфера — UTF-16LE (имена процедур/модулей в стеке вызовов)
	const tailStart = uriEnd + 1;
	if (tailStart >= buffer.length) return result;
	const tail = buffer.subarray(tailStart);
	try {
		const tailStr = tail.toString('utf16le');
		// Имена разделены нулём или спецсимволом; фильтруем пустые и мусор
		const parts = tailStr.split(/\0+/).map((s) => s.trim()).filter((s) => s.length > 0 && /[\u0400-\u04FF\w.]/.test(s));
		result.presentations = parts;
	} catch {
		// игнорируем ошибки UTF-16LE
	}
	return result;
}

/** Извлекает targetId как строку из объекта result (targetID может быть вложенным объектом с полем id). */
function getTargetIdFromResult(obj: Record<string, unknown>): string {
	const t = obj.targetId ?? obj.TargetId ?? obj.targetID;
	if (t == null) return '';
	if (typeof t === 'string') return t;
	if (typeof t === 'object' && t !== null && 'id' in t)
		return String((t as Record<string, unknown>).id ?? '');
	return '';
}

/** Нормализует цель отладки из XML (getDbgTargets/ping targetStarted). */
function parseDebugTargetFromXml(t: unknown): DebugTargetId {
	if (!t || typeof t !== 'object') return { id: '' };
	const o = t as Record<string, unknown>;
	const id = String(o.id ?? o.Id ?? '');
	const seanceId = o.seanceId ?? o.SeanceId;
	const seanceNo = o.seanceNo ?? o.SeanceNo;
	const targetType = o.targetType ?? o.TargetType;
	const userName = o.userName ?? o.UserName;
	const infoBaseAlias = o.infoBaseAlias ?? o.InfoBaseAlias;
	return {
		id,
		seanceId: seanceId != null ? String(seanceId) : undefined,
		seanceNo: typeof seanceNo === 'number' ? seanceNo : seanceNo != null ? Number(seanceNo) : undefined,
		targetType: targetType != null ? String(targetType) : undefined,
		userName: userName != null ? String(userName) : undefined,
		infoBaseAlias: infoBaseAlias != null ? String(infoBaseAlias) : undefined,
	};
}

function buildAttachDebugUiBody(req: RdbgAttachDebugUiRequest): string {
	const opts = req.options as DebuggerOptions | undefined;
	const optionsXml =
		opts?.foregroundAbility !== undefined
			? `<options><foregroundAbility>${opts.foregroundAbility}</foregroundAbility></options>`
			: '';
	return buildRequestBody(buildBaseRequestXml(req) + optionsXml);
}

/**
 * Формирует XML для setBreakpoints по формату обмена с сервером 1С: префиксы debugRDBGRequestResponse/debugBreakpoints,
 * id с objectID, propertyID, version без префикса; bpInfo — дочерние line и hitCount без обёртки breakpoint.
 */
function buildSetBreakpointsBody(req: RdbgSetBreakpointsRequest): string {
	const q = 'debugRDBGRequestResponse';
	const bp = 'debugBreakpoints';
	const parts: string[] = [];
	for (const m of req.bpWorkspace) {
		if (!m.objectId?.trim() || !m.propertyId?.trim()) continue;
		const versionRaw = String(((m as unknown) as Record<string, unknown>).version ?? '');
		const version = versionRaw.trim();
		const versionXml = version ? `<version>${escapeXml(version)}</version>` : '';
		const bpInfoParts: string[] = [];
		for (const bpItem of m.bpInfo) {
			const line = bpItem.line;
			const hitCount = bpItem.hitCount ?? 0;
			bpInfoParts.push(`<${bp}:line>${line}</${bp}:line><${bp}:hitCount>${hitCount}</${bp}:hitCount>`);
		}
		if (bpInfoParts.length === 0) bpInfoParts.push(`<${bp}:line>0</${bp}:line><${bp}:hitCount>0</${bp}:hitCount>`);
		parts.push(
			`<${bp}:moduleBPInfo>` +
			`<${bp}:id><objectID>${escapeXml(m.objectId)}</objectID><propertyID>${escapeXml(m.propertyId)}</propertyID>${versionXml}</${bp}:id>` +
			`<${bp}:bpInfo>${bpInfoParts.join('')}</${bp}:bpInfo>` +
			`</${bp}:moduleBPInfo>`,
		);
	}
	return `<?xml version="1.0" encoding="UTF-8"?>` +
		`<request xmlns="http://v8.1c.ru/8.3/debugger/debugBaseData" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:debugBreakpoints="${NS.debugBreakpoints}" xmlns:debugRDBGRequestResponse="${NS.debugRDBGRequestResponse}" xmlns:v8="http://v8.1c.ru/8.3/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="${NS.xsi}">` +
		`<${q}:infoBaseAlias>${escapeXml(req.infoBaseAlias)}</${q}:infoBaseAlias>` +
		`<${q}:idOfDebuggerUI>${escapeXml(req.idOfDebuggerUi)}</${q}:idOfDebuggerUI>` +
		`<${q}:bpWorkspace>${parts.join('')}</${q}:bpWorkspace>` +
		`</request>`;
}

export interface RdbgClientOptions {
	/** Включить запись протокола в %TEMP%/PlatformTools-rdbg-protocol (настройка 1c-dev-tools.debug.logProtocol) */
	logProtocol?: boolean;
}

export class RdbgClient {
	private baseUrl: string;
	private parser: XMLParser;
	private protocolLogDir: string | null = null;
	private protocolSeq = 0;
	private logProtocol: boolean;

	constructor(host: string, port: number, options?: RdbgClientOptions) {
		this.baseUrl = `http://${host}:${port}/e1crdbg`;
		this.logProtocol = options?.logProtocol ?? false;
		this.parser = new XMLParser({
			ignoreDeclaration: true,
			removeNSPrefix: true,
			// onec-debug-adapter: result, callstack, id — коллекции; moduleBPInfo, item — элементы массивов
			isArray: (name) =>
				/^(id|result|callstack|item|moduleBPInfo|callStack)$/i.test(name),
		});
	}

	/** Создаёт папку для логов протокола в %TEMP%/PlatformTools-rdbg-protocol/YYYYMMDD_HHMMSS */
	private ensureProtocolLogDir(): string {
		if (this.protocolLogDir) return this.protocolLogDir;
		const now = new Date();
		const ts = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_').slice(0, 15);
		const base = path.join(os.tmpdir(), 'PlatformTools-rdbg-protocol');
		this.protocolLogDir = path.join(base, ts);
		try {
			fs.mkdirSync(this.protocolLogDir, { recursive: true });
		} catch {
			// игнорируем ошибку создания папки
		}
		return this.protocolLogDir;
	}

	/** Путь к папке логов протокола (после первого запроса) */
	getProtocolLogDirectory(): string | null {
		return this.protocolLogDir;
	}

	/** Записывает request и response в папку логов протокола (если включена настройка). При ответе в Base64 добавляет декодированное содержимое. */
	private writeProtocolLog(cmd: string, url: string, requestBody: string, responseBody: string, statusCode: number): void {
		if (!this.logProtocol) return;
		try {
			const dir = this.ensureProtocolLogDir();
			this.protocolSeq++;
			const seq = String(this.protocolSeq).padStart(4, '0');
			const ts = Date.now();
			const reqPath = path.join(dir, `${seq}_${ts}_${cmd}_request.xml`);
			const resPath = path.join(dir, `${seq}_${ts}_${cmd}_response.xml`);
			const reqContent = [
				`<!-- RDBG ${cmd} | URL: ${url} | ${new Date().toISOString()} -->`,
				requestBody,
			].join('\n');
			const decoded = decodeBase64FromResponse(responseBody);
			const resContent = [
				`<!-- RDBG ${cmd} | Status: ${statusCode} | ${new Date().toISOString()} -->`,
				responseBody,
				decoded ? ['', '<!-- Decoded from Base64 <data> -->', decoded].join('\n') : '',
			].join('\n');
			fs.writeFileSync(reqPath, reqContent, 'utf8');
			fs.writeFileSync(resPath, resContent, 'utf8');
		} catch {
			// игнорируем ошибку записи
		}
	}

	/** Записывает последний ответ ping. Непустой ответ дополнительно в ping_response_last_nonempty.xml (для отладки). */
	private writePingResponseLog(responseBody: string): void {
		try {
			const dir = this.ensureProtocolLogDir();
			const decoded = decodeBase64FromResponse(responseBody);
			const dataBuf = getDataBufferFromResponse(responseBody);
			const content = [
				`<!-- RDBG pingDebugUIParams | ${new Date().toISOString()} | body length: ${responseBody.length} -->`,
				responseBody,
				decoded ? ['', '<!-- Decoded from Base64 (UTF-8) -->', decoded].join('\n') : '',
				dataBuf && dataBuf.length > 0 ? ['', '<!-- Data as buffer length: ' + dataBuf.length + ' -->'].join('\n') : '',
			].join('\n');
			fs.writeFileSync(path.join(dir, 'ping_response_last.xml'), content, 'utf8');
			if (responseBody.length > 0) {
				fs.writeFileSync(path.join(dir, 'ping_response_last_nonempty.xml'), content, 'utf8');
			}
		} catch {
			// игнорируем ошибку записи
		}
	}

	/** endpoint: rdbg для всех команд. queryParams — доп. параметры (напр. dbgui для ping). logCmd — имя для лога (если задано, в URL по-прежнему cmd). */
	private async postXml(
		cmd: string,
		body: string,
		options?: { endpoint?: 'rdbg' | 'rdng'; skipDumpOnError?: boolean; queryParams?: Record<string, string>; logCmd?: string },
	): Promise<string> {
		const endpoint = options?.endpoint ?? 'rdbg';
		const skipDumpOnError = options?.skipDumpOnError ?? false;
		const logCmd = options?.logCmd ?? cmd;
		const url = new URL(`${this.baseUrl}/${endpoint}`);
		url.searchParams.set('cmd', cmd);
		for (const [k, v] of Object.entries(options?.queryParams ?? {})) {
			url.searchParams.set(k, v);
		}
		const bodyBuf = Buffer.from(body, 'utf8');
		return new Promise((resolve, reject) => {
			const req = http.request(
				{
					hostname: url.hostname,
					port: url.port || 80,
					path: url.pathname + url.search,
					method: 'POST',
					headers: {
						'Content-Type': 'application/xml; charset=utf-8',
						'User-Agent': '1CV8',
						'Content-Length': bodyBuf.length,
					},
					timeout: 15000,
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on('data', (chunk) => chunks.push(chunk));
					res.on('end', () => {
						const text = Buffer.concat(chunks).toString('utf8');
						const statusCode = res.statusCode ?? 0;
						// Полный протокол — все запросы/ответы в папку temp (кроме ping — слишком много файлов)
						if (cmd !== 'pingDebugUIParams') {
							this.writeProtocolLog(logCmd, url.toString(), body, text, statusCode);
						} else if (this.logProtocol) {
							// Последний ответ ping — в один файл для отладки пустого call stack
							this.writePingResponseLog(text);
						}
						if (statusCode >= 400) {
							let fileHint = '';
							if (!skipDumpOnError && this.logProtocol) {
								const decoded = decodeBase64FromResponse(text);
								const logContent = [
									`=== RDBG ${logCmd} ${statusCode} ${res.statusMessage} ===`,
									`URL: ${url.toString()}`,
									'',
									'--- Request body ---',
									body,
									'',
									'--- Response body (full) ---',
									text,
									decoded ? ['', '--- Response body (decoded Base64) ---', decoded].join('\n') : '',
								].join('\n');
								try {
									const dir = this.ensureProtocolLogDir();
									const dumpPath = path.join(dir, `rdbg-${logCmd}-${statusCode}-${Date.now()}.txt`);
									fs.writeFileSync(dumpPath, logContent, 'utf8');
									fileHint = ` Полный ответ и тело запроса записаны в: ${dumpPath}`;
								} catch {
									// игнорируем ошибку записи
								}
							}
							const detail = text.trim() ? ` Ответ: ${text.trim().slice(0, 500)}` : '';
							reject(new Error(`RDBG ${cmd}: ${statusCode} ${res.statusMessage}.${detail}${fileHint}`));
							return;
						}
						resolve(text);
					});
				},
			);
			req.on('error', (err) => {
				const msg = (err as NodeJS.ErrnoException).code
					? `${(err as NodeJS.ErrnoException).code}: ${err.message}`
					: err.message;
				reject(new Error(`Сервер отладки ${url.hostname}:${url.port || 80} — ${msg}. Проверьте, что dbgs запущен и доступен.`));
			});
			req.on('timeout', () => {
				req.destroy();
				reject(new Error(`Таймаут подключения к ${url.hostname}:${url.port || 80}. Запущен ли dbgs?`));
			});
			req.write(bodyBuf);
			req.end();
		});
	}

	/**
	 * Парсит XML ответа. Сервер возвращает корень <response xmlns="http://v8.1c.ru/8.3/debugger/debugBaseData">,
	 * как в onec-debug-adapter RequestSerializer.Deserialize.
	 */
	private parseResponse<T>(xml: string): T {
		const obj = this.parser.parse(xml) as Record<string, unknown>;
		const response = obj[ResponseSchema.rootElement] ?? obj;
		return response as T;
	}

	/**
	 * Проверка доступности сервера отладки.
	 */
	async test(): Promise<void> {
		const url = new URL(`${this.baseUrl}/rdbgTest?cmd=test`);
		await new Promise<void>((resolve, reject) => {
			const req = http.request(
				{
					hostname: url.hostname,
					port: url.port || 80,
					path: url.pathname + url.search,
					method: 'POST',
					headers: { 'User-Agent': '1CV8' },
					timeout: 10000,
				},
				(res) => {
					res.on('data', () => {});
					res.on('end', () => {
						if (res.statusCode && res.statusCode >= 400) {
							reject(new Error(`rdbgTest: ${res.statusCode}`));
							return;
						}
						resolve();
					});
				},
			);
			req.on('error', (err) => {
				const msg = (err as NodeJS.ErrnoException).code
					? `${(err as NodeJS.ErrnoException).code}: ${err.message}`
					: err.message;
				reject(new Error(`Сервер отладки ${url.hostname}:${url.port || 80} — ${msg}. Запустите dbgs и проверьте host/port.`));
			});
			req.on('timeout', () => {
				req.destroy();
				reject(new Error(`Таймаут подключения к ${url.hostname}:${url.port || 80}. Запущен ли dbgs?`));
			});
			req.end();
		});
	}

	/**
	 * Подключение UI отладчика к ИБ.
	 */
	async attachDebugUI(request: RdbgAttachDebugUiRequest): Promise<RdbgAttachDebugUiResponse> {
		const body = buildAttachDebugUiBody(request);
		const xml = await this.postXml('attachDebugUI', body);
		const response = this.parseResponse<{ result?: string }>(xml);
		const result = response?.result;
		return { result: result as RdbgAttachDebugUiResponse['result'] };
	}

	/**
	 * Отключение UI отладчика.
	 */
	async detachDebugUI(base: RDbgBaseRequest): Promise<{ result: boolean }> {
		const body = buildRequestBody(buildBaseRequestXml(base));
		const xml = await this.postXml('detachDebugUI', body);
		const response = this.parseResponse<{ result?: boolean }>(xml);
		return { result: response?.result ?? false };
	}

	/**
	 * Список целей отладки (потоков).
	 * Ответ: <response><id>...</id><id>...</id></response> (как в onec-debug-adapter 02_GetDbgTargets).
	 */
	async getDbgTargets(base: RDbgBaseRequest, debugAreaName?: string): Promise<RdbgsGetDbgTargetsResponse> {
		const area = debugAreaName ? `<debugAreaName>${escapeXml(debugAreaName)}</debugAreaName>` : '';
		const body = buildRequestBody(buildBaseRequestXml(base) + area);
		const xml = await this.postXml('getDbgTargets', body);
		const response = this.parseResponse<Record<string, unknown>>(xml);
		// XML: <debugRDBGRequestResponse:id> или <id> — парсер может вернуть id или "debugRDBGRequestResponse:id"
		let raw = response?.id;
		if (raw == null && response) {
			const alt = (response['debugRDBGRequestResponse:id'] ?? response['debugRDBGRequestResponse\\:id']) as unknown;
			if (alt != null) raw = alt;
		}
		const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
		const id = list.map((t) => parseDebugTargetFromXml(t));
		return { id };
	}

	/**
	 * Шаг отладки (Continue, Step, StepIn, StepOut). Формат по трафику Конфигуратора (namespace debugBaseData, префикс debugRDBGRequestResponse, без simple).
	 */
	async step(
		base: RDbgBaseRequest,
		targetId: DebugTargetIdLight,
		action: DebugStepAction,
	): Promise<unknown> {
		const body = buildStepRequestBody(base, targetId, action);
		const xml = await this.postXml('step', body);
		return this.parseResponse<unknown>(xml);
	}

	/**
	 * Установка точек останова в сервере отладки 1С.
	 */
	async setBreakpoints(request: RdbgSetBreakpointsRequest): Promise<void> {
		const body = buildSetBreakpointsBody(request);
		await this.postXml('setBreakpoints', body);
	}

	/**
	 * Вычисление выражения в контексте остановки (evalExpr). Формат по трафику Конфигуратора (default NS debugBaseData, префиксы, два idOfDebuggerUI, calcWaitingTime 100).
	 */
	/**
	 * Вычисление выражения (evalExpr). При пустом теле ответа результат может прийти в ping (exprEvaluated); выполняем до 3 опросов ping с паузой 100 ms.
	 */
	async evalExpr(
		base: RDbgBaseRequest,
		targetId: DebugTargetIdLight,
		expression: string,
		frameIndex: number,
	): Promise<EvalExprResult> {
		const { body, expressionResultID } = buildEvalExprRequestBody(base, targetId, expression, frameIndex);
		const xml = await this.postXml('evalExpr', body);
		const parsed = parseEvalExprResult(xml);
		const hasContent = parsed.result !== '' || (parsed.children && parsed.children.length > 0) || parsed.error;
		if (hasContent) return parsed;
		for (let i = 0; i < 3; i++) {
			await new Promise((r) => setTimeout(r, 100));
			const pingResult = await this.pingDebugUIParams(base);
			const found = pingResult?.exprEvaluated?.find((e) => e.expressionResultID === expressionResultID);
			if (found) return found.result;
		}
		return parsed;
	}

	/**
	 * Опрос сервера отладки. Возвращает события: targetStarted, targetQuit, callStackFormed.
	 * cmd=pingDebugUIParams. Как onec-debug-adapter: rdbg + query dbgui={idOfDebuggerUI}.
	 */
	async pingDebugUIParams(base: RDbgBaseRequest): Promise<PingDebugUIParamsResult | null> {
		const body = buildRequestBody(buildBaseRequestXml(base));
		const raw = await this.postXml('pingDebugUIParams', body, {
			skipDumpOnError: true,
			queryParams: { dbgui: base.idOfDebuggerUi },
		});
		// Сервер может вернуть обёртку <request><dbgtgtRemoteRequestResponse:data>Base64</data></request>
		// Внутри Base64 — либо XML (response/result/callStackFormed), либо бинарный формат 1С: URI модуля + UTF-16LE имена стека
		const decoded = decodeBase64FromResponse(raw);
		const xml = decoded.trim() ? decoded : raw;
		let result = parsePingDebugUIParamsResponse(xml);
		if (result) return result;
		// Декодированный payload не XML — пробуем парсить бинарный формат (обёртка request + dbgtgtRemoteRequestResponse:data)
		// Пробуем при любом наличии элемента data в ответе (decoded может быть пустым при чисто бинарном payload)
		const dataBuf = getDataBufferFromResponse(raw);
		if (dataBuf && dataBuf.length > 0) {
			const binary = parsePingDataBinary(dataBuf);
			if (binary.objectId || binary.propertyId || binary.presentations.length > 0) {
				const moduleId =
					binary.objectId && binary.propertyId
						? { type: 'ConfigModule' as const, extensionName: '', objectId: binary.objectId, propertyId: binary.propertyId }
						: undefined;
				const callStack: StackItemViewInfoData[] =
					binary.presentations.length > 0
						? binary.presentations.map((presentation, i) => ({
								moduleId,
								lineNo: i === 0 ? 1 : 0,
								presentation,
						  }))
						: moduleId
							? [{ moduleId, lineNo: 1, presentation: '' }]
							: [];
				result = {
					callStackFormed: {
						callStack: callStack.length > 0 ? callStack : [],
						targetId: '',
						reason: 'Breakpoint',
						stopByBp: true,
					},
				};
				return result;
			}
		}
		return null;
	}

	/**
	 * Инициализация начальных настроек отладки (initSettings).
	 * Вызывается после attachDebugUI перед началом отладки.
	 */
	async initSettings(base: RDbgBaseRequest, settings?: InitialDebugSettings): Promise<void> {
		const body = buildRequestBody(buildBaseRequestXml(base));
		await this.postXml('initSettings', body);
	}

	/**
	 * Получение стека вызовов для цели отладки (getCallStack). Формат по трафику Конфигуратора: request с debugBaseData, элемент id (не targetID).
	 */
	async getCallStack(base: RDbgBaseRequest, targetId: DebugTargetIdLight): Promise<StackItemViewInfoData[]> {
		const body = buildGetCallStackRequestBody(base, targetId);
		const xml = await this.postXml('getCallStack', body);
		return parseCallStackResponse(xml);
	}

	/**
	 * Вычисление локальных переменных (evalLocalVariables). Формат по трафику Конфигуратора (default NS debugBaseData, префиксы, два idOfDebuggerUI, calcWaitingTime 100).
	 * При пустом теле ответа результат может прийти асинхронно в ping (exprEvaluated); выполняем до 3 опросов ping с паузой 100 ms.
	 */
	async evalLocalVariables(
		base: RDbgBaseRequest,
		targetId: DebugTargetIdLight,
		stackLevel: number,
	): Promise<EvalLocalVariablesResult> {
		const { body, expressionResultID } = buildEvalLocalVariablesRequestBody(base, targetId, stackLevel);
		const raw = await this.postXml('evalLocalVariables', body);
		const decoded = decodeBase64FromResponse(raw);
		const xml = decoded.trim() ? decoded : raw;
		const parsed = parseEvalLocalVariablesResult(xml);
		if (parsed.variables.length > 0) return parsed;
		for (let i = 0; i < 3; i++) {
			await new Promise((r) => setTimeout(r, 100));
			const pingResult = await this.pingDebugUIParams(base);
			const found = pingResult?.exprEvaluated?.find((e) => e.expressionResultID === expressionResultID);
			if (found) {
				const variables = (found.result.children ?? []).map((c) => ({
					name: c.name,
					value: c.value,
					typeName: c.typeName,
				}));
				return { variables };
			}
		}
		return parsed;
	}

	/**
	 * Батч evalLocalVariables: один запрос с контекстом и списком раскрываемых выражений. Результаты могут прийти в теле ответа или в ping (exprEvaluated).
	 */
	async evalLocalVariablesBatch(
		base: RDbgBaseRequest,
		targetId: DebugTargetIdLight,
		stackLevel: number,
		expandableExpressions: string[],
	): Promise<EvalLocalVariablesBatchResult> {
		const { body, expressionResultIDs } = buildEvalLocalVariablesBatchRequestBody(base, targetId, stackLevel, expandableExpressions);
		const raw = await this.postXml('evalLocalVariables', body);
		const decoded = decodeBase64FromResponse(raw);
		const xml = decoded.trim() ? decoded : raw;
		const multi = parseEvalLocalVariablesMultiResponse(xml);
		const childrenByExpression: Record<string, EvalExprResult> = {};
		for (let i = 0; i < expandableExpressions.length; i++) {
			if (multi.exprResultsByIndex[i]) {
				childrenByExpression[expandableExpressions[i]] = multi.exprResultsByIndex[i];
			}
		}
		let variables = multi.variables;
		const missingIds = new Set(expressionResultIDs);
		if (variables.length > 0) missingIds.delete(expressionResultIDs[0]);
		for (let poll = 0; poll < 3 && missingIds.size > 0; poll++) {
			await new Promise((r) => setTimeout(r, 100));
			const pingResult = await this.pingDebugUIParams(base);
			for (const ev of pingResult?.exprEvaluated ?? []) {
				if (!missingIds.has(ev.expressionResultID)) continue;
				missingIds.delete(ev.expressionResultID);
				const idx = expressionResultIDs.indexOf(ev.expressionResultID);
				if (idx === 0) {
					variables = (ev.result.children ?? []).map((c) => ({
						name: c.name,
						value: c.value,
						typeName: c.typeName,
					}));
				} else if (idx > 0 && expandableExpressions[idx - 1] !== undefined) {
					childrenByExpression[expandableExpressions[idx - 1]] = ev.result;
				}
			}
		}
		if (variables.length === 0) {
			const fallback = parseEvalLocalVariablesResult(xml);
			variables = fallback.variables;
		}
		return { variables, childrenByExpression };
	}

	/**
	 * Подключение/отключение конкретных целей отладки (attachDetachDbgTargets).
	 * Структура из C#: <attach>true</attach> + <id><id xmlns="debugBaseData">guid</id></id> для каждой цели.
	 * @param base - базовые параметры запроса
	 * @param command - команда с массивами attach/detach
	 */
	async attachDetachDbgTargets(base: RDbgBaseRequest, command: AttachDetachTargetsCommand): Promise<void> {
		let targetsXml = '';
		if (command.attach && command.attach.length > 0) {
			targetsXml += `<attach xmlns="${NS.debugRDBGRequestResponse}">true</attach>`;
			for (const id of command.attach) {
				targetsXml += `<id xmlns="${NS.debugRDBGRequestResponse}"><id xmlns="${NS.debugBaseData}">${escapeXml(id)}</id></id>`;
			}
		}
		if (command.detach && command.detach.length > 0) {
			targetsXml += `<attach xmlns="${NS.debugRDBGRequestResponse}">false</attach>`;
			for (const id of command.detach) {
				targetsXml += `<id xmlns="${NS.debugRDBGRequestResponse}"><id xmlns="${NS.debugBaseData}">${escapeXml(id)}</id></id>`;
			}
		}
		const body = buildRequestBody(buildBaseRequestXml(base) + targetsXml);
		await this.postXml('attachDetachDbgTargets', body);
	}

	/**
	 * Настройка автоподключения к целям отладки (setAutoAttachSettings).
	 * @param base - базовые параметры запроса
	 * @param settings - настройки автоподключения по типам
	 */
	async setAutoAttachSettings(base: RDbgBaseRequest, settings: AutoAttachSettings): Promise<void> {
		// Правильная структура из C# примера:
		// <autoAttachSettings xmlns="debugRDBGRequestResponse">
		//   <targetType xmlns="debugAutoAttach">Client</targetType>
		// </autoAttachSettings>
		const targetTypesXml = settings.targetTypes
			.filter((t) => t.autoAttach) // Только включенные типы
			.map((t) => `<targetType xmlns="${NS.debugAutoAttach}">${escapeXml(t.type)}</targetType>`)
			.join('');
		const body = buildRequestBody(
			buildBaseRequestXml(base) + 
			`<autoAttachSettings xmlns="${NS.debugRDBGRequestResponse}">${targetTypesXml}</autoAttachSettings>`,
		);
		await this.postXml('setAutoAttachSettings', body);
	}

	/**
	 * Установка останова на ошибках выполнения (setBreakOnRTE).
	 * @param base - базовые параметры запроса
	 * @param stopOnErrors - останавливаться ли на ошибках
	 * @param errorFilter - фильтр по тексту ошибки (опционально)
	 */
	async setBreakOnRTE(base: RDbgBaseRequest, stopOnErrors: boolean, errorFilter?: string): Promise<void> {
		// Правильная структура из C# примера:
		// <state xmlns="debugRDBGRequestResponse">
		//   <stopOnErrors xmlns="debugRTEFilter">false</stopOnErrors>
		//   <analyzeErrorStr xmlns="debugRTEFilter">false</analyzeErrorStr>
		// </state>
		let stateXml = 
			`<state xmlns="${NS.debugRDBGRequestResponse}">` +
			`<stopOnErrors xmlns="${NS.debugRTEFilter}">${stopOnErrors}</stopOnErrors>` +
			`<analyzeErrorStr xmlns="${NS.debugRTEFilter}">false</analyzeErrorStr>`;
		
		// Добавляем фильтр по тексту ошибки если указан
		if (errorFilter) {
			stateXml += `<strTemplate xmlns="${NS.debugRTEFilter}"><str>${escapeXml(errorFilter)}</str></strTemplate>`;
		}
		
		stateXml += `</state>`;
		
		const body = buildRequestBody(buildBaseRequestXml(base) + stateXml);
		await this.postXml('setBreakOnRTE', body);
	}

	/**
	 * Отмена останова на следующем операторе (clearBreakOnNextStatement).
	 * @param base - базовые параметры запроса
	 */
	async clearBreakOnNextStatement(base: RDbgBaseRequest): Promise<void> {
		const body = buildRequestBody(buildBaseRequestXml(base));
		await this.postXml('clearBreakOnNextStatement', body);
	}
}

/** Декодирует base64 в UTF-8. Убирает пробелы и переносы (pres в ответе может быть многострочным). */
function decodeBase64ToUtf8(b64: unknown): string {
	if (typeof b64 !== 'string') return '';
	try {
		const normalized = b64.replace(/\s/g, '');
		return Buffer.from(normalized, 'base64').toString('utf8');
	} catch {
		return '';
	}
}

/** Извлекает CallStackFormed из ответа pingDebugUIParams (как onec-debug-adapter DebugServerListener). */
function parseCallStackFormedFromPingResponse(xml: string): CallStackFormedResult | null {
	try {
		const parser = new XMLParser({
			ignoreDeclaration: true,
			removeNSPrefix: true,
			isArray: (name) =>
				/^(result|callstack|callStack|stack|item|stackitem)$/i.test(name),
		});
		const parsed = parser.parse(xml) as Record<string, unknown>;
		const response = parsed[ResponseSchema.rootElement] ?? parsed;
		const result = (response as Record<string, unknown>).result;
		if (result == null) return null;

		const results = Array.isArray(result) ? result : [result];
		for (const item of results) {
			const obj = item as Record<string, unknown>;
			// Пропускаем не-CallStackFormed (DbguiExtCmds); если cmdId пустой — обрабатываем (совместимость)
			const cmdId = String(obj.cmdID ?? obj.cmdId ?? obj.CmdId ?? '').toLowerCase();
			if (cmdId && cmdId !== DbguiExtCmds.CallStackFormed.toLowerCase()) continue;

			const callStack = obj.callStack ?? obj.CallStack ?? obj.callstack ?? obj.stack;
			if (callStack == null) continue;

			const targetId = getTargetIdFromResult(obj);
			const stopByBpVal = obj.stopByBp ?? obj.StopByBp ?? obj.stopByBP;
			const suspendedByOtherVal = obj.suspendedByOther ?? obj.SuspendedByOther;
			const stopByBp = stopByBpVal === true || String(stopByBpVal).toLowerCase() === 'true';
			const suspendedByOther = suspendedByOtherVal === true || String(suspendedByOtherVal).toLowerCase() === 'true';

			let reason: CallStackFormedResult['reason'] = 'Step';
			if (stopByBp) reason = 'Breakpoint';
			else if (suspendedByOther) reason = 'Step';

			const stackItems = Array.isArray(callStack) ? callStack : [callStack];
			// ВАЖНО: порядок стека от сервера должен быть проверен тестированием.
			// DAP ожидает [current, ..., root] (stackFrames[0] = текущая позиция).
			// Если сервер отдаёт [root, ..., current], нужно добавить .reverse() здесь.
			// Текущая реализация предполагает, что сервер уже отдаёт правильный порядок.
			const callStackData: StackItemViewInfoData[] = stackItems.map((si: unknown) => {
				const s = si as Record<string, unknown>;
				const mid = s.moduleId ?? s.ModuleId;
				let moduleId: BslModuleIdInternal | undefined;
				if (mid && typeof mid === 'object') {
					const m = mid as Record<string, unknown>;
					moduleId = {
						type: (m.type as BslModuleIdInternal['type']) ?? 'ConfigModule',
						extensionName: String(m.extensionName ?? m.ExtensionName ?? ''),
						objectId: String(m.objectID ?? m.objectId ?? m.ObjectID ?? ''),
						propertyId: String(m.propertyID ?? m.propertyId ?? m.PropertyID ?? ''),
					};
				}
				const lineNo = s.lineNo ?? s.LineNo ?? s.line;
				// moduleIDStr, presentation в Messages.cs — base64Binary (UTF-8/UTF-16)
				const moduleIdStrRaw = s.moduleIDStr ?? s.moduleIdStr ?? s.ModuleIDStr ?? s.ModuleIdStr;
				const moduleIdStr = typeof moduleIdStrRaw === 'string' ? decodeBase64ToUtf8(moduleIdStrRaw) : '';
				const presRaw = s.presentation ?? s.Presentation;
				const presentation = typeof presRaw === 'string' && presRaw.length > 0
					? (decodeBase64ToUtf8(presRaw) || presRaw)
					: '';
				return {
					moduleId,
					moduleIdStr: moduleIdStr || undefined,
					lineNo: typeof lineNo === 'number' ? lineNo : parseInt(String(lineNo ?? 0), 10),
					presentation,
					isFantom: !!(s.isFantom ?? s.IsFantom),
				};
			});

			return { callStack: callStackData, targetId, reason, stopByBp: !!stopByBp, suspendedByOther: !!suspendedByOther };
		}
	} catch {
		// игнорируем ошибки парсинга
	}
	return null;
}

/** Парсит полный ответ pingDebugUIParams со всеми событиями (targetStarted, targetQuit, callStackFormed). */
function parsePingDebugUIParamsResponse(xml: string): PingDebugUIParamsResult | null {
	try {
		const parser = new XMLParser({
			ignoreDeclaration: true,
			removeNSPrefix: true,
			isArray: (name) =>
				/^(result|callstack|callStack|stack|item|stackitem)$/i.test(name),
		});
		const parsed = parser.parse(xml) as Record<string, unknown>;
		const response = parsed[ResponseSchema.rootElement] ?? parsed;
		const resp = response as Record<string, unknown>;
		// Ключ может быть "result" (removeNSPrefix), "debugRDBGRequestResponse:result" или единственный дочерний узел
		let result = resp.result ?? resp['debugRDBGRequestResponse:result'];
		if (result == null) {
			const keys = Object.keys(resp).filter((k) => k !== '@_attributes' && !k.startsWith('@'));
			if (keys.length === 1 && typeof resp[keys[0]] === 'object')
				result = resp[keys[0]];
		}
		if (result == null) return null;

		const results = Array.isArray(result) ? result : [result];
		const pingResult: PingDebugUIParamsResult = {};

		/** Нормализует значение из XML (строка "true"/"false" или boolean) в boolean. */
		const toBool = (v: unknown): boolean => v === true || String(v).toLowerCase() === 'true';

		for (const item of results) {
			const obj = item as Record<string, unknown>;
			// XML: cmdID (после removeNSPrefix из debugDBGUICommands:cmdID); сравнение без учёта регистра
			const cmdId = String(obj.cmdID ?? obj.cmdId ?? obj.CmdId ?? obj.CmdID ?? '').toLowerCase();
			const cmdCallStackFormed = DbguiExtCmds.CallStackFormed.toLowerCase();
			const cmdTargetStarted = DbguiExtCmds.TargetStarted.toLowerCase();
			const cmdTargetQuit = DbguiExtCmds.TargetQuit.toLowerCase();

			// Событие targetStarted (XML: q1:targetID)
			if (cmdId === cmdTargetStarted) {
				const q1 = (obj as Record<string, unknown>).q1;
				const targetID = obj.targetID ?? obj.targetId ?? obj.TargetID ?? (q1 && typeof q1 === 'object' ? (q1 as Record<string, unknown>).targetID : undefined);
				if (targetID && typeof targetID === 'object') {
					const target = parseDebugTargetFromXml(targetID);
					pingResult.targetStarted = pingResult.targetStarted ?? [];
					pingResult.targetStarted.push(target);
				}
				continue;
			}

			// Событие targetQuit (XML: q1:targetID)
			if (cmdId === cmdTargetQuit) {
				const q1 = (obj as Record<string, unknown>).q1;
				const targetID = obj.targetID ?? obj.targetId ?? obj.TargetID ?? (q1 && typeof q1 === 'object' ? (q1 as Record<string, unknown>).targetID : undefined);
				if (targetID && typeof targetID === 'object') {
					const target = parseDebugTargetFromXml(targetID);
					pingResult.targetQuit = pingResult.targetQuit ?? [];
					pingResult.targetQuit.push(target);
				}
				continue;
			}

			// Событие callStackFormed (формат из трафика: response/result xsi:type=DBGUIExtCmdInfoCallStackFormed)
			if (!cmdId || cmdId === cmdCallStackFormed) {
				const callStack = obj.callStack ?? obj.CallStack ?? obj.callstack ?? obj.stack;
				if (callStack == null) continue;

				const targetId = getTargetIdFromResult(obj);
				const stopByBp = toBool(obj.stopByBp ?? obj.StopByBp ?? obj.stopByBP);
				const suspendedByOther = toBool(obj.suspendedByOther ?? obj.SuspendedByOther);

				let reason: CallStackFormedResult['reason'] = 'Step';
				if (stopByBp) reason = 'Breakpoint';
				else if (suspendedByOther) reason = 'Step';

				const stackItems = Array.isArray(callStack) ? callStack : [callStack];
				const callStackData: StackItemViewInfoData[] = stackItems.map((si: unknown) => {
					const s = si as Record<string, unknown>;
					const mid = s.moduleId ?? s.ModuleId;
					let moduleId: BslModuleIdInternal | undefined;
					if (mid && typeof mid === 'object') {
						const m = mid as Record<string, unknown>;
						moduleId = {
							type: (m.type as BslModuleIdInternal['type']) ?? 'ConfigModule',
							extensionName: String(m.extensionName ?? m.ExtensionName ?? ''),
							objectId: String(m.objectID ?? m.objectId ?? m.ObjectID ?? ''),
							propertyId: String(m.propertyID ?? m.propertyId ?? m.PropertyID ?? ''),
						};
					}
					const lineNo = s.lineNo ?? s.LineNo ?? s.line;
					const moduleIdStrRaw = s.moduleIDStr ?? s.moduleIdStr ?? s.ModuleIDStr ?? s.ModuleIdStr;
					const moduleIdStr = typeof moduleIdStrRaw === 'string' ? decodeBase64ToUtf8(moduleIdStrRaw) : '';
					const presRaw = s.presentation ?? s.Presentation;
					const presentation = typeof presRaw === 'string' && presRaw.length > 0
						? (decodeBase64ToUtf8(presRaw) || presRaw)
						: '';
					return {
						moduleId,
						moduleIdStr: moduleIdStr || undefined,
						lineNo: typeof lineNo === 'number' ? lineNo : parseInt(String(lineNo ?? 0), 10),
						presentation,
						isFantom: !!(s.isFantom ?? s.IsFantom),
					};
				});

				pingResult.callStackFormed = {
					callStack: callStackData,
					targetId,
					reason,
					stopByBp,
					suspendedByOther,
				};
			}
		}

			// Событие exprEvaluated — результат вычисления, доставленный асинхронно в ping (evalLocalVariables/evalExpr)
			const cmdExprEvaluated = DbguiExtCmds.ExprEvaluated.toLowerCase();
			if (cmdId === cmdExprEvaluated) {
				const expressionResultID = String(obj.expressionResultID ?? obj.ExpressionResultID ?? '').trim();
				if (expressionResultID) {
					const data = (obj.evalExprResBaseData ?? obj.calculationResult ?? obj) as Record<string, unknown>;
					const parsed = parseEvalExprResultFromResultObject(data);
					pingResult.exprEvaluated = pingResult.exprEvaluated ?? [];
					pingResult.exprEvaluated.push({ expressionResultID, result: parsed });
				}
				continue;
			}
		}

		// Возвращаем результат только если есть хотя бы одно событие
		if (pingResult.targetStarted || pingResult.targetQuit || pingResult.callStackFormed || (pingResult.exprEvaluated && pingResult.exprEvaluated.length > 0)) {
			return pingResult;
		}
	} catch {
		// игнорируем ошибки парсинга
	}
	return null;
}

/** Парсит один узел результата eval (resultValueInfo, calculationResult.valueOfContextPropInfo) в EvalExprResult. Используется для ответа evalExpr и для exprEvaluated в ping. */
function parseEvalExprResultFromResultObject(res: Record<string, unknown>): EvalExprResult {
	const errorVal = res.error ?? res.Error;
	if (errorVal) {
		return { result: '', error: String(errorVal) };
	}
	const evalResultState = String(res.evalResultState ?? res.EvalResultState ?? '');
	if (evalResultState && evalResultState.toLowerCase() !== 'correctly') {
		return { result: evalResultState, error: evalResultState };
	}
	const valueInfo = (res.resultValueInfo ?? res.ResultValueInfo) as Record<string, unknown> | undefined;
	const typeName = valueInfo ? String(valueInfo.typeName ?? valueInfo.TypeName ?? '') : '';
	const isExpandable = !!(valueInfo?.isExpandable ?? valueInfo?.IsExpandable);
	const collectionSize = valueInfo?.collectionSize ?? valueInfo?.CollectionSize;
	let simpleValue = '';
	if (valueInfo) {
		const vb = valueInfo.valueBoolean ?? valueInfo.ValueBoolean;
		const vd = valueInfo.valueDecimal ?? valueInfo.ValueDecimal;
		const vs = valueInfo.valueString ?? valueInfo.ValueString;
		const vdt = valueInfo.valueDateTime ?? valueInfo.ValueDateTime;
		const pres = valueInfo.pres ?? valueInfo.Pres;
		if (vb !== undefined && vb !== null) simpleValue = String(vb);
		else if (vd !== undefined && vd !== null) simpleValue = String(vd);
		else if (vdt !== undefined && vdt !== null) simpleValue = String(vdt);
		else if (vs !== undefined && vs !== null) {
			simpleValue = decodeBase64ToUtf8(vs) || String(vs);
		} else if (typeof pres === 'string' && pres.length > 0) simpleValue = decodeBase64ToUtf8(pres) || pres;
	}
	const calcResult = (res.calculationResult ?? res.CalculationResult) as Record<string, unknown> | undefined;
	const propList = calcResult?.valueOfContextPropInfo ?? calcResult?.ValueOfContextPropInfo;
	const arr = Array.isArray(propList) ? propList : propList ? [propList] : [];
	const children: EvalExprResult['children'] = arr.map((p: unknown) => {
		const prop = p as Record<string, unknown>;
		const propInfo = (prop.propInfo ?? prop.PropInfo) as Record<string, unknown> | undefined;
		const valInfo = (prop.valueInfo ?? prop.ValueInfo) as Record<string, unknown> | undefined;
		const name = propInfo ? String(propInfo.propName ?? propInfo.PropName ?? '').trim() : '';
		const childTypeName = valInfo
			? String(valInfo.typeName ?? valInfo.TypeName ?? '').trim()
			: String(propInfo?.typeName ?? propInfo?.TypeName ?? '').trim();
		let value = '';
		if (valInfo) {
			const vd = valInfo.valueDecimal ?? valInfo.ValueDecimal;
			const vdt = valInfo.valueDateTime ?? valInfo.ValueDateTime;
			const vs = valInfo.valueString ?? valInfo.ValueString;
			const vb = valInfo.valueBoolean ?? valInfo.ValueBoolean;
			const pres = valInfo.pres ?? valInfo.Pres;
			const typeCode = valInfo.typeCode ?? valInfo.TypeCode;
			if (vd !== undefined && vd !== null) value = String(vd);
			else if (vdt !== undefined && vdt !== null) value = String(vdt);
			else if (vb !== undefined && vb !== null) value = String(vb);
			else if (vs !== undefined && vs !== null) {
				value = decodeBase64ToUtf8(vs) || String(vs);
			} else if (typeof pres === 'string' && pres.length > 0) value = decodeBase64ToUtf8(pres) || pres;
			else if (childTypeName) value = childTypeName;
			else if (typeCode !== undefined && typeCode !== null) value = String(typeCode);
		}
		if (!value && childTypeName) value = childTypeName;
		if (!value && name) value = 'Неопределено';
		return { name, value: value || '', typeName: childTypeName || undefined };
	});
	const summary = children.length > 0
		? (typeName + (typeof collectionSize === 'number' ? ` (${collectionSize})` : '') + (children.length > 0 && !typeName ? ` { ${children.length} }` : '')).trim() || typeName
		: (simpleValue || typeName);
	return {
		result: summary || typeName || 'OK',
		typeName: typeName || undefined,
		isExpandable: isExpandable || children.length > 0,
		collectionSize: typeof collectionSize === 'number' ? collectionSize : undefined,
		children: children.length > 0 ? children : undefined,
	};
}

/** Парсит ответ evalExpr: resultValueInfo (typeName, isExpandable, collectionSize), calculationResult.valueOfContextPropInfo (для Watch). */
function parseEvalExprResult(xml: string): EvalExprResult {
	try {
		const parser = new XMLParser({
			ignoreDeclaration: true,
			removeNSPrefix: true,
			isArray: (name) => /^valueOfContextPropInfo$/i.test(name),
		});
		const parsed = parser.parse(xml) as Record<string, unknown>;
		const response = parsed[ResponseSchema.rootElement] ?? parsed;
		const r = response as Record<string, unknown>;
		const resultNode = r.result ?? r.Result;
		if (resultNode == null) {
			return { result: '', error: r.error ? String(r.error) : undefined };
		}
		const res = resultNode as Record<string, unknown>;
		return parseEvalExprResultFromResultObject(res);
	} catch (err) {
		return {
			result: '',
			error: `Ошибка парсинга ответа evalExpr: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

/** Парсит ответ getCallStack. */
function parseCallStackResponse(xml: string): StackItemViewInfoData[] {
	try {
		const parser = new XMLParser({
			ignoreDeclaration: true,
			removeNSPrefix: true,
			isArray: (name) => /^(callstack|callStack|stackitem|item)$/i.test(name),
		});
		const parsed = parser.parse(xml) as Record<string, unknown>;
		const response = parsed[ResponseSchema.rootElement] ?? parsed;
		const r = response as Record<string, unknown>;
		const callStack = r.callStack ?? r.CallStack ?? r.callstack ?? [];
		
		const stackItems = Array.isArray(callStack) ? callStack : [callStack];
		return stackItems.map((si: unknown) => {
			const s = si as Record<string, unknown>;
			const mid = s.moduleId ?? s.ModuleId;
			let moduleId: BslModuleIdInternal | undefined;
			if (mid && typeof mid === 'object') {
				const m = mid as Record<string, unknown>;
				moduleId = {
					type: (m.type as BslModuleIdInternal['type']) ?? 'ConfigModule',
					extensionName: String(m.extensionName ?? m.ExtensionName ?? ''),
					objectId: String(m.objectID ?? m.objectId ?? m.ObjectID ?? ''),
					propertyId: String(m.propertyID ?? m.propertyId ?? m.PropertyID ?? ''),
				};
			}
			const lineNo = s.lineNo ?? s.LineNo ?? s.line;
			const moduleIdStrRaw = s.moduleIDStr ?? s.moduleIdStr ?? s.ModuleIDStr ?? s.ModuleIdStr;
			const moduleIdStr = typeof moduleIdStrRaw === 'string' ? decodeBase64ToUtf8(moduleIdStrRaw) : '';
			const presRaw = s.presentation ?? s.Presentation ?? '';
			const presentation = typeof presRaw === 'string' && presRaw.length > 0
				? (decodeBase64ToUtf8(presRaw) || String(presRaw))
				: '';
			return {
				moduleId,
				moduleIdStr: moduleIdStr || undefined,
				lineNo: typeof lineNo === 'number' ? lineNo : parseInt(String(lineNo ?? 0), 10),
				presentation,
				isFantom: !!(s.isFantom ?? s.IsFantom),
			};
		});
	} catch {
		return [];
	}
}

/** Парсит ответ evalLocalVariables. Сервер возвращает тот же формат, что и evalExpr: result.calculationResult.valueOfContextPropInfo (propInfo.propName, valueInfo.typeName, pres и т.д.). Дополнительно поддерживается формат localVariables. */
function parseEvalLocalVariablesResult(xml: string): EvalLocalVariablesResult {
	try {
		const parser = new XMLParser({
			ignoreDeclaration: true,
			removeNSPrefix: true,
			isArray: (name) => /^(localVariables|variable|valueOfContextPropInfo)$/i.test(name),
		});
		const parsed = parser.parse(xml) as Record<string, unknown>;
		const response = parsed[ResponseSchema.rootElement] ?? parsed;
		const r = response as Record<string, unknown>;
		let resultNode = r.result ?? r.Result ?? r['debugRDBGRequestResponse:result'];
		if (resultNode == null) {
			const keys = Object.keys(r).filter((k) => k !== '@_attributes' && !k.startsWith('@'));
			const withResult = keys.find((k) => {
				const v = r[k];
				return typeof v === 'object' && v != null && ((v as Record<string, unknown>).calculationResult != null || (v as Record<string, unknown>).evalResultState != null);
			});
			if (withResult) resultNode = r[withResult];
			else if (keys.length === 1 && typeof r[keys[0]] === 'object') resultNode = r[keys[0]];
		}
		const res = (resultNode && typeof resultNode === 'object' ? resultNode as Record<string, unknown> : null);
		if (res) {
			const calcResult = (res.calculationResult ?? res.CalculationResult ?? res['debugCalculations:calculationResult']) as Record<string, unknown> | undefined;
			const propList = calcResult?.valueOfContextPropInfo ?? calcResult?.ValueOfContextPropInfo ?? calcResult?.['debugCalculations:valueOfContextPropInfo'];
			const arr = Array.isArray(propList) ? propList : propList ? [propList] : [];
			if (arr.length > 0) {
				const variables = arr.map((p: unknown) => {
					const prop = p as Record<string, unknown>;
					const propInfo = (prop.propInfo ?? prop.PropInfo) as Record<string, unknown> | undefined;
					const valInfo = (prop.valueInfo ?? prop.ValueInfo) as Record<string, unknown> | undefined;
					const name = propInfo ? String(propInfo.propName ?? propInfo.PropName ?? '').trim() : '';
					const typeName = valInfo
						? String(valInfo.typeName ?? valInfo.TypeName ?? '').trim()
						: String(propInfo?.typeName ?? propInfo?.TypeName ?? '').trim();
					let value = '';
					if (valInfo) {
						const vd = valInfo.valueDecimal ?? valInfo.ValueDecimal;
						const vdt = valInfo.valueDateTime ?? valInfo.ValueDateTime;
						const vs = valInfo.valueString ?? valInfo.ValueString;
						const vb = valInfo.valueBoolean ?? valInfo.ValueBoolean;
						const pres = valInfo.pres ?? valInfo.Pres;
						if (vd !== undefined && vd !== null) value = String(vd);
						else if (vdt !== undefined && vdt !== null) value = String(vdt);
						else if (vb !== undefined && vb !== null) value = String(vb);
						else if (vs !== undefined && vs !== null) {
							value = decodeBase64ToUtf8(vs) || String(vs);
						} else if (typeof pres === 'string' && pres.length > 0) value = decodeBase64ToUtf8(pres) || pres;
						else if (typeName) value = typeName;
					}
					if (!value && typeName) value = typeName;
					if (!value && name) value = 'Неопределено';
					return { name, value: value || '', typeName: typeName || undefined };
				});
				return { variables };
			}
		}
		const source = (res ?? r) as Record<string, unknown>;
		const localVars = source.localVariables ?? source.LocalVariables ?? [];
		const varList = Array.isArray(localVars) ? localVars : localVars ? [localVars] : [];
		const variables = varList.map((v: unknown) => {
			const variable = v as Record<string, unknown>;
			return {
				name: String(variable.name ?? variable.Name ?? ''),
				value: String(variable.value ?? variable.Value ?? ''),
				typeName: String(variable.typeName ?? variable.TypeName ?? ''),
			};
		});
		return { variables };
	} catch {
		return { variables: [] };
	}
}

/** Парсит ответ evalLocalVariables с несколькими result (батч): первый — контекст (variables), остальные — EvalExprResult по порядку. */
function parseEvalLocalVariablesMultiResponse(
	xml: string,
): { variables: LocalVariable[]; exprResultsByIndex: EvalExprResult[] } {
	const variables: LocalVariable[] = [];
	const exprResultsByIndex: EvalExprResult[] = [];
	try {
		const parser = new XMLParser({
			ignoreDeclaration: true,
			removeNSPrefix: true,
			isArray: (name) => /^(result|valueOfContextPropInfo|localVariables|variable)$/i.test(name),
		});
		const parsed = parser.parse(xml) as Record<string, unknown>;
		const response = parsed[ResponseSchema.rootElement] ?? parsed;
		const r = response as Record<string, unknown>;
		let resultNode = r.result ?? r.Result ?? r['debugRDBGRequestResponse:result'];
		if (resultNode == null) return { variables: [], exprResultsByIndex: [] };
		const results = Array.isArray(resultNode) ? resultNode : [resultNode];
		for (let i = 0; i < results.length; i++) {
			const res = results[i] as Record<string, unknown>;
			if (!res || typeof res !== 'object') continue;
			const calcResult = (res.calculationResult ?? res.CalculationResult) as Record<string, unknown> | undefined;
			const propList = calcResult?.valueOfContextPropInfo ?? calcResult?.ValueOfContextPropInfo;
			const arr = Array.isArray(propList) ? propList : propList ? [propList] : [];
			if (arr.length > 0) {
				if (i === 0) {
					variables.push(...arr.map((p: unknown) => {
						const prop = p as Record<string, unknown>;
						const propInfo = (prop.propInfo ?? prop.PropInfo) as Record<string, unknown> | undefined;
						const valInfo = (prop.valueInfo ?? prop.ValueInfo) as Record<string, unknown> | undefined;
						const name = propInfo ? String(propInfo.propName ?? propInfo.PropName ?? '').trim() : '';
						const typeName = valInfo ? String(valInfo.typeName ?? valInfo.TypeName ?? '').trim() : String(propInfo?.typeName ?? propInfo?.TypeName ?? '').trim();
						let value = '';
						if (valInfo) {
							const vd = valInfo.valueDecimal ?? valInfo.ValueDecimal;
							const vdt = valInfo.valueDateTime ?? valInfo.ValueDateTime;
							const vs = valInfo.valueString ?? valInfo.ValueString;
							const vb = valInfo.valueBoolean ?? valInfo.ValueBoolean;
							const pres = valInfo.pres ?? valInfo.Pres;
							if (vd !== undefined && vd !== null) value = String(vd);
							else if (vdt !== undefined && vdt !== null) value = String(vdt);
							else if (vb !== undefined && vb !== null) value = String(vb);
							else if (vs !== undefined && vs !== null) value = decodeBase64ToUtf8(vs) || String(vs);
							else if (typeof pres === 'string' && pres.length > 0) value = decodeBase64ToUtf8(pres) || pres;
							else if (typeName) value = typeName;
						}
						if (!value && typeName) value = typeName;
						if (!value && name) value = 'Неопределено';
						return { name, value: value || '', typeName: typeName || undefined };
					}));
				} else {
					exprResultsByIndex.push(parseEvalExprResultFromResultObject(res));
				}
			} else {
				const localVars = res.localVariables ?? res.LocalVariables ?? [];
				const varList = Array.isArray(localVars) ? localVars : localVars ? [localVars] : [];
				if (i === 0 && varList.length > 0) {
					for (const v of varList) {
						const variable = v as Record<string, unknown>;
						variables.push({
							name: String(variable.name ?? variable.Name ?? ''),
							value: String(variable.value ?? variable.Value ?? ''),
							typeName: String(variable.typeName ?? variable.TypeName ?? ''),
						});
					}
				}
			}
		}
	} catch {
		// ignore
	}
	return { variables, exprResultsByIndex };
}
