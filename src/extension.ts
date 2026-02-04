import * as vscode from 'vscode';
import * as path from 'node:path';
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
	await vscode.commands.executeCommand('setContext', '1c-platform-tools.is1CProject', false);
	
	const isProject = await is1CProject();
	
	if (isProject) {
		await vscode.commands.executeCommand('setContext', '1c-platform-tools.is1CProject', true);
	}

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
		panelTreeView = vscode.window.createTreeView('1c-platform-tools-panel-view', {
			treeDataProvider: treeDataProvider,
			showCollapseAll: true,
		});
	}

	const refreshCommand = vscode.commands.registerCommand('1c-platform-tools.refresh', () => {
		if (!isProject) {
			vscode.window.showWarningMessage('Откройте проект 1С (с файлом packagedef в корне) для использования расширения');
			return;
		}
		treeDataProvider.refresh();
		vscode.window.showInformationMessage('Дерево обновлено');
	});

	const settingsCommand = vscode.commands.registerCommand('1c-platform-tools.settings', () => {
		vscode.commands.executeCommand('workbench.action.openSettings', '@ext:whiterabbit.1c-platform-tools');
	});

	// Вспомогательная функция для проверки проекта перед выполнением команды
	const requireProject = (): boolean => {
		if (!isProject) {
			vscode.window.showWarningMessage('Откройте проект 1С (с файлом packagedef в корне) для использования этой команды');
			return false;
		}
		return true;
	};

	const configurationLoadFromSrcCommand = vscode.commands.registerCommand('1c-platform-tools.configuration.loadFromSrc', () => {
		if (!requireProject()) return;
		configurationCommands.loadFromSrc('update');
	});

	const configurationLoadFromSrcInitCommand = vscode.commands.registerCommand('1c-platform-tools.configuration.loadFromSrc.init', () => {
		if (!requireProject()) return;
		configurationCommands.loadFromSrc('init');
	});

	const configurationUpdateFromSrcWithCommitCommand = vscode.commands.registerCommand('1c-platform-tools.configuration.updateFromSrcWithCommit', () => {
		if (!requireProject()) return;
		configurationCommands.updateFromSrcWithCommit();
	});

	const configurationLoadFromCfCommand = vscode.commands.registerCommand('1c-platform-tools.configuration.loadFromCf', () => {
		if (!requireProject()) return;
		configurationCommands.loadFromCf();
	});

	const configurationDumpToSrcCommand = vscode.commands.registerCommand('1c-platform-tools.configuration.dumpToSrc', () => {
		if (!requireProject()) return;
		configurationCommands.dumpToSrc();
	});

	const configurationDumpUpdateToSrcCommand = vscode.commands.registerCommand('1c-platform-tools.configuration.dumpUpdateToSrc', () => {
		if (!requireProject()) return;
		configurationCommands.dumpUpdateToSrc();
	});

	const configurationDumpToCfCommand = vscode.commands.registerCommand('1c-platform-tools.configuration.dumpToCf', () => {
		if (!requireProject()) return;
		configurationCommands.dumpToCf();
	});

	const configurationDumpToDistCommand = vscode.commands.registerCommand('1c-platform-tools.configuration.dumpToDist', () => {
		if (!requireProject()) return;
		configurationCommands.dumpToDist();
	});

	const configurationBuildCommand = vscode.commands.registerCommand('1c-platform-tools.configuration.build', () => {
		if (!requireProject()) return;
		configurationCommands.compile();
	});

	const configurationDecompileCommand = vscode.commands.registerCommand('1c-platform-tools.configuration.decompile', () => {
		if (!requireProject()) return;
		configurationCommands.decompile();
	});

	const extensionsLoadFromSrcCommand = vscode.commands.registerCommand('1c-platform-tools.extensions.loadFromSrc', () => {
		if (!requireProject()) return;
		extensionsCommands.loadFromSrc();
	});

	const extensionsLoadFromCfeCommand = vscode.commands.registerCommand('1c-platform-tools.extensions.loadFromCfe', () => {
		if (!requireProject()) return;
		extensionsCommands.loadFromCfe();
	});

	const extensionsDumpToSrcCommand = vscode.commands.registerCommand('1c-platform-tools.extensions.dumpToSrc', () => {
		if (!requireProject()) return;
		extensionsCommands.dumpToSrc();
	});

	const extensionsDumpUpdateToSrcCommand = vscode.commands.registerCommand('1c-platform-tools.extensions.dumpUpdateToSrc', () => {
		if (!requireProject()) return;
		extensionsCommands.dumpUpdateToSrc();
	});

	const extensionsUpdateFromSrcWithCommitCommand = vscode.commands.registerCommand('1c-platform-tools.extensions.updateFromSrcWithCommit', () => {
		if (!requireProject()) return;
		extensionsCommands.updateFromSrcWithCommit();
	});

	const extensionsDumpToCfeCommand = vscode.commands.registerCommand('1c-platform-tools.extensions.dumpToCfe', () => {
		if (!requireProject()) return;
		extensionsCommands.dumpToCfe();
	});

	const extensionsBuildCommand = vscode.commands.registerCommand('1c-platform-tools.extensions.build', () => {
		if (!requireProject()) return;
		extensionsCommands.compile();
	});

	const extensionsDecompileCommand = vscode.commands.registerCommand('1c-platform-tools.extensions.decompile', () => {
		if (!requireProject()) return;
		extensionsCommands.decompile();
	});

	const externalProcessorsBuildCommand = vscode.commands.registerCommand('1c-platform-tools.externalProcessors.build', () => {
		if (!requireProject()) return;
		externalFilesCommands.compile('processor');
	});

	const externalProcessorsDecompileCommand = vscode.commands.registerCommand('1c-platform-tools.externalProcessors.decompile', () => {
		if (!requireProject()) return;
		externalFilesCommands.decompile('processor');
	});

	const externalReportsBuildCommand = vscode.commands.registerCommand('1c-platform-tools.externalReports.build', () => {
		if (!requireProject()) return;
		externalFilesCommands.compile('report');
	});

	const externalReportsDecompileCommand = vscode.commands.registerCommand('1c-platform-tools.externalReports.decompile', () => {
		if (!requireProject()) return;
		externalFilesCommands.decompile('report');
	});

	const externalFilesClearCacheCommand = vscode.commands.registerCommand('1c-platform-tools.externalFiles.clearCache', () => {
		if (!requireProject()) return;
		externalFilesCommands.clearCache();
	});

	const infobaseUpdateDatabaseCommand = vscode.commands.registerCommand('1c-platform-tools.infobase.updateDatabase', () => {
		if (!requireProject()) return;
		infobaseCommands.updateDatabase();
	});

	const infobaseBlockExternalResourcesCommand = vscode.commands.registerCommand('1c-platform-tools.infobase.blockExternalResources', () => {
		if (!requireProject()) return;
		infobaseCommands.blockExternalResources();
	});

	const infobaseDumpToDtCommand = vscode.commands.registerCommand('1c-platform-tools.infobase.dumpToDt', () => {
		if (!requireProject()) return;
		infobaseCommands.dumpToDt();
	});

	const infobaseLoadFromDtCommand = vscode.commands.registerCommand('1c-platform-tools.infobase.loadFromDt', () => {
		if (!requireProject()) return;
		infobaseCommands.loadFromDt();
	});

	const dependenciesInstallCommand = vscode.commands.registerCommand('1c-platform-tools.dependencies.install', () => {
		if (!requireProject()) return;
		dependenciesCommands.installDependencies();
	});

	const dependenciesRemoveCommand = vscode.commands.registerCommand('1c-platform-tools.dependencies.remove', () => {
		if (!requireProject()) return;
		dependenciesCommands.removeDependencies();
	});

	const dependenciesInitializePackagedefCommand = vscode.commands.registerCommand('1c-platform-tools.dependencies.initializePackagedef', () => {
		if (!requireProject()) return;
		dependenciesCommands.initializePackagedef();
	});

	const buildConfigurationCommand = vscode.commands.registerCommand('1c-platform-tools.build.configuration', () => {
		if (!requireProject()) return;
		configurationCommands.compile();
	});

	const buildExtensionsCommand = vscode.commands.registerCommand('1c-platform-tools.build.extensions', () => {
		if (!requireProject()) return;
		extensionsCommands.compile();
	});

	const buildExternalProcessorCommand = vscode.commands.registerCommand('1c-platform-tools.build.externalProcessor', () => {
		if (!requireProject()) return;
		externalFilesCommands.compile();
	});

	const buildExternalReportCommand = vscode.commands.registerCommand('1c-platform-tools.build.externalReport', () => {
		if (!requireProject()) return;
		externalFilesCommands.compile();
	});

	const decompileConfigurationCommand = vscode.commands.registerCommand('1c-platform-tools.decompile.configuration', () => {
		if (!requireProject()) return;
		configurationCommands.decompile();
	});

	const decompileExternalProcessorCommand = vscode.commands.registerCommand('1c-platform-tools.decompile.externalProcessor', () => {
		if (!requireProject()) return;
		externalFilesCommands.decompile();
	});

	const decompileExternalReportCommand = vscode.commands.registerCommand('1c-platform-tools.decompile.externalReport', () => {
		if (!requireProject()) return;
		externalFilesCommands.decompile();
	});

	const decompileExtensionCommand = vscode.commands.registerCommand('1c-platform-tools.decompile.extension', () => {
		if (!requireProject()) return;
		extensionsCommands.decompile();
	});

	const runEnterpriseCommand = vscode.commands.registerCommand('1c-platform-tools.run.enterprise', () => {
		if (!requireProject()) return;
		runCommands.runEnterprise();
	});

	const runDesignerCommand = vscode.commands.registerCommand('1c-platform-tools.run.designer', () => {
		if (!requireProject()) return;
		runCommands.runDesigner();
	});


	const launchViewCommand = vscode.commands.registerCommand('1c-platform-tools.launch.view', () => {
		if (!requireProject()) return;
		treeDataProvider.refresh();
	});

	const launchRunCommand = vscode.commands.registerCommand('1c-platform-tools.launch.run', async (taskLabel: string) => {
		if (!requireProject()) return;
		await workspaceTasksCommands.runTask(taskLabel);
	});

	const launchEditCommand = vscode.commands.registerCommand('1c-platform-tools.launch.edit', () => {
		if (!requireProject()) return;
		workspaceTasksCommands.editTasks();
	});

	const fileOpenCommand = vscode.commands.registerCommand('1c-platform-tools.file.open', async (filePath: string) => {
		const uri = vscode.Uri.file(filePath);
		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc);
	});

	const launchEditConfigurationsCommand = vscode.commands.registerCommand('1c-platform-tools.launch.editConfigurations', () => {
		if (!requireProject()) return;
		workspaceTasksCommands.editLaunchConfigurations();
	});

	const configEnvEditCommand = vscode.commands.registerCommand('1c-platform-tools.config.env.edit', async () => {
		const workspaceRoot = vrunnerManager.getWorkspaceRoot();
		if (!workspaceRoot) {
			vscode.window.showErrorMessage('Откройте рабочую область для работы с проектом');
			return;
		}
		const envPath = vscode.Uri.file(path.join(workspaceRoot, 'env.json'));
		const doc = await vscode.workspace.openTextDocument(envPath);
		await vscode.window.showTextDocument(doc);
	});

	const infobaseCreateEmptyCommand = vscode.commands.registerCommand('1c-platform-tools.infobase.createEmpty', () => {
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

/**
 * Деактивирует расширение
 * Очистка не требуется: все ресурсы автоматически освобождаются
 * через context.subscriptions при деактивации расширения
 */
export function deactivate() {
	// Очистка не требуется
}
