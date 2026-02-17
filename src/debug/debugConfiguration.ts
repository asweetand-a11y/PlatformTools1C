/**
 * DebugConfigurationProvider: подставляет значения из env.json в конфигурацию отладки.
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

type EnvDefaultSection = {
	'--ibconnection'?: string;
	'--infoBase'?: string;
	'--db-user'?: string;
	'--db-pwd'?: string;
	'--debug-server'?: string;
	'--debug-port-range'?: string;
	'--v8-platform-root'?: string;
	'--v8version'?: string;
};

type EnvConfig = {
	default?: EnvDefaultSection;
};

/**
 * Парсит порт из диапазона "1560:1591" — возвращает первый порт.
 */
function parsePortFromRange(portRange: string | undefined): number | undefined {
	if (!portRange) {
		return undefined;
	}
	const part = portRange.split(':')[0]?.trim();
	if (!part) {
		return undefined;
	}
	const n = parseInt(part, 10);
	return Number.isNaN(n) ? undefined : n;
}

/**
 * Читает env.json из корня workspace и возвращает секцию default.
 */
function loadEnvDefault(workspaceFolder: string): EnvDefaultSection | undefined {
	const envPath = path.join(workspaceFolder, 'env.json');
	if (!fs.existsSync(envPath)) {
		return undefined;
	}
	try {
		const raw = fs.readFileSync(envPath, 'utf8');
		const config = JSON.parse(raw) as EnvConfig;
		return config.default;
	} catch {
		return undefined;
	}
}

/**
 * DebugConfigurationProvider для типа onec.
 */
export class OnecDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
	resolveDebugConfigurationWithSubstitutedVariables(
		_folder: vscode.WorkspaceFolder | undefined,
		config: vscode.DebugConfiguration,
	): vscode.ProviderResult<vscode.DebugConfiguration> {
		if (config.type !== 'onec') {
			return config;
		}

		const workspaceFolder = _folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceFolder) {
			return config;
		}

		const env = loadEnvDefault(workspaceFolder);
		if (!env) {
			return config;
		}

		// env.json — источник истины: подставляем значения из env, при отсутствии — из config или дефолты
		config.debugServerHost = env['--debug-server'] ?? config.debugServerHost ?? 'localhost';
		config.debugServerPort =
			parsePortFromRange(env['--debug-port-range']) ?? config.debugServerPort ?? 1560;
		config.ibconnection = env['--ibconnection'] ?? config.ibconnection;
		config.infoBase = env['--infoBase'] ?? config.infoBase;
		config.infoBaseAlias = config.infoBaseAlias ?? 'DefAlias';
		// Всегда подставляем папку проекта — иначе маппинг модулей и пути /F неверны
		config.rootProject = workspaceFolder;
		config.platformPath = env['--v8-platform-root'] ?? config.platformPath;
		config.platformVersion = env['--v8version'] ?? config.platformVersion;
		config.dbUser = env['--db-user'] ?? config.dbUser;
		config.dbPwd = env['--db-pwd'] ?? config.dbPwd;

		// Валидация обязательных полей
		if (!config.debugServerHost || !config.debugServerPort) {
			vscode.window.showErrorMessage(
				'1C Dev Tools: не заданы debugServerHost или debugServerPort. Проверьте launch.json и env.json.',
			);
			return undefined;
		}
		if (config.request === 'attach' && !config.ibconnection) {
			vscode.window.showErrorMessage(
				'1C Dev Tools: не задан ibconnection для режима attach. Проверьте launch.json и env.json.',
			);
			return undefined;
		}
		if (config.request === 'launch' && !config.infoBase) {
			vscode.window.showErrorMessage(
				'1C Dev Tools: не задан infoBase для режима launch. Проверьте launch.json и env.json.',
			);
			return undefined;
		}

		return config;
	}

	provideDebugConfigurations(
		_folder: vscode.WorkspaceFolder | undefined,
	): vscode.ProviderResult<vscode.DebugConfiguration[]> {
		const workspaceFolder = _folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const env = workspaceFolder ? loadEnvDefault(workspaceFolder) : undefined;
		const port = env?.['--debug-port-range'] ? parsePortFromRange(env['--debug-port-range']) : 1560;
		const host = env?.['--debug-server'] ?? 'localhost';

		return [
			{
				type: 'onec',
				request: 'attach',
				name: '1C: Присоединиться',
				debugServerHost: host,
				debugServerPort: port ?? 1560,
				infoBaseAlias: 'DefAlias',
				autoAttachTypes: ['Client', 'Server'],
			},
		];
	}
}
