/**
 * Сопоставление путей к .bsl с ObjectId/PropertyId для RDBG setBreakpoints.
 * objectID — GUID объекта метаданных (справочник, документ, форма и т.д.), из которого вызывается отладка.
 * propertyID — GUID свойства (модуль формы, модуль объекта и т.д.), т.е. модуля из которого вызывается отладка.
 * URL в setBreakpoints не передаём — только ExtensionName, ObjectId, PropertyId.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DbModuleType, BslModuleTypeEnum } from './rdbgTypes';

export type { DbModuleType };

export interface ModuleInfo {
	extension: string;
	objectId: string;
	propertyId: string;
	path: string;
	/** Строковый идентификатор модуля (moduleName в XDTO), например Справочник.Контрагенты.МодульОбъекта. */
	moduleIdString: string;
	/** Тип модуля для db:type (FormModule, ObjectModule, CommonModule и т.д.). */
	dbModuleType: DbModuleType;
	/** BSLModuleType для XDTO-схемы (ConfigModule, ObjectModule, ManagedFormModule и т.д.). */
	bslModuleType: BslModuleTypeEnum;
}

/** Папка метаданных (EDT) → русское имя типа (Справочник, Документ, …). */
const MD_TYPE_TO_RU: Record<string, string> = {
	Catalogs: 'Справочник',
	Documents: 'Документ',
	DataProcessors: 'Обработка',
	Reports: 'Отчет',
	CommonModules: 'ОбщийМодуль',
	Enums: 'Перечисление',
	InformationRegisters: 'РегистрСведений',
	AccumulationRegisters: 'РегистрНакопления',
	ChartsOfAccounts: 'ПланСчетов',
	ChartsOfCalculationTypes: 'ПланВидовРасчета',
	ChartsOfCharacteristicTypes: 'ПланВидовХарактеристик',
	BusinessProcesses: 'БизнесПроцесс',
	Tasks: 'Задача',
	WebServices: 'ВебСервис',
	HTTPServices: 'HTTPСервис',
	ExternalDataSources: 'ВнешнийИсточникДанных',
	SessionParameters: 'ПараметрСеанса',
	Settings: 'Настройка',
	Subsystems: 'Подсистема',
	Roles: 'Роль',
	Languages: 'Язык',
	CommonForms: 'ОбщаяФорма',
	CommonCommands: 'ОбщаяКоманда',
};

/** Имя файла модуля → русский суффикс (МодульОбъекта, Модуль, …), DbModuleType и BslModuleTypeEnum. */
function getModuleSuffixAndDbType(moduleName: string): {
	suffix: string;
	dbType: DbModuleType;
	bslType: BslModuleTypeEnum;
} {
	const map: Record<string, { suffix: string; dbType: DbModuleType; bslType: BslModuleTypeEnum }> = {
		ObjectModule: { suffix: 'МодульОбъекта', dbType: 'ObjectModule', bslType: 'ObjectModule' },
		ManagerModule: { suffix: 'МодульМенеджера', dbType: 'ManagerModule', bslType: 'ManagerModule' },
		Module: { suffix: 'Форма', dbType: 'FormModule', bslType: 'ManagedFormModule' },
		CommandModule: { suffix: 'МодульКоманды', dbType: 'Module', bslType: 'ConfigModule' },
		SessionModule: { suffix: 'Модуль', dbType: 'Module', bslType: 'SessionModule' },
		OrdinaryApplicationModule: { suffix: 'Модуль', dbType: 'Module', bslType: 'ConfigModule' },
		ManagedApplicationModule: { suffix: 'Модуль', dbType: 'Module', bslType: 'ConfigModule' },
		ExternalConnectionModule: { suffix: 'Модуль', dbType: 'Module', bslType: 'ExternalConnectionModule' },
	};
	const r = map[moduleName];
	return r ?? { suffix: 'Модуль', dbType: 'Module', bslType: 'ConfigModule' };
}

/**
 * Фиксированные GUID свойств модулей (как в onec-debug-adapter MetadataProvider.GetPropertyId).
 * propertyID — фиксированный GUID по типу модуля: Ext/ObjectModule.bsl → ObjectModule, Forms/X/Form.bsl → Form.
 */
function getPropertyId(mdType: string, moduleName: string): string {
	if (mdType === 'CommonModules' || mdType === 'WebServices' || mdType === 'HTTPServices') {
		return 'd5963243-262e-4398-b4d7-fb16d06484f6';
	}
	const map: Record<string, string> = {
		Module: '32e087ab-1491-49b6-aba7-43571b41ac2b',
		Form: '32e087ab-1491-49b6-aba7-43571b41ac2b', // модуль формы (Form.bsl), propertyID = GUID свойства модуля
		CommandModule: '078a6af8-d22c-4248-9c33-7e90075a3d2c',
		ObjectModule: 'a637f77f-3840-441d-a1c3-699c8c5cb7e0', // Ext/ObjectModule.bsl
		ManagerModule: 'd1b64a2c-8078-4982-8190-8f81aefda192',
		RecordSetModule: '9f36fd70-4bf4-47f6-b235-935f73aab43f',
		ValueManagerModule: '3e58c91f-9aaa-4f42-8999-4baf33907b75',
		ManagedApplicationModule: 'd22e852a-cf8a-4f77-8ccb-3548e7792bea',
		SessionModule: '9b7bbbae-9771-46f2-9e4d-2489e0ffc702',
		ExternalConnectionModule: 'a4a9c1e2-1e54-4c7f-af06-4ca341198fac',
		OrdinaryApplicationModule: 'a78d9ce3-4e0c-48d5-9863-ae7342eedf94',
	};
	return map[moduleName] ?? '32e087ab-1491-49b6-aba7-43571b41ac2b';
}

/** Корневые теги объектов метаданных 1С (EDT и стандартная выгрузка). */
const METADATA_ROOT_TAGS =
	'MetaDataObject|Configuration|Document|Catalog|Form|CommonModule|Command|Report|DataProcessor|Task|BusinessProcess|Enum|InformationRegister|AccumulationRegister|ChartOfAccounts|ChartOfCalculationTypes|ChartOfCharacteristicTypes|ExchangePlan|Sequence|ExternalDataSource|Role|Language|CommonForm|CommonCommand|CommonPicture|CommonTemplate|Template|FilterCriterion|SessionParameter|Setting|Subsystem|CommandGroup|DefinedType|FunctionalOption|CommonAttribute|EventSubscription';

/** Извлекает uuid объекта метаданных из корневого тега XML (objectID — GUID объекта, из которого вызывается отладка). */
function getObjectIdFromXml(filePath: string): string | null {
	try {
		const xml = fs.readFileSync(filePath, 'utf8');
		const uuidMatch = xml.match(
			new RegExp(`<(?:${METADATA_ROOT_TAGS})[^>]*\\suuid="([0-9a-fA-F-]{36})"`, 'i'),
		);
		return uuidMatch ? uuidMatch[1] : null;
	} catch {
		return null;
	}
}

function normalizePath(p: string): string {
	return path.resolve(p).replace(/\\/g, '/');
}

/** Кэш: ключ — нормализованный путь к .bsl, значение — ModuleInfo. По одному кэшу на rootProject. */
const cacheByRoot = new Map<string, Map<string, ModuleInfo>>();

function fillCache(rootProject: string): void {
	const root = normalizePath(rootProject);
	if (cacheByRoot.has(root)) return;

	const cache = new Map<string, ModuleInfo>();

	function cacheModule(
		modulePath: string,
		extension: string,
		objectId: string,
		propertyId: string,
		moduleIdString: string,
		dbModuleType: DbModuleType,
		bslModuleType: BslModuleTypeEnum,
	): void {
		const key = normalizePath(modulePath);
		cache.set(key, { extension, objectId, propertyId, path: modulePath, moduleIdString, dbModuleType, bslModuleType });
	}

	// Корень конфигурации: Configuration.xml в rootProject или в src/cf (vanessa-bootstrap)
	const configXmlInRoot = path.join(rootProject, 'Configuration.xml');
	const configXmlInSrcCf = path.join(rootProject, 'src', 'cf', 'Configuration.xml');
	const configXmlPath = fs.existsSync(configXmlInRoot)
		? configXmlInRoot
		: fs.existsSync(configXmlInSrcCf)
			? configXmlInSrcCf
			: null;
	const configRoot = configXmlPath ? path.dirname(configXmlPath) : rootProject;

	if (configXmlPath) {
		const configObjectId = getObjectIdFromXml(configXmlPath);
		if (configObjectId) {
			const extPath = path.join(configRoot, 'Ext');
			const configModuleNames: Record<string, string> = {
				SessionModule: 'МодульСеанса.Модуль',
				OrdinaryApplicationModule: 'МодульПриложения.Модуль',
				ManagedApplicationModule: 'МодульУправляемогоПриложения.Модуль',
				ExternalConnectionModule: 'МодульВнешнегоСоединения.Модуль',
			};
			if (fs.existsSync(extPath) && fs.statSync(extPath).isDirectory()) {
				for (const entry of fs.readdirSync(extPath, { withFileTypes: true })) {
					const full = path.join(extPath, entry.name);
					if (entry.isFile() && entry.name.toLowerCase().endsWith('.bsl')) {
						const moduleName = path.basename(entry.name, '.bsl');
						const moduleIdStr = configModuleNames[moduleName] ?? `Конфигурация.${moduleName}`;
						const { dbType, bslType } = getModuleSuffixAndDbType(moduleName);
						cacheModule(full, '', configObjectId, getPropertyId('', moduleName), moduleIdStr, dbType, bslType);
					}
				}
			}
		}
	}

	// Папки метаданных: Catalogs, Documents, DataProcessors и т.д. — каждая содержит *.xml
	const rootDirs = ['Catalogs', 'Documents', 'DataProcessors', 'Reports', 'InformationRegisters', 'AccumulationRegisters', 'Enums', 'CommonModules', 'SessionParameters', 'Settings', 'Subsystems', 'BusinessProcesses', 'Tasks', 'WebServices', 'HTTPServices', 'ExternalDataSources', 'Roles', 'Languages', 'Styles', 'CommonAttributes', 'CommonForms', 'CommonCommands', 'CommonPictures', 'FilterCriteria', 'ChartsOfCalculationTypes', 'ChartsOfAccounts', 'ChartsOfCharacteristicTypes', 'ExchangePlans', 'Sequences', 'FunctionalOptions', 'DefinedTypes', 'CommandGroups', 'CommonTemplates', 'Templates', 'EventSubscriptions'];
	for (const dirName of rootDirs) {
		const mdDir = path.join(configRoot, dirName);
		if (!fs.existsSync(mdDir) || !fs.statSync(mdDir).isDirectory()) continue;

		const xmlFiles = fs.readdirSync(mdDir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.xml'));
		for (const xmlEntry of xmlFiles) {
			const xmlPath = path.join(mdDir, xmlEntry.name);
			const objectId = getObjectIdFromXml(xmlPath);
			if (!objectId) continue;

			const mdName = path.basename(xmlEntry.name, '.xml');
			const mdPath = path.join(mdDir, mdName);
			const mdType = dirName;

			// Ext/*.bsl (в т.ч. в подкаталогах, например Ext/ObjectModule.bsl)
			const extPath = path.join(mdPath, 'Ext');
			const mdTypeRu = MD_TYPE_TO_RU[mdType] ?? mdType;
			const isCommonLike = mdType === 'CommonModules' || mdType === 'WebServices' || mdType === 'HTTPServices';
			if (fs.existsSync(extPath) && fs.statSync(extPath).isDirectory()) {
				const objId = objectId;
				function scanExt(dir: string): void {
					for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
						const full = path.join(dir, e.name);
						if (e.isDirectory()) scanExt(full);
						else if (e.name.toLowerCase().endsWith('.bsl')) {
							const moduleName = path.basename(e.name, '.bsl');
							let moduleIdStr: string;
							let dbType: DbModuleType;
							let bslType: BslModuleTypeEnum;
							if (isCommonLike) {
								moduleIdStr = `ОбщийМодуль.${mdName}.Модуль`;
								dbType = 'CommonModule';
								bslType = 'CommonModule';
							} else {
								const s = getModuleSuffixAndDbType(moduleName);
								moduleIdStr = `${mdTypeRu}.${mdName}.${s.suffix}`;
								dbType = s.dbType;
								bslType = s.bslType;
							}
							cacheModule(full, '', objId, getPropertyId(mdType, moduleName), moduleIdStr, dbType, bslType);
						}
					}
				}
				scanExt(extPath);
			}

			// Forms (модули формы: Forms/X/Ext/Form/Module.bsl или Forms/X/*.bsl)
			const formsPath = path.join(mdPath, 'Forms');
			if (fs.existsSync(formsPath) && fs.statSync(formsPath).isDirectory()) {
				for (const formEntry of fs.readdirSync(formsPath, { withFileTypes: true })) {
					if (!formEntry.name.toLowerCase().endsWith('.xml')) continue;
					const formXmlPath = path.join(formsPath, formEntry.name);
					const formObjectId = getObjectIdFromXml(formXmlPath);
					if (!formObjectId) continue;
					const formName = path.basename(formEntry.name, '.xml');
					const formDir = path.join(formsPath, formName);
					if (!fs.existsSync(formDir) || !fs.statSync(formDir).isDirectory()) continue;
					const moduleIdStr = `${mdTypeRu}.${mdName}.Форма.${formName}.Форма`;
					// Стандартная структура: Forms/X/Ext/Form/Module.bsl
					const formExtFormPath = path.join(formDir, 'Ext', 'Form');
					const formModuleBsl = path.join(formExtFormPath, 'Module.bsl');
					if (fs.existsSync(formModuleBsl) && fs.statSync(formModuleBsl).isFile()) {
						cacheModule(formModuleBsl, '', formObjectId, getPropertyId(mdType, 'Module'), moduleIdStr, 'FormModule', 'ManagedFormModule');
					} else {
						// Альтернатива: Forms/X/*.bsl (vanessa-bootstrap, Form.bsl)
						const bslFiles = fs.readdirSync(formDir, { withFileTypes: true }).filter((f) => f.isFile() && f.name.toLowerCase().endsWith('.bsl'));
						const firstBsl = bslFiles[0];
						if (firstBsl) {
							const full = path.join(formDir, firstBsl.name);
							const moduleName = path.basename(firstBsl.name, '.bsl');
							cacheModule(full, '', formObjectId, getPropertyId(mdType, moduleName), moduleIdStr, 'FormModule', 'ManagedFormModule');
						}
					}
				}
			}

			// Commands (Commands/X/Ext/CommandModule.bsl или Commands/X/*.bsl)
			const commandsPath = path.join(mdPath, 'Commands');
			if (fs.existsSync(commandsPath) && fs.statSync(commandsPath).isDirectory()) {
				const xml = fs.readFileSync(xmlPath, 'utf8');
				const commandUuidMatches = xml.matchAll(/<Command[^>]*\suuid="([0-9a-fA-F-]{36})"[^>]*>[\s\S]*?<Name>([^<]+)<\/Name>/g);
				for (const m of commandUuidMatches) {
					const cmdObjectId = m[1];
					const cmdName = m[2];
					const cmdDir = path.join(commandsPath, cmdName);
					if (!fs.existsSync(cmdDir) || !fs.statSync(cmdDir).isDirectory()) continue;
					const moduleIdStr = `${mdTypeRu}.${mdName}.Команда.${cmdName}.МодульКоманды`;
					const cmdExtBsl = path.join(cmdDir, 'Ext', 'CommandModule.bsl');
					if (fs.existsSync(cmdExtBsl) && fs.statSync(cmdExtBsl).isFile()) {
						cacheModule(cmdExtBsl, '', cmdObjectId, getPropertyId('', 'CommandModule'), moduleIdStr, 'Module', 'ConfigModule');
					} else {
						const bslFiles = fs.readdirSync(cmdDir, { withFileTypes: true }).filter((f) => f.isFile() && f.name.toLowerCase().endsWith('.bsl'));
						if (bslFiles[0]) {
							const full = path.join(cmdDir, bslFiles[0].name);
							const moduleName = path.basename(bslFiles[0].name, '.bsl');
							cacheModule(full, '', cmdObjectId, getPropertyId('', moduleName), moduleIdStr, 'Module', 'ConfigModule');
						}
					}
				}
			}
		}
	}

	cacheByRoot.set(root, cache);
}

/**
 * Возвращает информацию о модуле по пути к файлу .bsl.
 * rootProject — корень проекта (каталог с Configuration.xml и Catalogs, Documents и т.д.).
 * При первом вызове для данного rootProject выполняется разбор конфигурации и заполнение кэша.
 */
export function getModuleInfoByPath(rootProject: string, sourcePath: string): ModuleInfo {
	if (!rootProject || !sourcePath) {
		return { extension: '', objectId: '', propertyId: '', path: sourcePath || '', moduleIdString: '', dbModuleType: 'Module', bslModuleType: 'ConfigModule' };
	}
	fillCache(rootProject);
	const root = normalizePath(rootProject);
	const cache = cacheByRoot.get(root);
	const key = normalizePath(sourcePath);
	const found = cache?.get(key);
	if (found) return found;
	// Попытка по относительному пути (если sourcePath относительный)
	const resolved = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(rootProject, sourcePath);
	const keyResolved = normalizePath(resolved);
	const foundResolved = cache?.get(keyResolved);
	if (foundResolved) return foundResolved;
	return { extension: '', objectId: '', propertyId: '', path: sourcePath, moduleIdString: '', dbModuleType: 'Module', bslModuleType: 'ConfigModule' };
}

/**
 * Обратный поиск: путь к файлу .bsl по objectID и propertyID (для маппинга стека вызовов).
 */
export function getModulePathByObjectProperty(rootProject: string, objectId: string, propertyId: string): string {
	if (!rootProject || !objectId || !propertyId) return '';
	fillCache(rootProject);
	const root = normalizePath(rootProject);
	const cache = cacheByRoot.get(root);
	if (!cache) return '';
	for (const info of cache.values()) {
		if (info.objectId === objectId && info.propertyId === propertyId) {
			return info.path;
		}
	}
	return '';
}
