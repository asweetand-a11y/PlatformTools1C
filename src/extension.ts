import * as vscode from 'vscode';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchDbgsProcess, resolveDbgsPath } from './debug/dbgsLauncher';
import { setLastDbgsLaunch } from './debug/dbgsLaunchInfo';
import { PlatformTreeDataProvider, PlatformTreeItem } from './treeViewProvider';
import { VRunnerManager } from './vrunnerManager';
import { InfobaseCommands } from './commands/infobaseCommands';
import { ConfigurationCommands } from './commands/configurationCommands';
import { ExtensionsCommands } from './commands/extensionsCommands';
import { ExternalFilesCommands } from './commands/externalFilesCommands';
import { DependenciesCommands } from './commands/dependenciesCommands';
import { RunCommands } from './commands/runCommands';
import { TestCommands } from './commands/testCommands';
import { WorkspaceTasksCommands } from './commands/workspaceTasksCommands';
import { registerDebugAdapter } from './debug/debugAdapter';

type EnvDefaultSection = {
	'--v8version'?: string;
	'--debug-server'?: string;
	'--debug-port-range'?: string;
	'--v8-platform-root'?: string;
};

type EnvConfig = {
	default?: EnvDefaultSection;
};

let dbgsProcess: ChildProcess | undefined;

/**
 * Проверяет, является ли открытая рабочая область проектом 1С
 * Расширение активируется, если в корне есть файл packagedef
 * @returns true, если это проект 1С
 */
async function is1CProject(): Promise<boolean> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		return false;
	}

	const workspaceRoot = workspaceFolders[0].uri.fsPath;
	const fs = await import('node:fs/promises');
	const path = await import('node:path');

	const packagedefPath = path.join(workspaceRoot, 'packagedef');
	
	try {
		await fs.access(packagedefPath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Активирует расширение
 * @param context - Контекст расширения VS Code
 */
export async function activate(context: vscode.ExtensionContext) {
	await launchDbgsFromEnv(context);

	await vscode.commands.executeCommand('setContext', '1c-dev-tools.is1CProject', false);

	const isProject = await is1CProject();
	
	if (isProject) {
		await vscode.commands.executeCommand('setContext', '1c-dev-tools.is1CProject', true);
	}

	registerDebugAdapter(context);

	const vrunnerManager = VRunnerManager.getInstance(context);

	const infobaseCommands = new InfobaseCommands();
	const configurationCommands = new ConfigurationCommands();
	const extensionsCommands = new ExtensionsCommands();
	const externalFilesCommands = new ExternalFilesCommands();
	const dependenciesCommands = new DependenciesCommands();
	const runCommands = new RunCommands();
	const testCommands = new TestCommands();
	const workspaceTasksCommands = new WorkspaceTasksCommands();

	const treeDataProvider = new PlatformTreeDataProvider(context.extensionUri);

	let panelTreeView: vscode.TreeView<PlatformTreeItem> | undefined;
	if (isProject) {
		panelTreeView = vscode.window.createTreeView('1c-dev-tools-panel-view', {
			treeDataProvider: treeDataProvider,
			showCollapseAll: true,
		});
	}

	const refreshCommand = vscode.commands.registerCommand('1c-dev-tools.refresh', () => {
		if (!isProject) {
			vscode.window.showWarningMessage('Откройте проект 1С (с файлом packagedef в корне) для использования расширения');
			return;
		}
		treeDataProvider.refresh();
		vscode.window.showInformationMessage('Дерево обновлено');
	});

	const settingsCommand = vscode.commands.registerCommand('1c-dev-tools.settings', () => {
		vscode.commands.executeCommand('workbench.action.openSettings', '@ext:whiterabbit.1c-dev-tools');
	});

	// Вспомогательная функция для проверки проекта перед выполнением команды
	const requireProject = (): boolean => {
		if (!isProject) {
			vscode.window.showWarningMessage('Откройте проект 1С (с файлом packagedef в корне) для использования этой команды');
			return false;
		}
		return true;
	};

	const configurationLoadFromSrcCommand = vscode.commands.registerCommand('1c-dev-tools.configuration.loadFromSrc', () => {
		if (!requireProject()) return;
		configurationCommands.loadFromSrc('update');
	});

	const configurationLoadFromSrcInitCommand = vscode.commands.registerCommand('1c-dev-tools.configuration.loadFromSrc.init', () => {
		if (!requireProject()) return;
		configurationCommands.loadFromSrc('init');
	});

	const configurationUpdateFromSrcWithCommitCommand = vscode.commands.registerCommand('1c-dev-tools.configuration.updateFromSrcWithCommit', () => {
		if (!requireProject()) return;
		configurationCommands.updateFromSrcWithCommit();
	});

	const configurationLoadFromCfCommand = vscode.commands.registerCommand('1c-dev-tools.configuration.loadFromCf', () => {
		if (!requireProject()) return;
		configurationCommands.loadFromCf();
	});

	const configurationDumpToSrcCommand = vscode.commands.registerCommand('1c-dev-tools.configuration.dumpToSrc', () => {
		if (!requireProject()) return;
		configurationCommands.dumpToSrc();
	});

	const configurationDumpUpdateToSrcCommand = vscode.commands.registerCommand('1c-dev-tools.configuration.dumpUpdateToSrc', () => {
		if (!requireProject()) return;
		configurationCommands.dumpUpdateToSrc();
	});

	const configurationDumpToCfCommand = vscode.commands.registerCommand('1c-dev-tools.configuration.dumpToCf', () => {
		if (!requireProject()) return;
		configurationCommands.dumpToCf();
	});

	const configurationDumpToDistCommand = vscode.commands.registerCommand('1c-dev-tools.configuration.dumpToDist', () => {
		if (!requireProject()) return;
		configurationCommands.dumpToDist();
	});

	const configurationBuildCommand = vscode.commands.registerCommand('1c-dev-tools.configuration.build', () => {
		if (!requireProject()) return;
		configurationCommands.compile();
	});

	const configurationDecompileCommand = vscode.commands.registerCommand('1c-dev-tools.configuration.decompile', () => {
		if (!requireProject()) return;
		configurationCommands.decompile();
	});

	const extensionsLoadFromSrcCommand = vscode.commands.registerCommand('1c-dev-tools.extensions.loadFromSrc', () => {
		if (!requireProject()) return;
		extensionsCommands.loadFromSrc();
	});

	const extensionsLoadFromCfeCommand = vscode.commands.registerCommand('1c-dev-tools.extensions.loadFromCfe', () => {
		if (!requireProject()) return;
		extensionsCommands.loadFromCfe();
	});

	const extensionsDumpToSrcCommand = vscode.commands.registerCommand('1c-dev-tools.extensions.dumpToSrc', () => {
		if (!requireProject()) return;
		extensionsCommands.dumpToSrc();
	});

	const extensionsDumpUpdateToSrcCommand = vscode.commands.registerCommand('1c-dev-tools.extensions.dumpUpdateToSrc', () => {
		if (!requireProject()) return;
		extensionsCommands.dumpUpdateToSrc();
	});

	const extensionsUpdateFromSrcWithCommitCommand = vscode.commands.registerCommand('1c-dev-tools.extensions.updateFromSrcWithCommit', () => {
		if (!requireProject()) return;
		extensionsCommands.updateFromSrcWithCommit();
	});

	const extensionsDumpToCfeCommand = vscode.commands.registerCommand('1c-dev-tools.extensions.dumpToCfe', () => {
		if (!requireProject()) return;
		extensionsCommands.dumpToCfe();
	});

	const extensionsBuildCommand = vscode.commands.registerCommand('1c-dev-tools.extensions.build', () => {
		if (!requireProject()) return;
		extensionsCommands.compile();
	});

	const extensionsDecompileCommand = vscode.commands.registerCommand('1c-dev-tools.extensions.decompile', () => {
		if (!requireProject()) return;
		extensionsCommands.decompile();
	});

	const externalProcessorsBuildCommand = vscode.commands.registerCommand('1c-dev-tools.externalProcessors.build', () => {
		if (!requireProject()) return;
		externalFilesCommands.compile('processor');
	});

	const externalProcessorsDecompileCommand = vscode.commands.registerCommand('1c-dev-tools.externalProcessors.decompile', () => {
		if (!requireProject()) return;
		externalFilesCommands.decompile('processor');
	});

	const externalReportsBuildCommand = vscode.commands.registerCommand('1c-dev-tools.externalReports.build', () => {
		if (!requireProject()) return;
		externalFilesCommands.compile('report');
	});

	const externalReportsDecompileCommand = vscode.commands.registerCommand('1c-dev-tools.externalReports.decompile', () => {
		if (!requireProject()) return;
		externalFilesCommands.decompile('report');
	});

	const externalFilesClearCacheCommand = vscode.commands.registerCommand('1c-dev-tools.externalFiles.clearCache', () => {
		if (!requireProject()) return;
		externalFilesCommands.clearCache();
	});

	const infobaseUpdateDatabaseCommand = vscode.commands.registerCommand('1c-dev-tools.infobase.updateDatabase', () => {
		if (!requireProject()) return;
		infobaseCommands.updateDatabase();
	});

	const infobaseBlockExternalResourcesCommand = vscode.commands.registerCommand('1c-dev-tools.infobase.blockExternalResources', () => {
		if (!requireProject()) return;
		infobaseCommands.blockExternalResources();
	});

	const infobaseDumpToDtCommand = vscode.commands.registerCommand('1c-dev-tools.infobase.dumpToDt', () => {
		if (!requireProject()) return;
		infobaseCommands.dumpToDt();
	});

	const infobaseLoadFromDtCommand = vscode.commands.registerCommand('1c-dev-tools.infobase.loadFromDt', () => {
		if (!requireProject()) return;
		infobaseCommands.loadFromDt();
	});

	const dependenciesInstallCommand = vscode.commands.registerCommand('1c-dev-tools.dependencies.install', () => {
		if (!requireProject()) return;
		dependenciesCommands.installDependencies();
	});

	const dependenciesRemoveCommand = vscode.commands.registerCommand('1c-dev-tools.dependencies.remove', () => {
		if (!requireProject()) return;
		dependenciesCommands.removeDependencies();
	});

	const dependenciesInitializePackagedefCommand = vscode.commands.registerCommand('1c-dev-tools.dependencies.initializePackagedef', () => {
		if (!requireProject()) return;
		dependenciesCommands.initializePackagedef();
	});

	const buildConfigurationCommand = vscode.commands.registerCommand('1c-dev-tools.build.configuration', () => {
		if (!requireProject()) return;
		configurationCommands.compile();
	});

	const buildExtensionsCommand = vscode.commands.registerCommand('1c-dev-tools.build.extensions', () => {
		if (!requireProject()) return;
		extensionsCommands.compile();
	});

	const buildExternalProcessorCommand = vscode.commands.registerCommand('1c-dev-tools.build.externalProcessor', () => {
		if (!requireProject()) return;
		externalFilesCommands.compile();
	});

	const buildExternalReportCommand = vscode.commands.registerCommand('1c-dev-tools.build.externalReport', () => {
		if (!requireProject()) return;
		externalFilesCommands.compile();
	});

	const decompileConfigurationCommand = vscode.commands.registerCommand('1c-dev-tools.decompile.configuration', () => {
		if (!requireProject()) return;
		configurationCommands.decompile();
	});

	const decompileExternalProcessorCommand = vscode.commands.registerCommand('1c-dev-tools.decompile.externalProcessor', () => {
		if (!requireProject()) return;
		externalFilesCommands.decompile();
	});

	const decompileExternalReportCommand = vscode.commands.registerCommand('1c-dev-tools.decompile.externalReport', () => {
		if (!requireProject()) return;
		externalFilesCommands.decompile();
	});

	const decompileExtensionCommand = vscode.commands.registerCommand('1c-dev-tools.decompile.extension', () => {
		if (!requireProject()) return;
		extensionsCommands.decompile();
	});

	const runEnterpriseCommand = vscode.commands.registerCommand('1c-dev-tools.run.enterprise', () => {
		if (!requireProject()) return;
		runCommands.runEnterprise();
	});

	const runDesignerCommand = vscode.commands.registerCommand('1c-dev-tools.run.designer', () => {
		if (!requireProject()) return;
		runCommands.runDesigner();
	});


	const launchViewCommand = vscode.commands.registerCommand('1c-dev-tools.launch.view', () => {
		if (!requireProject()) return;
		treeDataProvider.refresh();
	});

	const launchRunCommand = vscode.commands.registerCommand('1c-dev-tools.launch.run', async (taskLabel: string) => {
		if (!requireProject()) return;
		await workspaceTasksCommands.runTask(taskLabel);
	});

	const launchEditCommand = vscode.commands.registerCommand('1c-dev-tools.launch.edit', () => {
		if (!requireProject()) return;
		workspaceTasksCommands.editTasks();
	});

	const fileOpenCommand = vscode.commands.registerCommand('1c-dev-tools.file.open', async (filePath: string) => {
		const uri = vscode.Uri.file(filePath);
		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc);
	});

	const launchEditConfigurationsCommand = vscode.commands.registerCommand('1c-dev-tools.launch.editConfigurations', () => {
		if (!requireProject()) return;
		workspaceTasksCommands.editLaunchConfigurations();
	});

	const configEnvEditCommand = vscode.commands.registerCommand('1c-dev-tools.config.env.edit', async () => {
		const workspaceRoot = vrunnerManager.getWorkspaceRoot();
		if (!workspaceRoot) {
			vscode.window.showErrorMessage('Откройте рабочую область для работы с проектом');
			return;
		}
		const envPath = vscode.Uri.file(path.join(workspaceRoot, 'env.json'));
		const doc = await vscode.workspace.openTextDocument(envPath);
		await vscode.window.showTextDocument(doc);
	});

	const infobaseCreateEmptyCommand = vscode.commands.registerCommand('1c-dev-tools.infobase.createEmpty', () => {
		if (!requireProject()) return;
		infobaseCommands.createEmptyInfobase();
	});

	if (panelTreeView) {
		context.subscriptions.push(panelTreeView);
	}

	context.subscriptions.push(
		refreshCommand,
		settingsCommand,
		infobaseCreateEmptyCommand,
		configurationLoadFromSrcCommand,
		configurationLoadFromSrcInitCommand,
		configurationUpdateFromSrcWithCommitCommand,
		configurationLoadFromCfCommand,
		configurationDumpToSrcCommand,
		configurationDumpUpdateToSrcCommand,
		configurationDumpToCfCommand,
		configurationDumpToDistCommand,
		configurationBuildCommand,
		configurationDecompileCommand,
		extensionsLoadFromSrcCommand,
		extensionsLoadFromCfeCommand,
		extensionsDumpToSrcCommand,
		extensionsDumpUpdateToSrcCommand,
		extensionsUpdateFromSrcWithCommitCommand,
		extensionsDumpToCfeCommand,
		extensionsBuildCommand,
		extensionsDecompileCommand,
		externalProcessorsBuildCommand,
		externalProcessorsDecompileCommand,
		externalReportsBuildCommand,
		externalReportsDecompileCommand,
		externalFilesClearCacheCommand,
		infobaseUpdateDatabaseCommand,
		infobaseBlockExternalResourcesCommand,
		infobaseDumpToDtCommand,
		infobaseLoadFromDtCommand,
		dependenciesInstallCommand,
		dependenciesRemoveCommand,
		dependenciesInitializePackagedefCommand,
		buildConfigurationCommand,
		buildExtensionsCommand,
		buildExternalProcessorCommand,
		buildExternalReportCommand,
		decompileConfigurationCommand,
		decompileExternalProcessorCommand,
		decompileExternalReportCommand,
		decompileExtensionCommand,
		runEnterpriseCommand,
		runDesignerCommand,
		launchViewCommand,
		launchRunCommand,
		launchEditCommand,
		fileOpenCommand,
		launchEditConfigurationsCommand,
		configEnvEditCommand
	);

}

async function launchDbgsFromEnv(context: vscode.ExtensionContext): Promise<void> {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceFolder) {
		return;
	}

	const envPath = path.join(workspaceFolder, 'env.json');
	if (!fs.existsSync(envPath)) {
		return;
	}

	const envConfig = parseEnvConfig(envPath);
	const envDefault = envConfig.default;
	if (!envDefault) {
		return;
	}

	const v8version = envDefault['--v8version'];
	const debugServer = envDefault['--debug-server'];
	const debugPortRange = envDefault['--debug-port-range'];

	// Не запускать dbgs.exe, если сервер отладки на другом компьютере
	const hostname = os.hostname();
	if (debugServer && debugServer.toLocaleLowerCase() !== hostname.toLocaleLowerCase()) {
		return;
	}

	if (!v8version || !debugServer || !debugPortRange) {
		void vscode.window.showWarningMessage(
			'1C Dev Tools: для запуска dbgs.exe заполните --v8version, --debug-server и --debug-port-range в env.json',
		);
		return;
	}

	const dbgsPath = resolveDbgsPath(v8version, envDefault['--v8-platform-root']);
	if (!dbgsPath) {
		void vscode.window.showErrorMessage(
			`1C Dev Tools: не найден dbgs.exe для версии платформы ${v8version}. Укажите --v8-platform-root в env.json`,
		);
		return;
	}

	const notifyFilePath = path.join(os.tmpdir(), `V8_${randomUUID()}.tmp`);

	try {
		const ownerPid = process.pid;
		dbgsProcess = launchDbgsProcess(dbgsPath, {
			debugServer,
			portRange: debugPortRange,
			ownerPid,
			notifyFilePath,
		});

		const quotedPath = dbgsPath.includes(' ') ? `"${dbgsPath}"` : dbgsPath;
		setLastDbgsLaunch({
			commandLine: `${quotedPath} --addr=${debugServer} --portRange=${debugPortRange} --ownerPID=${ownerPid} --notify=${notifyFilePath}`,
			ownerPid,
		});

		dbgsProcess.unref();
		context.subscriptions.push({
			dispose: () => {
				if (dbgsProcess && !dbgsProcess.killed) {
					dbgsProcess.kill();
				}
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(`1C Dev Tools: ошибка запуска dbgs.exe: ${message}`);
	}
}

function parseEnvConfig(envPath: string): EnvConfig {
	const rawContent = fs.readFileSync(envPath, 'utf8');
	return JSON.parse(rawContent) as EnvConfig;
}

/**
 * Деактивирует расширение
 */
export async function deactivate(): Promise<void> {
	if (dbgsProcess && !dbgsProcess.killed) {
		dbgsProcess.kill();
	}
	dbgsProcess = undefined;
}
