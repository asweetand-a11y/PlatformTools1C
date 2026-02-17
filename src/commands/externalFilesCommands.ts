import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { BaseCommand } from './baseCommand';
import {
	getBuildExternalProcessorCommandName,
	getBuildExternalReportCommandName,
	getDecompileExternalProcessorCommandName,
	getDecompileExternalReportCommandName
} from '../commandNames';

/**
 * Тип внешнего файла
 */
export type ExternalFileType = 'processor' | 'report';

/**
 * Команды для работы с внешними файлами (обработки и отчеты)
 */
export class ExternalFilesCommands extends BaseCommand {

	/**
	 * Собирает внешний файл (обработку или отчет) из исходников
	 * Выполняет команду v8runner-cli.os loadExternalFiles для каждой папки в исходниках
	 * @param fileType - Тип файла: 'processor' для обработок, 'report' для отчетов
	 * @returns Промис, который разрешается после запуска команды
	 */
	async compile(fileType: ExternalFileType = 'processor'): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const srcFolder = fileType === 'processor' ? this.vrunner.getEpfPath() : this.vrunner.getErfPath();
		const srcPath = path.join(workspaceRoot, srcFolder);

		if (!(await this.checkDirectoryExists(srcPath, `Папка ${srcFolder} не является директорией`))) {
			return;
		}

		const ibParams = await this.vrunner.getIbConnectionParams();
		const buildPath = this.vrunner.getBuildPath();
		const outputFolder = path.join(buildPath, fileType === 'processor' ? 'epf' : 'erf');
		const outputFolderFullPath = path.join(workspaceRoot, outputFolder);

		try {
			await fs.mkdir(outputFolderFullPath, { recursive: true });
		} catch (error) {
			vscode.window.showErrorMessage(`Ошибка при создании папки ${outputFolder}: ${(error as Error).message}`);
			return;
		}

		const commandName = fileType === 'processor' 
			? getBuildExternalProcessorCommandName()
			: getBuildExternalReportCommandName();

		// Получаем список всех подпапок в srcFolder
		const entries = await fs.readdir(srcPath, { withFileTypes: true });
		const folders = entries.filter(entry => entry.isDirectory()).map(entry => entry.name);

		if (folders.length === 0) {
			vscode.window.showWarningMessage(`В папке ${srcFolder} не найдено подпапок для сборки`);
			return;
		}

		// Для каждой папки создаем команду сборки
		for (const folder of folders) {
			const folderSrcPath = path.join(workspaceRoot, srcFolder, folder);
			const outputFileName = `${folder}.${fileType === 'processor' ? 'epf' : 'erf'}`;
			const outputFilePath = path.join(workspaceRoot, outputFolder, outputFileName);

			const args = [
				'loadExternalFiles',
				'--ibconnection', ibParams.connection,
				'--src', folderSrcPath,
				'--file', outputFilePath
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

	/**
	 * Разбирает внешний файл (обработку или отчет) из .epf/.erf в исходники
	 * Выполняет команду v8runner-cli.os dumpExternalFiles для каждого файла в папке
	 * @param fileType - Тип файла: 'processor' для обработок, 'report' для отчетов
	 * @returns Промис, который разрешается после запуска команды
	 */
	async decompile(fileType: ExternalFileType = 'processor'): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const buildPath = this.vrunner.getBuildPath();
		const buildFolder = fileType === 'processor' ? 'epf' : 'erf';
		const inputPath = path.join(buildPath, buildFolder);
		const inputFullPath = path.join(workspaceRoot, inputPath);

		if (!(await this.checkDirectoryExists(inputFullPath, `Папка ${inputPath} не является директорией`))) {
			return;
		}

		const outputPath = fileType === 'processor' ? this.vrunner.getEpfPath() : this.vrunner.getErfPath();
		const outputFullPath = path.join(workspaceRoot, outputPath);

		try {
			await fs.mkdir(outputFullPath, { recursive: true });
		} catch (error) {
			vscode.window.showErrorMessage(`Ошибка при создании папки ${outputPath}: ${(error as Error).message}`);
			return;
		}

		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = fileType === 'processor' 
			? getDecompileExternalProcessorCommandName()
			: getDecompileExternalReportCommandName();

		// Получаем список всех .epf/.erf файлов в buildFolder
		const extension = fileType === 'processor' ? '.epf' : '.erf';
		const entries = await fs.readdir(inputFullPath, { withFileTypes: true });
		const files = entries
			.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
			.map(entry => entry.name);

		if (files.length === 0) {
			vscode.window.showWarningMessage(`В папке ${inputPath} не найдено файлов ${extension} для разбора`);
			return;
		}

		// Для каждого файла создаем команду разбора
		for (const file of files) {
			const inputFilePath = path.join(workspaceRoot, inputPath, file);
			const fileNameWithoutExt = path.parse(file).name;
			const outputFolderPath = path.join(workspaceRoot, outputPath, fileNameWithoutExt);

			const args = [
				'dumpExternalFiles',
				'--ibconnection', ibParams.connection,
				'--out', outputFolderPath,
				'--file', inputFilePath
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

	/**
	 * Очищает кэш, удаляя файл build/cache.json
	 * @returns Промис, который разрешается после удаления файла кэша
	 */
	async clearCache(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const buildPath = this.vrunner.getBuildPath();
		const buildDir = path.dirname(buildPath);
		const cacheFilePath = path.join(workspaceRoot, buildDir, 'cache.json');

		try {
			await fs.unlink(cacheFilePath);
			vscode.window.showInformationMessage('Кэш успешно очищен');
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code === 'ENOENT') {
				vscode.window.showInformationMessage('Файл кэша не найден');
			} else {
				vscode.window.showErrorMessage(`Ошибка при удалении кэша: ${err.message}`);
			}
		}
	}
}
