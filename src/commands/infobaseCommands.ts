import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { BaseCommand } from './baseCommand';
import {
	getCreateEmptyInfobaseCommandName,
	getUpdateDatabaseCommandName,
	getBlockExternalResourcesCommandName,
	getDumpInfobaseToDtCommandName,
	getLoadInfobaseFromDtCommandName
} from '../commandNames';

/**
 * Команды для работы с информационными базами
 */
export class InfobaseCommands extends BaseCommand {

	/**
	 * Создает пустую информационную базу
	 * Выполняет команду v8runner-cli.os createInfobase
	 * @returns Промис, который разрешается после запуска команды
	 */
	async createEmptyInfobase(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const ibParams = await this.vrunner.getIbConnectionParams();
		const buildPath = this.vrunner.getBuildPath();
		const ibPath = path.join(workspaceRoot, buildPath, 'ib');
		const commandName = getCreateEmptyInfobaseCommandName();

		const args = [
			'createInfobase',
			'--ibconnection', ibParams.connection,
			'--path', ibPath
		];

		if (ibParams.username) {
			args.push('--db-user', ibParams.username);
		}
		if (ibParams.password) {
			args.push('--db-pwd', ibParams.password);
		}

		this.vrunner.executeOscriptInTerminal(
			'oscript_modules/v8runner/src/v8runner-cli.os',
			args,
			{
				cwd: workspaceRoot,
				name: commandName.title
			}
		);
	}

	/**
	 * Выполняет постобработку обновления информационной базы
	 * Выполняет команду v8runner-cli.os executeEpf с обработкой ЗакрытьПредприятие.epf
	 * @returns Промис, который разрешается после запуска команды
	 */
	async updateDatabase(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getUpdateDatabaseCommandName();
		const epfPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'epf', 'ЗакрытьПредприятие.epf');

		const args = [
			'executeEpf',
			'--ibconnection', ibParams.connection,
			'--epf', epfPath,
			'--command', 'ЗапуститьОбновлениеИнформационнойБазы;ЗавершитьРаботуСистемы;'
		];

		if (ibParams.username) {
			args.push('--db-user', ibParams.username);
		}
		if (ibParams.password) {
			args.push('--db-pwd', ibParams.password);
		}

		this.vrunner.executeOscriptInTerminal(
			'oscript_modules/v8runner/src/v8runner-cli.os',
			args,
			{
				cwd: workspaceRoot,
				name: commandName.title
			}
		);
	}

	/**
	 * Запрещает работу с внешними ресурсами
	 * Выполняет команду v8runner-cli.os executeEpf с обработкой БлокировкаРаботыСВнешнимиРесурсами.epf
	 * @returns Промис, который разрешается после запуска команды
	 */
	async blockExternalResources(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getBlockExternalResourcesCommandName();
		const epfPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'epf', 'БлокировкаРаботыСВнешнимиРесурсами.epf');

		const args = [
			'executeEpf',
			'--ibconnection', ibParams.connection,
			'--epf', epfPath,
			'--command', 'ЗапретитьРаботуСВнешнимиРесурсами;ЗавершитьРаботуСистемы'
		];

		if (ibParams.username) {
			args.push('--db-user', ibParams.username);
		}
		if (ibParams.password) {
			args.push('--db-pwd', ibParams.password);
		}

		this.vrunner.executeOscriptInTerminal(
			'oscript_modules/v8runner/src/v8runner-cli.os',
			args,
			{
				cwd: workspaceRoot,
				name: commandName.title
			}
		);
	}

	/**
	 * Выгружает информационную базу в dt-файл
	 * Формирует имя файла в формате: 1Cv8_YYYYMMDD_HHMMSS.dt
	 * Выполняет команду v8runner-cli.os dumpInfobase
	 * @returns Промис, который разрешается после запуска команды
	 */
	async dumpToDt(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const buildPath = this.vrunner.getBuildPath();
		const dtFolder = path.join(buildPath, 'dt');
		const dtFolderFullPath = path.join(workspaceRoot, dtFolder);

		try {
			await fs.mkdir(dtFolderFullPath, { recursive: true });
		} catch (error) {
			vscode.window.showErrorMessage(`Ошибка при создании папки ${dtFolder}: ${(error as Error).message}`);
			return;
		}

		const now = new Date();
		const year = now.getFullYear();
		const month = String(now.getMonth() + 1).padStart(2, '0');
		const day = String(now.getDate()).padStart(2, '0');
		const hours = String(now.getHours()).padStart(2, '0');
		const minutes = String(now.getMinutes()).padStart(2, '0');
		const seconds = String(now.getSeconds()).padStart(2, '0');
		const dateStr = `${year}${month}${day}`;
		const timeStr = `${hours}${minutes}${seconds}`;

		const fileName = `1Cv8_${dateStr}_${timeStr}.dt`;
		const dtPath = path.join(workspaceRoot, dtFolder, fileName);
		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getDumpInfobaseToDtCommandName();

		const args = [
			'dumpInfobase',
			'--ibconnection', ibParams.connection,
			'--out', dtPath
		];

		if (ibParams.username) {
			args.push('--db-user', ibParams.username);
		}
		if (ibParams.password) {
			args.push('--db-pwd', ibParams.password);
		}

		this.vrunner.executeOscriptInTerminal(
			'oscript_modules/v8runner/src/v8runner-cli.os',
			args,
			{
				cwd: workspaceRoot,
				name: commandName.title
			}
		);
	}

	/**
	 * Загружает информационную базу из dt-файла
	 * Предлагает окно для выбора dt-файла
	 * Выполняет команду v8runner-cli.os loadInfobase
	 * @returns Промис, который разрешается после выбора файла и запуска команды
	 */
	async loadFromDt(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const buildPath = this.vrunner.getBuildPath();
		const dtFolder = path.join(workspaceRoot, buildPath, 'dt');

		const fileUri = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			openLabel: 'Загрузить',
			filters: {
				'DT файлы': ['dt']
			},
			defaultUri: vscode.Uri.file(dtFolder)
		});

		if (!fileUri || fileUri.length === 0) {
			return;
		}

		const selectedFilePath = fileUri[0].fsPath;
		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getLoadInfobaseFromDtCommandName();

		const args = [
			'loadInfobase',
			'--ibconnection', ibParams.connection,
			'--file', selectedFilePath
		];

		if (ibParams.username) {
			args.push('--db-user', ibParams.username);
		}
		if (ibParams.password) {
			args.push('--db-pwd', ibParams.password);
		}

		this.vrunner.executeOscriptInTerminal(
			'oscript_modules/v8runner/src/v8runner-cli.os',
			args,
			{
				cwd: workspaceRoot,
				name: commandName.title
			}
		);
	}
}
